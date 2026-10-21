import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setAppDirOverride } from "./app-storage.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import {
  appendVisitorReply,
  cleanVisitorText,
  closeVisitorCommentStores,
  commentPause,
  finishVisitorComment,
  pauseVisitorComments,
  readVisitorComment,
  receiveVisitorComment,
  sweepVisitorComments,
  visitorCommentRows,
  visitorReplies,
  VisitorCommentRefused,
  VisitorCommentsUnavailable,
} from "./visitor-comment-store.ts"
let app: string
let root: string
beforeEach(async () => {
  app = await mkdtemp(join(tmpdir(), "visitor-private-"))
  root = await mkdtemp(join(tmpdir(), "visitor-workspace-"))
  setAppDirOverride(app)
  setWorkspaceRootOverride(root)
})
afterEach(async () => {
  closeVisitorCommentStores()
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await Promise.all([
    rm(app, { recursive: true, force: true }),
    rm(root, { recursive: true, force: true }),
  ])
})
function comment(
  overrides: Partial<Parameters<typeof receiveVisitorComment>[0]> = {}
) {
  return {
    worktableId: "worktableId",
    linkId: "link",
    linkLabel: "Review",
    linkCreator: "owner",
    documentId: "doc_report",
    spaceId: "space",
    kind: "html",
    visitorName: "Visitor",
    visitorKey: "a".repeat(64),
    clientKey: "c".repeat(32),
    body: "OUTSIDE_SENTINEL",
    requestId: "request01",
    ...overrides,
  }
}
describe("private visitor comments", () => {
  it("opens nothing on a read, stores outside input privately, and isolates links, visitors and workspaces", async () => {
    expect(
      visitorCommentRows({ worktableId: "worktableId", linkId: "link" })
    ).toEqual([])
    expect(commentPause("worktableId", "link")).toBeNull()
    expect(await readdir(app)).toEqual([])
    const made = receiveVisitorComment(comment())
    expect(receiveVisitorComment(comment())).toEqual(made)
    expect(
      visitorCommentRows({
        worktableId: "worktableId",
        linkId: "link",
        visitorKey: "b".repeat(64),
      })
    ).toEqual([])
    expect(
      visitorCommentRows({ worktableId: "other", linkId: "link" })
    ).toEqual([])
    expect(
      visitorCommentRows({ worktableId: "worktableId", linkId: "other" })
    ).toEqual([])
    expect(readVisitorComment("worktableId", made.id)?.body).toBe(
      "OUTSIDE_SENTINEL"
    )
    expect(await readdir(root)).toEqual([])
    const dir = join(app, "visitor-comments")
    const [workspace] = await readdir(dir)
    expect(
      (await stat(join(dir, workspace!, "comments.sqlite"))).mode & 0o777
    ).toBe(0o600)
    appendVisitorReply(
      "worktableId",
      made.id,
      { id: "person", name: "The team" },
      "Reply"
    )
    expect(visitorReplies([made.id]).map((reply) => reply.body)).toEqual([
      "Reply",
    ])
    for (let index = 0; index < 21; index++)
      appendVisitorReply(
        "worktableId",
        made.id,
        { id: "person", name: "The team" },
        `Reply ${index}`
      )
    expect(visitorReplies([made.id])).toHaveLength(20)
    finishVisitorComment("worktableId", made.id)
    expect(readVisitorComment("worktableId", made.id)?.status).toBe("done")
    finishVisitorComment("worktableId", made.id, "person")
    expect(readVisitorComment("worktableId", made.id)?.body).toBeNull()
    expect(visitorReplies([made.id])).toEqual([])
    expect(
      visitorCommentRows({ worktableId: "worktableId", linkId: "link" })
    ).toEqual([])
  })
  it("keeps cap-triggered pauses, deduplicates accepted sends and resumes only by a person", () => {
    let first: ReturnType<typeof receiveVisitorComment> | undefined
    for (let client = 0; client < 4; client++) {
      const key = String(client).repeat(32)
      for (let index = 0; index < 5; index++) {
        const made = receiveVisitorComment(
          comment({
            clientKey: key,
            visitorKey: `visitor-${client}`,
            requestId: `request-${index}`,
          })
        )
        first ??= made
      }
      expect(() =>
        receiveVisitorComment(
          comment({
            clientKey: key,
            visitorKey: `visitor-${client}`,
            requestId: "over-cap",
          })
        )
      ).toThrow(VisitorCommentRefused)
    }
    expect(commentPause("worktableId", "link")).toBe("spike")
    expect(() =>
      receiveVisitorComment(comment({ requestId: "while-paused" }))
    ).toThrow("Comments are paused")
    expect(
      receiveVisitorComment(
        comment({
          clientKey: "0".repeat(32),
          visitorKey: "visitor-0",
          requestId: "request-0",
        })
      )
    ).toEqual(first!)
    pauseVisitorComments("worktableId", "link", false)
    expect(commentPause("worktableId", "link")).toBeNull()
    expect(
      receiveVisitorComment(
        comment({
          clientKey: "new",
          visitorKey: "new",
          requestId: "after-resume",
        })
      ).id
    ).toMatch(/^vc_/)
  })
  it("strips control and direction characters and erases old client keys and expired text off the request path", () => {
    expect(cleanVisitorText(" A\u202ee\u0301\u0000\nB ")).toBe("Aé\nB")
    const made = receiveVisitorComment(comment())
    sweepVisitorComments(Date.now() + 8 * 24 * 3_600_000)
    expect(readVisitorComment("worktableId", made.id)?.client_key).toBeNull()
    expect(readVisitorComment("worktableId", made.id)?.body).toBe(
      "OUTSIDE_SENTINEL"
    )
    sweepVisitorComments(Date.now() + 181 * 24 * 3_600_000)
    expect(readVisitorComment("worktableId", made.id)).toBeNull()
  })
  it("refuses private storage inside the workspace before creating anything", async () => {
    setAppDirOverride(join(root, "inside"))
    expect(() => receiveVisitorComment(comment())).toThrow(
      VisitorCommentsUnavailable
    )
    expect(await readdir(root)).toEqual([])
    await symlink(root, join(app, "workspace-link"))
    setAppDirOverride(join(app, "workspace-link", "not-created"))
    expect(() => receiveVisitorComment(comment())).toThrow(
      VisitorCommentsUnavailable
    )
    expect(await readdir(root)).toEqual([])
  })
})
