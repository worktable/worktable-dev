// The names the preview surface gives tools it registers under new names,
// and guidance written for the released names as the preview surface says it.

import type { WorktableToolName } from "./operations.ts"

export const PREVIEW_TOOL_NAMES: Partial<Record<WorktableToolName, string>> = {
  worktable_documents_read: "worktable_files_read",
  worktable_documents_write: "worktable_files_write",
}

/** Guidance as the preview surface names its tools. */
export function withPreviewToolNames(text: string): string {
  let named = text
  for (const [released, preview] of Object.entries(PREVIEW_TOOL_NAMES)) {
    if (preview) named = named.replace(new RegExp(`\\b${released}\\b`, "g"), preview)
  }
  return named
}
