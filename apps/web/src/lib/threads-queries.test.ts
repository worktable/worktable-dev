import { describe, expect, test } from "bun:test"
import type {
  ThreadActivity,
  ThreadMessage,
  ThreadReadResult,
} from "@worktable/types"

import { QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  applyPostedThreadMessage,
  applyThreadAssignment,
  mergeThreadPage,
  refreshThreadWindow,
  threadQueryKeys,
} from "./threads-queries"
import {
  applyThreadRename,
  refreshThreadNamingCapabilities,
} from "./thread-naming"
import { applyThreadPayload } from "./ws"

const createdAt = "2026-08-15T10:00:00.000Z"

function message(
  sequence: number,
  body = `Message ${sequence}`
): ThreadMessage {
  return {
    id: `msg_message${String(sequence).padStart(8, "0")}`,
    sequence,
    authorIdentityId: "idt_finnparticipant",
    authorMemberId: "ptc_finnparticipant",
    notifyIdentityIds: [],
    body,
    idempotencyKey: `message-${sequence}`,
    createdAt,
  }
}

function result(
  messages: ThreadMessage[],
  input: {
    revision: number
    oldestCursor: number
    hasOlder: boolean
    activities?: ThreadActivity[]
  }
): ThreadReadResult {
  return {
    location: { kind: "worktable" },
    thread: {
      type: "worktable.thread",
      version: 3,
      id: "thr_refreshmerge1",
      location: { kind: "worktable" },
      title: "Refresh merge",
      members: [
        {
          id: "ptc_finnparticipant",
          kind: "agent",
          name: "Finn",
          addedAt: createdAt,
        },
      ],
      identities: [
        {
          id: "idt_finnparticipant",
          memberId: "ptc_finnparticipant",
          name: "Finn",
          default: true,
          status: "active",
          createdAt,
          updatedAt: createdAt,
        },
      ],
      revision: input.revision,
      messages,
      createdAt,
      updatedAt: createdAt,
    },
    messages,
    cursor: messages.at(-1)?.sequence ?? 0,
    oldestCursor: input.oldestCursor,
    hasOlder: input.hasOlder,
    hasNewer: false,
    activities: input.activities ?? [],
    viewerMemberId: "ptc_finnparticipant",
    viewerIdentityId: "idt_finnparticipant",
    viewerParticipantId: "ptc_finnparticipant",
  }
}

