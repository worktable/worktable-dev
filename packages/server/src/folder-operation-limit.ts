// A folder moves, archives, restores or deletes as one operation, journaled
// so it finishes or rolls back whole. The journal holds at most this many
// Docs and files, the folder's own Doc included.

export const FOLDER_OPERATION_MAX_ENTRIES = 128

/** Why a folder operation over the limit was refused, and what to do instead. */
export function folderTooLargeMessage(
  action: "move" | "archive" | "restore" | "delete",
  count: number
): string {
  return `${count} Docs and files are inside. Worktable can ${action} up to ${FOLDER_OPERATION_MAX_ENTRIES} at a time, so ${action} some of them first.`
}
