import { createHash } from "node:crypto"
import type { Context } from "hono"
import {
  ANNOTATION_SENT_TO_KEY,
  type Annotation,
  type AnnotationSentTo,
  type PassVisitorCommentInput,
  type SendVisitorCommentsInput,
} from "@worktable/types"
import { createAnnotation, updateAnnotation } from "./annotation-store.ts"
import {
  ANNOTATION_ORIGIN_KEY,
  VISITOR_ANNOTATION_PREFIX,
  VisitorCommentOriginSchema,
} from "./annotation-origin.ts"
import { readDocumentIdentities } from "./document-query.ts"
import { teamsEnabled } from "./team-database.ts"
import {
  notifyVisitorComments,
  visitorCommentNamespace,
  visitorCommentReader,
  visitorNamespaceStillCurrent,
} from "./visitor-comment-access.ts"
import {
  cleanVisitorText,
  markVisitorCommentPassed,
  readVisitorComment,
  type StoredVisitorComment,
} from "./visitor-comment-store.ts"
import { wsManager } from "./ws.ts"
import { CommentRecipientError, commentRecipients } from "./comment-recipients.ts"
import { encodeTargetPath } from "./link-rewrite.ts"
import { withStoreWriteLock } from "./store.ts"
import { postThreadMessage } from "./thread-service.ts"

export class VisitorCommentPassError extends Error {
  readonly status: 403 | 404 | 409 | 503
  constructor(message: string, status: 403 | 404 | 409 | 503) {
    super(message)
    this.status = status
  }
}

/** The caller holds this private comment's write lock across the operation. */
export async function passVisitorComment(
  c: Context,
  context: Awaited<ReturnType<typeof visitorCommentNamespace>>,
  row: StoredVisitorComment,
  input: PassVisitorCommentInput
) {
  const spaceId = c.req.param("spaceId")!
  const { identities } = await readDocumentIdentities(spaceId)
  const document = identities.current.get(row.document_id)
  if (!document || identities.spaceArchived)
    throw new VisitorCommentPassError("This document no longer opens here", 404)
  if (
    !(await visitorNamespaceStillCurrent(context)) ||
    !visitorCommentReader(c, spaceId)
  )
    throw new VisitorCommentPassError("Your access changed", 403)
  const actor = c.get("identity").principal
  const note = cleanVisitorText(input.note ?? "")
  const quote = cleanVisitorText(input.quote)
  if (!quote) throw new VisitorCommentPassError("Enter a quote", 409)
  const to = await commentRecipients(c.get("identity"), spaceId, input.to).catch(
    (error: unknown) => {
      if (error instanceof CommentRecipientError)
        throw new VisitorCommentPassError(error.message, 409)
      throw error
    }
  )
  const name = input.includeName ? row.visitor_name : null
  const origin = VisitorCommentOriginSchema.parse({
    kind: "visitorComment",
    v: 1,
    visitorCommentId: row.id,
    visitorName: name,
    linkId: row.link_id,
    linkLabel: row.link_label,
    receivedAt: new Date(row.received_at).toISOString(),
    passedBy: { id: actor.id, name: actor.displayName },
    passedAt: new Date().toISOString(),
    quote,
    quoteEdited: quote !== row.body,
  })
  const when = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(row.received_at)
  const attribution = `Outside input, unverified. Visitor comment${name ? ` from "${name}"` : ""} via ${row.link_label || "Untitled link"}, ${when}:`
  const quoted = `${attribution}\n${quote}`
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
  // Without a note, the visitor's words stand on their own, still quoted.
  const body = note ? `${note}\n\n${quoted}` : quoted
  const result = await createAnnotation(
    spaceId,
    {
      target:
        row.kind === "html"
          ? { type: "widget", widgetId: document.path }
          : { type: "doc", docPath: document.path },
      category: input.category ?? "comment",
      body,
      to,
      author: {
        type: "user",
        id: teamsEnabled() ? actor.id : "user",
        name: actor.displayName,
      },
      idempotencyKey: `${VISITOR_ANNOTATION_PREFIX}${row.id}`,
      metadata: { [ANNOTATION_ORIGIN_KEY]: origin },
    },
    async (documentId) => {
      if (documentId !== undefined && documentId !== row.document_id)
        throw new VisitorCommentPassError(
          "The document changed. Try again",
          409
        )
      if (documentId === undefined) {
        // Legacy writers hold the namespace lock; never acquire it recursively.
        const current = await readDocumentIdentities(spaceId, {
          lockHeld: true,
        })
        if (
          current.identities.current.get(row.document_id)?.path !==
          document.path
        )
          throw new VisitorCommentPassError(
            "The document changed. Try again",
            409
          )
      }
      const latest = readVisitorComment(context.worktableId, row.id)
      if (
        !latest ||
        latest.status === "deleted" ||
        latest.document_id !== row.document_id ||
        !visitorCommentReader(c, spaceId)
      )
        throw new VisitorCommentPassError("Your access changed", 403)
    }
  )
  // A retry after the annotation committed keeps the original member's credit.
  // Refuse a conflicting historical idempotency key rather than trusting it.
  const saved = VisitorCommentOriginSchema.safeParse(
    result.annotation.metadata[ANNOTATION_ORIGIN_KEY]
  )
  if (
    !saved.success ||
    saved.data.visitorCommentId !== row.id ||
    saved.data.linkId !== row.link_id ||
    result.annotation.author.type !== "user" ||
    (result.annotation.author.id !== "user" &&
      result.annotation.author.id !== saved.data.passedBy.id)
  )
    throw new VisitorCommentPassError(
      "Could not recover the passed comment",
      503
    )
  markVisitorCommentPassed(context.worktableId, row.id, {
    annotationId: result.annotation.id,
    by: saved.data.passedBy,
    at: saved.data.passedAt,
  })
  wsManager.broadcast(spaceId, {
    type: "annotation_update",
    spaceId,
    data: {
      annotationId: result.annotation.id,
      annotation: result.annotation,
      event: "created",
    },
  })
  notifyVisitorComments(spaceId, row.document_id, row.link_id)
  return { annotation: result.annotation, created: result.created }
}

