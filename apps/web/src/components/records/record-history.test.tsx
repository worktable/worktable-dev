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
