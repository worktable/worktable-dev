import { describe, expect, it } from "bun:test"
import { LinkGrantSchema } from "./link-grants"
import type { RecordPredicate } from "./records"

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
          mode: "scoped",
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
    ["summaries mode without rules", { fields: [], mode: "summaries" }],
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
