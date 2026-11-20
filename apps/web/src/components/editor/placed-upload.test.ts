import { expect, it } from "bun:test"
import { BlockNoteEditor } from "@blocknote/core"
import { placedFor, removePlaced } from "./placed-upload.ts"

const file = new File(["x"], "shot.png", { type: "image/png" })

/** A Doc where a paste has just placed `shot.png`'s block, as BlockNote does. */
function pasted(into: "a new block" | "an empty block with nested blocks") {
  const editor = BlockNoteEditor.create({
    initialContent: [
      { id: "above", type: "paragraph", content: "above" },
      {
        id: "empty",
        type: "bulletListItem",
        content: [],
        children: [{ id: "nested", type: "paragraph", content: "nested" }],
      },
    ],
  })
  const placed = { type: "image", props: { name: file.name } } as never
  const id =
    into === "a new block"
      ? editor.insertBlocks([placed], "above", "after")[0]!.id
      : editor.updateBlock("empty", placed).id
  return { editor, id }
}

it("takes a failed paste's block out, keeps what is nested in it, and leaves a block that got a file", () => {
  const added = pasted("a new block")
  expect(placedFor(added.editor, file, added.id)).toBe(true)
  removePlaced(added.editor, file, added.id)
  expect(added.editor.getBlock(added.id)).toBeUndefined()
  expect(added.editor.document.map((block) => block.id)).toEqual(["above", "empty"])

  // A paste into an empty block reuses it, with the blocks nested in it.
  const reused = pasted("an empty block with nested blocks")
  removePlaced(reused.editor, file, reused.id)
  const back = reused.editor.getBlock("empty")
  expect(back?.type).toBe("paragraph")
  expect(back?.children.map((block) => block.id)).toEqual(["nested"])

  // Someone gave the block a file while the upload ran.
  const filled = pasted("a new block")
  filled.editor.updateBlock(filled.id, { props: { url: "other.png" } } as never)
  removePlaced(filled.editor, file, filled.id)
  expect(filled.editor.getBlock(filled.id)).toBeDefined()

  // A block the file panel uploads into was not placed by a paste.
  const panel = pasted("a new block")
  panel.editor.updateBlock(panel.id, { props: { name: "" } } as never)
  expect(placedFor(panel.editor, file, panel.id)).toBe(false)
})
