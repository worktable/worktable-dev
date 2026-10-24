import { z } from "zod"
import { LINK_GRANT_MAX_COLLECTIONS, LINK_GRANT_MAX_FIELDS } from "./constants"
import { RECORD_QUERY_MAX_LIMIT, RecordPredicateSchema } from "./records"
import { CanonicalIdSchema } from "./widgets"

// What a share link opens of a Worktable's Records. The server enforces a
// grant on the rows before a visitor's query runs, and checks it against the
// live schemas when it is saved and every time it is used. Grants live in the
// app directory, where agents can't write, so a republished tool can narrow a
// link but never widen it.

// Any key a collection schema can hold; the lists that carry keys are capped.
const FieldKeySchema = z.string().min(1)

/**
 * Reserved for "Can use" and shared with agent write boundaries. The server
 * rejects it while link writes are off. There is no delete, ever.
 */
export const RecordWriteBoundarySchema = z.strictObject({
  create: z.boolean().default(false),
  update: z.boolean().default(false),
  fields: z.array(FieldKeySchema).max(LINK_GRANT_MAX_FIELDS).default([]),
  forced: z.record(FieldKeySchema, z.unknown()).default({}),
  /** Checked inside the record lock: the row must match before and after. */
  rows: z.literal("before-and-after").default("before-and-after"),
})

const CollectionGrantFieldsSchema = z.strictObject({
  /** Which rows the link shows; null shows every live row. Uses the collection's own fields and `id` only. */
  rows: RecordPredicateSchema.nullable().default(null),
  /** Data fields the link shows. Fields added later stay hidden; the record envelope is never listed. */
  fields: z.array(FieldKeySchema).max(LINK_GRANT_MAX_FIELDS),
  /** Whether created and updated times are shown. */
  timestamps: z.boolean().default(true),
  writes: RecordWriteBoundarySchema.optional(),
})

/**
 * One collection a link opens. Grants saved while links had several ways to
 * read a collection carry `mode: "scoped"`, which is what every grant means
 * now, so it is dropped. Any other stored mode fails to parse, so its link
 * stays closed rather than opening more than was approved.
 */
export const CollectionGrantSchema = z.preprocess<
  unknown,
  typeof CollectionGrantFieldsSchema,
  z.input<typeof CollectionGrantFieldsSchema>
>((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value
  if ((value as { mode?: unknown }).mode !== "scoped") return value
  const rest: Record<string, unknown> = { ...value }
  delete rest["mode"]
  return rest
}, CollectionGrantFieldsSchema)

/** Per-link limits, shared by everyone using the link. */
export const LINK_GRANT_DEFAULT_LIMITS = {
  rowsPerQuery: 200,
  queriesPerMinute: 120,
  rowsPerHour: 10_000,
} as const

export const LinkGrantLimitsSchema = z.strictObject({
  rowsPerQuery: z
    .number()
    .int()
    .min(1)
    .max(RECORD_QUERY_MAX_LIMIT)
    .default(LINK_GRANT_DEFAULT_LIMITS.rowsPerQuery),
  queriesPerMinute: z
    .number()
    .int()
    .min(1)
    .max(600)
    .default(LINK_GRANT_DEFAULT_LIMITS.queriesPerMinute),
  rowsPerHour: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(LINK_GRANT_DEFAULT_LIMITS.rowsPerHour),
})

/**
 * The tool's saved state on a link: `visitor` keeps each visitor's own state
 * for their browser tab; `team-read` also shows the team's, read-only.
 */
export const LinkGrantStateSchema = z.enum(["none", "visitor", "team-read"])

export const LinkGrantSchema = z.strictObject({
  version: z.literal(1),
  /** Keyed by collection id; there is no wildcard. */
  collections: z
    .record(CanonicalIdSchema, CollectionGrantSchema)
    .refine(
      (collections) =>
        Object.keys(collections).length <= LINK_GRANT_MAX_COLLECTIONS,
      "A link can open at most 32 collections"
    )
    .default({}),
  limits: LinkGrantLimitsSchema.default(LINK_GRANT_DEFAULT_LIMITS),
  state: LinkGrantStateSchema.default("visitor"),
})

export type RecordWriteBoundary = z.infer<typeof RecordWriteBoundarySchema>
export type CollectionGrant = z.infer<typeof CollectionGrantSchema>
export type LinkGrantLimits = z.infer<typeof LinkGrantLimitsSchema>
export type LinkGrantState = z.infer<typeof LinkGrantStateSchema>
export type LinkGrant = z.infer<typeof LinkGrantSchema>
export type LinkGrantInput = z.input<typeof LinkGrantSchema>
