import { describe, expect, it } from "bun:test"
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  type QueryKey,
} from "@tanstack/react-query"
import * as Y from "yjs"
import type { ThreadReadResult, ThreadListItem } from "@worktable/types"
import { threadQueryKeys } from "./threads-queries"
import { docQueryKeys } from "./docs-queries"
import { documentQueryKeys } from "./documents-queries"
import { queryKeys } from "./queries"
import { recentQueryKeys } from "./lifetime"
import { firstHeadingText, registerLiveDocument } from "./live-documents"
import {
  applySpaceEvent,
  applyThreadActivityToQueries,
  reconcileSpaceThreadQueries,
  revalidateSpaceAfterReconnect,
  shouldReplaceThreadSummaryActivity,
  spaceReconnectAttemptsForTrigger,
  spaceReconnectDelayMs,
} from "./ws"

/** Let query fetches and their follow-ups run to completion. */
async function settle(queryClient: QueryClient) {
  for (let tick = 0; tick < 50; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (queryClient.isFetching() === 0 && tick > 3) return
  }
}

/** An on-screen query with cached data that counts the reads it makes. */
function watched(
  queryClient: QueryClient,
  queryKey: QueryKey,
  data: unknown,
  read: () => Promise<unknown> = () => Promise.resolve(data)
) {
  queryClient.setQueryData(queryKey, data)
  let reads = 0
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: () => {
      reads++
      return read()
    },
    staleTime: Infinity,
  })
  const unsubscribe = observer.subscribe(() => undefined)
  return {
    get reads() {
      return reads
    },
    unsubscribe,
  }
}

function headingDoc(title: string): Y.Doc {
  const doc = new Y.Doc()
  const group = new Y.XmlElement("blockGroup")
  const container = new Y.XmlElement("blockContainer")
  const heading = new Y.XmlElement("heading")
  heading.insert(0, [new Y.XmlText(title)])
  container.insert(0, [heading])
  group.insert(0, [container])
  doc.getXmlFragment("document-store").insert(0, [group])
  return doc
}

