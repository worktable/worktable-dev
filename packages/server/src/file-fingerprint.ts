import { stat } from "node:fs/promises"

/**
 * A file changed within this window of being observed may change again
 * without a new modification time on coarse-timestamp filesystems (the same
 * "racy" rule git applies). Derived data must not trust such a fingerprint.
 */
export const RACY_FINGERPRINT_WINDOW_MS = 2_000

export interface FileFingerprint {
  /** Device, inode, size and nanosecond change and modification times. */
  key: string
  /** Modified too recently for an equal key to prove equal content. */
  racy: boolean
}

/**
 * Identify a file's current content without reading it. Symbolic links are
 * followed, like the readers this guards; a replaced link target changes the
 * inode. Returns null when the file does not exist.
 */
export async function readFileFingerprint(
  path: string,
  observedAt = Date.now()
): Promise<FileFingerprint | null> {
  let info
  try {
    info = await stat(path, { bigint: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  }
  const modifiedAt = Number(info.mtimeNs / 1_000_000n)
  return {
    key: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
    racy: observedAt - modifiedAt < RACY_FINGERPRINT_WINDOW_MS,
  }
}
