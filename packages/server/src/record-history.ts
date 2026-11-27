// ============================================================
// Record history: every change to a Record, kept beside Doc versions
// ============================================================
//
// A Record's file holds only its latest values. This keeps what each change
// replaced: one small file per Record that has changed, one JSON line per
// change, at `<workspace>/versions/<space>/records/<collection>/<record>.jsonl`.
// It lives in the workspace folder beside Doc versions, so backups and
// exports carry it and storage counts it as history, never as files.
//
// A line holds who made the change, when, through what, and each field that
// really changed with the value before and after. A write that changes
// nothing never reaches here.
//
// Writing is best effort, as Activity is: by the time a change is noted the
// Record is already written, so a failure here is logged and never fails or
// undoes that write. Each change is appended as a line break followed by its
// line, so a line a crash cut short ends there: it is skipped when read and
// never joins the change after it.
//
// History is bounded however it is written. A value over MAX_VALUE_BYTES is
// not kept: its change says only that it was too large. A change stays
// within MAX_CHANGE_BYTES and a Record's history within MAX_HISTORY_BYTES,
// its oldest changes going first, so reading one never loads more than that.
// Each change is admitted under the storage limit as history; one that would
// pass the limit is not kept.
//
// History is kept as long as Doc versions are (settings-store.ts retention):
// `pruneRecordHistories` runs with the retention sweep. The newest change of
// a Record always stays, so a Record can always say who last changed it and
// what that replaced.
//
// This module imports neither record-store.ts nor store.ts: the store calls
// it, and version-retention.ts, which the store imports, calls it too.

import { randomBytes } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { open, readdir, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  CanonicalIdSchema,
  RecordChangeSchema,
  type ActivityActor,
  type RecordChange,
  type RecordFile,
  type RecordValueChange,
} from "@worktable/types"
import { actorFromAttribution } from "./activity-log.ts"
import { atomicWriteText } from "./atomic-file.ts"
import { logError } from "./debug-log.ts"
import {
  getRetentionPolicyGeneration,
  getServerSettings,
  type RetentionPolicy,
} from "./settings-store.ts"
import { admitStorageWrite, StorageLimitError } from "./storage-limit.ts"
import { noteStorageChange } from "./storage-usage.ts"
import { ensureRealDocumentStorageDirectory } from "./workspace-storage-v2.ts"
import { getSpacesDir, getVersionsDir, getWorkspaceRoot } from "./workspace.ts"

const DAY_MS = 24 * 60 * 60 * 1000
/** Under a count policy, how long the history of a Record that is gone stays. */
const GONE_RECORD_DAYS = 30
/** A value larger than this, as JSON, is not kept. */
export const MAX_VALUE_BYTES = 64 * 1024
/** One change stays within this; past it, its largest values go first. */
export const MAX_CHANGE_BYTES = 256 * 1024
/** A Record's history stays within this; past it, its oldest changes go. */
export const MAX_HISTORY_BYTES = 1024 * 1024

function isCanonicalId(id: string): boolean {
  return CanonicalIdSchema.safeParse(id).success
}

function collectionHistoryDir(spaceId: string, collectionId: string): string {
  return join(getVersionsDir(), spaceId, "records", collectionId)
}

/** Where a Record's changes are kept; null for ids that name no Record. */
export function recordHistoryPath(
  spaceId: string,
  collectionId: string,
  recordId: string
): string | null {
  if (![spaceId, collectionId, recordId].every(isCanonicalId)) return null
  return join(collectionHistoryDir(spaceId, collectionId), `${recordId}.jsonl`)
}

// One writer per history file in this process: an append never lands in the
// middle of a prune's rewrite.
const queues = new Map<string, Promise<unknown>>()

function withHistoryLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(path) ?? Promise.resolve())
    .catch(() => undefined)
    .then(work)
  queues.set(path, next)
  const forget = () => {
    if (queues.get(path) === next) queues.delete(path)
  }
  next.then(forget, forget)
  return next
}

/** Each key whose value differs, as it was and as it became. */
function changedValues(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, RecordValueChange> | undefined {
  const changed: Record<string, RecordValueChange> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const had = Object.hasOwn(before, key)
    const has = Object.hasOwn(after, key)
    if (had && has && isDeepStrictEqual(before[key], after[key])) continue
    changed[key] = {
      ...(had ? keptSide("before", before[key]) : {}),
      ...(has ? keptSide("after", after[key]) : {}),
    }
  }
  return Object.keys(changed).length > 0 ? changed : undefined
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "")
}

