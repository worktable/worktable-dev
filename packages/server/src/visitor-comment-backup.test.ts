import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import {
  appendVisitorReply,
  closeVisitorCommentStores,
  commentPause,
  pauseVisitorComments,
  readVisitorComment,
  receiveVisitorComment,
  visitorCommentsCheckpoint,
  visitorReplies,
  VisitorCommentsUnavailable,
} from "./visitor-comment-store.ts"
import {
  captureVisitorCommentBackup,
  holdVisitorCommentsAtCheckpoint,
  inspectVisitorCommentBackup,
  restoreVisitorCommentBackup,
} from "./visitor-comment-backup.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visitor-backup-"))
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(join(root, "workspace"))
})
afterEach(async () => {
  closeVisitorCommentStores()
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})
const input = () => ({
  worktableId: "worktable",
  linkId: "link",
  linkLabel: "Review",
  linkCreator: "owner",
  documentId: "doc_report",
  spaceId: "notes",
  kind: "html",
  visitorName: "Reviewer",
  visitorKey: "a".repeat(64),
  clientKey: "c".repeat(32),
  body: "PRIVATE_BACKUP_CONTROL",
  requestId: "request01",
})

it("captures private state and rejects stale safety fences before restoring a complete checkpoint", async () => {
  expect(
    await captureVisitorCommentBackup(join(root, "empty"), "worktable")
  ).toBeUndefined()
  const releaseEmpty = holdVisitorCommentsAtCheckpoint(undefined)
  releaseEmpty()
  const row = receiveVisitorComment(input())
  const beforeDuplicate = visitorCommentsCheckpoint()
  expect(receiveVisitorComment(input())).toEqual(row)
  expect(visitorCommentsCheckpoint()).toEqual(beforeDuplicate)
  appendVisitorReply(
    "worktable",
    row.id,
    { id: "member", name: "The team" },
    "Saved reply"
  )
  pauseVisitorComments("worktable", "link", true)
  const backup = join(root, "backup")
  const state = (await captureVisitorCommentBackup(backup, "worktable"))!
  expect(state.checkpoint).toEqual(visitorCommentsCheckpoint()!)
  expect(
    (await stat(join(backup, "app", "visitor-comments.sqlite"))).mode & 0o777
  ).toBe(0o600)
  await inspectVisitorCommentBackup(backup, state)
  expect(() => holdVisitorCommentsAtCheckpoint(undefined)).toThrow(
    "changed after"
  )
  expect(() => holdVisitorCommentsAtCheckpoint(null)).toThrow("changed after")
  appendVisitorReply(
    "worktable",
    row.id,
    { id: "member", name: "The team" },
    "Later reply"
  )
  pauseVisitorComments("worktable", "link", false)
  expect(() => holdVisitorCommentsAtCheckpoint(state.checkpoint)).toThrow(
    "changed after"
  )
  expect(visitorReplies([row.id])).toHaveLength(2)
  const current = visitorCommentsCheckpoint()
  const release = holdVisitorCommentsAtCheckpoint(current)
  try {
    expect(() =>
      appendVisitorReply(
        "worktable",
        row.id,
        { id: "member", name: "The team" },
        "Fenced"
      )
    ).toThrow(VisitorCommentsUnavailable)
    await restoreVisitorCommentBackup(backup, state, "worktable")
    // Nested publication must not release the caller's replacement fence.
    expect(() => pauseVisitorComments("worktable", "link", false)).toThrow(
      VisitorCommentsUnavailable
    )
  } finally {
    release()
  }
  expect(readVisitorComment("worktable", row.id)?.body).toBe(
    "PRIVATE_BACKUP_CONTROL"
  )
  expect(visitorReplies([row.id]).map((reply) => reply.body)).toEqual([
    "Saved reply",
  ])
  expect(commentPause("worktable", "link")).toBe("sharer")
  expect(visitorCommentsCheckpoint()?.incarnation).not.toBe(
    state.checkpoint.incarnation
  )
  pauseVisitorComments("worktable", "link", false)
  // A retry can publish again, but can never revalidate the old safety fence.
  await restoreVisitorCommentBackup(backup, state, "worktable")
  expect(() => holdVisitorCommentsAtCheckpoint(current)).toThrow(
    "changed after"
  )
  await restoreVisitorCommentBackup(backup, null, "worktable")
  expect(visitorCommentsCheckpoint()).toBeNull()
  expect(visitorReplies([row.id])).toEqual([])
})

it("rejects corrupt or foreign backups without changing current private data or leaving writers fenced", async () => {
  const row = receiveVisitorComment(input())
  const backup = join(root, "backup")
  const state = (await captureVisitorCommentBackup(backup, "worktable"))!
  const checkpoint = visitorCommentsCheckpoint()
  await expect(
    restoreVisitorCommentBackup(backup, state, "another-worktable")
  ).rejects.toThrow("another Worktable")
  const path = join(backup, "app", "visitor-comments.sqlite")
  const bytes = await readFile(path)
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
  await writeFile(path, bytes)
  await expect(inspectVisitorCommentBackup(backup, state)).rejects.toThrow(
    "changed"
  )
  await expect(
    restoreVisitorCommentBackup(backup, state, "worktable")
  ).rejects.toThrow("changed")
  expect(visitorCommentsCheckpoint()).toEqual(checkpoint)
  expect(readVisitorComment("worktable", row.id)?.body).toBe(
    "PRIVATE_BACKUP_CONTROL"
  )
  appendVisitorReply(
    "worktable",
    row.id,
    { id: "member", name: "The team" },
    "Still writable"
  )
  expect(visitorReplies([row.id])).toHaveLength(1)
})
