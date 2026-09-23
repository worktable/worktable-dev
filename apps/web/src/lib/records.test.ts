import { describe, expect, it } from "bun:test"
import type { RecordCollectionSchema, RecordFile } from "@worktable/types"
import { canApplyFilterValue, documentPathIsSelected, normalizeDocumentPickerSearch, toggleDocumentPath, collectRecordQueryWarnings, coerceFieldInput, fieldLabel, filterOpsForType, indexDanglingRelations, recordDetailSections, recordFieldColumns, resolveDocumentGroupValue } from "./records"

const schema = {
  version: 2,
  kind: "worktable.recordSchema",
  id: "research",
  name: "Research",
  fields: {
    summary: { type: "text" },
    title: { type: "string", required: true },
    source: { type: "document" },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: "test",
  metadata: {},
} satisfies RecordCollectionSchema

const record = {
  version: 1,
  kind: "worktable.record",
  id: "one",
  collectionId: "research",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdBy: "test",
  metadata: {},
  data: { title: "One", source: "notes/one", externalNote: "preserved" },
} satisfies RecordFile

describe("record document fields and portable column order", () => {
  it("keeps authored schema order and appends recoverable unmodeled data", () => {
    expect(recordFieldColumns(schema, [record]).map((column) => column.key)).toEqual([
      "summary",
      "title",
      "source",
      "externalNote",
    ])
  })

  it("normalizes friendly scalar and many document input", () => {
    expect(coerceFieldInput({ type: "document", field: { type: "document" } }, "/Notes/Caf%C3%A9.md")).toEqual({ value: "Notes/Café" })
    expect(coerceFieldInput({ type: "document", field: { type: "document", many: true } }, ["/one.md", "two.json"])).toEqual({ value: ["one", "two"] })
  })

  it("clears scalar document input without trying to parse it", () => {
    expect(coerceFieldInput({ type: "document", field: { type: "document" } }, null)).toEqual({ value: null })
    expect(coerceFieldInput({ type: "document", field: { type: "document" } }, "  ")).toEqual({ value: null })
  })

  it("uses exact identity operators, including membership for many fields", () => {
    expect(filterOpsForType("document", { type: "document" })).toEqual(["eq", "neq", "isEmpty"])
    expect(filterOpsForType("document", { type: "document", many: true })).toEqual(["has", "isEmpty"])
  })

  it("builds a readable detail hierarchy without changing schema order", () => {
    const detailedSchema = {
      ...schema,
      fields: {
        title: { type: "string", required: true },
        summary: { type: "text" },
        status: { type: "select", values: ["open"] },
        owner: { type: "person" },
        score: { type: "number" },
        source: { type: "document" },
      },
    } satisfies RecordCollectionSchema
    const sections = recordDetailSections(detailedSchema, record, 2)

    expect(sections.title?.key).toBe("title")
    expect(sections.narrative.map((column) => column.key)).toEqual(["summary"])
    expect(sections.primary.map((column) => column.key)).toEqual(["status", "owner"])
    expect(sections.secondary.map((column) => column.key)).toEqual(["score"])
    expect(sections.sources.map((column) => column.key)).toEqual(["source"])
    expect(sections.unmodeled.map((column) => column.key)).toEqual(["externalNote"])
  })

  it("turns file-friendly camelCase and slug keys into readable labels", () => {
    expect(fieldLabel("relatedDocs")).toBe("Related Docs")
    expect(fieldLabel("source_documents")).toBe("Source Documents")
  })

  it("indexes dangling relation targets per record field", () => {
    const indexed = indexDanglingRelations([
      { recordId: "one", field: "related", target: "tasks/missing-a" },
      { recordId: "one", field: "related", target: "tasks/missing-b" },
      { recordId: "two", field: "owner", target: "people/missing" },
    ])

    expect([...indexed.get("one:related") ?? []]).toEqual(["tasks/missing-a", "tasks/missing-b"])
    expect([...indexed.get("two:owner") ?? []]).toEqual(["people/missing"])
  })

  it("uses resolved document identities for scalar and many-value group buckets", () => {
    const identities = new Map([["notes/old", "notes/current"]])
    expect(resolveDocumentGroupValue("notes/old", identities)).toBe("notes/current")
    expect(resolveDocumentGroupValue(["notes/other", "notes/old"], identities)).toEqual(["notes/other", "notes/current"])
  })
})

describe("collectRecordQueryWarnings", () => {
  it("merges and deduplicates warnings from record pages and grouped queries", () => {
    expect(collectRecordQueryWarnings([
      { warnings: ["projects projection is drifted"] },
      undefined,
      { warnings: ["projects projection is drifted", "owners projection is drifted"] },
    ])).toEqual([
      "projects projection is drifted",
      "owners projection is drifted",
    ])
  })
})

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
