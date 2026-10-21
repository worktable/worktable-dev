import { Hono } from "hono"
import { z } from "zod"
import { sharingPreviewEnabled } from "../sharing-preview.ts"
import {
  DocumentIdSchema,
  VisitorCommentReplyInputSchema,
} from "@worktable/types"
import {
  canDeleteVisitorComment,
  memberVisitorComments,
  notifyVisitorComments,
  visitorCommentNamespace,
  visitorCommentReader,
  visitorDocumentInSpace,
  visitorNamespaceStillCurrent,
} from "../visitor-comment-access.ts"
import {
  appendVisitorReply,
  cleanVisitorText,
  finishVisitorComment,
  readVisitorComment,
  visitorCommentRows,
  VisitorCommentRefused,
  VisitorCommentsUnavailable,
} from "../visitor-comment-store.ts"

export const visitorCommentsRouter = new Hono()
const Cursor = z.strictObject({
  receivedAt: z.number().int().nonnegative(),
  id: z.string().regex(/^vc_[A-Za-z0-9_-]{22}$/),
})
visitorCommentsRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store")
  if (!sharingPreviewEnabled()) return c.json({ error: "Not found" }, 404)
  if (!visitorCommentReader(c, c.req.param("spaceId") ?? ""))
    return c.json({ error: "Forbidden", code: "HUMAN_REQUIRED" }, 403)
  return next()
})
visitorCommentsRouter.onError((error, c) => {
  if (error instanceof VisitorCommentRefused)
    return c.json({ error: error.message, code: error.code }, error.status, {
      "Retry-After": String(error.retryAfter),
    })
  if (!(error instanceof VisitorCommentsUnavailable))
    console.error(
      "[visitor-comments] unavailable",
      error instanceof Error ? error.name : "error"
    )
  return c.json(
    { error: "Visitor comments are unavailable", code: "COMMENTS_UNAVAILABLE" },
    503
  )
})
visitorCommentsRouter.get("/", async (c) => {
  const parsed = DocumentIdSchema.safeParse(c.req.query("documentId"))
  if (!parsed.success)
    return c.json({ error: "Choose a document", code: "INVALID_REQUEST" }, 400)
  const rawCursor = c.req.query("before")
  let before: z.infer<typeof Cursor> | undefined
  if (rawCursor !== undefined) {
    try {
      if (rawCursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(rawCursor))
        throw new Error()
      before = Cursor.parse(
        JSON.parse(Buffer.from(rawCursor, "base64url").toString())
      )
    } catch {
      return c.json({ error: "Invalid cursor", code: "INVALID_REQUEST" }, 400)
    }
  }
  const spaceId = c.req.param("spaceId")!
  const context = await visitorCommentNamespace()
  if (!(await visitorDocumentInSpace(spaceId, parsed.data)))
    return c.json({ error: "Not found" }, 404)
  if (
    !(await visitorNamespaceStillCurrent(context)) ||
    !visitorCommentReader(c, spaceId)
  )
    return c.json({ error: "Forbidden" }, 403)
  const rows = visitorCommentRows({
    worktableId: context.worktableId,
    documentId: parsed.data,
    before,
    limit: 101,
  })
  const page = rows.slice(0, 100)
  const last = page.at(-1)
  return c.json({
    comments: memberVisitorComments(c, spaceId, page),
    nextCursor:
      rows.length > 100 && last
        ? Buffer.from(
            JSON.stringify({ receivedAt: last.received_at, id: last.id })
          ).toString("base64url")
        : null,
  })
})
visitorCommentsRouter.post("/:id/replies", async (c) => {
  const input = VisitorCommentReplyInputSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!input.success)
    return c.json({ error: "Enter a reply", code: "INVALID_REQUEST" }, 400)
  const spaceId = c.req.param("spaceId")!
  const context = await visitorCommentNamespace()
  const row = readVisitorComment(context.worktableId, c.req.param("id"))
  if (
    !row ||
    row.status === "deleted" ||
    !(await visitorDocumentInSpace(spaceId, row.document_id))
  )
    return c.json({ error: "Not found" }, 404)
  if (
    !(await visitorNamespaceStillCurrent(context)) ||
    !visitorCommentReader(c, spaceId)
  )
    return c.json({ error: "Forbidden" }, 403)
  const actor = c.get("identity").principal
  const body = cleanVisitorText(input.data.body)
  if (!body)
    return c.json({ error: "Enter a reply", code: "INVALID_REQUEST" }, 400)
  appendVisitorReply(
    context.worktableId,
    row.id,
    { id: actor.id, name: actor.displayName },
    body
  )
  notifyVisitorComments(spaceId, row.document_id, row.link_id)
  return c.json({ ok: true }, 201)
})
visitorCommentsRouter.post("/:id/done", async (c) => {
  const spaceId = c.req.param("spaceId")!
  const context = await visitorCommentNamespace()
  const row = readVisitorComment(context.worktableId, c.req.param("id"))
  if (
    !row ||
    row.status === "deleted" ||
    !(await visitorDocumentInSpace(spaceId, row.document_id))
  )
    return c.json({ error: "Not found" }, 404)
  if (
    !(await visitorNamespaceStillCurrent(context)) ||
    !visitorCommentReader(c, spaceId)
  )
    return c.json({ error: "Forbidden" }, 403)
  finishVisitorComment(context.worktableId, row.id)
  notifyVisitorComments(spaceId, row.document_id, row.link_id)
  return c.json({ ok: true })
})
visitorCommentsRouter.delete("/:id", async (c) => {
  const spaceId = c.req.param("spaceId")!
  const context = await visitorCommentNamespace()
  const row = readVisitorComment(context.worktableId, c.req.param("id"))
  if (!row || !(await visitorDocumentInSpace(spaceId, row.document_id)))
    return c.json({ error: "Not found" }, 404)
  if (
    !(await visitorNamespaceStillCurrent(context)) ||
    !canDeleteVisitorComment(c, spaceId, row)
  )
    return c.json({ error: "Forbidden" }, 403)
  finishVisitorComment(
    context.worktableId,
    row.id,
    c.get("identity").principal.id
  )
  notifyVisitorComments(spaceId, row.document_id, row.link_id)
  return c.json({ ok: true })
})
