import { describe, expect, it } from "bun:test"
import { LinkGrantSchema } from "./link-grants"
import { RecordPredicateSchema, type RecordPredicate } from "./records"

const rows: RecordPredicate = {
  and: [
    { field: "client", op: "eq", value: "acme" },
    { not: { field: "stage", op: "in", value: ["lost"] } },
  ],
}

describe("LinkGrantSchema", () => {
  it("stores a canonical predicate tree and fills every default", () => {
    expect(
      LinkGrantSchema.parse({
        version: 1,
        collections: { deals: { rows, fields: ["name", "amount"] } },
      })
    ).toEqual({
      version: 1,
      collections: {
        deals: {
          rows,
          fields: ["name", "amount"],
          timestamps: true,
        },
      },
      limits: { rowsPerQuery: 200, queriesPerMinute: 120, rowsPerHour: 10_000 },
      state: "visitor",
    })
  })

  it.each([
    ["a flat filter map", { rows: { client: "acme" }, fields: [] }],
    [
      "a flat filter inside a tree",
      { rows: { and: [{ client: "acme" }] }, fields: [] },
    ],
    [
      "a leaf with an extra key",
      {
        rows: { field: "client", op: "eq", value: "acme", or: [] },
        fields: [],
      },
    ],
    [
      "a value the operator can't take",
      { rows: { field: "stage", op: "in", value: "won" }, fields: [] },
    ],
    ["an unknown collection key", { fields: [], share: true }],
    ["a totals mode", { fields: [], mode: "summaries" }],
    ["a saved reads mode", { fields: [], mode: "fixed" }],
    [
      "a delete permission",
      { fields: [], writes: { create: true, delete: true } },
    ],
  ])("rejects %s", (_name, collection) => {
    expect(
      LinkGrantSchema.safeParse({
        version: 1,
        collections: { deals: collection },
      }).success
    ).toBe(false)
  })

  it("rejects unknown keys and a wildcard collection", () => {
    expect(
      LinkGrantSchema.safeParse({ version: 1, network: true }).success
    ).toBe(false)
    expect(
      LinkGrantSchema.safeParse({
        version: 1,
        collections: { "*": { fields: [] } },
      }).success
    ).toBe(false)
  })

  it("bounds the collections a visitor read can reach", () => {
    const collections = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`collection-${index}`, { fields: [] }]))
    expect(LinkGrantSchema.safeParse({ version: 1, collections }).success).toBe(false)
    delete collections["collection-32"]
    expect(LinkGrantSchema.safeParse({ version: 1, collections }).success).toBe(true)
  })

  it.each([
    ["not", (node: RecordPredicate): RecordPredicate => ({ not: node })],
    ["and", (node: RecordPredicate): RecordPredicate => ({ and: [node] })],
    ["or", (node: RecordPredicate): RecordPredicate => ({ or: [node] })],
  ])("stops %s chains at the engine's depth limit, however deep", (_, wrap) => {
    const nested = (depth: number) => {
      let node: RecordPredicate = { field: "stage", op: "eq", value: "won" }
      for (let level = 0; level < depth; level++) node = wrap(node)
      return node
    }
    expect(RecordPredicateSchema.safeParse(nested(20)).success).toBe(true)
    expect(RecordPredicateSchema.safeParse(nested(21)).success).toBe(false)
    expect(RecordPredicateSchema.safeParse(nested(100_000)).success).toBe(false)
  })

  it("keeps the write boundary free of deletes", () => {
    const grant = LinkGrantSchema.parse({
      version: 1,
      collections: { deals: { fields: ["stage"], writes: {} } },
    })
    expect(grant.collections.deals?.writes).toEqual({
      create: false,
      update: false,
      fields: [],
      forced: {},
      rows: "before-and-after",
    })
  })
})
