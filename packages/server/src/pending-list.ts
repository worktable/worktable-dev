// ============================================================
// The pending list: what is waiting on each person and agent
// ============================================================
//
// One list for everything that asks a person or agent for a response:
// comments sent to them and thread messages assigned to them, and later other
// kinds. Each kind keeps its own truth in its own files; this list only
// indexes what is open, by recipient, so a request never scans those files.
//
// The list is rebuilt from the sources once per workspace, in the background,
// and then follows writes as they happen: comment writes report themselves,
// thread writes and thread files changed on disk arrive as workspace events.
//
// Each recipient has a revision that only goes up. An item gets the next one
// when the list first sees it, and keeps it across restarts: the revision
// and the Delivered and Read marks are kept in a small private file in the
// app directory, never in the workspace.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type {
  AnnotationAuthor,
  AnnotationRequest,
  AnnotationStatus,
  SpaceFile,
  ThreadLocation,
} from "@worktable/types"
import { threadLocationKey } from "@worktable/types"
import { getAppDir } from "./app-storage.ts"
import { logError } from "./debug-log.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"
import { runWithoutTeamIdentity } from "./team-policy.ts"
import {
  scanAllThreadDigests,
  scanThreadDigests,
  type ThreadDigest,
} from "./thread-store.ts"
import {
  onWorkspaceChange,
  threadEventLocation,
} from "./workspace-events.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"

export type PendingKind = "comment" | "threadRequest"

export type PendingActor = {
  kind: "person" | "agent" | "system"
  id: string
  name?: string
}

export interface PendingCommentSource {
  kind: "comment"
  spaceId: string
  annotationId: string
  requestId: string
  /** The Doc or HTML Doc, by durable id when it has one. */
  documentId?: string
  /** The path when the list saw it; readers prefer the current one. */
  path: string
  from: PendingActor
  /** Who it was sent to, as the comment names them. */
  to: { kind: "human" | "agent"; name: string }
  excerpt: string
  quote?: string
}

export interface PendingThreadRequestSource {
  kind: "threadRequest"
  location: ThreadLocation
  threadId: string
  threadTitle: string
  messageId: string
  createdAt: string
  from: PendingActor
  /** The identity it was assigned to, by its name in the thread. */
  recipientName: string
  excerpt: string
}

export interface PendingEntry {
  /** Stable for the request it stands for; a new request is a new item. */
  itemId: string
  kind: PendingKind
  recipient: { participantId: string; identityId?: string }
  scope: { spaceId: string | null; documentId?: string; threadId?: string }
  /** The recipient's revision when the list first saw this item. */
  revision: number
  createdAt: string
  source: PendingCommentSource | PendingThreadRequestSource
}

export type PendingCloseReason = "replied" | "resolved" | "withdrawn"

export type PendingChange =
  | { type: "added"; entry: PendingEntry }
  | { type: "closed"; entry: PendingEntry; reason: PendingCloseReason }

type Derived = Omit<PendingEntry, "revision">

interface Marks {
  participantId: string
  revision: number
  deliveredAt?: string
  readAt?: string
}

interface MarksFile {
  type: "worktable.pending"
  version: 1
  revisions: Record<string, number>
  items: Record<string, Marks>
}

interface ListState {
  root: string
  entries: Map<string, PendingEntry>
  /** Item IDs by the source group that produced them. */
  groups: Map<string, Set<string>>
  byRecipient: Map<string, Set<string>>
  marks: MarksFile
  ready: Promise<void>
  /** While building, nothing is announced: the backlog is not news. */
  building: boolean
  saveTimer: ReturnType<typeof setTimeout> | null
}

let state: ListState | null = null
const listeners = new Set<(change: PendingChange) => void>()

/** Hear items open and close, for wakes and live views. */
export function onPendingChange(
  listener: (change: PendingChange) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(change: PendingChange): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch (error) {
      console.error("[pending] listener failed:", logError(error))
    }
  }
}

function marksPath(): string {
  return join(getAppDir(), "pending", `${workspaceCacheKey()}.json`)
}

