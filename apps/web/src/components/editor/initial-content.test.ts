import { describe, expect, it } from "bun:test"
import {
  getBlockNoteCreationContent,
  normalizeEditorInitialContent,
} from "./initial-content"

describe("editor initial content normalization", () => {
  it("preserves undefined when no external snapshot was supplied", () => {
    expect(normalizeEditorInitialContent(undefined)).toBeUndefined()
  })

  it("preserves an empty snapshot so a reused editor can be cleared", () => {
    expect(normalizeEditorInitialContent([])).toEqual([])
  })

  it("does not pass an empty snapshot to BlockNote during editor creation", () => {
    expect(getBlockNoteCreationContent([])).toBeUndefined()
  })

  it("passes non-empty snapshots to BlockNote during editor creation", () => {
    const content = [{ type: "paragraph" }]
    expect(getBlockNoteCreationContent(content)).toBe(content)
  })
})
