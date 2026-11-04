// ============================================================
// What Worktable keeps of a large file
// ============================================================
//
// A file's history holds whole versions, each at most one version entry.
// A larger file still lists, opens, downloads and streams; Worktable only
// keeps no versions of it while it stays that large, and says so. Whether a
// file is over the limit is decided by its size on disk, never by reading it.

import { DOCUMENT_GENERATION_MAX_ENTRY_BYTES, type FileNoHistory } from "@worktable/types"

/** The largest file one version holds. */
export const FILE_VERSION_MAX_BYTES = DOCUMENT_GENERATION_MAX_ENTRY_BYTES

/** What people and agents are told about a file over the limit. */
export const FILE_NO_HISTORY_MESSAGE = "No history while this file is larger than 64 MiB."

/** Why a file of this size keeps no versions, or undefined when it does. */
export function fileNoHistory(byteLength: number | undefined): FileNoHistory | undefined {
  return byteLength !== undefined && byteLength > FILE_VERSION_MAX_BYTES
    ? { reason: "too-large", maxBytes: FILE_VERSION_MAX_BYTES }
    : undefined
}
