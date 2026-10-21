import { z } from "zod"
import {
  RECORD_QUERY_MAX_LIMIT,
  RecordAggregateFnSchema,
  RecordPredicateSchema,
  RecordQuerySchema,
} from "./records"
import { CanonicalIdSchema } from "./widgets"

// What a share link opens of a Worktable's Records. The server enforces a
// grant on the rows before a visitor's query runs, and checks it against the
// live schemas when it is saved and every time it is used. Grants live in the
// app directory, where agents can't write, so a republished tool can narrow a
// link but never widen it.

// Any key a collection schema can hold; the lists that carry keys are capped.
const FieldKeySchema = z.string().min(1)

/** How a link reads one collection. */
export const LINK_RECORD_MODES = ["scoped", "summaries", "fixed"] as const
export const LinkRecordModeSchema = z.enum(LINK_RECORD_MODES)
export type LinkRecordMode = z.infer<typeof LinkRecordModeSchema>

/** Summaries mode: totals only, never individual records. */
export const SummaryRulesSchema = z.strictObject({
  /** The only fields visitors may group by, and filter on. */
  groupBy: z.array(FieldKeySchema).max(6),
  /** Number fields that sum, avg, min and max may read. */
  measures: z.array(FieldKeySchema).max(12),
  fns: z.array(RecordAggregateFnSchema).default(["count", "sum", "avg"]),
  /** Smaller groups are dropped from every answer. */
  minGroupSize: z.number().int().min(2).max(1000).default(5),
})

/** An adjustable value in a saved read. `any` is allowed only on fields the grant shows. */
export const FixedParamSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("oneOf"),
    values: z.array(z.unknown()).min(1).max(500),
  }),
  z.strictObject({ kind: z.literal("any") }),
])

/**
 * A saved read in canonical form: `where` is a predicate tree, and paging and
 * archive flags are left out because the engine supplies them.
 */
export const FixedReadQuerySchema = RecordQuerySchema.omit({
  cursor: true,
  includeArchived: true,
})
  .extend({ where: RecordPredicateSchema.optional() })
  .strict()

/** Fixed mode: visitors may run only these reads. Ids are as the tool recorded them. */
export const FixedReadSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  query: FixedReadQuerySchema,
  /** Keyed by JSON pointer into `query`. */
  params: z.record(z.string().max(256), FixedParamSchema).default({}),
})

/**
 * Reserved for "Can use" and shared with agent write boundaries. The server
 * rejects it while link writes are off. There is no delete, ever.
 */
export const RecordWriteBoundarySchema = z.strictObject({
  create: z.boolean().default(false),
  update: z.boolean().default(false),
  fields: z.array(FieldKeySchema).max(200).default([]),
  forced: z.record(FieldKeySchema, z.unknown()).default({}),
  /** Checked inside the record lock: the row must match before and after. */
  rows: z.literal("before-and-after").default("before-and-after"),
})

export const CollectionGrantSchema = z
  .strictObject({
    /** Which rows the link shows; null shows every live row. Uses the collection's own fields and `id` only. */
    rows: RecordPredicateSchema.nullable().default(null),
    /** Data fields the link shows. Fields added later stay hidden; the record envelope is never listed. */
    fields: z.array(FieldKeySchema).max(200),
    /** Whether created and updated times are shown. */
    timestamps: z.boolean().default(true),
    mode: LinkRecordModeSchema.default("scoped"),
    summaries: SummaryRulesSchema.optional(),
    fixed: z.array(FixedReadSchema).min(1).max(50).optional(),
    writes: RecordWriteBoundarySchema.optional(),
  })
  .superRefine((grant, ctx) => {
    if ((grant.mode === "summaries") !== (grant.summaries !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["summaries"],
        message: "Summary rules are required in summaries mode, and only there",
      })
    }
    if ((grant.mode === "fixed") !== (grant.fixed !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["fixed"],
        message: "Saved reads are required in fixed mode, and only there",
      })
    }
    const ids = grant.fixed?.map((read) => read.id) ?? []
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["fixed"],
        message: "Saved read ids must be unique",
      })
    }
  })

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
  collections: z.record(CanonicalIdSchema, CollectionGrantSchema)
    .refine((collections) => Object.keys(collections).length <= 32, "A link can open at most 32 collections")
    .default({}),
  limits: LinkGrantLimitsSchema.default(LINK_GRANT_DEFAULT_LIMITS),
  state: LinkGrantStateSchema.default("visitor"),
})

export type SummaryRules = z.infer<typeof SummaryRulesSchema>
export type FixedParam = z.infer<typeof FixedParamSchema>
export type FixedReadQuery = z.infer<typeof FixedReadQuerySchema>
export type FixedRead = z.infer<typeof FixedReadSchema>
export type RecordWriteBoundary = z.infer<typeof RecordWriteBoundarySchema>
export type CollectionGrant = z.infer<typeof CollectionGrantSchema>
export type LinkGrantLimits = z.infer<typeof LinkGrantLimitsSchema>
export type LinkGrantState = z.infer<typeof LinkGrantStateSchema>
export type LinkGrant = z.infer<typeof LinkGrantSchema>
export type LinkGrantInput = z.input<typeof LinkGrantSchema>
