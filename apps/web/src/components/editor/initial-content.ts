import { normalizeMermaidBlocks } from "@worktable/types"

export function normalizeEditorInitialContent(
  initialContent: unknown[] | undefined
): unknown[] | undefined {
  if (initialContent === undefined) return undefined
  return normalizeMermaidBlocks(initialContent).blocks
}

export function getBlockNoteCreationContent<T>(
  initialContent: T[] | undefined
): T[] | undefined {
  return initialContent?.length ? initialContent : undefined
}
