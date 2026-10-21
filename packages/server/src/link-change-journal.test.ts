import { expect, test } from "bun:test"
import {
  LinkGrantSchema,
  type RecordFile,
  type RecordQueryResult,
} from "@worktable/types"
import { createLinkKey } from "./link-grant-view.ts"
import { LinkChangeJournal } from "./link-change-journal.ts"
import { buildRecordCollectionSchema } from "./record-store.ts"

test("change hints respect row access, retain removals of served rows, and reset bounded cursors", () => {
  const journal = new LinkChangeJournal()
  const key = createLinkKey(new Uint8Array(32).fill(4))
  const grant = LinkGrantSchema.parse({
    version: 1,
    collections: {
      deals: {
        fields: ["name"],
        rows: { field: "visibility", op: "eq", value: "public" },
      },
    },
  })
  const schema = buildRecordCollectionSchema({
    id: "deals",
    name: "Deals",
    fields: { name: { type: "text" }, visibility: { type: "text" } },
  })
  const target = {
    id: "link",
    spaceId: "space",
    authorization: "first",
    grant,
    schemas: new Map([["deals", schema]]),
    key,
  }
  journal.touch(target)
  const event = {
    type: "record" as const,
    spaceId: "space",
    collectionId: "deals",
    recordId: "first",
  }
  const row = (visibility: string): RecordFile => ({
    version: 1,
    kind: "worktable.record",
    id: "first",
    collectionId: "deals",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    createdBy: "test",
    metadata: {},
    data: { name: "Visible", visibility },
  })
  const baseline = journal.changes("link").cursor
  journal.record(event, row("private"))
  journal.collection("space", "ungranted")
  expect(journal.changes("link", baseline)).toEqual({
    cursor: baseline,
    reset: false,
    collections: [],
  })
  journal.record(event, row("public"))
  const shown = journal.changes("link", baseline)
  expect(shown.collections).toEqual(["deals"])
  journal.served("link", "deals", {
    records: [{ ...row("public"), id: key.recordId("deals", "first") }],
  } as RecordQueryResult)
  journal.record(event, row("private"))
  expect(journal.changes("link", shown.cursor).collections).toEqual(["deals"])
  expect(JSON.stringify(journal.changes("link", baseline))).not.toContain(
    "Visible"
  )
  journal.touch({ ...target, authorization: "tightened" })
  expect(journal.changes("link", baseline).reset).toBe(true)
  const beforeOverflow = journal.changes("link").cursor
  for (let index = 0; index < 257; index++) journal.collection("space", "deals")
  expect(journal.changes("link", beforeOverflow).reset).toBe(true)
  expect(journal.changes("link", "invalid").collections).toEqual(["deals"])
})
