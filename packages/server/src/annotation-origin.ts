import { z } from "zod"

export const ANNOTATION_ORIGIN_KEY = "worktable.origin"
export const VISITOR_ANNOTATION_PREFIX = "visitor-comment:"
export type AnnotationWriteGuard = (documentId?: string) => void | Promise<void>

/** Runtime-owned provenance cannot be forged, cleared or preempted by clients. */
export function reservedAnnotationInput(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  const metadata = value.metadata
  return Boolean(
    (metadata &&
      typeof metadata === "object" &&
      Object.hasOwn(metadata, ANNOTATION_ORIGIN_KEY)) ||
    (typeof value.idempotencyKey === "string" &&
      value.idempotencyKey.startsWith(VISITOR_ANNOTATION_PREFIX))
  )
}

export const VisitorCommentOriginSchema = z.strictObject({
  kind: z.literal("visitorComment"),
  v: z.literal(1),
  visitorCommentId: z.string().regex(/^vc_[A-Za-z0-9_-]{22}$/),
  visitorName: z.string().nullable(),
  linkId: z.string().min(1),
  linkLabel: z.string(),
  receivedAt: z.iso.datetime(),
  passedBy: z.strictObject({ id: z.string().min(1), name: z.string() }),
  passedAt: z.iso.datetime(),
  quote: z.string(),
  quoteEdited: z.boolean(),
})