async function loadMarks(): Promise<MarksFile> {
  try {
    const parsed = JSON.parse(await readFile(marksPath(), "utf8")) as MarksFile
    if (parsed?.type === "worktable.pending" && parsed.version === 1) {
      return {
        type: "worktable.pending",
        version: 1,
        revisions: parsed.revisions ?? {},
        items: parsed.items ?? {},
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[pending] starting a new list:", logError(error))
    }
  }
  return { type: "worktable.pending", version: 1, revisions: {}, items: {} }
}

let saveCounter = 0

function scheduleSave(current: ListState): void {
  if (current.saveTimer) return
  current.saveTimer = setTimeout(() => {
    current.saveTimer = null
    if (state !== current) return
    void saveMarks(current).catch((error: unknown) => {
      console.error("[pending] could not save:", logError(error))
    })
  }, 250)
  current.saveTimer.unref?.()
}

async function saveMarks(current: ListState): Promise<void> {
  const path = marksPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${(saveCounter += 1)}`
  await writeFile(tmp, `${JSON.stringify(current.marks)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

function add(current: ListState, group: string, derived: Derived): void {
  const known = current.marks.items[derived.itemId]
  const participantId = derived.recipient.participantId
  let revision = known?.revision
  if (revision === undefined) {
    revision = (current.marks.revisions[participantId] ?? 0) + 1
    current.marks.revisions[participantId] = revision
    current.marks.items[derived.itemId] = { participantId, revision }
    scheduleSave(current)
  }
  const entry: PendingEntry = { ...derived, revision }
  current.entries.set(entry.itemId, entry)
  let ids = current.groups.get(group)
  if (!ids) current.groups.set(group, (ids = new Set()))
  ids.add(entry.itemId)
  let mine = current.byRecipient.get(participantId)
  if (!mine) current.byRecipient.set(participantId, (mine = new Set()))
  mine.add(entry.itemId)
  if (!known && !current.building) emit({ type: "added", entry })
}

function close(
  current: ListState,
  group: string,
  itemId: string,
  reason: PendingCloseReason
): void {
  const entry = current.entries.get(itemId)
  current.groups.get(group)?.delete(itemId)
  if (current.groups.get(group)?.size === 0) current.groups.delete(group)
  if (!entry) return
  current.entries.delete(itemId)
  current.byRecipient.get(entry.recipient.participantId)?.delete(itemId)
  // Closed items never open again: a later request is a new item.
  delete current.marks.items[itemId]
  scheduleSave(current)
  if (!current.building) emit({ type: "closed", entry, reason })
}

/**
 * Make one source group hold exactly these items. Items it no longer holds
 * are closed, for the reason the source gives.
 */
function replaceGroup(
  current: ListState,
  group: string,
  items: readonly Derived[],
  reasonFor: (itemId: string) => PendingCloseReason
): void {
  const next = new Set(items.map((item) => item.itemId))
  for (const itemId of [...(current.groups.get(group) ?? [])]) {
    if (!next.has(itemId)) close(current, group, itemId, reasonFor(itemId))
  }
  for (const item of items) {
    if (!current.entries.has(item.itemId)) add(current, group, item)
    else current.entries.set(item.itemId, {
      ...item,
      revision: current.entries.get(item.itemId)!.revision,
    })
  }
}

/** Replace every group under a prefix, closing groups that are gone. */
function replaceGroups(
  current: ListState,
  prefix: string,
  groups: ReadonlyMap<string, readonly Derived[]>,
  reasonFor: (group: string, itemId: string) => PendingCloseReason
): void {
  for (const group of [...current.groups.keys()]) {
    if (group.startsWith(prefix) && !groups.has(group)) {
      replaceGroup(current, group, [], (itemId) => reasonFor(group, itemId))
    }
  }
  for (const [group, items] of groups) {
    replaceGroup(current, group, items, (itemId) => reasonFor(group, itemId))
  }
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= 160 ? flat : `${flat.slice(0, 159).trimEnd()}…`
}

// ── Comments ───────────────────────────────────────────────

function commentGroup(spaceId: string, annotationId: string): string {
  return `cmt:${spaceId}:${annotationId}`
}

/** What the list needs of a comment, in either storage layout. */
export interface IndexedComment {
  id: string
  status: AnnotationStatus
  author: AnnotationAuthor
  body: string
  requests?: AnnotationRequest[]
}

/** Where a comment is: its Doc's path, durable id, and quoted passage. */
export interface CommentPlace {
  path: string
  documentId?: string
  quote?: string
}

/** The open requests on one comment, as items. */
function commentItems(
  spaceId: string,
  annotation: IndexedComment,
  { path, documentId, quote }: CommentPlace
): Derived[] {
  if (annotation.status === "resolved") return []
  return (annotation.requests ?? []).flatMap((request) =>
    request.status === "open"
      ? [
          {
            itemId: `cmt:${annotation.id}:${request.id}`,
            kind: "comment" as const,
            recipient: { participantId: request.to.id },
            scope: { spaceId, ...(documentId ? { documentId } : {}) },
            createdAt: request.createdAt,
            source: {
              kind: "comment" as const,
              spaceId,
              annotationId: annotation.id,
              requestId: request.id,
              ...(documentId ? { documentId } : {}),
              path,
              from: {
                kind:
                  annotation.author.type === "user"
                    ? ("person" as const)
                    : annotation.author.type,
                id: annotation.author.id,
                ...(annotation.author.name
                  ? { name: annotation.author.name }
                  : {}),
              },
              to: { kind: request.to.kind, name: request.to.name },
              excerpt: excerpt(annotation.body),
              ...(quote ? { quote: excerpt(quote) } : {}),
            },
          },
        ]
      : []
  )
}

function commentCloseReason(annotation: IndexedComment | null) {
  return (itemId: string): PendingCloseReason => {
    if (!annotation || annotation.status === "resolved") return "resolved"
    const requestId = itemId.slice(itemId.lastIndexOf(":") + 1)
    const request = annotation.requests?.find(
      (candidate) => candidate.id === requestId
    )
    return request?.status === "replied" ? "replied" : "withdrawn"
  }
}

/** A comment changed: its open requests are now exactly these. */
export function noteCommentChanged(
  spaceId: string,
  annotation: IndexedComment,
  place: CommentPlace
): void {
  const current = state
  if (!current || current.root !== getWorkspaceRoot()) return
  // A rebuild in progress picks the change up from the files it reads.
  void current.ready.then(() => {
    if (state !== current) return
    replaceGroup(
      current,
      commentGroup(spaceId, annotation.id),
      commentItems(spaceId, annotation, place),
      commentCloseReason(annotation)
    )
  })
}

/** Comments in a Space moved or went away: index them again. */
export function noteCommentsMoved(spaceId: string): void {
  const current = state
  if (!current || current.root !== getWorkspaceRoot()) return
  void current.ready
    .then(() => (state === current ? rebuildSpaceComments(current, spaceId) : undefined))
    .catch((error: unknown) => {
      console.error("[pending] could not follow moved comments:", logError(error))
    })
}

/** Index every comment in a Space that waits on someone. */
async function rebuildSpaceComments(
  current: ListState,
  spaceId: string
): Promise<void> {
  const { openCommentsWithRequests } = await import("./annotation-store.ts")
  const comments = await openCommentsWithRequests(spaceId)
  const groups = new Map<string, Derived[]>()
  for (const { annotation, place } of comments) {
    groups.set(
      commentGroup(spaceId, annotation.id),
      commentItems(spaceId, annotation, place)
    )
  }
  replaceGroups(current, `cmt:${spaceId}:`, groups, () => "resolved")
}

// ── Thread requests ────────────────────────────────────────

function threadGroup(location: ThreadLocation, threadId: string): string {
  return `thr:${threadLocationKey(location)}:${threadId}`
}

function threadItems(digest: ThreadDigest): Derived[] {
  const thread = digest.summary
  return digest.requests.flatMap(({ openMessage: message, responseRequest }) => {
    if (!message || responseRequest.status !== "open") return []
    const identity = thread.identities.find(
      (candidate) => candidate.id === responseRequest.identityId
    )
    if (!identity) return []
    const member = thread.members.find(
      (candidate) => candidate.id === message.authorMemberId
    )
    const author = thread.identities.find(
      (candidate) => candidate.id === message.authorIdentityId
    )
    return [
      {
        itemId: `thr:${thread.id}:${message.id}:${identity.id}`,
        kind: "threadRequest" as const,
        recipient: { participantId: identity.memberId, identityId: identity.id },
        scope: {
          spaceId:
            thread.location.kind === "space" ? thread.location.spaceId : null,
          threadId: thread.id,
        },
        createdAt: message.createdAt,
        source: {
          kind: "threadRequest" as const,
          location: thread.location,
          threadId: thread.id,
          threadTitle: thread.title,
          messageId: message.id,
          createdAt: message.createdAt,
          from: {
            kind:
              member?.kind === "human"
                ? ("person" as const)
                : (member?.kind ?? "agent"),
            id: message.authorMemberId,
            name: author?.name ?? member?.name ?? "Someone",
          },
          recipientName: identity.name,
          excerpt: excerpt(message.body),
        },
      },
    ]
  })
}

function threadCloseReason(digest: ThreadDigest | undefined) {
  return (itemId: string): PendingCloseReason => {
    const messageId = itemId.split(":")[2]
    const request = digest?.requests.find(
      (candidate) => candidate.messageId === messageId
    )
    return request?.responseRequest.status === "responded"
      ? "replied"
      : "withdrawn"
  }
}

function applyThreadDigests(
  current: ListState,
  prefix: string,
  threads: readonly ThreadDigest[]
): void {
  const digests = new Map<string, ThreadDigest>()
  const groups = new Map<string, Derived[]>()
  for (const digest of threads) {
    const group = threadGroup(digest.summary.location, digest.summary.id)
    digests.set(group, digest)
    groups.set(group, threadItems(digest))
  }
  replaceGroups(current, prefix, groups, (group, itemId) =>
    threadCloseReason(digests.get(group))(itemId)
  )
}

async function rescanThreadLocation(
  current: ListState,
  location: ThreadLocation
): Promise<void> {
  const scan = await runWithoutTeamIdentity(() => scanThreadDigests(location))
  // A file that couldn't be read keeps what the list had for it.
  if (!scan.complete) return
  applyThreadDigests(current, `thr:${threadLocationKey(location)}:`, scan.threads)
}

// ── Building and following ─────────────────────────────────

async function build(current: ListState): Promise<void> {
  current.marks = await loadMarks()
  const spaces: SpaceFile[] = await listSpaces()
  const scan = await runWithoutTeamIdentity(() => scanAllThreadDigests(spaces))
  for (const location of scan.locations) {
    const key = threadLocationKey(location)
    applyThreadDigests(
      current,
      `thr:${key}:`,
      scan.threads.filter(
        (digest) => threadLocationKey(digest.summary.location) === key
      )
    )
  }
  for (const space of spaces) {
    if (getSpaceArchiveInfo(space)) continue
    await rebuildSpaceComments(current, space.id).catch((error: unknown) => {
      console.error(`[pending] skipped comments in ${space.id}:`, logError(error))
    })
  }
  // Marks for items that are no longer open don't come back.
  for (const itemId of Object.keys(current.marks.items)) {
    if (!current.entries.has(itemId)) delete current.marks.items[itemId]
  }
  scheduleSave(current)
}

/** The list for the current workspace, built on first use. */
export function pendingList(): Promise<void> {
  const root = getWorkspaceRoot()
  if (state?.root === root) return state.ready
  if (state?.saveTimer) clearTimeout(state.saveTimer)
  const current: ListState = {
    root,
    entries: new Map(),
    groups: new Map(),
    byRecipient: new Map(),
    marks: { type: "worktable.pending", version: 1, revisions: {}, items: {} },
    ready: Promise.resolve(),
    building: true,
    saveTimer: null,
  }
  state = current
  current.ready = runWithoutTeamIdentity(() => build(current))
    .catch((error: unknown) => {
      console.error("[pending] could not build the list:", logError(error))
    })
    .finally(() => {
      current.building = false
    })
  return current.ready
}

/** Open items for one participant, newest first. */
export async function pendingFor(participantId: string): Promise<PendingEntry[]> {
  await pendingList()
  const current = state!
  return [...(current.byRecipient.get(participantId) ?? [])]
    .map((itemId) => current.entries.get(itemId)!)
    .filter(Boolean)
    .sort((a, b) => b.revision - a.revision)
}

/** Open items a participant asked of others, newest first. */
export async function pendingFrom(participantId: string): Promise<PendingEntry[]> {
  await pendingList()
  return [...state!.entries.values()]
    .filter((entry) => entry.source.from.id === participantId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** The highest revision a participant's items have reached. */
export async function pendingRevision(participantId: string): Promise<number> {
  await pendingList()
  return state!.marks.revisions[participantId] ?? 0
}

/** Delivered and Read marks for one item, when it is open. */
export function pendingMarks(
  itemId: string
): { deliveredAt?: string; readAt?: string } | null {
  const marks = state?.marks.items[itemId]
  return marks
    ? {
        ...(marks.deliveredAt ? { deliveredAt: marks.deliveredAt } : {}),
        ...(marks.readAt ? { readAt: marks.readAt } : {}),
      }
    : null
}

/** Write the revisions and marks now, as at shutdown. */
export async function savePendingList(): Promise<void> {
  const current = state
  if (!current) return
  await current.ready
  if (current.saveTimer) clearTimeout(current.saveTimer)
  current.saveTimer = null
  await saveMarks(current)
}

// Thread files change through this server's writes and on disk; the list
// follows both. A rescan reads only thread files whose fingerprints changed.
const rescans = new Map<string, Promise<void>>()

function queueThreadRescan(location: ThreadLocation): void {
  const current = state
  if (!current || current.root !== getWorkspaceRoot()) return
  const key = threadLocationKey(location)
  const previous = rescans.get(key) ?? current.ready
  const next = previous
    .then(() => (state === current ? rescanThreadLocation(current, location) : undefined))
    .catch((error: unknown) => {
      console.error("[pending] could not follow a thread change:", logError(error))
    })
  rescans.set(key, next)
  void next.then(() => {
    if (rescans.get(key) === next) rescans.delete(key)
  })
}

onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    if (state?.saveTimer) clearTimeout(state.saveTimer)
    state = null
    return
  }
  if (event.type === "thread" || event.type === "threadCollectionReconcile") {
    queueThreadRescan(threadEventLocation(event))
  }
})
