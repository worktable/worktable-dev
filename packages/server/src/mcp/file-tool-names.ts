// Preferred file tool names. Both names remain advertised for compatibility.

import type { WorktableToolName } from "./operations.ts"

export const FILE_TOOL_NAMES: Partial<Record<WorktableToolName, string>> = {
  worktable_documents_read: "worktable_files_read",
  worktable_documents_write: "worktable_files_write",
}

/** Guidance uses the preferred names while old calls stay compatible. */
export function withFileToolNames(text: string): string {
  let named = text
  for (const [released, preview] of Object.entries(FILE_TOOL_NAMES)) {
    if (preview)
      named = named.replace(new RegExp(`\\b${released}\\b`, "g"), preview)
  }
  return named
}