/** One side of a change, or only the mark that it was too large to keep. */
function keptSide(side: "before" | "after", value: unknown): RecordValueChange {
  if (jsonBytes(value) > MAX_VALUE_BYTES) {
    return side === "before" ? { beforeTooLarge: true } : { afterTooLarge: true }
  }
  return side === "before" ? { before: value } : { after: value }
}

/** The most a change keeps of an archive's reason, a page's path and a name. */
const MAX_REASON_CHARS = 2048
const MAX_PAGE_CHARS = 4096
const MAX_NAME_CHARS = 512
/** What a mark adds over the key of the value it replaces (12 bytes), with a margin. */
const TOO_LARGE_MARK_BYTES = 16

/**
 * Hold one change to MAX_CHANGE_BYTES. Its largest values go first; when
 * the names of its fields alone are too much, which fields changed goes
 * too. Everything else a change holds is clipped where it is made, so what
 * is left always fits.
 */
function bounded(change: RecordChange): RecordChange {
  let bytes = Buffer.byteLength(line(change))
  if (bytes <= MAX_CHANGE_BYTES) return change
  // Sized once and taken largest first, so a change to very many fields
  // costs one pass, not one pass per value.
  const sides: { values: RecordValueChange; side: "before" | "after"; bytes: number }[] = []
  for (const values of [
    ...Object.values(change.fields ?? {}),
    ...Object.values(change.metadata ?? {}),
  ]) {
    for (const side of ["before", "after"] as const) {
      if (Object.hasOwn(values, side)) {
        sides.push({ values, side, bytes: jsonBytes(values[side]) })
      }
    }
  }
  sides.sort((left, right) => right.bytes - left.bytes)
  for (const { values, side, bytes: size } of sides) {
    if (bytes <= MAX_CHANGE_BYTES) break
    delete values[side]
    if (side === "before") values.beforeTooLarge = true
    else values.afterTooLarge = true
    bytes -= size - TOO_LARGE_MARK_BYTES
  }
  if (Buffer.byteLength(line(change)) > MAX_CHANGE_BYTES) {
    delete change.fields
    delete change.metadata
    change.detailTooLarge = true
  }
  return change
}

/** A change made through an HTML Doc is stamped `widget:<path>`. */
function pageOf(stamp: string | undefined): string | undefined {
  return stamp?.startsWith("widget:") ? stamp.slice("widget:".length) : undefined
}

function parseChanges(text: string): RecordChange[] {
  return text.split("\n").flatMap((line) => {
    if (!line) return []
    try {
      const parsed = RecordChangeSchema.safeParse(JSON.parse(line))
      return parsed.success ? [parsed.data] : []
    } catch {
      return []
    }
  })
}

/** The most a read of one history loads: a full history and one change past it. */
const READ_MAX_BYTES = MAX_HISTORY_BYTES + MAX_CHANGE_BYTES

/**
 * A history's text, or its newest READ_MAX_BYTES when something outside
 * Worktable left it larger, with whether that is all of it; null when there
 * is none, or when the path is a link rather than a file. A cut starts
 * mid-line, and that line is skipped as any unreadable line is.
 */
async function readHistoryText(
  path: string
): Promise<{ text: string; whole: boolean } | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ELOOP") return null
    throw error
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, READ_MAX_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return { text: buffer.toString("utf8"), whole: length === size }
  } finally {
    await handle.close()
  }
}

async function readChanges(path: string): Promise<RecordChange[]> {
  return parseChanges((await readHistoryText(path))?.text ?? "")
}

/**
 * Append to a history, creating its folders. No part of the path may be a
 * link: history is written inside the workspace folder and nowhere else.
 */
async function appendToHistory(path: string, text: string): Promise<void> {
  await ensureRealDocumentStorageDirectory(getWorkspaceRoot(), dirname(path))
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o644
  )
  try {
    await handle.appendFile(text)
  } finally {
    await handle.close()
  }
}