describe("Space WebSocket reconnect backoff", () => {
  const spaceA = { kind: "space", spaceId: "space-a" } as const
  const spaceB = { kind: "space", spaceId: "space-b" } as const
  it("keeps retrying with bounded exponential delays", () => {
    const delays = Array.from({ length: 100 }, (_, index) => spaceReconnectDelayMs(index + 1))
    expect(delays.every((delay) => delay > 0 && delay <= 10_000)).toBe(true)
    expect(delays.every((delay, index) => index === 0 || delay >= delays[index - 1]!)).toBe(true)
    expect(delays.at(-1)).toBe(delays.at(-2))

  })

  it("resets a long-running backoff only for an explicit retry trigger", () => {
    expect(spaceReconnectAttemptsForTrigger(100, false)).toBe(100)
    expect(spaceReconnectAttemptsForTrigger(100, true)).toBe(0)
  })

  it("converges reconnect state after the authorized thread list refreshes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let visibleThreads = [{ id: "thr_visible" }, { id: "thr_removed" }]
    const listObserver = new QueryObserver(queryClient, {
      queryKey: threadQueryKeys.list(spaceA),
      queryFn: () => Promise.resolve({ threads: visibleThreads }),
    })
    const unsubscribeList = listObserver.subscribe(() => undefined)
    await listObserver.refetch()
    queryClient.setQueryData(threadQueryKeys.detail(spaceA, "thr_removed"), {
      thread: { id: "thr_removed", messages: [{ body: "private" }] },
    })
    const removedObserver = new QueryObserver(queryClient, {
      queryKey: threadQueryKeys.detail(spaceA, "thr_removed"),
      queryFn: () => Promise.reject(new Error("FORBIDDEN")),
    })
    const unsubscribeRemoved = removedObserver.subscribe(() => undefined)
    await removedObserver.refetch()
    expect(removedObserver.getCurrentResult().data).toBeDefined()

    queryClient.setQueryData(threadQueryKeys.detail(spaceA, "thr_visible"), { thread: { id: "thr_visible" } })
    queryClient.setQueryData(threadQueryKeys.detail(spaceB, "thr_other_space"), { thread: { id: "thr_other_space" } })
    queryClient.setQueryData(["threads", "participants"], [{ id: "person" }])
    visibleThreads = [{ id: "thr_visible" }]
    await reconcileSpaceThreadQueries(queryClient, "space-a")

    expect(
      queryClient.getQueryData(threadQueryKeys.detail(spaceA, "thr_removed"))
    ).toBeUndefined()
    expect(removedObserver.getCurrentResult().data).toBeUndefined()
    expect(queryClient.getQueryData(threadQueryKeys.detail(spaceA, "thr_visible"))).toBeDefined()
    expect(queryClient.getQueryData(threadQueryKeys.detail(spaceB, "thr_other_space"))).toBeDefined()
    expect(queryClient.getQueryState(threadQueryKeys.detail(spaceB, "thr_other_space"))?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(["threads", "participants"])?.isInvalidated).toBe(true)
    unsubscribeRemoved()
    unsubscribeList()
  })

  it("keeps a newer message activity when an older heartbeat arrives later", () => {
    const messages = [
      { id: "msg_older123456", sequence: 1 },
      { id: "msg_newer123456", sequence: 2 },
    ] as Parameters<typeof shouldReplaceThreadSummaryActivity>[2]
    const current = {
      messageId: "msg_newer123456",
      participantId: "ptc_recipient123",
      state: "replied",
      revision: 4,
      attempts: 1,
      updatedAt: "2026-07-25T00:00:02Z",
    } as const
    const lateHeartbeat = {
      messageId: "msg_older123456",
      participantId: "ptc_recipient123",
      state: "working",
      revision: 8,
      attempts: 1,
      updatedAt: "2026-07-25T00:00:03Z",
    } as const

    expect(
      shouldReplaceThreadSummaryActivity(current, lateHeartbeat, messages)
    ).toBe(false)
    expect(
      shouldReplaceThreadSummaryActivity(lateHeartbeat, current, messages)
    ).toBe(true)
    expect(
      shouldReplaceThreadSummaryActivity(
        current,
        lateHeartbeat,
        [],
        current.messageId
      )
    ).toBe(false)
    expect(
      shouldReplaceThreadSummaryActivity(
        lateHeartbeat,
        current,
        [],
        current.messageId
      )
    ).toBe(true)
  })

  it("updates global activity caches without invalidating participants or lists", () => {
    const queryClient = new QueryClient()
    const message = {
      id: "msg_progress123456",
      sequence: 1,
    }
    const summary = {
      id: "thr_progress",
      location: spaceA,
      lastMessage: { id: message.id, excerpt: "" },
    } as ThreadListItem
    const duplicateAtRoot = {
      ...summary,
      location: { kind: "worktable" as const },
    }
    queryClient.setQueryData<ThreadReadResult>(
      threadQueryKeys.detail(spaceA, summary.id),
      {
        thread: { messages: [message] },
        activities: [],
      } as ThreadReadResult
    )
    queryClient.setQueryData(threadQueryKeys.list({ kind: "all" }), {
      threads: [summary, duplicateAtRoot],
    })
    queryClient.setQueryData(threadQueryKeys.list(spaceA), {
      threads: [summary],
    })
    queryClient.setQueryData(threadQueryKeys.participants, {
      participants: [{ id: "ptc_participant123" }],
    })
    const activity = {
      messageId: message.id,
      participantId: "ptc_participant123",
      state: "receiving" as const,
      revision: 3,
      attempts: 1,
      receivedCharacters: 42,
      updatedAt: "2026-07-27T02:00:00.000Z",
    }

    applyThreadActivityToQueries(queryClient, spaceA, summary.id, activity)

    expect(
      queryClient.getQueryData<ThreadReadResult>(
        threadQueryKeys.detail(spaceA, summary.id)
      )?.activity
    ).toEqual(activity)
    for (const queryKey of [
      threadQueryKeys.list({ kind: "all" }),
      threadQueryKeys.list(spaceA),
    ]) {
      expect(
        queryClient.getQueryData<{ threads: ThreadListItem[] }>(queryKey)
          ?.threads[0]?.activity
      ).toEqual(activity)
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)
    }
    expect(
      queryClient.getQueryData<{ threads: ThreadListItem[] }>(
        threadQueryKeys.list({ kind: "all" })
      )?.threads[1]?.activity
    ).toBeUndefined()
    expect(
      queryClient.getQueryState(threadQueryKeys.participants)?.isInvalidated
    ).toBe(false)
  })

  it("updates one identity activity without replacing its sibling", () => {
    const queryClient = new QueryClient()
    const message = { id: "msg_sharedactivity", sequence: 1 }
    const queued = {
      messageId: message.id,
      participantId: "ptc_participant123",
      identityId: "idt_reviewidentity1",
      state: "queued" as const,
      revision: 1,
      attempts: 0,
      updatedAt: "2026-08-15T00:00:00.000Z",
    }
    const working = {
      ...queued,
      identityId: "idt_researchident1",
      state: "working" as const,
      revision: 2,
      attempts: 1,
      updatedAt: "2026-08-15T00:00:01.000Z",
    }
    queryClient.setQueryData<ThreadReadResult>(
      threadQueryKeys.detail(spaceA, "thr_identityactivity"),
      {
        thread: { messages: [message] },
        activities: [queued],
      } as ThreadReadResult
    )

    applyThreadActivityToQueries(
      queryClient,
      spaceA,
      "thr_identityactivity",
      working
    )

    expect(
      queryClient.getQueryData<ThreadReadResult>(
        threadQueryKeys.detail(spaceA, "thr_identityactivity")
      )?.activities
    ).toEqual([queued, working])
  })
})

