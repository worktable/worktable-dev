import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setAppDirOverride } from "./app-storage.ts"
import { setWorkspaceRootOverride, workspaceCacheKey } from "./workspace.ts"
import {
  appendVisitorReply,
  cleanVisitorText,
  closeVisitorCommentStores,
  commentPause,
  finishVisitorComment,
  pauseVisitorComments,
  pendingVisitorCommentGroups,
  visitorCommentGeneration,
  prepareVisitorCommentStore,
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
  it("uses the latest receipt label for Pending", () => {
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(now)
    try {
      for (let index = 0; index < 4; index++)
        receiveVisitorComment(comment({ requestId: `pending0${index}` }))
      clock.mockReturnValue(now + 1)
      receiveVisitorComment(
        comment({
          requestId: "newlabel1",
          clientKey: "label-client",
          linkLabel: "Zebra",
        })
      )
      clock.mockReturnValue(now + 2)
      receiveVisitorComment(
        comment({
          requestId: "newlabel2",
          clientKey: "label-client",
          linkLabel: "Alpha",
        })
      )
      expect(pendingVisitorCommentGroups("worktableId")).toEqual([
        expect.objectContaining({
          link_label: "Alpha",
          space_at_receipt: "space",
          count: 6,
          at: now + 2,
        }),
      ])
    } finally {
      clock.mockRestore()
    }
  })
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
    const deletion = readVisitorComment("worktableId", made.id)
    const generation = visitorCommentGeneration()
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 1000)
    try {
      finishVisitorComment("worktableId", made.id, "another-person")
      expect(readVisitorComment("worktableId", made.id)?.deleted_at).toBe(
        deletion?.deleted_at
      )
      expect(readVisitorComment("worktableId", made.id)?.deleted_by).toBe(
        "person"
      )
      expect(visitorCommentGeneration()).toBe(generation)
    } finally {
      clock.mockRestore()
    }
    expect(visitorReplies([made.id])).toEqual([])
    expect(
      visitorCommentRows({ worktableId: "worktableId", linkId: "link" })
    ).toEqual([])
    const file = join(dir, workspace!, "comments.sqlite")
    expect(
      (await readFile(file)).includes(Buffer.from("OUTSIDE_SENTINEL"))
    ).toBe(false)
    const cold = receiveVisitorComment(
      comment({ requestId: "coldread", body: "COLD_READ_CONTROL" })
    )
    closeVisitorCommentStores()
    const before = await readFile(file)
    await chmod(file, 0o400)
    await chmod(join(dir, workspace!), 0o500)
    try {
      expect(readVisitorComment("worktableId", cold.id)?.body).toBe(
        "COLD_READ_CONTROL"
      )
      expect(await readdir(join(dir, workspace!))).toEqual(["comments.sqlite"])
      expect(await readFile(file)).toEqual(before)
    } finally {
      closeVisitorCommentStores()
      await chmod(join(dir, workspace!), 0o700)
      await chmod(file, 0o600)
    }
    const legacy = new Database(file)
    try {
      legacy.exec("PRAGMA journal_mode=WAL")
      legacy
        .query("UPDATE visitor_comments SET body=? WHERE id=?")
        .run("RECOVERED_CONTROL", cold.id)
      const wal = await readFile(`${file}-wal`)
      const shm = await readFile(`${file}-shm`)
      expect(() => readVisitorComment("worktableId", cold.id)).toThrow(
        VisitorCommentsUnavailable
      )
      expect(await readFile(`${file}-wal`)).toEqual(wal)
      expect(await readFile(`${file}-shm`)).toEqual(shm)
    } finally {
      legacy.close()
    }
    prepareVisitorCommentStore()
    expect(readVisitorComment("worktableId", cold.id)?.body).toBe(
      "RECOVERED_CONTROL"
    )
    expect(await readdir(join(dir, workspace!))).toEqual(["comments.sqlite"])
  })
  it("lets a room on one address comment, holds one visitor, pauses a burst and resumes only by a person", () => {
    const refusal = (input: ReturnType<typeof comment>) => {
      try {
        receiveVisitorComment(input)
      } catch (error) {
        if (error instanceof VisitorCommentRefused) return error
        throw error
      }
      throw new Error("Expected a refusal")
    }
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(now)
    try {
      // One person is held at six in ten minutes, then may comment again.
      const one = (requestId: string) =>
        comment({ visitorKey: "solo", clientKey: "solo", requestId })
      for (let index = 0; index < 6; index++)
        receiveVisitorComment(one(`solo-${index}`))
      expect(refusal(one("solo-over"))).toMatchObject({
        status: 429,
        retryAfter: 600,
      })
      clock.mockReturnValue(now + 600_001)
      expect(receiveVisitorComment(one("solo-later")).id).toMatch(/^vc_/)
      clock.mockReturnValue(now + 2 * 600_001)
      // A room of forty on one venue address gets two hundred through; the
      // next is refused without pausing the link.
      let first: ReturnType<typeof receiveVisitorComment> | undefined
      const room = (person: number, index: number | string) =>
        comment({
          clientKey: "venue",
          visitorKey: `room-${person}`,
          requestId: `room-${index}`,
        })
      for (let person = 0; person < 40; person++)
        for (let index = 0; index < 5; index++) {
          const made = receiveVisitorComment(room(person, index))
          first ??= made
        }
      expect(refusal(room(40, 0))).toMatchObject({ retryAfter: 600 })
      expect(commentPause("worktableId", "link")).toBeNull()
      // A burst past three hundred in ten minutes pauses the link.
      for (let visitor = 0; visitor < 100; visitor++)
        receiveVisitorComment(
          comment({
            clientKey: `client-${visitor}`,
            visitorKey: `burst-${visitor}`,
            requestId: "burst",
          })
        )
      expect(
        refusal(comment({ clientKey: "late", visitorKey: "late" }))
      ).toMatchObject({ retryAfter: 3600 })
      expect(commentPause("worktableId", "link")).toBe("spike")
      expect(refusal(comment({ requestId: "while-paused" }))).toMatchObject({
        code: "COMMENTS_PAUSED",
      })
      expect(receiveVisitorComment(room(0, 0))).toEqual(first!)
      pauseVisitorComments("worktableId", "link", false)
      expect(commentPause("worktableId", "link")).toBeNull()
      // Two addresses at their cap within ten minutes also pause a link,
      // even while it stays under three hundred.
      const capped = (address: string, index: number | string) =>
        comment({
          linkId: "capped",
          clientKey: address,
          visitorKey: `${address}-${index}`,
          requestId: "cap",
        })
      for (let index = 0; index < 200; index++)
        receiveVisitorComment(capped("first", index))
      clock.mockReturnValue(Date.now() + 599_000)
      expect(refusal(capped("first", "over"))).toMatchObject({
        retryAfter: 600,
      })
      expect(commentPause("worktableId", "capped")).toBeNull()
      clock.mockReturnValue(Date.now() + 1_001)
      for (let index = 0; index < 200; index++)
        receiveVisitorComment(capped("second", index))
      expect(refusal(capped("second", "over"))).toMatchObject({
        retryAfter: 3600,
      })
      expect(commentPause("worktableId", "capped")).toBe("spike")
    } finally {
      clock.mockRestore()
    }
  }, 30_000)
  it("strips control and direction characters and erases old client keys and expired text off the request path", () => {
    expect(cleanVisitorText(" A\u202ee\u0301\u0000\nB ")).toBe("Aé\nB")
    const made = receiveVisitorComment(comment())
    expect(sweepVisitorComments(Date.now() + 8 * 24 * 3_600_000)).toEqual([])
    expect(readVisitorComment("worktableId", made.id)?.client_key).toBeNull()
    expect(readVisitorComment("worktableId", made.id)?.body).toBe(
      "OUTSIDE_SENTINEL"
    )
    expect(sweepVisitorComments(Date.now() + 181 * 24 * 3_600_000)).toEqual([
      {
        worktableId: "worktableId",
        spaceId: "space",
        documentId: "doc_report",
        linkId: "link",
      },
    ])
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
    setAppDirOverride(app)
    const privateRoot = join(app, "visitor-comments")
    await symlink(root, privateRoot)
    expect(() => receiveVisitorComment(comment())).toThrow(
      VisitorCommentsUnavailable
    )
    expect(await readdir(root)).toEqual([])
    await rm(privateRoot)
    await mkdir(privateRoot)
    const privateWorkspace = join(privateRoot, workspaceCacheKey())
    await symlink(root, privateWorkspace)
    expect(() => receiveVisitorComment(comment())).toThrow(
      VisitorCommentsUnavailable
    )
    expect(await readdir(root)).toEqual([])
    await rm(privateWorkspace)
    await mkdir(privateWorkspace)
    await symlink(
      join(root, "leaked.sqlite"),
      join(privateWorkspace, "comments.sqlite")
    )
    expect(() => receiveVisitorComment(comment())).toThrow(
      VisitorCommentsUnavailable
    )
    expect(await readdir(root)).toEqual([])
  })
})
