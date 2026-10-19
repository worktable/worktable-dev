import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import type { ActivityActor, DocumentProvenance } from "@worktable/types"
import { activityQueryOptions } from "@/lib/activity"
import { queryKeys } from "@/lib/queries"
import { DocumentByline } from "./document-byline"

const actor: ActivityActor = {
  kind: "agent",
  id: "local-token:claude",
  name: "Claude Code @ test-machine",
}
const provenance: DocumentProvenance = {
  updatedBy: `agent:${actor.id}`,
  updatedAt: "2026-10-19T09:00:00.000Z",
  source: "mcp",
  versionId: "test-version",
  contentHash: "test-hash",
}

function renderByline(
  options: {
    name?: string
    updatedBy?: string
    editor?: ActivityActor
    team?: boolean
  } = {}
): string {
  const client = new QueryClient()
  const editor = options.editor ?? actor
  client.setQueryData(queryKeys.workspace, {
    presentations: options.name ? { [editor.id]: { name: options.name } } : {},
    person: { activityId: "local:owner" },
    ...(options.team ? { teamContext: {} } : {}),
  })
  client.setQueryData(
    activityQueryOptions({ spaceId: "test", docPath: "plan", limit: 6 })
      .queryKey,
    {
      entries: [
        {
          id: "test-edit",
          at: provenance.updatedAt,
          actor: editor,
          spaceId: "test",
          action: "doc.edited",
          target: { kind: "doc", path: "plan" },
          repeats: 1,
        },
      ],
      nextCursor: null,
    }
  )
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <DocumentByline
          spaceId="test"
          docPath="plan"
          provenance={{
            ...provenance,
            updatedBy: options.updatedBy ?? provenance.updatedBy,
          }}
          contributors={{ lastEditor: editor, recent: [editor] }}
          state={{
            open: "activity",
            setOpen() {},
            lifetimeOpen: false,
            setLifetimeOpen() {},
          }}
        />
      </QueryClientProvider>
    ).replace(/<[^>]*>/g, "")
  } finally {
    client.clear()
  }
}

test("the byline and its activity use current identity names with recorded names as a fallback", () => {
  for (const name of [undefined, "Finn (Claude)", "Scout"]) {
    const text = renderByline({ name })
    expect(text.startsWith(`${name ?? actor.name} edited `)).toBe(true)
    expect(text.split(`${name ?? actor.name} edited`)).toHaveLength(3)
    if (name) expect(text).not.toContain(actor.name!)
  }
  // A newer save by someone else must not inherit this agent's name.
  expect(
    renderByline({ name: "Finn", updatedBy: "agent:another-agent" }).startsWith(
      "Edited "
    )
  ).toBe(true)
})

test("current names preserve You for the reader and name other team members", () => {
  const editor = {
    kind: "person" as const,
    id: "local:owner",
    name: "Old name",
  }
  expect(
    renderByline({ editor, name: "Maya", updatedBy: "user" }).startsWith(
      "You edited "
    )
  ).toBe(true)
  expect(
    renderByline({
      editor: { ...editor, id: "team:other" },
      name: "Maya",
      updatedBy: "team:other",
      team: true,
    }).startsWith("Maya edited ")
  ).toBe(true)
})
