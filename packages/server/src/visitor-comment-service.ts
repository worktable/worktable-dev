import type { Context } from "hono"
import type { PassVisitorCommentInput } from "@worktable/types"
import { createAnnotation } from "./annotation-store.ts"
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
  const note = cleanVisitorText(input.note)
  const quote = cleanVisitorText(input.quote)
  if (!note || !quote)
    throw new VisitorCommentPassError("Enter a note and quote", 409)
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
  const body = `${note}\n\n${`${attribution}\n${quote}`
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`
  const result = await createAnnotation(
    spaceId,
    {
      target:
        row.kind === "html"
          ? { type: "widget", widgetId: document.path }
          : { type: "doc", docPath: document.path },
      category: input.category,
      body,
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
