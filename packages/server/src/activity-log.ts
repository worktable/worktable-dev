// ============================================================
// Workspace activity history
// ============================================================
//
// Append-only JSONL per Space (plus one for Worktable-level threads), kept in
// machine-local app storage beside thread delivery state. It never changes the
// workspace folder, its exports, or the file watcher. Recording is best effort:
// a failure to note activity must never fail the write that caused it.
//
// The acting principal comes from the request scope (REST middleware and MCP
// dispatch) so write paths that predate attribution need no extra parameter.

import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  ActivityEventSchema,
  sourceCategory,
  type ActivityAction,
  type ActivityActor,
  type ActivityEntry,
  type ActivityEvent,
  type ActivityPage,
} from "@worktable/types"
import { ensureAppDir, getAppDir } from "./app-storage.ts"
import { atomicWriteText } from "./atomic-file.ts"
import type { DocPathMoves } from "./doc-aliases.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import type { RequestPrincipal } from "./token-store.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { logError } from "./debug-log.ts"

/** Log name for Worktable-level threads; Space IDs cannot start with "_". */
const WORKTABLE_KEY = "_worktable"
/**
 * Compact a log once it passes this size, keeping the newest events within
 * both limits so the result always lands well under the threshold.
 */
const COMPACT_AT_BYTES = 2 * 1024 * 1024
const KEEP_AFTER_COMPACT = 5000
const KEEP_BYTES_AFTER_COMPACT = COMPACT_AT_BYTES / 2
/** Repeated saves of one doc by one actor within this window are one edit. */
const EDIT_SESSION_MS = 15 * 60 * 1000

export const SYSTEM_ACTOR: ActivityActor = {
  kind: "system",
  id: "worktable",
  name: "Worktable",
}

// ------------------------------------------------------------
// Actor scope
// ------------------------------------------------------------

const actorScope = new AsyncLocalStorage<ActivityActor>()

export function actorFromPrincipal(principal: RequestPrincipal): ActivityActor {
  return {
    kind:
      principal.type === "human"
        ? "person"
        : principal.type === "agent"
          ? "agent"
          : "system",
    id: principal.id,
    name: principal.displayName,
  }
}

/** Run work on behalf of a principal so its writes are attributed to it. */
export function runAsActivityActor<T>(
  principal: RequestPrincipal | undefined,
  work: () => T
): T {
  if (!principal) return work()
  return actorScope.run(actorFromPrincipal(principal), work)
}

export function currentActivityActor(): ActivityActor | undefined {
  return actorScope.getStore()
}

/**
 * Best actor for a write that carries only legacy attribution strings, such as
 * browser collaboration saves and edits made directly in the workspace folder.
 */
export function actorFromAttribution(
  updatedBy?: string,
  source?: string
): ActivityActor {
  const scoped = currentActivityActor()
  if (scoped) return scoped
  const by = updatedBy ?? ""
  switch (sourceCategory(source, updatedBy)) {
    case "human":
      return { kind: "person", id: "local:owner" }
    case "agent": {
      const id = by.startsWith("agent:") ? by.slice("agent:".length) : by
      return { kind: "agent", id: id || "agent" }
    }
    case "external":
      return { kind: "system", id: "filesystem", name: "Files" }
    default:
      return SYSTEM_ACTOR
  }
}

// ------------------------------------------------------------
// Recording
// ------------------------------------------------------------

export type ActivityInput = Omit<ActivityEvent, "id" | "at" | "actor"> & {
  actor?: ActivityActor
  at?: string
}

const pending = new Set<Promise<void>>()
const lastEditAt = new Map<string, number>()

function logDir(): string {
  return join(ensureAppDir(), "activity", workspaceCacheKey())
}

function logPath(spaceId: string | null): string {
  return join(logDir(), `${spaceId ?? WORKTABLE_KEY}.jsonl`)
}

const queues = new Map<string, Promise<unknown>>()

