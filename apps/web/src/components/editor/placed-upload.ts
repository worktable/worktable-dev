// A file pasted or dropped into a Doc gets its block before its upload
// starts: BlockNote adds one, or turns the empty block under the caret into
// it, keeping whatever is nested there. When the upload fails, BlockNote
// leaves that block loading for good. These take it back out.

/** What this needs of the editor. */
export interface PlacedBlockEditor {
  getBlock(id: string): { props?: unknown; children?: unknown[] } | undefined
  removeBlocks(ids: string[]): unknown
  updateBlock(id: string, update: { type: "paragraph"; props: object }): unknown
}

/**
 * Whether the block is still the one a paste or drop placed for this file:
 * named after it, with nothing to show yet.
 */
export function placedFor(
  editor: PlacedBlockEditor | null,
  file: File,
  blockId: string | undefined
): boolean {
  if (!editor || !blockId) return false
  const props = editor.getBlock(blockId)?.props as
    | { name?: unknown; url?: unknown }
    | undefined
  return props?.name === file.name && !props.url
}

/**
 * Take out a placed block whose upload failed. One that has since been given
 * a file is left alone, and one with blocks nested in it goes back to an
 * empty line, so they stay.
 */
export function removePlaced(
  editor: PlacedBlockEditor | null,
  file: File,
  blockId: string
): void {
  if (!editor || !placedFor(editor, file, blockId)) return
  if (editor.getBlock(blockId)?.children?.length) {
    editor.updateBlock(blockId, { type: "paragraph", props: {} })
  } else {
    editor.removeBlocks([blockId])
  }
}
