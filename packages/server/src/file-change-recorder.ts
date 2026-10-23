// ============================================================
// Versions for files changed on disk
// ============================================================
//
// An agent writing straight to a Space's folder changes a file without going
// through Worktable. Each change settles briefly, so a file still being
// written is not kept half-done, then its bytes become a version.

import { recordExternalFileChange } from "./document-write-service.ts"
import { filesPreviewEnabled } from "./files-preview.ts"
import { logError } from "./debug-log.ts"

const SETTLE_MS = 1000
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/** A file below docs/ changed on disk; keep its version once it settles. */
export function noteExternalFileChange(spaceId: string, path: string): void {
  if (!filesPreviewEnabled()) return
  const key = `${spaceId}\0${path}`
  const previous = pending.get(key)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    pending.delete(key)
    recordExternalFileChange({ spaceId, path }).catch((error) => {
      console.error("[files] version for a change on disk failed:", logError(error))
    })
  }, SETTLE_MS)
  timer.unref?.()
  pending.set(key, timer)
}