/** One writer per log in this process, and across processes by lock dir. */
function withLogLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`
  const previous = queues.get(path) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() =>
      withCrossProcessLock(lockPath, { label: "Activity history" }, work)
    )
  queues.set(path, next)
  // Settle on both outcomes; the caller handles the write's own failure.
  const forget = () => {
    if (queues.get(path) === next) queues.delete(path)
  }
  next.then(forget, forget)
  return next
}

function targetKey(event: Pick<ActivityEvent, "target">): string {
  const target = event.target
  switch (target.kind) {
    case "doc":
      return `doc:${target.path}`
    case "thread":
      return `thread:${target.threadId}`
    case "collection":
      return `collection:${target.collectionId}`
  }
}

let activityObserver: ((event: ActivityEvent) => void) | null = null

/** Something that reacts to activity as it is recorded, such as setup progress. */
export function setActivityObserver(
  observer: ((event: ActivityEvent) => void) | null
): void {
  activityObserver = observer
}

/** Note activity without delaying or failing the caller. */
export function recordActivity(input: ActivityInput): void {
  const actor = input.actor ?? currentActivityActor() ?? SYSTEM_ACTOR
  const now = input.at ? Date.parse(input.at) : Date.now()
  // Every save counts toward who last touched a doc, even inside one session.
  if (input.target.kind === "doc" && input.spaceId) {
    noteDocSummary(
      input.spaceId,
      input.target.path,
      input.action,
      actor,
      new Date(now).toISOString()
    )
  }
  let sessionKey: string | undefined
  if (input.action === "doc.edited") {
    const key = `${input.spaceId}|${actor.id}|${targetKey(input)}`
    const previous = lastEditAt.get(key)
    lastEditAt.set(key, now)
    sessionKey = key
    if (lastEditAt.size > 10_000) forgetEndedSessions(now)
    if (previous !== undefined && now - previous < EDIT_SESSION_MS) return
  }
  const parsed = ActivityEventSchema.safeParse({
    ...input,
    actor,
    id: `act_${randomBytes(9).toString("base64url")}`,
    at: new Date(now).toISOString(),
    ...(input.quote ? { quote: clip(input.quote) } : {}),
  })
  if (!parsed.success) {
    console.error(
      `[activity] rejected event: ${parsed.error.issues.length} issue(s)`,
      parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")} ${issue.code}`).join(", ")
    )
    return
  }
  try {
    activityObserver?.(parsed.data)
  } catch (error) {
    console.warn("[activity] observer failed:", logError(error))
  }
  const write = appendEvent(parsed.data).catch((error) => {
    console.error("[activity] could not record event:", logError(error))
    // The session never got its first line; let the next edit try again.
    if (sessionKey && lastEditAt.get(sessionKey) === now) {
      lastEditAt.delete(sessionKey)
    }
  })
  pending.add(write)
  void write.finally(() => pending.delete(write))
}

/**
 * Note a content change. Machine normalization (no person, agent, or folder
 * edit behind it) is not activity anyone needs to read about.
 */
export function noteDocumentEdited(
  spaceId: string,
  path: string,
  updatedBy?: string,
  source?: string
): void {
  const actor = actorFromAttribution(updatedBy, source)
  if (actor.kind === "system" && actor.id !== "filesystem") return
  recordActivity({
    spaceId,
    action: "doc.edited",
    actor,
    target: { kind: "doc", path },
  })
}

/** Note a comment or instruction; machine-written annotations are skipped. */
export function noteCommentActivity(options: {
  spaceId: string
  action: "comment.created" | "comment.replied" | "comment.resolved"
  path: string
  author: { type: "user" | "agent" | "system"; id: string; name?: string }
  body?: string
  category?: "comment" | "instruction"
}): void {
  if (
    options.author.type === "system" ||
    options.author.id === "worktable-lint"
  ) {
    return
  }
  recordActivity({
    spaceId: options.spaceId,
    action: options.action,
    actor: currentActivityActor() ?? {
      kind: options.author.type === "user" ? "person" : "agent",
      id: options.author.id,
      ...(options.author.name ? { name: options.author.name } : {}),
    },
    target: { kind: "doc", path: options.path },
    ...(options.body ? { quote: options.body } : {}),
    ...(options.category ? { category: options.category } : {}),
  })
}

