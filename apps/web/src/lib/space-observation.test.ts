import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import { docQueryOptions, docReadCurrent } from "./docs-queries"
import {
  documentPageQueryOptions,
  documentPageValidatedLive,
} from "./documents-queries"
import {
  noteSpaceChange,
  noteSpaceLive,
  resetSpaceObservations,
} from "./space-observation"

const realFetch = globalThis.fetch

beforeEach(() => {
  resetSpaceObservations()
  globalThis.fetch = (async (input) => {
    const url = String(input)
    return Response.json(
      url.includes("/documents/page")
        ? { page: { kind: "document", document: { path: "notes/plan" } } }
        : { path: "notes/plan", content: [] }
    )
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("document reads proven current by the Space's socket", () => {
  it("reuses a page check only while the live socket has reported nothing since it began", async () => {
    const queryClient = new QueryClient()
    const read = () =>
      queryClient.fetchQuery({
        ...documentPageQueryOptions("space-live", "notes/plan"),
        staleTime: 0,
      })

    // Read before the socket is caught up: nothing proves it later.
    await read()
    noteSpaceLive("space-live", true)
    expect(documentPageValidatedLive("space-live", "notes/plan")).toBe(false)

    await read()
    expect(documentPageValidatedLive("space-live", "notes/plan")).toBe(true)
    noteSpaceChange("space-live")
    expect(documentPageValidatedLive("space-live", "notes/plan")).toBe(false)

    await read()
    noteSpaceLive("space-live", false)
    expect(documentPageValidatedLive("space-live", "notes/plan")).toBe(false)
  })

  it("accepts a document read for this open, until a change arrives after it began", async () => {
    const queryClient = new QueryClient()
    const read = () =>
      queryClient.fetchQuery({
        ...docQueryOptions("space-open", "notes/plan"),
        staleTime: 0,
      })

    await read()
    const openedAfterRead = performance.now() + 1
    // A read from before this open, with no live socket, proves nothing.
    expect(docReadCurrent("space-open", "notes/plan", openedAfterRead)).toBe(
      false
    )

    const openedAt = performance.now()
    await read()
    expect(docReadCurrent("space-open", "notes/plan", openedAt)).toBe(true)
    noteSpaceChange("space-open")
    expect(docReadCurrent("space-open", "notes/plan", openedAt)).toBe(false)
  })
})