/** The newest changes that fit a Record's history, the newest always among them. */
function withinHistory(changes: readonly RecordChange[]): RecordChange[] {
  let bytes = 0
  let from = changes.length
  while (from > 0) {
    bytes += Buffer.byteLength(line(changes[from - 1]!))
    if (bytes > MAX_HISTORY_BYTES && from < changes.length) break
    from -= 1
  }
  return changes.slice(from)
}

/** One change as it is appended: the line break first (see the header). */
function line(change: RecordChange): string {
  return `\n${JSON.stringify(change)}`
}

function serialize(changes: readonly RecordChange[]): string {
  return changes.map(line).join("")
}

export interface RecordChangeNote {
  kind: RecordChange["kind"]
  /** The Record before the change; null when it was just added. */
  before: RecordFile | null
  after: RecordFile
  /** One id shared by every Record a single call changed. */
  call?: string
  reason?: string
}

/**
 * Keep one change to a Record. Call it once the Record is written, with the
 * request's actor still in scope. Never throws.
 */
export async function noteRecordChange(
  spaceId: string,
  note: RecordChangeNote
): Promise<void> {
  const { before, after } = note
  const path = recordHistoryPath(spaceId, after.collectionId, after.id)
  if (!path) return
  let room: { release(): void } | null = null
  try {
    const stamp = after.updatedBy ?? after.createdBy
    const actor: ActivityActor = actorFromAttribution(stamp)
    const page = pageOf(stamp)
    const fields =
      note.kind === "changed"
        ? changedValues(before?.data ?? {}, after.data)
        : undefined
    const metadata =
      note.kind === "changed"
        ? changedValues(before?.metadata ?? {}, after.metadata)
        : undefined
    const change: RecordChange = bounded({
      id: `rch_${randomBytes(9).toString("base64url")}`,
      at: after.updatedAt,
      by: {
        kind: actor.kind,
        id: actor.id.slice(0, MAX_NAME_CHARS),
        ...(actor.name ? { name: actor.name.slice(0, MAX_NAME_CHARS) } : {}),
      },
      // A path too long to be one names no page.
      ...(page && page.length <= MAX_PAGE_CHARS ? { page } : {}),
      ...(note.call ? { call: note.call } : {}),
      kind: note.kind,
      ...(fields ? { fields } : {}),
      ...(metadata ? { metadata } : {}),
      ...(note.reason ? { reason: note.reason.slice(0, MAX_REASON_CHARS) } : {}),
    })
    const text = line(change)
    if (Buffer.byteLength(text) > MAX_CHANGE_BYTES) return
    // History counts toward the storage limit as history. A change that
    // would pass it is not kept: the Record is written already, and history
    // must never be what fills the disk. This never waits, so locks may be
    // held.
    try {
      room = admitStorageWrite(Buffer.byteLength(text), { files: 0 })
    } catch (error) {
      if (!(error instanceof StorageLimitError)) throw error
      console.warn("[record-history] storage is full; a change was not kept")
      return
    }
    await withHistoryLock(path, async () => {
      await appendToHistory(path, text)
      // A rewrite keeps only what was read whole: it goes ahead when the
      // change just written is the newest it read, and never otherwise.
      const readWhole = (changes: readonly RecordChange[]) =>
        changes.at(-1)?.id === change.id
      // Past its size, a history loses its oldest changes.
      if ((await stat(path)).size > MAX_HISTORY_BYTES) {
        const within = withinHistory(await readChanges(path))
        if (readWhole(within)) await atomicWriteText(path, serialize(within))
      }
      // Keeping the newest few per item prunes as it writes, as Docs do. The
      // read takes time: a policy relaxed meanwhile must not lose changes to
      // the stricter one.
      const generation = getRetentionPolicyGeneration()
      const policy = getServerSettings().history.retention
      if (policy.mode === "count") {
        const kept = await readChanges(path)
        if (
          kept.length > policy.maxPerDoc &&
          readWhole(kept) &&
          getRetentionPolicyGeneration() === generation
        ) {
          await atomicWriteText(path, serialize(kept.slice(-policy.maxPerDoc)))
        }
      }
      noteStorageChange(path)
    })
  } catch (error) {
    console.error("[record-history] could not keep a change:", logError(error))
  } finally {
    room?.release()
  }
}

