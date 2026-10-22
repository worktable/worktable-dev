import { Hono } from "hono"
import { VisitorCommentInputSchema } from "@worktable/types"
import {
  SHARE_CAPABILITY_HEADER,
  SHARE_COMMENT_CURSOR_HEADER,
  SHARE_UNLOCK_HEADER,
  VISITOR_HEADERS,
} from "@worktable/hosted-contract"
import { cameThroughGateway } from "../hosted.ts"
import {
  resolveShareLinkView,
  shareLinkStillOpens,
} from "../share-link-views.ts"
import { sharingPreviewEnabled } from "../sharing-preview.ts"
import {
  visitorCommentNamespace,
  notifyVisitorComments,
  visitorNamespaceStillCurrent,
} from "../visitor-comment-access.ts"
import {
  cleanVisitorText,
  commentPause,
  receiveVisitorComment,
  visitorCommentRows,
  visitorReplies,
  VisitorCommentRefused,
} from "../visitor-comment-store.ts"
import {
  nextVisitorCommentCursor,
  readVisitorCommentCursor,
  visitorCommentPageScope,
} from "../visitor-comment-pages.ts"

const DIGEST = /^[a-f0-9]{32,64}$/
const UNAVAILABLE = {
  error: "This link isn't available.",
  code: "LINK_UNAVAILABLE",
}

async function readCommentBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) return null
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    void reader.cancel().catch(() => {})
  }, 1500)
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (expired) return null
      if (done) break
      bytes += value.byteLength
      if (bytes > 16 * 1024) {
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    const all = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      all.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(all)
    ) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}

/** Link ingress constructs this router privately, after verifying its signed
 * envelope. Headers on an ordinary local HTTP request never confer authority. */
