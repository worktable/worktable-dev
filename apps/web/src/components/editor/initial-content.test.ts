import { describe, expect, it } from "bun:test"
import {
  getBlockNoteCreationContent,
  normalizeEditorInitialContent,
} from "./initial-content"

describe("editor initial content normalization", () => {
  it("distinguishes absent, clearing and populated snapshots when creating or reusing an editor", () => {
    const populated = [{ type: "paragraph" }]
    for (const [input, creation] of [[undefined, undefined], [[], undefined], [populated, populated]] as const) {
      expect(normalizeEditorInitialContent(input)).toEqual(input)
      expect(getBlockNoteCreationContent(input)).toEqual(creation)
    }
  })
})