/** A Record's changes, newest first. */
export async function readRecordHistory(
  spaceId: string,
  collectionId: string,
  recordId: string
): Promise<RecordChange[]> {
  const path = recordHistoryPath(spaceId, collectionId, recordId)
  if (!path) return []
  return (await withHistoryLock(path, () => readChanges(path))).reverse()
}

/** A deleted Record takes its history with it. Never throws. */
export async function forgetRecordHistory(
  spaceId: string,
  collectionId: string,
  recordId: string
): Promise<void> {
  const path = recordHistoryPath(spaceId, collectionId, recordId)
  if (!path) return
  try {
    await withHistoryLock(path, async () => {
      if (!existsSync(path)) return
      await rm(path, { force: true })
      noteStorageChange(path)
    })
  } catch (error) {
    console.error("[record-history] could not remove history:", logError(error))
  }
}

export interface RecordHistoryPruneResult {
  /** Records whose history lost a change. */
  recordsTouched: number
  changesRemoved: number
  bytesFreed: number
}

async function childNames(dir: string, kind: "dir" | "file"): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => (kind === "dir" ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

/**
 * Hold every Record's history to the retention policy. Under an age policy,
 * changes older than the window go; under a count policy, all but the newest
 * few. A Record's newest change always stays while the Record exists; the
 * history of a Record that is gone goes once it is past the window. `all`
 * walks nothing. `stillCurrent` stops the walk when the policy changes.
 */
export async function pruneRecordHistories(
  policy: RetentionPolicy,
  stillCurrent: () => boolean = () => true,
  now: number = Date.now()
): Promise<RecordHistoryPruneResult> {
  const result: RecordHistoryPruneResult = {
    recordsTouched: 0,
    changesRemoved: 0,
    bytesFreed: 0,
  }
  if (policy.mode === "all") return result
  const cutoff = policy.mode === "age" ? now - policy.maxAgeDays * DAY_MS : null
  const versions = getVersionsDir()
  for (const spaceId of await childNames(versions, "dir")) {
    if (!isCanonicalId(spaceId)) continue
    const recordsDir = join(versions, spaceId, "records")
    for (const collectionId of await childNames(recordsDir, "dir")) {
      if (!isCanonicalId(collectionId)) continue
      const dir = join(recordsDir, collectionId)
      for (const name of await childNames(dir, "file")) {
        if (!stillCurrent()) return result
        if (!name.endsWith(".jsonl")) continue
        const recordId = name.slice(0, -".jsonl".length)
        const path = recordHistoryPath(spaceId, collectionId, recordId)
        if (!path) continue
        try {
          await withHistoryLock(path, async () => {
            const read = await readHistoryText(path).catch(() => null)
            // The wait for the lock and the read both take time: a policy
            // relaxed meanwhile must not lose changes to the stricter one.
            // A history is rewritten only from all of it: one too large to
            // read whole is left for its next change to bring within size.
            if (read === null || !read.whole || !stillCurrent()) return
            const { text } = read
            const changes = parseChanges(text)
            const exists = existsSync(
              join(getSpacesDir(), spaceId, "records", collectionId, `${recordId}.yaml`)
            )
            let kept: RecordChange[]
            if (cutoff !== null) {
              kept = changes.filter((change) => Date.parse(change.at) >= cutoff)
              const newest = changes.at(-1)
              if (kept.length === 0 && newest && exists) kept = [newest]
            } else {
              kept = changes.slice(-(policy as { maxPerDoc: number }).maxPerDoc)
              // A count sets no age: what a Record that is gone left behind
              // goes after the window deleted items keep under a count.
              const newest = changes.at(-1)
              if (!exists && newest && Date.parse(newest.at) < now - GONE_RECORD_DAYS * DAY_MS) {
                kept = []
              }
            }
            if (kept.length === changes.length) return
            const next = serialize(kept)
            if (kept.length === 0) await rm(path, { force: true })
            else await atomicWriteText(path, next)
            noteStorageChange(path)
            result.recordsTouched += 1
            result.changesRemoved += changes.length - kept.length
            result.bytesFreed += Buffer.byteLength(text) - Buffer.byteLength(next)
          })
        } catch (error) {
          console.warn(
            "[record-history] could not prune a Record's history:",
            logError(error)
          )
        }
      }
    }
  }
  return result
}