describe("Space events in the query cache", () => {
  it("reads back nothing for a synced document's own collaborative saves", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const doc = headingDoc("Plan")
    let synced = true
    const unregister = registerLiveDocument("space-echo", "notes/plan", {
      synced: () => synced,
      label: () => firstHeadingText(doc.getXmlFragment("document-store")),
    })
    const docs = watched(queryClient, docQueryKeys.docs("space-echo"), [
      { path: "notes/plan", format: "blocknote", updatedAt: 1, headings: ["Plan"] },
    ])
    const documents = watched(queryClient, documentQueryKeys.list("space-echo"), [
      { kind: "document", path: "notes/plan", updatedAt: "2026-10-01T00:00:00.000Z" },
    ])
    const content = watched(queryClient, docQueryKeys.doc("space-echo", "notes/plan"), {
      path: "notes/plan",
      content: [],
    })
    const recent = watched(queryClient, recentQueryKeys.all, { items: [] })
    const save = (origin?: string) => ({
      type: "doc_update",
      spaceId: "space-echo",
      docPath: "notes/plan",
      ...(origin ? { origin } : {}),
      data: {
        path: "notes/plan",
        updatedAt: Date.parse("2026-10-02T00:00:00.000Z"),
        provenance: {
          updatedAt: "2026-10-02T00:00:00.000Z",
          updatedBy: "user",
          source: "browser-yjs",
          versionId: "ver_2",
          contentHash: "hash_2",
        },
      },
    })

    // Recognized by its browser provenance alone, and by an explicit origin.
    applySpaceEvent(queryClient, "space-echo", save())
    applySpaceEvent(queryClient, "space-echo", save("yjs"))
    await settle(queryClient)
    expect([docs.reads, documents.reads, content.reads, recent.reads]).toEqual([0, 0, 0, 0])
    expect(
      queryClient.getQueryData<Array<{ updatedAt?: string }>>(
        documentQueryKeys.list("space-echo")
      )?.[0]?.updatedAt
    ).toBe("2026-10-02T00:00:00.000Z")
    // Lists on other pages read again when they next open.
    expect(queryClient.getQueryState(recentQueryKeys.all)?.isInvalidated).toBe(true)

    // A new first heading renames the document in lists: read them once.
    const group = doc.getXmlFragment("document-store").get(0) as Y.XmlElement
    const container = group.get(0) as Y.XmlElement
    const heading = container.get(0) as Y.XmlElement
    ;(heading.get(0) as Y.XmlText).insert(4, " B")
    applySpaceEvent(queryClient, "space-echo", save())
    await settle(queryClient)
    expect([docs.reads, documents.reads, content.reads]).toEqual([1, 0, 0])

    // Without a synced session the same save is news to this tab.
    synced = false
    applySpaceEvent(queryClient, "space-echo", save())
    await settle(queryClient)
    expect([docs.reads, documents.reads, content.reads]).toEqual([2, 1, 0])
    for (const query of [docs, documents, content, recent]) query.unsubscribe()
    unregister()
  })

  it("refreshes exact lists for other changes, leaving open content and other Spaces alone", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const docs = watched(queryClient, docQueryKeys.docs("space-a"), [])
    const documents = watched(queryClient, documentQueryKeys.list("space-a"), [])
    const page = watched(queryClient, documentQueryKeys.page("space-a", "notes/plan"), {})
    const content = watched(queryClient, docQueryKeys.doc("space-a", "notes/plan"), {})
    // A document named "references" must not answer for reference lookups.
    const namedReferences = watched(queryClient, docQueryKeys.doc("space-a", "references"), {})
    const references = watched(queryClient, docQueryKeys.references("space-a", ["notes/plan"]), [])
    const space = watched(queryClient, queryKeys.space("space-a"), {})
    const otherDocs = watched(queryClient, docQueryKeys.docs("space-b"), [])

    applySpaceEvent(queryClient, "space-a", {
      type: "doc_update",
      spaceId: "space-a",
      docPath: "notes/plan",
      data: { path: "notes/plan", content: [], provenance: { source: "mcp" } },
    })
    await settle(queryClient)

    expect({
      docs: docs.reads,
      documents: documents.reads,
      page: page.reads,
      references: references.reads,
      content: content.reads,
      namedReferences: namedReferences.reads,
      space: space.reads,
      otherDocs: otherDocs.reads,
    }).toEqual({
      docs: 1,
      documents: 1,
      page: 1,
      references: 1,
      content: 0,
      namedReferences: 0,
      space: 0,
      otherDocs: 0,
    })
    for (const query of [docs, documents, page, content, namedReferences, references, space, otherDocs]) {
      query.unsubscribe()
    }
  })

  it("joins a read in flight and follows it with one more, however many changes arrive", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const releases: Array<() => void> = []
    const docs = watched(queryClient, docQueryKeys.docs("space-burst"), [], () =>
      new Promise((resolve) => releases.push(() => resolve([])))
    )
    const change = { type: "doc_update", spaceId: "space-burst" }

    applySpaceEvent(queryClient, "space-burst", change)
    applySpaceEvent(queryClient, "space-burst", change)
    applySpaceEvent(queryClient, "space-burst", change)
    expect(docs.reads).toBe(1)

    // The first read may predate the later changes, so exactly one follows.
    releases.shift()!()
    for (let tick = 0; tick < 10 && releases.length === 0; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(docs.reads).toBe(2)
    releases.shift()!()
    await settle(queryClient)
    expect(docs.reads).toBe(2)
    docs.unsubscribe()
  })

  it("revalidates only the reconnected Space's lists on screen", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const spaces = watched(queryClient, queryKeys.spaces, [])
    const docs = watched(queryClient, docQueryKeys.docs("space-a"), [])
    const recent = watched(queryClient, recentQueryKeys.all, { items: [] })
    const content = watched(queryClient, docQueryKeys.doc("space-a", "notes/plan"), {})
    const otherDocs = watched(queryClient, docQueryKeys.docs("space-b"), [])
    queryClient.setQueryData(docQueryKeys.doc("space-a", "notes/closed"), {})

    revalidateSpaceAfterReconnect(queryClient, "space-a")
    await settle(queryClient)

    expect([spaces.reads, docs.reads, recent.reads]).toEqual([1, 1, 1])
    // Open content checks itself; closed content reads again when it opens.
    expect(content.reads).toBe(0)
    expect(
      queryClient.getQueryState(docQueryKeys.doc("space-a", "notes/closed"))?.isInvalidated
    ).toBe(true)
    expect(otherDocs.reads).toBe(0)
    expect(queryClient.getQueryState(docQueryKeys.docs("space-b"))?.isInvalidated).toBe(false)
    for (const query of [spaces, docs, recent, content, otherDocs]) query.unsubscribe()
  })

  it("patches record grids from payloads and reads only what a payload cannot settle", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const record = (id: string, data: Record<string, unknown>) => ({
      version: 1,
      kind: "record",
      id,
      collectionId: "tasks",
      createdAt: `2026-10-0${id.at(-1)}T00:00:00.000Z`,
      updatedAt: "2026-10-05T00:00:00.000Z",
      data,
    })
    const grid = (params: Record<string, unknown>, records: unknown[]) => {
      const queryKey = queryKeys.recordPages("space-r", "tasks", params)
      queryClient.setQueryData(queryKey, { pages: [{ records }], pageParams: [""] })
      let reads = 0
      const observer = new InfiniteQueryObserver(queryClient, {
        queryKey,
        queryFn: () => {
          reads++
          return Promise.resolve({ records })
        },
        initialPageParam: "",
        getNextPageParam: () => undefined,
        staleTime: Infinity,
      })
      const unsubscribe = observer.subscribe(() => undefined)
      return {
        get reads() {
          return reads
        },
        records: () =>
          (
            queryClient.getQueryData(queryKey) as {
              pages: Array<{ records: Array<{ id: string; data: Record<string, unknown> }> }>
            }
          ).pages[0]!.records,
        unsubscribe,
      }
    }
    const plain = grid({}, [record("rec_1", { title: "One" }), record("rec_2", { title: "Two" })])
    const filtered = grid({ where: { status: "open" } }, [record("rec_1", { title: "One" })])
    const counts = watched(queryClient, queryKeys.recordCollections("space-r"), [])
    // Another collection's grid showing rec_1 as a linked title.
    const linkingKey = queryKeys.recordPages("space-r", "hires", { expand: { task: true } })
    queryClient.setQueryData(linkingKey, {
      pages: [{ records: [], expanded: { tasks: { rec_1: record("rec_1", { title: "One" }) } } }],
      pageParams: [""],
    })

    applySpaceEvent(queryClient, "space-r", {
      type: "record_update",
      spaceId: "space-r",
      collectionId: "tasks",
      recordId: "rec_1",
      data: record("rec_1", { title: "One, edited" }),
    })
    await settle(queryClient)
    expect(plain.records()[0]?.data.title).toBe("One, edited")
    // The unfiltered grid needs nothing more; a filtered one may no longer match,
    // and a grid in another collection shows its old title.
    expect([plain.reads, filtered.reads, counts.reads]).toEqual([0, 1, 0])
    expect(queryClient.getQueryState(linkingKey)?.isInvalidated).toBe(true)

    applySpaceEvent(queryClient, "space-r", {
      type: "record_deleted",
      spaceId: "space-r",
      collectionId: "tasks",
      recordId: "rec_2",
    })
    await settle(queryClient)
    expect(plain.records().map((entry) => entry.id)).toEqual(["rec_1"])
    expect([plain.reads, counts.reads]).toEqual([0, 1])

    // A record no grid holds yet is read in.
    applySpaceEvent(queryClient, "space-r", {
      type: "record_update",
      spaceId: "space-r",
      collectionId: "tasks",
      recordId: "rec_3",
      data: record("rec_3", { title: "Three" }),
    })
    await settle(queryClient)
    expect([plain.reads, counts.reads]).toEqual([1, 2])
    for (const query of [plain, filtered, counts]) query.unsubscribe()
  })

  it("applies thread payloads and refreshes only the lists a named thread appears in", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const location = { kind: "space", spaceId: "space-t" } as const
    const message = (sequence: number) => ({ id: `msg_${sequence}`, sequence })
    const detail = watched(queryClient, threadQueryKeys.detail(location, "thr_open"), {
      thread: { id: "thr_open", revision: 1, messages: [message(1)] },
      messages: [message(1)],
      cursor: 1,
      oldestCursor: 1,
      hasOlder: false,
      hasNewer: false,
      activities: [],
    })
    const other = watched(queryClient, threadQueryKeys.detail(location, "thr_other"), {
      thread: { id: "thr_other", revision: 1, messages: [] },
      messages: [],
      activities: [],
    })
    const list = watched(queryClient, threadQueryKeys.list(location), {
      threads: [{ id: "thr_open" }, { id: "thr_other" }],
    })

    applySpaceEvent(queryClient, "space-t", {
      type: "thread_update",
      location,
      spaceId: "space-t",
      threadId: "thr_open",
      data: { id: "thr_open", revision: 2, messages: [message(1), message(2)] },
    })
    applySpaceEvent(queryClient, "space-t", {
      type: "thread_update",
      location,
      spaceId: "space-t",
      threadId: "thr_open",
    })
    await settle(queryClient)

    expect(
      queryClient
        .getQueryData<ThreadReadResult>(threadQueryKeys.detail(location, "thr_open"))
        ?.messages.map((entry) => entry.sequence)
    ).toEqual([1, 2])
    expect([detail.reads, other.reads, list.reads]).toEqual([0, 0, 1])

    // A change the server could not name reconciles the Space's threads.
    applySpaceEvent(queryClient, "space-t", { type: "thread_update" })
    await settle(queryClient)
    expect([detail.reads, other.reads]).toEqual([1, 1])
    for (const query of [detail, other, list]) query.unsubscribe()
  })
})
