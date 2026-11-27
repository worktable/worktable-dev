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
// undoes that write. A line cut short by a crash is skipped when read.
//
// History is kept as long as Doc versions are (settings-store.ts retention):
// `pruneRecordHistories` runs with the retention sweep. The newest change of
// a Record always stays, so a Record can always say who last changed it and
// what that replaced.
//
// This module imports neither record-store.ts nor store.ts: the store calls
// it, and version-retention.ts, which the store imports, calls it too.

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises"
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
import { getServerSettings, type RetentionPolicy } from "./settings-store.ts"
import { noteStorageChange } from "./storage-usage.ts"
import { getSpacesDir, getVersionsDir } from "./workspace.ts"

const DAY_MS = 24 * 60 * 60 * 1000
/** Under a count policy, how long the history of a Record that is gone stays. */
const GONE_RECORD_DAYS = 30

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
      ...(had ? { before: before[key] } : {}),
      ...(has ? { after: after[key] } : {}),
    }
  }
  return Object.keys(changed).length > 0 ? changed : undefined
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

async function readChanges(path: string): Promise<RecordChange[]> {
  try {
    return parseChanges(await readFile(path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

function serialize(changes: readonly RecordChange[]): string {
  return changes.map((change) => `${JSON.stringify(change)}\n`).join("")
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
  const stamp = after.updatedBy ?? after.createdBy
  const by: ActivityActor = actorFromAttribution(stamp)
  const page = pageOf(stamp)
  const fields =
    note.kind === "changed"
      ? changedValues(before?.data ?? {}, after.data)
      : undefined
  const metadata =
    note.kind === "changed"
      ? changedValues(before?.metadata ?? {}, after.metadata)
      : undefined
  const change: RecordChange = {
    id: `rch_${randomBytes(9).toString("base64url")}`,
    at: after.updatedAt,
    by,
    ...(page ? { page } : {}),
    ...(note.call ? { call: note.call } : {}),
    kind: note.kind,
    ...(fields ? { fields } : {}),
    ...(metadata ? { metadata } : {}),
    ...(note.reason ? { reason: note.reason } : {}),
  }
  try {
    await withHistoryLock(path, async () => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${JSON.stringify(change)}\n`)
      // Keeping the newest few per item prunes as it writes, as Docs do.
      const policy = getServerSettings().history.retention
      if (policy.mode === "count") {
        const kept = await readChanges(path)
        if (kept.length > policy.maxPerDoc) {
          await atomicWriteText(path, serialize(kept.slice(-policy.maxPerDoc)))
        }
      }
      noteStorageChange(path)
    })
  } catch (error) {
    console.error("[record-history] could not keep a change:", logError(error))
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
            const text = await readFile(path, "utf8").catch(() => null)
            if (text === null) return
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
