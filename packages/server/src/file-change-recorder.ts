// ============================================================
// Versions for files changed on disk
// ============================================================
//
// An agent writing straight to a Space's folder changes a file without going
// through Worktable. Each change settles briefly, so a file still being
// written is not kept half-done, then its bytes become a version. Shutdown
// and export flush what is still settling, and each recording is a server
// task, so the drains that follow wait for it.

import { recordExternalFileChange } from "./document-write-service.ts"
import { filesPreviewEnabled } from "./files-preview.ts"
import { logError } from "./debug-log.ts"

const SETTLE_MS = 1000
const pending = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; record: () => void }
>()
let track: (task: Promise<unknown>) => void = () => {}

/** Where recordings go so the server's drains wait for them. */
export function setExternalFileChangeTracker(
  tracker: (task: Promise<unknown>) => void
): void {
  track = tracker
}

/** A file below docs/ changed on disk; keep its version once it settles. */
export function noteExternalFileChange(spaceId: string, path: string): void {
  if (!filesPreviewEnabled()) return
  const key = `${spaceId}\0${path}`
  const previous = pending.get(key)
  if (previous) clearTimeout(previous.timer)
  const record = () => {
    pending.delete(key)
    track(
      recordExternalFileChange({ spaceId, path }).catch((error) => {
        console.error(
          "[files] version for a change on disk failed:",
          logError(error)
        )
      })
    )
  }
  const timer = setTimeout(record, SETTLE_MS)
  timer.unref?.()
  pending.set(key, { timer, record })
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
