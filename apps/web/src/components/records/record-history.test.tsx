import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  RecordChange,
  RecordCollectionSchema,
  RecordFile,
} from "@worktable/types"
import { queryKeys } from "@/lib/queries"
import { RecordHistory } from "./record-history"

const schema = {
  version: 2,
  kind: "worktable.recordSchema",
  id: "queue",
  name: "Queue",
  fields: {
    status: { type: "select", values: ["pending", "approved"] },
    tags: { type: "multi_select", values: ["a", "b", "c", "d", "e"] },
    score: { type: "number" },
    decided_at: { type: "datetime" },
    draft: { type: "text" },
  },
} as unknown as RecordCollectionSchema

const record = {
  id: "r1",
  collectionId: "queue",
  updatedAt: "2026-11-27T10:00:00.000Z",
} as RecordFile

function renderHistory(changes: RecordChange[]): string {
  const client = new QueryClient()
  client.setQueryData(queryKeys.workspace, {
    presentations: {},
    person: { activityId: "local:owner" },
  })
  client.setQueryData(
    [
      ...queryKeys.records("lab", record.collectionId),
      "history",
      record.id,
      record.updatedAt,
    ],
    {
      pages: [{ changes, total: changes.length }],
      pageParams: [undefined],
    }
  )
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RecordHistory spaceId="lab" schema={schema} record={record} />
      </QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}

test("a Record's history shows each change with what it replaced", () => {
  const html = renderHistory([
    {
      id: "rch_2",
      at: "2026-11-27T10:00:00.000Z",
      by: { kind: "agent", id: "local-token:a", name: "Claude Code" },
      kind: "changed",
      // A field and one of the record's other values share a name.
      fields: {
        status: { before: "pending", after: "approved" },
        // A list changed in its fourth entry.
        tags: { before: ["a", "b", "c", "d"], after: ["a", "b", "c", "e"] },
      },
      metadata: { status: { before: "draft-1", after: "draft-2" } },
    },
    {
      id: "rch_1",
      at: "2026-11-27T09:00:00.000Z",
      by: { kind: "person", id: "local:owner" },
      kind: "archived",
      reason: "No longer needed",
    },
  ])

  expect(html).toContain("Claude Code")
  expect(html).toContain("pending")
  expect(html).toContain("approved")
  // The other value keeps its own row beside the field of the same name.
  expect(html).toContain("draft-1")
  expect(html).toContain("draft-2")
  // Every entry of a list shows on both sides, so the changed one can be seen.
  expect(html).toContain(">d<")
  expect(html).toContain(">e<")
  expect(html).not.toContain("+1")
  expect(html).toContain("You")
  expect(html).toContain("Archived")
  expect(html).toContain("No longer needed")
})

test("two values that differ never read the same in a Record's history", () => {
  const opening =
    "The first two sentences of this draft are the same in both versions. So is this one."
  const html = renderHistory([
    {
      id: "rch_1",
      at: "2026-11-27T10:00:00.000Z",
      by: { kind: "agent", id: "local-token:a", name: "Claude Code" },
      kind: "changed",
      fields: {
        // Past the fourth decimal place, where a cell rounds both to 0.
        score: { before: 0.00001, after: 0.00002 },
        // Within the same minute, where a cell shows the same time.
        decided_at: {
          before: "2026-11-27T12:58:04Z",
          after: "2026-11-27T12:58:31Z",
        },
        // Edited far past the lines a row shows.
        draft: {
          before: `${opening} It ends one way.`,
          after: `${opening} It ends another way.`,
        },
      },
    },
  ])

  expect(html).toContain("0.00001")
  expect(html).toContain("0.00002")
  expect(html).toContain("2026-11-27T12:58:04Z")
  expect(html).toContain("2026-11-27T12:58:31Z")
  // The text starts near the edit, not at the opening both versions share.
  expect(html).not.toContain("The first two sentences")
  expect(html).toContain("one way.")
  expect(html).toContain("another way.")
})
