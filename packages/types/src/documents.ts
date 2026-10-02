import { z } from "zod"

export const DOCUMENT_ARCHIVE_REASON_MAX_LENGTH = 500

/**
 * Private, durable identity for a Worktable-owned document. Paths remain the
 * public and portable address; this id lets lifecycle data survive path moves.
 */
export const DocumentIdSchema = z
  .string()
  .regex(/^doc_[A-Za-z0-9_-]{22}$/, "invalid document id")

export type DocumentId = z.infer<typeof DocumentIdSchema>

/**
 * Open, durable format id. The registry is code-owned, but persisted ids must
 * round-trip even when the running build has no matching handler.
 */
export const DocumentFormatIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/,
    "format ids must be lowercase namespaced identifiers"
  )

export type DocumentFormatId = z.infer<typeof DocumentFormatIdSchema>

export const DocumentFormatClaimSchema = z.object({
  id: DocumentFormatIdSchema,
  sourceVersion: z.number().int().positive(),
})

export type DocumentFormatClaim = z.infer<typeof DocumentFormatClaimSchema>

export const DocumentHealthSchema = z.enum([
  "supported",
  "unsupported-format",
  "unsupported-version",
  "invalid",
  "ambiguous",
  "temporarily-unavailable",
])

export type DocumentHealth = z.infer<typeof DocumentHealthSchema>

export const DocumentRenderDispositionSchema = z.enum([
  "trusted-component",
  "opaque-sandbox",
  "attachment-only",
])

export type DocumentRenderDisposition = z.infer<
  typeof DocumentRenderDispositionSchema
>

/** Browser view owned by the running Worktable client for a supported format. */
export type DocumentSpecializedView = "doc" | "html"

/** Canonical same-Space destination returned to document-aware clients. */
export interface DocumentNavigationTarget {
  path: string
  /** Compatibility hint for clients that still choose a legacy route. */
  view?: DocumentSpecializedView
  resolvedFrom?: string
}

const RelativeSourcePathSchema = z.string().min(1).max(4096)

export const DocumentSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    relativePath: RelativeSourcePathSchema,
  }),
  z.object({
    kind: z.literal("bundle"),
    relativePath: RelativeSourcePathSchema,
    manifestPath: RelativeSourcePathSchema.optional(),
  }),
])

export type DocumentSource = z.infer<typeof DocumentSourceSchema>

export interface DocumentDescriptor {
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
  title: string
  health: DocumentHealth
  updatedAt?: string
}

export const DocumentFolderOperationsSchema = z.object({
  move: z.boolean(),
  /** Omission is the fail-closed value for older producers. */
  archive: z.boolean().optional(),
  /** Omission is the fail-closed value for older producers. */
  delete: z.boolean().optional(),
})

export type DocumentFolderOperations = z.infer<
  typeof DocumentFolderOperationsSchema
>

const DocumentListClaimSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document"),
    path: z.string(),
    format: DocumentFormatClaimSchema,
    archived: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("alias"),
    path: z.string(),
    targetPath: z.string(),
  }),
])

/**
 * How long a document stays active. Durable documents stay until someone
 * archives them; temporary documents archive automatically on their date.
 */
export const DocumentLifetimeSchema = z.enum(["durable", "temporary"])

export type DocumentLifetime = z.infer<typeof DocumentLifetimeSchema>

/**
 * A temporary document stays active at least this long after it is made
 * temporary or last changed, renamed, or commented on.
 */
export const TEMPORARY_DOCUMENT_GRACE_DAYS = 7

const ISO_DATE_OR_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/

/** Archive dates are ISO dates or date-times; other date formats are rejected. */
export function isArchiveOnValue(value: string): boolean {
  return ISO_DATE_OR_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))
}

/** How agents should choose a lifetime; shown wherever they create documents. */
export const DOCUMENT_LIFETIME_GUIDANCE = [
  "Required when creating a document.",
  "- durable: work people will browse, rely on, or return to: deliverables, decisions, maintained references, active plans, standing instructions.",
  `- temporary: supports work in progress and can leave browsing once that work moves on: handoffs, evidence and run notes, scratch research, intermediate drafts, one-off comparisons. Archives ${TEMPORARY_DOCUMENT_GRACE_DAYS} days after the last edit, rename, or comment; set archiveOn for a later date. Archived documents remain searchable with includeArchived and can be restored.`,
  "If unsure: choose temporary if it only matters for finishing the current work, and durable if someone would look for it in a month. Archive point-in-time records when the work they document is complete.",
].join("\n")

/** Returned when a create omits its lifetime, so older agents learn the rule. */
export const DOCUMENT_LIFETIME_REQUIRED_MESSAGE = `lifetime is required when creating a document. Use "durable" for work people will browse or return to (deliverables, decisions, references, active plans) or "temporary" for supporting work (handoffs, evidence, scratch research, drafts), which archives ${TEMPORARY_DOCUMENT_GRACE_DAYS} days after its last activity.`

/** Agent-facing lifetime input: the error itself explains the choice. */
export const DocumentLifetimeInputSchema = z
  .enum(["durable", "temporary"], { error: DOCUMENT_LIFETIME_REQUIRED_MESSAGE })
  .describe(DOCUMENT_LIFETIME_GUIDANCE)

/** Optional archive date for temporary documents (ISO date or date-time). */
export const DOCUMENT_ARCHIVE_ON_DESCRIPTION = `Temporary documents only: ISO date or date-time when the document archives. Defaults to ${TEMPORARY_DOCUMENT_GRACE_DAYS} days from now; later activity can push it out.`

