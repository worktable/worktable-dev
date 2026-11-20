// ============================================================
// Parsing files in the background, before anyone asks
// ============================================================
//
// A file a reader parses (PDF) is parsed a moment after it is written,
// through Worktable or on disk, so its contents are there for search and
// for the first agent who reads it. A while after start, every Space is
// looked over once, for files written while the server was stopped and
// readers that read better since.
//
// It works from each Space's catalog snapshot: a file's source stamp says
// whether its bytes changed since it was last looked at, so a Space's other
// changes cost nothing. One file is parsed at a time, in the lane's
// background queue, so what someone waits for goes first, and each Space,
// and the workspace as a whole, has a budget of parsing time an hour, so
// Spaces filled at once can't hold the lane for hours. On a Cloud
// machine it runs only while the machine is awake; what it hasn't reached
// is parsed when someone reads it.

import { sourceStampSize } from "./document-catalog.ts"
import { resolveCurrentFile } from "./document-page-service.ts"
import { readDocumentCatalogSnapshot } from "./document-query.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { CONTENTS_READER_VERSIONS } from "./contents-reader-versions.ts"
import { derivedStore, type DerivedKey } from "./derived-store.ts"
import { contentsReaderFor } from "./file-contents.ts"
import { FILE_VERSION_MAX_BYTES } from "./file-limits.ts"
import { contentHashOf } from "./file-revision.ts"
import { parseVersion } from "./parsed-contents.ts"
import { listSpaces } from "./store.ts"
import { runWithoutTeamIdentity } from "./team-policy.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { workspaceCacheKey } from "./workspace.ts"

/** How long a Space's changes settle before its files are looked over. */
const SETTLE_MS = 5_000
/**
 * Background parsing one Space may take an hour, as time spent parsing:
 * a Space filled with files at once is parsed over hours, a slice an hour,
 * and never holds the lane past it. Its files are still parsed when read.
 */
export const SPACE_PARSE_BUDGET_MS = 10 * 60_000
/** And all Spaces together, so making more Spaces doesn't make more time. */
export const WORKSPACE_PARSE_BUDGET_MS = 20 * 60_000
const BUDGET_WINDOW_MS = 60 * 60_000

/** Time each Space's background parsing took in its current hour. */
const spent = new Map<string, { since: number; ms: number }>()

/** A Space of the served workspace, as these maps know it. */
function spaceKey(spaceId: string): string {
  return `${workspaceCacheKey()}\0${spaceId}`
}

/** When one budget, by its key, has room again, or now. */
function resumesAt(key: string, budgetMs: number, now: number): number {
  const used = spent.get(key)
  if (!used || now - used.since >= BUDGET_WINDOW_MS) return now
  return used.ms < budgetMs ? now : used.since + BUDGET_WINDOW_MS
}

/** When a Space may parse in the background again, or now: its own budget and the workspace's. */
function budgetResumesAt(spaceId: string, budgetMs: number, now = Date.now()): number {
  return Math.max(
    resumesAt(spaceKey(spaceId), budgetMs, now),
    resumesAt(workspaceCacheKey(), WORKSPACE_PARSE_BUDGET_MS, now)
  )
}

function spendOn(key: string, ms: number, now: number): void {
  const used = spent.get(key)
  if (!used || now - used.since >= BUDGET_WINDOW_MS) spent.set(key, { since: now, ms })
  else used.ms += ms
}

function spend(spaceId: string, ms: number, now = Date.now()): void {
  spendOn(spaceKey(spaceId), ms, now)
  spendOn(workspaceCacheKey(), ms, now)
}

/** Counts `ms` of background parsing against the served workspace's hour, for tests. */
export function spendWorkspaceBudgetForTests(ms: number): void {
  spendOn(workspaceCacheKey(), ms, Date.now())
}
/** When every Space is looked over after start. */
const FIRST_PASS_MS = 60_000

/**
 * The source stamp each file was last looked at with, by Space and file.
 * It lasts as long as the background it serves: each start, and a
 * workspace reset, which takes the derived store with it, begin it afresh.
 */
const lookedAt = new Map<string, string>()

/**
 * Parses the files of a Space whose bytes changed since they were last
 * looked at and have no contents kept; returns how many it parsed.
 */
