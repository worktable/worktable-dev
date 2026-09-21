import { describe, expect, it } from "bun:test"
import { canApplyFilterValue, documentPathIsSelected, normalizeDocumentPickerSearch, toggleDocumentPath } from "@/lib/records"

describe("document picker identity", () => {
  const identities = new Map([["notes/before-rename", "notes/current"]])

  it("treats an old stored alias as the current document selection", () => {
    expect(documentPathIsSelected(["notes/before-rename"], "notes/current", identities)).toBe(true)
    expect(toggleDocumentPath(["notes/before-rename"], "notes/current", identities)).toEqual([])
  })

  it("normalizes friendly existing paths before filtering candidates", () => {
    expect(normalizeDocumentPickerSearch("/Specs/Caf%C3%A9.md")).toEqual({
      fallbackPath: "Specs/Café",
      normalizedSearch: "specs/café",
    })
  })
})

describe("document filter values", () => {
  it("does not apply a cleared value to an operator that requires one", () => {
    expect(canApplyFilterValue(true, null)).toBe(false)
    expect(canApplyFilterValue(true, undefined)).toBe(false)
    expect(canApplyFilterValue(true, "notes/current")).toBe(true)
    expect(canApplyFilterValue(false, null)).toBe(true)
  })
})
