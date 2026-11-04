// ============================================================
// What pruning at the storage limit removed
// ============================================================
//
// When a Worktable reaches its storage limit, its oldest history goes first
// (storage-pruning.ts). What went is recorded here so people can see it: the
// totals and when it last happened, shown in Settings > Data > Storage, and
// per item, so its version history says older versions were removed.
//
// One small JSON file per workspace in app data (never in the workspace
// folder, so exports and backups don't carry it). It is read once when the
// server starts and kept in memory; requests read it from memory.

import { mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ensureAppDir, getAppDir } from "./app-storage.ts"
import { atomicWriteText } from "./atomic-file.ts"
import { logError } from "./debug-log.ts"
import { workspaceCacheKey } from "./workspace.ts"

/** Items whose pruning is remembered; the oldest are forgotten past this. */
const MAX_ITEMS = 2_000

export interface PrunedItem {
  versions: number
  at: string
}

export interface PrunedSummary {
  versions: number
  /** Deleted items emptied from the trash before their window ran out. */
  deletedItems: number
  bytes: number
  at: string
}

interface PrunedRecord {
  version: 1
  versions: number
  deletedItems: number
  bytes: number
  at: string | null
  /** By `<space id>/<document id>`, or `<space id>/path:<key>` for legacy history. */
  items: Record<string, PrunedItem>
}

function emptyRecord(): PrunedRecord {
  return { version: 1, versions: 0, deletedItems: 0, bytes: 0, at: null, items: {} }
}

let record: PrunedRecord = emptyRecord()
let recordKey: string | null = null
const spacesWithItems = new Set<string>()

function recordPath(appDir = getAppDir(), key = workspaceCacheKey()): string {
  return join(appDir, "storage-pruned", `${key}.json`)
}

function index(): void {
  spacesWithItems.clear()
  for (const key of Object.keys(record.items)) {
    spacesWithItems.add(key.slice(0, key.indexOf("/")))
  }
}

/** Read the served workspace's record into memory. Once, at start. */
export async function loadPrunedRecord(): Promise<void> {
  const key = workspaceCacheKey()
  try {
    const parsed = JSON.parse(await readFile(recordPath(), "utf8")) as PrunedRecord
    record =
      parsed?.version === 1 && parsed.items && typeof parsed.items === "object"
        ? parsed
        : emptyRecord()
  } catch {
    record = emptyRecord()
  }
  recordKey = key
  index()
}

/** Add one pruning run to the record and save it. Never throws. */
export async function recordPruning(run: {
  versions: number
  deletedItems: number
  bytes: number
  items: Map<string, number>
}): Promise<void> {
  if (run.versions === 0 && run.deletedItems === 0) return
  if (recordKey !== workspaceCacheKey()) await loadPrunedRecord()
  const at = new Date().toISOString()
  record.versions += run.versions
  record.deletedItems += run.deletedItems
  record.bytes += run.bytes
  record.at = at
  for (const [key, versions] of run.items) {
    const previous = record.items[key]
    delete record.items[key]
    // Re-inserted, so the object's order stays oldest first.
    record.items[key] = { versions: (previous?.versions ?? 0) + versions, at }
  }
  const keys = Object.keys(record.items)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ITEMS))) {
    delete record.items[key]
  }
  index()
  try {
    const path = recordPath(ensureAppDir())
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await atomicWriteText(path, `${JSON.stringify(record)}\n`)
  } catch (error) {
    console.error("[storage-limit] could not save what was pruned:", logError(error))
  }
}

/** Totals for Settings, from memory; null when nothing was ever pruned. */
export function prunedSummary(): PrunedSummary | null {
  if (!record.at || recordKey !== workspaceCacheKey()) return null
  return {
    versions: record.versions,
    deletedItems: record.deletedItems,
    bytes: record.bytes,
    at: record.at,
  }
}

/** Whether any item in this Space lost history to pruning. No I/O. */
export function spaceHasPrunedHistory(spaceId: string): boolean {
  return recordKey === workspaceCacheKey() && spacesWithItems.has(spaceId)
}

/** What pruning removed from one item's history, from memory. */
export function prunedHistoryFor(
  spaceId: string,
  owner: { documentId?: string; legacyKey?: string }
): PrunedItem | null {
  if (!spaceHasPrunedHistory(spaceId)) return null
  const byId = owner.documentId ? record.items[`${spaceId}/${owner.documentId}`] : undefined
  const byPath = owner.legacyKey ? record.items[`${spaceId}/path:${owner.legacyKey}`] : undefined
  if (!byId && !byPath) return null
  return {
    versions: (byId?.versions ?? 0) + (byPath?.versions ?? 0),
    at: [byId?.at, byPath?.at].filter(Boolean).sort().at(-1)!,
  }
}

export function resetPrunedRecordForTests(): void {
  record = emptyRecord()
  recordKey = null
  spacesWithItems.clear()
}