/** At most this many comments go in one batch. */
const SEND_LIMIT = 100

/**
 * Send visitor comments to the team in one go. Each becomes a team comment,
 * as Pass to Team made it. With a recipient, one thread message in the
 * comment's Space asks them about all of them: that message is the only ask,
 * so they are woken once, the way any thread message wakes them. Each comment
 * records the message, which tells people how far the recipient has got.
 */
export async function sendVisitorComments(
  c: Context,
  input: SendVisitorCommentsInput
): Promise<{
  annotations: Annotation[]
  thread: { threadId: string; messageId: string } | null
}> {
  const spaceId = c.req.param("spaceId")!
  const identity = c.get("identity")
  const ids = [...new Set(input.comments.map((comment) => comment.id))]
  if (ids.length !== input.comments.length || ids.length > SEND_LIMIT)
    throw new VisitorCommentPassError("Choose each comment once", 409)
  const to = input.to
    ? (
        await commentRecipients(identity, spaceId, [input.to]).catch(
          (error: unknown) => {
            if (error instanceof CommentRecipientError)
              throw new VisitorCommentPassError(error.message, 409)
            throw error
          }
        )
      )[0]!
    : null
  const context = await visitorCommentNamespace()
  // Check the whole selection before passing any of it, so a send that is
  // refused leaves every comment as it was.
  const rows = input.comments.map((item) =>
    readVisitorComment(context.worktableId, item.id)
  )
  if (rows.some((row) => !row || row.status === "deleted" || !row.body))
    throw new VisitorCommentPassError("A comment is gone", 404)
  if (new Set(rows.map((row) => row!.document_id)).size !== 1)
    throw new VisitorCommentPassError("Send comments from one page at a time", 409)
  const passed: Array<{ row: StoredVisitorComment; annotation: Annotation }> =
    []
  for (const item of input.comments) {
    passed.push(
      await withStoreWriteLock(
        `visitor-comment:${context.root}:${context.worktableId}:${item.id}`,
        async () => {
          const row = readVisitorComment(context.worktableId, item.id)
          if (!row || row.status === "deleted" || !row.body)
            throw new VisitorCommentPassError("A comment is gone", 404)
          const { annotation } = await passVisitorComment(c, context, row, {
            ...(item.note ? { note: item.note } : {}),
            quote: item.quote ?? row.body,
            includeName: input.includeName ?? false,
          })
          return { row, annotation }
        }
      )
    )
  }
  if (!to) return { annotations: passed.map(({ annotation }) => annotation), thread: null }

  const { identities } = await readDocumentIdentities(spaceId)
  const document = identities.current.get(passed[0]!.row.document_id)
  if (!document)
    throw new VisitorCommentPassError("This document no longer opens here", 404)
  const count = passed.length
  const ids_ = passed.map(({ annotation }) => annotation.id)
  const posted = await postThreadMessage(identity, {
    location: { kind: "space", spaceId },
    title: threadTitle(document.title),
    to: to.id,
    expectsReply: true,
    body: [
      `${count === 1 ? "1 comment" : `${count} comments`} on [${linkText(document.title)}](/${encodeTargetPath(document.path)}#comments) ${count === 1 ? "is" : "are"} for you. Answer each in its comment, then reply here.`,
      "",
      `Comments: ${ids_.map((id) => `\`${id}\``).join(", ")}`,
    ].join("\n"),
    idempotencyKey: `visitor-comments:${createHash("sha256")
      .update(`${identity.principal.id}\0${input.requestId}`)
      .digest("base64url")
      .slice(0, 32)}`,
  })
  const sentTo: AnnotationSentTo = {
    threadId: posted.threadId,
    messageId: posted.messageId,
    to,
    at: new Date().toISOString(),
  }
  const annotations: Annotation[] = []
  for (const { annotation } of passed) {
    const updated = await updateAnnotation(
      spaceId,
      annotation.id,
      { metadata: { [ANNOTATION_SENT_TO_KEY]: sentTo } },
      identity.principal.id
    )
    annotations.push(updated)
    wsManager.broadcast(spaceId, {
      type: "annotation_update",
      spaceId,
      data: { annotationId: updated.id, annotation: updated, event: "updated" },
    })
  }
  for (const link of new Set(passed.map(({ row }) => row.link_id)))
    notifyVisitorComments(spaceId, passed[0]!.row.document_id, link)
  return {
    annotations,
    thread: { threadId: posted.threadId, messageId: posted.messageId },
  }
}

/** Link text that can't break the Markdown link around it. */
function linkText(title: string): string {
  return title.replace(/[[\]\\]/g, "").trim() || "this page"
}

function threadTitle(title: string): string {
  const name = title.trim() || "this page"
  const full = `Comments on ${name}`
  return full.length <= 120 ? full : `${full.slice(0, 119).trimEnd()}…`
}