function forgetEndedSessions(now: number): void {
  for (const [key, at] of lastEditAt) {
    if (now - at >= EDIT_SESSION_MS) lastEditAt.delete(key)
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= 280 ? flat : `${flat.slice(0, 279).trimEnd()}…`
}

async function appendEvent(event: ActivityEvent): Promise<void> {
  const path = logPath(event.spaceId)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withLogLock(path, async () => {
    await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 })
    if ((await stat(path)).size < COMPACT_AT_BYTES) return
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean)
    const kept: string[] = []
    let bytes = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!
      bytes += Buffer.byteLength(line) + 1
      if (
        kept.length === KEEP_AFTER_COMPACT ||
        bytes > KEEP_BYTES_AFTER_COMPACT
      ) {
        break
      }
      kept.push(line)
    }
    await atomicWriteText(path, `${kept.reverse().join("\n")}\n`)
  })
}

async function drainWrites(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

/** Wait for activity writes and summaries started so far; tests and shutdown use this. */
export async function drainActivity(): Promise<void> {
  await drainWrites()
  await Promise.allSettled([...summaryBuilds.values()])
}

// ------------------------------------------------------------
// Who works on each doc
// ------------------------------------------------------------
//
// The doc page names who last edited a doc and who has worked on it. That
// comes from this in-memory summary rather than the log, so opening a doc
// never reads history: a Space's summary is built once in the background from
// its log, then kept current as this process records activity.

export interface DocActivitySummary {
  /** Who last created or edited the doc. */
  lastEditor?: ActivityActor
  /**
   * People and agents who created or edited it, most recent first. Comments
   * are left out: not every reader may see who commented.
   */
  contributors: ActivityActor[]
}

/** One actor's latest work on a doc. */
interface DocWork {
  actor: ActivityActor
  at: string
}

/** What one recorded path's history says, kept with times to merge paths. */
interface PathSummary {
  lastEdit?: DocWork
  contributors: DocWork[]
}

const CONTRIBUTORS_KEPT = 4
/** Keyed by workspace and Space, like the logs, without touching the disk. */
const docSummaries = new Map<string, Map<string, PathSummary>>()
/** Logs whose summary is building, with what arrived meanwhile. */
const summariesBuilding = new Map<string, ActivityEvent[]>()
const summaryBuilds = new Map<string, Promise<void>>()

function summaryKey(spaceId: string): string {
  return `${getAppDir()}\0${workspaceCacheKey()}\0${spaceId}`
}

function applyDocSummary(
  summaries: Map<string, PathSummary>,
  path: string,
  action: ActivityAction,
  actor: ActivityActor,
  at: string
): void {
  if (action !== "doc.created" && action !== "doc.edited") return
  const summary = summaries.get(path) ?? { contributors: [] }
  summary.lastEdit = { actor, at }
  if (actor.kind !== "system") {
    summary.contributors = [
      { actor, at },
      ...summary.contributors.filter((known) => known.actor.id !== actor.id),
    ].slice(0, CONTRIBUTORS_KEPT)
  }
  summaries.set(path, summary)
}

function noteDocSummary(
  spaceId: string,
  path: string,
  action: ActivityAction,
  actor: ActivityActor,
  at: string
): void {
  const key = summaryKey(spaceId)
  const summaries = docSummaries.get(key)
  if (summaries) return applyDocSummary(summaries, path, action, actor, at)
  // Saves inside one edit session never reach the log, so the summary that
  // will be built from it must receive this one now.
  if (!summariesBuilding.has(key)) startSummaryBuild(spaceId, key)
  summariesBuilding
    .get(key)
    ?.push({ action, actor, at, target: { kind: "doc", path } } as ActivityEvent)
}

/** The summaries of every path a doc was recorded under, as one. */
function mergePathSummaries(parts: readonly PathSummary[]): DocActivitySummary {
  const newestFirst = (a: DocWork, b: DocWork) => b.at.localeCompare(a.at)
  const lastEdit = parts
    .flatMap((part) => (part.lastEdit ? [part.lastEdit] : []))
    .sort(newestFirst)[0]
  const seen = new Set<string>()
  const contributors = parts
    .flatMap((part) => part.contributors)
    .sort(newestFirst)
    .filter(({ actor }) => !seen.has(actor.id) && seen.add(actor.id))
    .slice(0, CONTRIBUTORS_KEPT)
    .map(({ actor }) => actor)
  return { ...(lastEdit ? { lastEditor: lastEdit.actor } : {}), contributors }
}

async function buildDocSummaries(spaceId: string, key: string): Promise<void> {
  const queued: ActivityEvent[] = []
  summariesBuilding.set(key, queued)
  try {
    // Writes already on their way land in the log before it is read; later
    // ones queue above.
    await drainWrites()
    const summaries = new Map<string, PathSummary>()
    // Writes started together can land in the log in either order.
    const logged = (await readLog(spaceId)).sort((a, b) =>
      a.at.localeCompare(b.at)
    )
    for (const event of [...logged, ...queued]) {
      if (event.target.kind === "doc") {
        applyDocSummary(
          summaries,
          event.target.path,
          event.action,
          event.actor,
          event.at
        )
      }
    }
    if (summariesBuilding.get(key) === queued) docSummaries.set(key, summaries)
  } finally {
    if (summariesBuilding.get(key) === queued) summariesBuilding.delete(key)
  }
}

/**
 * Who has worked on a doc, without waiting. History stays under the paths it
 * was recorded at, so `moves` says which paths were this doc's before it
 * moved. A Space not summarized yet answers null and starts summarizing in
 * the background.
 */
export function peekDocActivity(
  spaceId: string,
  path: string,
  moves?: DocPathMoves
): DocActivitySummary | null {
  const key = summaryKey(spaceId)
  const summaries = docSummaries.get(key)
  if (summaries) {
    // Summaries only gain paths, so the moves' index of them stays valid.
    const recorded = moves ? moves.keysFor(summaries, path) : [path]
    return mergePathSummaries(
      recorded.flatMap((at) => {
        const summary = summaries.get(at)
        return summary ? [summary] : []
      })
    )
  }
  if (!summariesBuilding.has(key)) startSummaryBuild(spaceId, key)
  return null
}

function startSummaryBuild(spaceId: string, key: string): void {
  const build = buildDocSummaries(spaceId, key)
    .catch((error) => {
      console.error("[activity] could not summarize docs:", logError(error))
    })
    .finally(() => summaryBuilds.delete(key))
  summaryBuilds.set(key, build)
}

// A replaced or reset workspace starts with an empty history.
onWorkspaceChange((event) => {
  if (event.type !== "workspaceReset") return
  lastEditAt.clear()
  docSummaries.clear()
  summariesBuilding.clear()
  return drainActivity().then(() =>
    rm(logDir(), { recursive: true, force: true })
  )
})

// ------------------------------------------------------------
// Reading
// ------------------------------------------------------------

async function readLog(spaceId: string | null): Promise<ActivityEvent[]> {
  let text: string
  try {
    text = await readFile(logPath(spaceId), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return text.split("\n").flatMap((line) => {
    if (!line) return []
    try {
      const parsed = ActivityEventSchema.safeParse(JSON.parse(line))
      return parsed.success ? [parsed.data] : []
    } catch {
      return []
    }
  })
}

/** Space IDs with recorded history, plus null for Worktable-level threads. */
async function loggedSpaces(): Promise<(string | null)[]> {
  try {
    return (await readdir(logDir()))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length))
      .map((key) => (key === WORKTABLE_KEY ? null : key))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

export interface ListActivityOptions {
  /** Restrict to these Spaces; null includes Worktable-level threads. */
  spaces?: (string | null)[]
  /** Only Spaces the reader may see; events elsewhere are dropped. */
  visibleSpaces: ReadonlySet<string>
  includeThreads: boolean
  includeRecords: boolean
  includeComments: boolean
  actorKind?: ActivityActor["kind"]
  /** One actor, such as a single agent connection. */
  actorId?: string
  /** Only events about docs whose recorded path this accepts. */
  docPath?: (path: string) => boolean
  before?: string | null
  limit: number
  /** Reader's UTC offset in minutes (Date#getTimezoneOffset), for day grouping. */
  timezoneOffset?: number
}

function encodeCursor(event: ActivityEvent): string {
  return Buffer.from(`${event.at}|${event.id}`).toString("base64url")
}

function decodeCursor(cursor: string): { at: string; id: string } | null {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|")
  return at && id ? { at, id } : null
}

function newestFirst(a: ActivityEvent, b: ActivityEvent): number {
  return b.at.localeCompare(a.at) || b.id.localeCompare(a.id)
}

function isBefore(
  event: ActivityEvent,
  cursor: { at: string; id: string }
): boolean {
  return newestFirst(event, cursor as ActivityEvent) > 0
}

function dayKey(at: string, offsetMinutes: number): string {
  return new Date(Date.parse(at) - offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10)
}

/** Actions whose same-day repeats read as one line. */
const COMBINABLE: ReadonlySet<ActivityAction> = new Set<ActivityAction>([
  "doc.edited",
  "thread.replied",
  "records.added",
  "records.updated",
  "records.removed",
])

function combineKey(event: ActivityEvent, offset: number): string | null {
  if (!COMBINABLE.has(event.action)) return null
  return [
    dayKey(event.at, offset),
    event.spaceId,
    event.actor.id,
    event.action,
    targetKey(event),
  ].join("|")
}

function createdKey(event: ActivityEvent, offset: number): string {
  return [
    dayKey(event.at, offset),
    event.spaceId,
    event.actor.id,
    targetKey(event),
  ].join("|")
}

type VisibilityOptions = Pick<
  ListActivityOptions,
  "visibleSpaces" | "includeThreads" | "includeRecords" | "includeComments"
>

/** Whether the reader's Spaces and scopes let them see this event. */
function isVisible(event: ActivityEvent, options: VisibilityOptions): boolean {
  return (
    (event.spaceId === null
      ? options.includeThreads
      : options.visibleSpaces.has(event.spaceId)) &&
    (options.includeThreads || event.target.kind !== "thread") &&
    (options.includeRecords || event.target.kind !== "collection") &&
    (options.includeComments || !event.action.startsWith("comment."))
  )
}

export async function listActivity(
  options: ListActivityOptions
): Promise<ActivityPage> {
  await drainWrites()
  const offset = options.timezoneOffset ?? 0
  const sources = options.spaces ?? (await loggedSpaces())
  const cursor = options.before ? decodeCursor(options.before) : null
  const events = (await Promise.all(sources.map(readLog)))
    .flat()
    .filter(
      (event) =>
        isVisible(event, options) &&
        (!options.actorKind || event.actor.kind === options.actorKind) &&
        (!options.actorId || event.actor.id === options.actorId) &&
        (!options.docPath ||
          (event.target.kind === "doc" && options.docPath(event.target.path))) &&
        (!cursor || isBefore(event, cursor))
    )
    .sort(newestFirst)

  // A doc created and then edited by the same actor on one day reads as created.
  const created = new Set(
    events
      .filter((event) => event.action === "doc.created")
      .map((event) => createdKey(event, offset))
  )

  const entries: ActivityEntry[] = []
  const open = new Map<string, ActivityEntry>()
  let consumed: ActivityEvent | null = null
  for (const event of events) {
    if (
      event.action === "doc.edited" &&
      created.has(createdKey(event, offset))
    ) {
      consumed = event
      continue
    }
    const key = combineKey(event, offset)
    const existing = key ? open.get(key) : undefined
    if (existing) {
      existing.repeats += 1
      if (event.count || existing.count) {
        existing.count = (existing.count ?? 1) + (event.count ?? 1)
      }
      consumed = event
      continue
    }
    if (entries.length === options.limit) break
    const entry: ActivityEntry = { ...event, repeats: 1 }
    entries.push(entry)
    if (key) open.set(key, entry)
    consumed = event
  }
  const exhausted =
    consumed === null || consumed === events.at(-1) || entries.length === 0
  return {
    entries,
    nextCursor: exhausted || !consumed ? null : encodeCursor(consumed),
  }
}

/** Agents with visible activity, most recently active first. */
export async function listActivityAgents(
  options: VisibilityOptions & Pick<ListActivityOptions, "spaces">
): Promise<ActivityActor[]> {
  await drainWrites()
  const sources = options.spaces ?? (await loggedSpaces())
  const events = (await Promise.all(sources.map(readLog)))
    .flat()
    .filter(
      (event) => event.actor.kind === "agent" && isVisible(event, options)
    )
    .sort(newestFirst)
  const agents = new Map<string, ActivityActor>()
  for (const event of events) {
    if (!agents.has(event.actor.id)) agents.set(event.actor.id, event.actor)
  }
  return [...agents.values()]
}