export function createPublicVisitorCommentsRouter(
  trustedLinkIngress = false
): Hono {
  const router = new Hono()
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    c.header("X-Content-Type-Options", "nosniff")
    if (!sharingPreviewEnabled()) return c.json(UNAVAILABLE, 404)
    if (!trustedLinkIngress && !cameThroughGateway(c.req.raw))
      return c.json({ error: "Forbidden", code: "GATEWAY_REQUIRED" }, 403)
    return next()
  })
  router.onError((error, c) => {
    if (error instanceof VisitorCommentRefused)
      return c.json({ error: error.message, code: error.code }, error.status, {
        "Retry-After": String(error.retryAfter),
      })
    console.error(
      "[visitor-comments] unavailable",
      error instanceof Error ? error.name : "error"
    )
    return c.json(
      { error: "Try again in a moment.", code: "COMMENTS_UNAVAILABLE" },
      503,
      { "Retry-After": "3" }
    )
  })
  router.on(["GET", "HEAD", "POST"], "/", async (c) => {
    if (new URL(c.req.url).search) return c.json(UNAVAILABLE, 404)
    const visitorKey = c.req.header(VISITOR_HEADERS.KEY) ?? ""
    if (!DIGEST.test(visitorKey)) return c.json(UNAVAILABLE, 404)
    const view = await resolveShareLinkView(
      c.req.header(SHARE_CAPABILITY_HEADER) ?? "",
      { unlock: c.req.header(SHARE_UNLOCK_HEADER), revision: false }
    )
    if (view === "password-required")
      return c.json(
        { error: "This document needs a password.", code: "PASSWORD_REQUIRED" },
        401
      )
    if (!view || typeof view === "string" || view.link.level !== "comment")
      return c.json(UNAVAILABLE, 404)
    const context = await visitorCommentNamespace()
    const current = async () =>
      sharingPreviewEnabled() &&
      (await visitorNamespaceStillCurrent(context)) &&
      context.epoch === view.link.workspaceEpoch &&
      shareLinkStillOpens(view.link, view.policyRevision, { comments: true })
    if (!(await current())) return c.json(UNAVAILABLE, 404)
    const visitorsSee = view.policy.allowVisitorsSeeAll
      ? view.link.comments.visitorsSee
      : "own"
    const accepting =
      view.policy.allowComments &&
      view.link.comments.acceptComments &&
      !commentPause(context.worktableId, view.link.id)
    const rawCursor = c.req.header(SHARE_COMMENT_CURSOR_HEADER)
    if (c.req.method === "POST" && rawCursor !== undefined)
      return c.json({ error: "Invalid cursor", code: "INVALID_REQUEST" }, 400)
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      const scope = visitorCommentPageScope([
        context.worktableId,
        context.epoch,
        view.link.id,
        visitorKey,
        view.policyRevision,
        view.link.comments,
        visitorsSee,
      ])
      const page = readVisitorCommentCursor(rawCursor, scope)
      if (!page)
        return c.json({ error: "Invalid cursor", code: "INVALID_REQUEST" }, 400)
      const rows = visitorCommentRows({
        worktableId: context.worktableId,
        linkId: view.link.id,
        ...(visitorsSee === "own" ? { visitorKey } : {}),
        before: page.before,
        limit: 101,
      })
      const candidates = rows.slice(0, 100)
      const replies = visitorReplies(candidates.map((row) => row.id))
      const comments = []
      // Reserve the envelope and maximum cursor before accounting for rows.
      let bytes = 1024
      for (const row of candidates) {
        const item = {
          id: row.id,
          name: row.visitor_name,
          body: row.body!,
          receivedAt: new Date(row.received_at).toISOString(),
          mine: row.visitor_key === visitorKey,
          replies: replies
            .filter((reply) => reply.comment_id === row.id)
            .map((reply) => ({
              body: reply.body,
              from: view.link.comments.showSharerName
                ? view.link.createdByName
                : "The team",
              at: new Date(reply.created_at).toISOString(),
            })),
        }
        bytes += Buffer.byteLength(JSON.stringify(item)) + 1
        if (bytes > 1024 * 1024) break
        comments.push(item)
      }
      if (rows.length && !comments.length)
        return c.json(
          { error: "Comments are unavailable", code: "COMMENTS_UNAVAILABLE" },
          503
        )
      const last = candidates[comments.length - 1]
      return c.json({
        accepting,
        anonymousAllowed: view.link.comments.anonymousAllowed,
        visitorsSee,
        comments,
        nextCursor:
          last && rows.length > comments.length
            ? nextVisitorCommentCursor(last, scope)
            : null,
        ...(page.reset ? { reset: true } : {}),
      })
    }
    const clientKey = c.req.header(VISITOR_HEADERS.CLIENT) ?? ""
    if (
      c.req.header(VISITOR_HEADERS.VERIFIED) !== "1" ||
      !DIGEST.test(clientKey)
    )
      return c.json(
        { error: "A human check is required.", code: "HUMAN_REQUIRED" },
        403
      )
    if (!accepting)
      return c.json(
        {
          error: "Comments are paused for this link.",
          code: "COMMENTS_PAUSED",
        },
        409
      )
    if (
      (c.req.header("Content-Type") ?? "")
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return c.json({ error: "Use JSON", code: "INVALID_REQUEST" }, 400)
    const body = await readCommentBody(c.req.raw)
    const parsed = VisitorCommentInputSchema.safeParse(
      body && typeof body === "object" && !Array.isArray(body)
        ? {
            ...body,
            ...("body" in body && typeof body.body === "string"
              ? { body: cleanVisitorText(body.body) }
              : {}),
          }
        : null
    )
    if (
      !parsed.success ||
      (parsed.data.anonymous && !view.link.comments.anonymousAllowed)
    )
      return c.json(
        {
          error:
            "Enter a name and comment, or choose anonymous when available.",
          code: "INVALID_REQUEST",
        },
        400
      )
    // Nothing asynchronous follows the last authority/epoch check and insert.
    if (!(await current())) return c.json(UNAVAILABLE, 404)
    try {
      const result = receiveVisitorComment({
        worktableId: context.worktableId,
        linkId: view.link.id,
        linkLabel: view.link.label,
        linkCreator: view.link.createdById,
        documentId: view.link.documentId,
        spaceId: view.link.spaceId,
        kind: view.link.kind,
        visitorName: parsed.data.anonymous ? null : parsed.data.name!,
        visitorKey,
        clientKey,
        body: parsed.data.body,
        requestId: parsed.data.requestId,
      })
      notifyVisitorComments(
        view.link.spaceId,
        view.link.documentId,
        view.link.id
      )
      return c.json(result, 201)
    } catch (error) {
      if (
        error instanceof VisitorCommentRefused &&
        commentPause(context.worktableId, view.link.id)
      )
        notifyVisitorComments(
          view.link.spaceId,
          view.link.documentId,
          view.link.id
        )
      throw error
    }
  })
  return router
}
