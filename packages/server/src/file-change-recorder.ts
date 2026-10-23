// ============================================================
// Versions for files changed on disk
// ============================================================
//
// An agent writing straight to a Space's folder changes files without going
// through Worktable. A Space's changes settle briefly together, so a file
// still being written is not kept half-done, then one pass keeps the
// versions of every file they touched. Shutdown and export flush what is
// still settling, and each pass is a server task, so the drains that follow
// wait for it.

import { recordExternalFileChanges } from "./document-write-service.ts"
import { filesPreviewEnabled } from "./files-preview.ts"
import { logError } from "./debug-log.ts"

const SETTLE_MS = 1000
const pending = new Map<
  string,
  { paths: Set<string>; timer: ReturnType<typeof setTimeout>; record: () => void }
>()
let track: (task: Promise<unknown>) => void = () => {}

/** Where recordings go so the server's drains wait for them. */
export function setExternalFileChangeTracker(
  tracker: (task: Promise<unknown>) => void
): void {
  track = tracker
}

/** A file below docs/ changed on disk; keep its version once its Space settles. */
export function noteExternalFileChange(spaceId: string, path: string): void {
  if (!filesPreviewEnabled()) return
  const previous = pending.get(spaceId)
  if (previous) clearTimeout(previous.timer)
  const paths = previous?.paths ?? new Set<string>()
  paths.add(path)
  const record = () => {
    pending.delete(spaceId)
    track(
      recordExternalFileChanges({ spaceId, paths: [...paths] }).catch(
        (error) => {
          console.error(
            "[files] versions for changes on disk failed:",
            logError(error)
          )
        }
      )
    )
  }
  const timer = setTimeout(record, SETTLE_MS)
  timer.unref?.()
  pending.set(spaceId, { paths, timer, record })
}

/** Record every settling change now, as shutdown and export need. */
export function flushExternalFileChanges(): void {
  for (const { timer, record } of [...pending.values()]) {
    clearTimeout(timer)
    record()
  }
}

/** Drop what is still settling, for a start that failed. */
export function discardExternalFileChanges(): void {
  for (const { timer } of pending.values()) clearTimeout(timer)
  pending.clear()
}
