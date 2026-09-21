import { describe, expect, it } from "bun:test"
import {
  clearCompletedThreadDraft,
  retainThreadSubmission,
  threadDraftKey,
  type ThreadDraftState,
  type ThreadSubmissionIdentity,
} from "./thread-submission"

describe("thread submission identity", () => {
  it("reuses one key for the same draft and rotates when the intent changes", () => {
    let created = 0
    const create = () => `thread-post_${++created}`
    const first = retainThreadSubmission(
      undefined,
      "new:ptc_atlas:hello",
      create
    )
    const retry = retainThreadSubmission(first, "new:ptc_atlas:hello", create)
    const edited = retainThreadSubmission(
      retry,
      "new:ptc_atlas:hello-again",
      create
    )

    expect(retry).toBe(first)
    expect(retry.idempotencyKey).toBe("thread-post_1")
    expect(edited.idempotencyKey).toBe("thread-post_2")
    expect(created).toBe(2)
  })

  it("separates duplicate thread ids by location", () => {
    expect(threadDraftKey({ kind: "worktable" }, "thr_duplicate")).not.toBe(
      threadDraftKey({ kind: "space", spaceId: "product" }, "thr_duplicate")
    )
  })

  it("clears only the exact draft whose submission completed", () => {
    const completedSubmission: ThreadSubmissionIdentity = {
      fingerprint: "reply:hello",
      idempotencyKey: "thread-post_completed",
    }
    const completed = {
      key: "worktable:thr_original",
      body: "hello",
      submission: completedSubmission,
    }
    const exactDraft: ThreadDraftState = {
      key: completed.key,
      value: " hello ",
      submission: completedSubmission,
      updatedAt: 1,
    }
    const newerSubmission: ThreadSubmissionIdentity = {
      fingerprint: completedSubmission.fingerprint,
      idempotencyKey: "thread-post_newer",
    }
    const preserved: ThreadDraftState[] = [
      { ...exactDraft, key: "worktable:thr_other" },
      { ...exactDraft, value: "a newer draft" },
      { ...exactDraft, submission: newerSubmission },
      { key: exactDraft.key, value: exactDraft.value, updatedAt: 2 },
    ]

    expect(clearCompletedThreadDraft(exactDraft, completed)).toEqual({
      key: exactDraft.key,
      value: "",
      updatedAt: 1,
    })
    for (const draft of preserved) {
      expect(clearCompletedThreadDraft(draft, completed)).toBe(draft)
    }
  })
})
