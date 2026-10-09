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
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
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
import { ensureAppDir } from "./app-storage.ts"
import { atomicWriteText } from "./atomic-file.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import type { RequestPrincipal } from "./token-store.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"

const WORKTABLE_KEY = "worktable"
/** Compact a log once it passes this size, keeping the newest events. */
const COMPACT_AT_BYTES = 2 * 1024 * 1024
const KEEP_AFTER_COMPACT = 5000
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

/** Note activity without delaying or failing the caller. */
export function recordActivity(input: ActivityInput): void {
  const actor = input.actor ?? currentActivityActor() ?? SYSTEM_ACTOR
  const now = input.at ? Date.parse(input.at) : Date.now()
  if (input.action === "doc.edited") {
    const key = `${input.spaceId}|${actor.id}|${targetKey(input)}`
    const previous = lastEditAt.get(key)
    lastEditAt.set(key, now)
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
    console.error("[activity] rejected event:", parsed.error.message)
    return
  }
  const write = appendEvent(parsed.data).catch((error) => {
    console.error("[activity] could not record event:", error)
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
  if (options.author.type === "system" || options.author.id === "worktable-lint") {
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
    await atomicWriteText(
      path,
      `${lines.slice(-KEEP_AFTER_COMPACT).join("\n")}\n`
    )
  })
}

/** Wait for activity writes started so far; tests and shutdown use this. */
export async function drainActivity(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

// A replaced or reset workspace starts with an empty history.
onWorkspaceChange((event) => {
  if (event.type !== "workspaceReset") return
  lastEditAt.clear()
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

export async function listActivity(
  options: ListActivityOptions
): Promise<ActivityPage> {
  await drainActivity()
  const offset = options.timezoneOffset ?? 0
  const sources = options.spaces ?? (await loggedSpaces())
  const cursor = options.before ? decodeCursor(options.before) : null
  const events = (await Promise.all(sources.map(readLog)))
    .flat()
    .filter(
      (event) =>
        (event.spaceId === null
          ? options.includeThreads
          : options.visibleSpaces.has(event.spaceId)) &&
        (options.includeThreads || event.target.kind !== "thread") &&
        (options.includeRecords || event.target.kind !== "collection") &&
        (options.includeComments || !event.action.startsWith("comment.")) &&
        (!options.actorKind || event.actor.kind === options.actorKind) &&
        (!options.actorId || event.actor.id === options.actorId) &&
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
  options: Pick<
    ListActivityOptions,
    "spaces" | "visibleSpaces" | "includeThreads"
  >
): Promise<ActivityActor[]> {
  await drainActivity()
  const sources = options.spaces ?? (await loggedSpaces())
  const events = (await Promise.all(sources.map(readLog)))
    .flat()
    .filter(
      (event) =>
        event.actor.kind === "agent" &&
        (event.spaceId === null
          ? options.includeThreads
          : options.visibleSpaces.has(event.spaceId))
    )
    .sort(newestFirst)
  const agents = new Map<string, ActivityActor>()
  for (const event of events) {
    if (!agents.has(event.actor.id)) agents.set(event.actor.id, event.actor)
  }
  return [...agents.values()]
}
