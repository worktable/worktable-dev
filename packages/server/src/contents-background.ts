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
// background queue, so what someone waits for goes first. On a Cloud
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

/** How long a Space's changes settle before its files are looked over. */
const SETTLE_MS = 5_000
/** When every Space is looked over after start. */
const FIRST_PASS_MS = 60_000

/** The source stamp each file was last looked at with, by Space and file. */
const lookedAt = new Map<string, string>()

/**
 * Parses the files of a Space whose bytes changed since they were last
 * looked at and have no contents kept; returns how many it parsed.
 */
export async function parseChangedFiles(spaceId: string): Promise<number> {
  return runWithoutTeamIdentity(async () => {
    const catalog = await readDocumentCatalogSnapshot(spaceId)
    let parsed = 0
    for (const entry of catalog.entries) {
      if (entry.kind !== "document") continue
      if (entry.descriptor.format.id !== BUILTIN_DOCUMENT_FORMATS.file) continue
      const reader = contentsReaderFor(entry.descriptor.path)
      if (reader === null || reader === "text") continue
      const stamp = entry.handle.sourceStamp ?? ""
      const seen = `${spaceId}\0${entry.handle.documentId}`
      if (lookedAt.get(seen) === stamp) continue
      if ((sourceStampSize(stamp) ?? 0) > FILE_VERSION_MAX_BYTES) {
        lookedAt.set(seen, stamp)
        continue
      }
      const resolved = await resolveCurrentFile({ spaceId, path: entry.descriptor.path })
      if (resolved.kind !== "file") continue
      const key: DerivedKey = {
        spaceId,
        documentId: resolved.current.documentId,
        version: await contentHashOf(resolved.current.pinned),
        kind: "contents",
        variant: "",
        maker: reader,
        makerVersion: CONTENTS_READER_VERSIONS[reader],
      }
      if (!derivedStore().getContents(key)) {
        const result = await parseVersion(key, resolved.current.pinned, "background")
        // A busy lane or a file mid-change is looked at again next time.
        if (result.kind === "failed" && (result.why === "busy" || result.why === "source")) continue
        parsed += 1
      }
      lookedAt.set(seen, stamp)
    }
    return parsed
  })
}

/** Parses files as their Spaces change, and every Space a while after start. */
export function startContentsBackground(): () => void {
  let stopped = false
  const due = new Map<string, ReturnType<typeof setTimeout>>()
  // One Space at a time, so a burst of changes never queues work twice.
  let chain: Promise<unknown> = Promise.resolve()
  const run = (spaceId: string) => {
    chain = chain
      .then(() => (stopped ? 0 : parseChangedFiles(spaceId)))
      .catch(() => {
        // Looked over again at the Space's next change.
      })
  }
  const schedule = (spaceId: string) => {
    clearTimeout(due.get(spaceId))
    const timer = setTimeout(() => {
      due.delete(spaceId)
      run(spaceId)
    }, SETTLE_MS)
    timer.unref?.()
    due.set(spaceId, timer)
  }
  const stopListening = onWorkspaceChange((event) => {
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
  return () => {
    stopped = true
    stopListening()
    clearTimeout(first)
    for (const timer of due.values()) clearTimeout(timer)
    due.clear()
  }
}
