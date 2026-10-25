// A folder moves, archives, restores or deletes as one operation, journaled
// so it finishes or rolls back whole. The journal holds at most this many
// Docs and files, the folder's own Doc included.

export const FOLDER_OPERATION_MAX_ENTRIES = 128

// What gets under the limit. Archived entries still count, so archiving or
// restoring part of a folder doesn't; doing it a subfolder at a time does.
const NEXT_STEP = {
  move: "move some of them out first",
  delete: "delete some of them first",
  archive: "archive it a subfolder at a time, or move some of them out first",
  restore: "restore it a subfolder at a time",
} as const

/** Why a folder operation over the limit was refused, and what to do instead. */
export function folderTooLargeMessage(
  action: keyof typeof NEXT_STEP,
  count: number
): string {
  return `${count} Docs and files are inside. Worktable can ${action} up to ${FOLDER_OPERATION_MAX_ENTRIES} at a time, so ${NEXT_STEP[action]}.`
}
