import { describe, expect, it } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import type { ThreadReadResult, ThreadSummary } from "@worktable/types"
import { threadQueryKeys } from "./threads-queries"
import {
  applyThreadActivityToQueries,
  invalidateWorkspaceQueriesAfterReconnect,
  isSpaceThreadReconnectQuery,
  pruneInvisibleThreadDetails,
  reconcileSpaceThreadQueries,
  shouldReplaceThreadSummaryActivity,
  spaceReconnectAttemptsForTrigger,
  spaceReconnectDelayMs,
} from "./ws"

describe("Space WebSocket reconnect backoff", () => {
  const spaceA = { kind: "space", spaceId: "space-a" } as const
  const spaceB = { kind: "space", spaceId: "space-b" } as const
  it("keeps retrying with bounded exponential delays", () => {
    expect(
      Array.from({ length: 8 }, (_, index) => spaceReconnectDelayMs(index + 1))
    ).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000])
    expect(spaceReconnectDelayMs(100)).toBe(10_000)
  })

  it("resets a long-running backoff only for an explicit retry trigger", () => {
    expect(spaceReconnectAttemptsForTrigger(100, false)).toBe(100)
    expect(spaceReconnectAttemptsForTrigger(100, true)).toBe(0)
  })

  it("refreshes every thread surface after reconnecting, including participants", () => {
    expect(
      isSpaceThreadReconnectQuery(["threads", "participants"], "space-a")
    ).toBe(true)
    expect(
      isSpaceThreadReconnectQuery(
        ["threads", "detail", "space:space-a", "thr_1"],
        "space-a"
      )
    ).toBe(true)
    expect(
      isSpaceThreadReconnectQuery(
        ["threads", "detail", "space:space-b", "thr_1"],
        "space-a"
      )
    ).toBe(false)
  })

  it("invalidates every cached workspace query after a socket reconnect", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(["spaces"], [{ id: "old-space" }])
    queryClient.setQueryData(["docs", "old-space"], [{ id: "old-doc" }])

    await invalidateWorkspaceQueriesAfterReconnect(queryClient, false)
    expect(queryClient.getQueryState(["spaces"])?.isInvalidated).toBe(false)

    let releaseRoute!: () => void
    const routeReconciled = new Promise<void>((resolve) => {
      releaseRoute = resolve
    })
    const owner = invalidateWorkspaceQueriesAfterReconnect(queryClient, true, {
      reconcileRoute: () => routeReconciled,
    })
    await Promise.resolve()
    expect(queryClient.getQueryState(["spaces"])?.isInvalidated).toBe(false)
    releaseRoute()
    await owner
    expect(queryClient.getQueryState(["spaces"])?.isInvalidated).toBe(true)
    expect(
      queryClient.getQueryState(["docs", "old-space"])?.isInvalidated
    ).toBe(true)
  })

  it("clears an active stale detail that disappears from the authorized list", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(threadQueryKeys.list(spaceA), {
      threads: [{ id: "thr_visible" }],
    })
    queryClient.setQueryData(threadQueryKeys.detail(spaceA, "thr_visible"), {
      thread: { id: "thr_visible" },
    })
    queryClient.setQueryData(threadQueryKeys.detail(spaceA, "thr_removed"), {
      thread: { id: "thr_removed", messages: [{ body: "private" }] },
    })
    const removedObserver = new QueryObserver(queryClient, {
      queryKey: threadQueryKeys.detail(spaceA, "thr_removed"),
      queryFn: () => Promise.reject(new Error("FORBIDDEN")),
    })
    const unsubscribe = removedObserver.subscribe(() => undefined)
    await removedObserver.refetch()
    expect(removedObserver.getCurrentResult().data).toBeDefined()
    queryClient.setQueryData(
      threadQueryKeys.detail(spaceB, "thr_other_space"),
      { thread: { id: "thr_other_space" } }
    )

    expect(pruneInvisibleThreadDetails(queryClient, "space-a")).toEqual([
      "thr_removed",
    ])
    expect(
      queryClient.getQueryData(threadQueryKeys.detail(spaceA, "thr_removed"))
    ).toBeUndefined()
    expect(removedObserver.getCurrentResult().data).toBeUndefined()
    expect(
      queryClient.getQueryData(threadQueryKeys.detail(spaceA, "thr_visible"))
    ).toBeDefined()
    expect(
      queryClient.getQueryData(
        threadQueryKeys.detail(spaceB, "thr_other_space")
      )
    ).toBeDefined()
    unsubscribe()
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

    visibleThreads = [{ id: "thr_visible" }]
    await reconcileSpaceThreadQueries(queryClient, "space-a")

    expect(
      queryClient.getQueryData(threadQueryKeys.detail(spaceA, "thr_removed"))
    ).toBeUndefined()
    expect(removedObserver.getCurrentResult().data).toBeUndefined()
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
      lastMessage: message,
    } as ThreadSummary
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
        queryClient.getQueryData<{ threads: ThreadSummary[] }>(queryKey)
          ?.threads[0]?.activity
      ).toEqual(activity)
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false)
    }
    expect(
      queryClient.getQueryData<{ threads: ThreadSummary[] }>(
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
