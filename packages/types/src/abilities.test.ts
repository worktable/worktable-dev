import { describe, expect, it } from "bun:test"
import {
  describeAbilities,
  intersectRecordPermissions,
  type AbilityCollection,
  type WidgetRecordPermissions,
} from "./abilities"
import { LinkGrantSchema, type LinkGrantInput } from "./link-grants"

const collections: Record<string, AbilityCollection> = {
  opportunities: {
    name: "Opportunities",
    fields: {
      name: { name: "Name", type: "text" },
      client: { name: "Client", type: "relation" },
      stage: { name: "Stage", type: "select" },
      amount: { name: "Amount", type: "number" },
      closes: { name: "Close date", type: "date" },
      owner: { name: "Owner", type: "person" },
      email: { name: "Email", type: "email" },
      notes: { name: "Notes", type: "text" },
    },
  },
  contacts: { name: "Contacts", fields: {} },
  secrets: { name: "Secrets", fields: {} },
}

function linkText(
  grant: LinkGrantInput["collections"],
  counts?: Record<string, number>
): string {
  return describeAbilities({
    audience: "link",
    grant: LinkGrantSchema.parse({ version: 1, collections: grant }),
    collections,
    counts,
    describeValue: (_collection, _field, value) =>
      value === "rec-7f3a" ? "Acme" : String(value),
  }).text
}

describe("describeAbilities for links", () => {
  it("names the rows, the fields shown and the fields hidden", () => {
    expect(
      linkText(
        {
          opportunities: {
            rows: { field: "client", op: "eq", value: "rec-7f3a" },
            fields: ["name", "client", "stage", "amount"],
          },
        },
        { opportunities: 42 }
      )
    ).toBe(
      "Anyone with this link can see 42 Opportunities where Client is Acme: Name, Client, Stage, Amount, Created, Updated. Hidden: Close date, Owner, Email, Notes."
    )
  })

  it("says summaries never show individual records", () => {
    expect(
      linkText({
        opportunities: {
          fields: [],
          mode: "summaries",
          summaries: { groupBy: ["client", "stage"], measures: ["amount"] },
        },
      })
    ).toBe(
      "Anyone with this link can see totals of Opportunities by Client and Stage, never individual records."
    )
  })

  it("counts the reads saved with a fixed link", () => {
    const read = (id: string) => ({ id, query: { limit: 20 } })
    expect(
      linkText({
        opportunities: {
          fields: ["name", "client", "stage", "amount", "closes"],
          timestamps: false,
          mode: "fixed",
          fixed: [read("open"), read("won"), read("lost")],
        },
      })
    ).toBe(
      "Anyone with this link can see Opportunities only through the 3 reads saved with this link: Name, Client, Stage, Amount, Close date. Hidden: Owner, Email, Notes, Created, Updated."
    )
  })

  it("puts conditions joined by and into words", () => {
    expect(
      linkText({
        opportunities: {
          rows: {
            and: [
              { field: "stage", op: "in", value: ["won", "open"] },
              { field: "owner", op: "isEmpty", value: false },
              { field: "closes", op: "gte", value: "2026-01-01" },
            ],
          },
          fields: ["name"],
        },
      })
    ).toStartWith(
      "Anyone with this link can see Opportunities where Stage is won or open and Owner is not empty and Close date is on or after 2026-01-01: Name,"
    )
  })

  it("counts conditions it can't say in a short sentence", () => {
    const either = {
      or: [
        { field: "stage", op: "eq", value: "won" },
        { not: { field: "amount", op: "lt", value: 1000 } },
      ],
    }
    const long = { field: "notes", op: "contains", value: "x".repeat(200) }
    // eq null matches only a stored null, not every empty owner.
    const literalNull = { field: "owner", op: "eq", value: null }
    expect(
      linkText({ opportunities: { rows: either, fields: ["name"] } })
    ).toStartWith(
      "Anyone with this link can see Opportunities that match 2 conditions: Name,"
    )
    for (const rows of [long, literalNull]) {
      expect(
        linkText({ opportunities: { rows, fields: ["name"] } })
      ).toStartWith(
        "Anyone with this link can see Opportunities that match 1 condition: Name,"
      )
    }
  })
})

describe("describeAbilities for tools", () => {
  it("lists what a tool reads and changes, and whether it can send data out", () => {
    expect(
      describeAbilities({
        audience: "tool",
        permissions: {
          network: false,
          records: {
            opportunities: { read: true, update: true },
            contacts: { read: true },
          },
        },
        collections,
      }).sentences
    ).toEqual([
      "Reads Opportunities and Contacts.",
      "Changes Opportunities.",
      "Can't send anything outside this Worktable.",
    ])
    expect(
      describeAbilities({
        audience: "tool",
        permissions: {
          network: true,
          records: { "*": { read: true }, secrets: {} },
        },
        collections,
      }).text
    ).toBe(
      "Reads every collection except Secrets. Can send data outside this Worktable."
    )
  })
})

describe("intersectRecordPermissions", () => {
  const can = (
    records: WidgetRecordPermissions,
    id: string,
    action: "read" | "create" | "update" | "delete"
  ) =>
    Boolean((Object.hasOwn(records, id) ? records[id] : records["*"])?.[action])

  it("allows exactly what both sides allow, with entries replacing *", () => {
    const requested: WidgetRecordPermissions = {
      "*": { read: true },
      deals: { read: true, update: true, delete: true },
      secrets: {},
    }
    const ceiling: WidgetRecordPermissions = {
      "*": { read: true, update: true },
      contacts: {},
      deals: { read: true, update: true },
    }
    const result = intersectRecordPermissions(requested, ceiling)
    for (const id of ["deals", "secrets", "contacts", "other"]) {
      for (const action of ["read", "create", "update", "delete"] as const) {
        expect([id, action, can(result, id, action)]).toEqual([
          id,
          action,
          can(requested, id, action) && can(ceiling, id, action),
        ])
      }
    }
  })
})