export async function parseChangedFiles(
  spaceId: string,
  options: {
    signal?: AbortSignal
    budgetMs?: number
    /** Told when the Space's budget runs out, with when it resumes. */
    deferred?: (resumesAt: number) => void
  } = {}
): Promise<number> {
  const { signal, budgetMs = SPACE_PARSE_BUDGET_MS } = options
  const stopped = () => signal?.aborted === true
  return runWithoutTeamIdentity(async () => {
    const catalog = await readDocumentCatalogSnapshot(spaceId)
    let parsed = 0
    for (const entry of catalog.entries) {
      if (stopped()) break
      if (entry.kind !== "document") continue
      if (entry.descriptor.format.id !== BUILTIN_DOCUMENT_FORMATS.file) continue
      const reader = contentsReaderFor(entry.descriptor.path)
      if (reader === null || reader === "text") continue
      const stamp = entry.handle.sourceStamp ?? ""
      const seen = `${spaceKey(spaceId)}\0${entry.handle.documentId}`
      if (lookedAt.get(seen) === stamp) continue
      if ((sourceStampSize(stamp) ?? 0) > FILE_VERSION_MAX_BYTES) {
        lookedAt.set(seen, stamp)
        continue
      }
      // A file that can't be resolved or read now, gone or mid-change, is
      // looked at again next time; the Space's other files go on.
      let key: DerivedKey
      let resolved: Awaited<ReturnType<typeof resolveCurrentFile>>
      try {
        resolved = await resolveCurrentFile({ spaceId, path: entry.descriptor.path })
        if (resolved.kind !== "file") continue
        key = {
          spaceId,
          documentId: resolved.current.documentId,
          version: await contentHashOf(resolved.current.pinned),
          kind: "contents",
          variant: "",
          maker: reader,
          makerVersion: CONTENTS_READER_VERSIONS[reader],
        }
      } catch {
        continue
      }
      if (!derivedStore().getContents(key)) {
        const resumesAt = budgetResumesAt(spaceId, budgetMs)
        if (resumesAt > Date.now()) {
          options.deferred?.(resumesAt)
          break
        }
        const started = performance.now()
        const result = await parseVersion(key, resolved.current.pinned, "background", {
          ...(signal ? { signal } : {}),
        })
        spend(spaceId, performance.now() - started)
        // A busy lane, a file mid-change or a stop is looked at again next time.
        if (result.kind === "failed" && ["busy", "source", "cancelled"].includes(result.why)) continue
        parsed += 1
      }
      lookedAt.set(seen, stamp)
    }
    return parsed
  })
}

/**
 * Parses files as their Spaces change, and every Space a while after start.
 * Returns how to stop: the file being parsed is cancelled, its worker
 * killed and nothing kept, no file is started after it, and the promise
 * settles once the pass has ended, so a server's shutdown never leaves a
 * parse writing after it.
 */
export function startContentsBackground(): () => Promise<void> {
  const stopping = new AbortController()
  const due = new Map<string, ReturnType<typeof setTimeout>>()
  // One Space at a time, so a burst of changes never queues work twice.
  let chain: Promise<unknown> = Promise.resolve()
  const run = (spaceId: string) => {
    chain = chain
      .then(() =>
        stopping.signal.aborted
          ? 0
          : parseChangedFiles(spaceId, {
              signal: stopping.signal,
              // Picks the Space up again once its hour's budget is back.
              deferred: (resumesAt) => schedule(spaceId, resumesAt - Date.now()),
            })
      )
      .catch(() => {
        // Looked over again at the Space's next change.
      })
  }
  const schedule = (spaceId: string, delay = SETTLE_MS) => {
    clearTimeout(due.get(spaceId))
    const timer = setTimeout(() => {
      due.delete(spaceId)
      run(spaceId)
    }, Math.max(delay, SETTLE_MS))
    timer.unref?.()
    due.set(spaceId, timer)
  }
  lookedAt.clear()
  const stopListening = onWorkspaceChange((event) => {
    if (event.type === "workspaceReset") {
      lookedAt.clear()
      return
    }
    if ((event.type === "documentCorpus" || event.type === "space") && event.spaceId) {
      schedule(event.spaceId)
    }
  })
  const first = setTimeout(() => {
    void listSpaces()
      .then((spaces) => {
        for (const space of spaces) run(space.id)
      })
      .catch(() => {})
  }, FIRST_PASS_MS)
  first.unref?.()
  return async () => {
    stopping.abort()
    stopListening()
    clearTimeout(first)
    for (const timer of due.values()) clearTimeout(timer)
    due.clear()
    await chain
  }
}
