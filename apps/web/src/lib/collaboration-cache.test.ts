import { describe, expect, it } from "bun:test"
import { workspaceCollaborationCacheKey } from "./collaboration-cache.ts"

describe("workspace collaboration cache", () => {
  it("moves a document to a fresh IndexedDB room when the epoch changes", () => {
    const first = workspaceCollaborationCacheKey("notes", "daily", "epoch-one")
    const replacement = workspaceCollaborationCacheKey(
      "notes",
      "daily",
      "epoch-two"
    )

    expect(replacement).not.toBe(first)
    expect(replacement).toContain("notes-daily-yjs-v1")
  })

  it("moves one document to a fresh IndexedDB room after a format change", () => {
    const before = workspaceCollaborationCacheKey(
      "notes",
      "daily",
      "workspace-epoch",
      "doc-epoch-one"
    )
    const after = workspaceCollaborationCacheKey(
      "notes",
      "daily",
      "workspace-epoch",
      "doc-epoch-two"
    )

    expect(after).not.toBe(before)
  })

  it("keeps the pre-upgrade IndexedDB room for legacy documents", () => {
    expect(
      workspaceCollaborationCacheKey(
        "notes",
        "daily",
        "workspace-epoch",
        "legacy"
      )
    ).toBe("worktable-notes-daily-yjs-v1-workspace-epoch")
  })
})
