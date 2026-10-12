import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { annotationQueryOptions } from "./annotations-queries"
import {
  documentContentRevision,
  documentPageQueryOptions,
  documentPageValidated,
  documentPageValidatedLive,
  documentQueryKeys,
  noteDocumentOpen,
  prefetchDocumentContent,
} from "./documents-queries"
import {
  noteDocumentChange,
  noteSpaceChange,
  noteSpaceLive,
  resetSpaceObservations,
} from "./space-observation"

const realFetch = globalThis.fetch
let contentRequests: string[] = []

beforeEach(() => {
  resetSpaceObservations()
  contentRequests = []
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), "http://app.test")
    if (url.pathname.endsWith("/documents/content")) {
      const revision = url.searchParams.get("rev")!
      contentRequests.push(revision)
      // The document changed since the row named "rev-1".
      return revision === "rev-2"
        ? Response.json({ revision, format: "markdown", content: "# New" })
        : Response.json(
            { error: "changed", code: "REVISION_CHANGED", revision: "rev-2" },
            { status: 409 }
          )
    }
    return Response.json({
      page: { kind: "document", document: { path: "notes/plan" } },
    })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("document reads proven current by the Space's socket", () => {
  it("reuses a page check until a change to its document, or the Space, reaches the live socket", async () => {
    const queryClient = new QueryClient()
    const read = () =>
      queryClient.fetchQuery({
        ...documentPageQueryOptions("space-live", "notes/plan"),
        staleTime: 0,
      })
    const proven = () => documentPageValidatedLive("space-live", "notes/plan")

    // Read before the socket is caught up: nothing proves it later.
    await read()
    noteSpaceLive("space-live", true)
    expect(proven()).toBe(false)

    await read()
    expect(proven()).toBe(true)
    // Another document's change leaves this check alone.
    noteDocumentChange("space-live", "notes/other")
    expect(proven()).toBe(true)
    // This document's change retires it, however the path is spelled.
    noteDocumentChange("space-live", "Notes/Plan")
    expect(proven()).toBe(false)

    // A change without a path (an alias, a rename) concerns every document.
    await read()
    noteSpaceChange("space-live")
    expect(proven()).toBe(false)

    await read()
    noteSpaceLive("space-live", false)
    expect(proven()).toBe(false)
  })

  it("validates an open with a check read after it began, until the document changes", async () => {
    const queryClient = new QueryClient()
    const read = () =>
      queryClient.fetchQuery({
        ...documentPageQueryOptions("space-open", "notes/plan"),
        staleTime: 0,
      })
    const validated = () => documentPageValidated("space-open", "notes/plan")

    // A check from before this open (a hover's, say), with no live socket,
    // validates nothing.
    await read()
    noteDocumentOpen("space-open", "notes/plan")
    expect(validated()).toBe(false)

    await read()
    expect(validated()).toBe(true)
    noteDocumentChange("space-open", "notes/plan")
    expect(validated()).toBe(false)

    // On a live socket an earlier check holds until something changes.
    noteSpaceLive("space-open", true)
    await read()
    noteDocumentOpen("space-open", "notes/plan")
    expect(validated()).toBe(true)
  })
})

describe("annotations of an open document", () => {
  it("are read once while the Space's socket is live, and again without it", async () => {
    const queryClient = new QueryClient()
    let reads = 0
    const pageFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("/annotations")) {
        reads++
        return Response.json({ annotations: [], total: 0 })
      }
      return pageFetch(input, init)
    }) as typeof fetch
    const open = async () => {
      const observer = new QueryObserver(
        queryClient,
        annotationQueryOptions("space-notes", "notes/plan", true)
      )
      const unsubscribe = observer.subscribe(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 0))
      unsubscribe()
    }

    noteSpaceLive("space-notes", true)
    await open()
    await open()
    expect(reads).toBe(1)
    noteSpaceLive("space-notes", false)
    await open()
    expect(reads).toBe(2)
  })
})

describe("content by revision", () => {
  it("follows a revision that is no longer current to the current one, once", async () => {
    const queryClient = new QueryClient()
    await prefetchDocumentContent(
      queryClient,
      "space-rev",
      "notes/plan",
      "rev-1"
    )

    expect(contentRequests).toEqual(["rev-1", "rev-2"])
    expect(documentContentRevision("space-rev", "notes/plan", "rev-1")).toBe(
      "rev-2"
    )
    // The stale address keeps no content; the current one does.
    expect(
      queryClient.getQueryData(
        documentQueryKeys.content("space-rev", "notes/plan", "rev-1")
      )
    ).toBeUndefined()
    expect(
      queryClient.getQueryData(
        documentQueryKeys.content("space-rev", "notes/plan", "rev-2")
      )
    ).toEqual({ revision: "rev-2", format: "markdown", content: "# New" })

    // Opening it again reads nothing.
    await prefetchDocumentContent(
      queryClient,
      "space-rev",
      "notes/plan",
      "rev-1"
    )
    expect(contentRequests).toEqual(["rev-1", "rev-2"])
  })
})