/**
 * Public, format-neutral discovery result. Durable ids and source locations are
 * deliberately absent: paths remain the portable address until every legacy
 * source has been materialized with a stable identity.
 */
export const DocumentSummarySchema = z.object({
  kind: z.literal("document"),
  path: z.string(),
  format: DocumentFormatClaimSchema,
  title: z.string(),
  health: DocumentHealthSchema,
  updatedAt: z.string().datetime().optional(),
  /** When the document was created through Worktable; absent when unknown. */
  createdAt: z.string().datetime().optional(),
  /** Present on active documents whose storage records a lifetime. */
  lifetime: DocumentLifetimeSchema.optional(),
  /** Present on temporary documents: when the document archives itself. */
  archiveOn: z.string().datetime().optional(),
  archived: z.literal(true).optional(),
  folderOperations: DocumentFolderOperationsSchema.optional(),
})

export const DocumentConflictItemSchema = z.object({
  kind: z.literal("conflict"),
  pathKey: z.string(),
  health: z.literal("ambiguous"),
  claims: z.array(DocumentListClaimSchema).min(2),
})

export type DocumentSummary = z.infer<typeof DocumentSummarySchema>
export type DocumentConflictItem = z.infer<typeof DocumentConflictItemSchema>

export const DocumentListItemSchema = z.discriminatedUnion("kind", [
  DocumentSummarySchema,
  DocumentConflictItemSchema,
])

export type DocumentListItem = z.infer<typeof DocumentListItemSchema>

export const DocumentProvenanceSchema = z.object({
  updatedAt: z.string(),
  updatedBy: z.string(),
  source: z.string(),
  versionId: z.string(),
  contentHash: z.string(),
})

export type DocumentProvenance = z.infer<typeof DocumentProvenanceSchema>

export const DocumentRendererSchema = z.object({
  key: z.string().min(1).max(64),
  disposition: DocumentRenderDispositionSchema,
})

export const DocumentPageCapabilitiesSchema = z.object({
  rawSource: z.boolean(),
  versions: z.boolean(),
  annotations: z.boolean(),
  sharing: z.boolean(),
  /** Compatibility key consumed by the existing public-share service. */
  legacyShareKind: z.enum(["doc", "html"]).optional(),
})

export const DocumentPageSchema = z.object({
  kind: z.literal("document"),
  document: DocumentSummarySchema,
  resolvedFrom: z.string().optional(),
  renderer: DocumentRendererSchema.nullable(),
  capabilities: DocumentPageCapabilitiesSchema,
  provenance: DocumentProvenanceSchema.optional(),
})

export const DocumentPageResultSchema = z.discriminatedUnion("kind", [
  DocumentPageSchema,
  z.object({
    kind: z.literal("conflict"),
    conflict: DocumentConflictItemSchema,
    resolvedFrom: z.string().optional(),
  }),
])

export type DocumentRenderer = z.infer<typeof DocumentRendererSchema>
export type DocumentPageCapabilities = z.infer<
  typeof DocumentPageCapabilitiesSchema
>
export type DocumentPage = z.infer<typeof DocumentPageSchema>
export type DocumentPageResult = z.infer<typeof DocumentPageResultSchema>

export const DocumentVersionSummarySchema = z.object({
  store: z.enum(["v2", "legacy-v1"]).optional(),
  id: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  source: z.string(),
  reason: z.string().optional(),
  operation: z.enum(["create", "update", "checkpoint"]),
  checkpoint: z
    .object({
      meaningful: z.boolean(),
      kind: z.enum([
        "manual",
        "source-transition",
        "restore",
        "system",
        "review",
      ]),
      label: z.string().optional(),
    })
    .optional(),
})

export type DocumentVersionSummary = z.infer<
  typeof DocumentVersionSummarySchema
>

export const DocumentTextProjectionSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
  headings: z.array(z.string()),
  truncated: z.boolean(),
})

export const DocumentMetadataOnlyProjectionSchema = z.object({
  kind: z.literal("metadata-only"),
  reason: z.enum([
    "unsupported-format",
    "unsupported-version",
    "invalid",
    "projection-unavailable",
    "too-large",
    "temporarily-unavailable",
  ]),
})

export const DocumentReadResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document"),
    document: DocumentSummarySchema,
    resolvedFrom: z.string().optional(),
    projection: z.discriminatedUnion("kind", [
      DocumentTextProjectionSchema,
      DocumentMetadataOnlyProjectionSchema,
    ]),
  }),
  z.object({
    kind: z.literal("conflict"),
    conflict: DocumentConflictItemSchema,
    resolvedFrom: z.string().optional(),
  }),
])

export type DocumentReadResult = z.infer<typeof DocumentReadResultSchema>
export type DocumentTextProjection = z.infer<
  typeof DocumentTextProjectionSchema
>

export const DocumentArchiveOnInputSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isArchiveOnValue, {
    message: "archiveOn must be an ISO date or date-time",
  })
  .describe(DOCUMENT_ARCHIVE_ON_DESCRIPTION)

/** A Space shows at most this many pinned starting points. */
export const START_HERE_LIMIT = 7

/** One pinned starting point, stored in space.json settings.startHere. */
export const StartHerePinSchema = z.object({
  path: z.string().min(1).max(4096),
  note: z.string().max(200).optional(),
})

export type StartHerePin = z.infer<typeof StartHerePinSchema>

/** A pin resolved against the current documents, following renames. */
export const ResolvedStartHerePinSchema = StartHerePinSchema.extend({
  status: z.enum(["active", "archived", "missing"]),
  title: z.string().optional(),
  format: DocumentFormatClaimSchema.optional(),
})

export type ResolvedStartHerePin = z.infer<typeof ResolvedStartHerePinSchema>