describe("thread query refresh", () => {
  test("refreshes open-thread naming permissions when preview changes without refreshing lists", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    })
    const current = result([message(1)], {
      revision: 1,
      oldestCursor: 1,
      hasOlder: false,
    })
    const key = threadQueryKeys.detail(current.location, current.thread.id)
    const listKey = threadQueryKeys.list({ kind: "all" })
    let previewEnabled = false
    let reads = 0
    client.setQueryData(key, { ...current, canRename: false })
    client.setQueryData(listKey, { threads: [] })
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => {
        reads++
        return { ...current, canRename: previewEnabled }
      },
    })
    const unsubscribe = observer.subscribe(() => {})
    try {
      for (const enabled of [true, false]) {
        previewEnabled = enabled
        await refreshThreadNamingCapabilities(client)
        expect(observer.getCurrentResult().data?.canRename).toBe(enabled)
        expect(client.getQueryState(listKey)?.isInvalidated).toBe(false)
      }
      expect(reads).toBe(2)
    } finally {
      unsubscribe()
      client.clear()
    }
  })

  test("renames cached metadata without replacing messages or overwriting newer state", () => {
    const client = new QueryClient()
    const current = result([message(8), message(9)], {
      revision: 9,
      oldestCursor: 8,
      hasOlder: true,
    })
    const key = threadQueryKeys.detail(current.location, current.thread.id)
    client.setQueryData(key, current)
    applyThreadRename(client, current.location, {
      threadId: current.thread.id,
      title: "Named topic",
      revision: 10,
      updatedAt: createdAt,
    })
    const renamed = client.getQueryData<ThreadReadResult>(key)!
    expect(renamed.thread.title).toBe("Named topic")
    expect(renamed.messages).toBe(current.messages)
    expect(renamed.oldestCursor).toBe(8)
    expect(renamed.hasOlder).toBe(true)
    applyThreadRename(client, current.location, {
      threadId: current.thread.id,
      title: "Stale name",
      revision: 9,
      updatedAt: createdAt,
    })
    expect(client.getQueryData(key)).toBe(renamed)
  })

  test("applies a new assignment to both cached message views immediately", () => {
    const assigned = {
      ...message(1),
      notifyIdentityIds: ["idt_mara00000000"],
      responseRequest: {
        identityId: "idt_finnparticipant",
        status: "open" as const,
      },
    }
    const current = result([assigned], {
      revision: 1,
      oldestCursor: 1,
      hasOlder: false,
      activities: [
        {
          messageId: assigned.id,
          participantId: "ptc_maraparticipant",
          identityId: "idt_mara00000000",
          state: "failed",
          revision: 2,
          attempts: 0,
          error: {
            code: "DELIVERY_RETIRED",
            message: "The old assignment was retired.",
            retryable: false,
          },
          updatedAt: createdAt,
        },
      ],
    })

    const reassigned = applyThreadAssignment(
      current,
      assigned.id,
      "idt_mara00000000"
    )!

    expect(reassigned.messages[0]?.responseRequest).toEqual({
      identityId: "idt_mara00000000",
      status: "open",
    })
    expect(reassigned.thread.messages[0]?.responseRequest).toEqual(
      reassigned.messages[0]?.responseRequest
    )
    expect(reassigned.messages[0]?.notifyIdentityIds).toEqual([])
    expect(reassigned.activities).toEqual([])
  })

  test("refetches the loaded window so older mutable messages stay current", async () => {
    const staleSecond = {
      ...message(2),
      responseRequest: {
        identityId: "idt_finnparticipant",
        status: "open" as const,
      },
    }
    const currentActivity: ThreadActivity = {
      messageId: staleSecond.id,
      participantId: "ptc_finnparticipant",
      identityId: "idt_finnparticipant",
      state: "queued",
      revision: 1,
      attempts: 0,
      updatedAt: createdAt,
    }
    const current = result([message(1), staleSecond], {
      revision: 2,
      oldestCursor: 1,
      hasOlder: true,
      activities: [currentActivity],
    })
    const refreshedSecond = {
      ...staleSecond,
      responseRequest: {
        identityId: "idt_finnparticipant",
        status: "responded" as const,
        respondedBy: "msg_message00000003",
        resolvedAt: createdAt,
      },
    }
    const latestActivity: ThreadActivity = {
      ...currentActivity,
      state: "replied",
      revision: 2,
      attempts: 1,
    }
    const latest = result([message(3)], {
      revision: 3,
      oldestCursor: 3,
      hasOlder: true,
    })
    const refreshedOlder = result([message(1), refreshedSecond], {
      revision: 3,
      oldestCursor: 1,
      hasOlder: false,
      activities: [latestActivity],
    })
    const requestedBefore: Array<number | undefined> = []

    const merged = await refreshThreadWindow(current, (before) => {
      requestedBefore.push(before)
      return Promise.resolve(before === undefined ? latest : refreshedOlder)
    })

    expect(requestedBefore).toEqual([undefined, 3])
    expect(merged.thread.revision).toBe(3)
    expect(merged.messages.map(({ sequence }) => sequence)).toEqual([1, 2, 3])
    expect(merged.messages[1]?.responseRequest?.status).toBe("responded")
    expect(merged.activities).toEqual([latestActivity])
    expect(merged.oldestCursor).toBe(1)
    expect(merged.hasOlder).toBe(false)
  })

  test("does not merge disjoint transcript windows", () => {
    const current = result([message(201), message(202)], {
      revision: 3,
      oldestCursor: 201,
      hasOlder: true,
    })
    const distantReplyPage = result([message(1), message(2)], {
      revision: 3,
      oldestCursor: 1,
      hasOlder: false,
    })

    expect(mergeThreadPage(current, distantReplyPage)).toBe(current)
  })

  test("shows a posted reply from the response once, and asks for a read across a gap", () => {
    const current = result([message(1), message(2)], {
      revision: 2,
      oldestCursor: 1,
      hasOlder: false,
    })
    const posted = (sequence: number) => ({
      threadId: current.thread.id,
      location: current.location,
      messageId: message(sequence).id,
      cursor: sequence,
      createdThread: false,
      replies: [],
      timedOut: false,
      message: message(sequence, "My reply"),
    })

    const shown = applyPostedThreadMessage(current, posted(3))
    expect(shown.complete).toBe(true)
    expect(shown.thread?.messages.map((entry) => entry.sequence)).toEqual([
      1, 2, 3,
    ])
    expect(shown.thread?.thread.messages).toEqual(shown.thread?.messages)
    expect(shown.thread?.cursor).toBe(3)
    // The thread's own update may have shown it first.
    expect(applyPostedThreadMessage(shown.thread, posted(3)).thread).toBe(
      shown.thread
    )
    // Messages this tab has not seen sit between: read the thread.
    expect(applyPostedThreadMessage(current, posted(5)).complete).toBe(false)
  })

  test("extends the open window from a thread update without reading it", () => {
    const queryClient = new QueryClient()
    const current = result([message(2), message(3)], {
      revision: 3,
      oldestCursor: 2,
      hasOlder: true,
    })
    const key = threadQueryKeys.detail(current.location, current.thread.id)
    queryClient.setQueryData(key, current)
    const updated = {
      ...current.thread,
      revision: 4,
      messages: [message(1), message(2), message(3), message(4, "New")],
    }

    applyThreadPayload(queryClient, current.location, updated)
    const applied = queryClient.getQueryData<ThreadReadResult>(key)!
    expect(applied.messages.map((entry) => entry.sequence)).toEqual([2, 3, 4])
    expect(applied.thread.revision).toBe(4)
    expect(applied.cursor).toBe(4)
    expect(applied.hasOlder).toBe(true)

    // A late, older update never rolls the thread back.
    applyThreadPayload(queryClient, current.location, current.thread)
    expect(queryClient.getQueryData(key)).toBe(applied)
  })
})
