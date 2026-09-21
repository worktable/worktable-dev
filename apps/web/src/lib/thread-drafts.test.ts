import { describe, expect, test } from "bun:test"

import {
  clearPersistedThreadDrafts,
  MAX_THREAD_DRAFTS,
  loadThreadDrafts,
  normalizeThreadDraftIdentities,
  parseThreadDrafts,
  persistThreadDrafts,
  serializeThreadDrafts,
  setThreadDraft,
  threadDraftsStorageKey,
  type ThreadDraftCollection,
} from "./thread-drafts"
import { retainThreadSubmission } from "./thread-submission"

describe("thread draft persistence", () => {
  test("round-trips location-isolated values, intent, and submission identity", () => {
    const drafts: ThreadDraftCollection = {
      "worktable:thr_same": {
        key: "worktable:thr_same",
        value: "At Worktable",
        recipientId: "ptc_atlas",
        notifyIdentityIds: ["idn_finn"],
        responseIdentityId: "idn_maya",
        replyTo: "msg_question",
        responseTo: "msg_question",
        submission: {
          fingerprint: "same intent",
          idempotencyKey: "thread-post_stable",
        },
        updatedAt: 2,
      },
      "space:product:thr_same": {
        key: "space:product:thr_same",
        value: "In Product",
        updatedAt: 1,
      },
    }

    const restored = parseThreadDrafts(serializeThreadDrafts(drafts))
    expect(restored).toEqual(drafts)
    expect(
      retainThreadSubmission(
        restored["worktable:thr_same"]?.submission,
        "same intent",
        () => "thread-post_rotated"
      ).idempotencyKey
    ).toBe("thread-post_stable")
  })

  test("ignores malformed and incompatible payloads", () => {
    expect(parseThreadDrafts("not json")).toEqual({})
    expect(parseThreadDrafts('{"version":2,"drafts":{}}')).toEqual({})
    expect(
      parseThreadDrafts(
        '{"version":1,"drafts":{"bad":{"value":4,"updatedAt":1}}}'
      )
    ).toEqual({})
  })

  test("drops saved targets that are no longer active", () => {
    const normalized = normalizeThreadDraftIdentities(
      {
        key: "worktable:thr_same",
        value: "Follow up",
        notifyIdentityIds: ["idt_active", "idt_removed"],
        responseIdentityId: "idt_removed",
        submission: {
          fingerprint: "stale intent",
          idempotencyKey: "thread-post_stale",
        },
        updatedAt: 1,
      },
      new Set(["idt_active"])
    )

    expect(normalized.notifyIdentityIds).toEqual(["idt_active"])
    expect(normalized.responseIdentityId).toBeUndefined()
    expect(normalized.submission).toBeUndefined()
  })

  test("evicts the oldest meaningful drafts after twenty", () => {
    let drafts: ThreadDraftCollection = {}
    for (let index = 0; index < MAX_THREAD_DRAFTS + 2; index += 1) {
      drafts = setThreadDraft(drafts, {
        key: `worktable:thr_${index}`,
        value: `Draft ${index}`,
        updatedAt: index,
      })
    }

    expect(Object.keys(drafts)).toHaveLength(MAX_THREAD_DRAFTS)
    expect(drafts["worktable:thr_0"]).toBeUndefined()
    expect(drafts["worktable:thr_21"]?.value).toBe("Draft 21")
  })

  test("continues without throwing when session storage is unavailable", () => {
    const unavailable = {
      getItem(): string | null {
        throw new Error("blocked")
      },
      setItem(): void {
        throw new Error("full")
      },
      removeItem(): void {
        throw new Error("blocked")
      },
    }
    expect(loadThreadDrafts("ws_current", unavailable)).toEqual({})
    expect(() =>
      persistThreadDrafts("ws_current", {}, unavailable)
    ).not.toThrow()
  })

  test("isolates storage by workspace identity", () => {
    const stored = new Map<string, string>()
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    }
    const drafts: ThreadDraftCollection = {
      "worktable:@new": {
        key: "worktable:@new",
        value: "Private draft",
        updatedAt: 1,
      },
    }

    persistThreadDrafts("ws_first", drafts, storage)

    expect(loadThreadDrafts("ws_first", storage)).toEqual(drafts)
    expect(loadThreadDrafts("ws_second", storage)).toEqual({})
    expect(threadDraftsStorageKey("ws:first")).not.toBe(
      threadDraftsStorageKey("ws/first")
    )
    clearPersistedThreadDrafts("ws_first", storage)
    expect(loadThreadDrafts("ws_first", storage)).toEqual({})
  })
})
