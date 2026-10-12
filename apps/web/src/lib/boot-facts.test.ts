import { afterEach, expect, it } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import { startWorkspaceQueries } from "./boot-facts"
import { queryKeys, workspaceQueryOptions } from "./queries"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

it("answers the first render's workspace queries from the page, reading only without it", async () => {
  const reads: string[] = []
  const workspace = {
    id: "ws_page",
    name: "Notes",
    createdAt: "2026-10-01T00:00:00.000Z",
    mode: "daily" as const,
    provenance: null,
  }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    reads.push(String(input))
    return Response.json({ ...workspace, id: "ws_read" })
  }) as typeof fetch

  const fromPage = new QueryClient()
  startWorkspaceQueries(fromPage, {
    build: null,
    storageUpgrade: { state: "ready", canRetry: true },
    workspace,
  })
  expect(await fromPage.fetchQuery(workspaceQueryOptions())).toEqual(workspace)
  expect(fromPage.getQueryData(queryKeys.storageUpgrade)).toEqual({
    state: "ready",
    canRetry: true,
  })
  expect(reads).toEqual([])

  const withoutPage = new QueryClient()
  startWorkspaceQueries(withoutPage, null)
  expect(await withoutPage.fetchQuery(workspaceQueryOptions())).toMatchObject({
    id: "ws_read",
  })
  expect(reads).toEqual(["/api/workspace"])
})
