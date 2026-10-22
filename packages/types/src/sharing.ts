import { z } from "zod"
import { AnnotationCategorySchema } from "./annotations"
import { LinkGrantSchema, type FixedRead, type LinkGrant } from "./link-grants"
import type { RecordCollectionSchema } from "./records"
import { SHARE_LINK_LABEL_MAX_LENGTH } from "./constants"
import { CanonicalIdSchema, IsoTimestampSchema } from "./widgets"

// Share links: several per document, each with its own label, level, expiry
// and password, revocable on its own. Owner policy applies every time a link
// is used. Only people manage links; agents never reach these shapes.

// ---- Links ---------------------------------------------------------------

/** What a link lets visitors do. `use` (changing Records) is reserved. */
export const SHARE_LINK_LEVELS = ["view", "comment", "use"] as const
export const ShareLinkLevelSchema = z.enum(SHARE_LINK_LEVELS)
export type ShareLinkLevel = z.infer<typeof ShareLinkLevelSchema>

export const ShareLinkKindSchema = z.enum(["doc", "html"])
export type ShareLinkKind = z.infer<typeof ShareLinkKindSchema>

export const ShareLinkStatusSchema = z.enum([
  "active",
  "expired",
  "revoked",
  "blocked",
])
export type ShareLinkStatus = z.infer<typeof ShareLinkStatusSchema>

/** Why an unexpired, unrevoked link doesn't open: the owner policy or the sharer's access no longer allows it. */
export const ShareLinkBlockedBySchema = z.enum([
  "paused",
  "space",
  "sharer",
  "password",
  "level",
  "expiry-cap",
])
export type ShareLinkBlockedBy = z.infer<typeof ShareLinkBlockedBySchema>

const ShareLinkLabelSchema = z.string().trim().max(SHARE_LINK_LABEL_MAX_LENGTH)
const ShareLinkPasswordSchema = z.string().min(8).max(128)

/** Who sees a link's visitor comments: each visitor their own, or everyone holding the link. */
export const VisitorsSeeSchema = z.enum(["own", "all"])
export type VisitorsSee = z.infer<typeof VisitorsSeeSchema>

// Settings live in two forms: without defaults for inputs, so an update or a
// replacement never quietly resets what it omits, and with defaults for
// creating and reading stored values.
function withDefaults<S extends Record<string, z.ZodType>>(
  shape: S,
  defaults: { [K in keyof S]: z.output<S[K]> }
): { [K in keyof S]: z.ZodDefault<S[K]> } {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [
      key,
      schema.default(defaults[key] as never),
    ])
  ) as { [K in keyof S]: z.ZodDefault<S[K]> }
}

const CommentSettingsFieldsSchema = z.strictObject({
  /** The sharer's switch. Turning it on also resumes comments paused after a burst. */
  acceptComments: z.boolean(),
  /** Visitors may comment without a name. */
  anonymousAllowed: z.boolean(),
  /** Replies show the sharer's name instead of "The team". */
  showSharerName: z.boolean(),
  /** `all` needs the owner policy's `allowVisitorsSeeAll`. */
  visitorsSee: VisitorsSeeSchema,
})

/** Per-link comment settings. They apply while the link's level is `comment` or higher. */
export type ShareLinkCommentSettings = z.infer<
  typeof CommentSettingsFieldsSchema
>

export const DEFAULT_SHARE_LINK_COMMENT_SETTINGS: Readonly<ShareLinkCommentSettings> =
  {
    acceptComments: true,
    anonymousAllowed: false,
    showSharerName: false,
    visitorsSee: "own",
  }

export const ShareLinkCommentSettingsSchema = z.strictObject(
  withDefaults(
    CommentSettingsFieldsSchema.shape,
    DEFAULT_SHARE_LINK_COMMENT_SETTINGS
  )
)

export interface ShareLinkComments extends ShareLinkCommentSettings {
  /** Comments were paused automatically after a burst; `acceptComments: true` resumes them. */
  autoPaused: boolean
}

export const ShareTargetSchema = z.strictObject({
  kind: ShareLinkKindSchema,
  spaceId: CanonicalIdSchema,
  /** The server checks it is a safe path for its kind. */
  path: z.string().min(1).max(4096),
})
export type ShareTarget = z.infer<typeof ShareTargetSchema>

export const CreateShareLinkInputSchema = z.strictObject({
  target: ShareTargetSchema,
  label: ShareLinkLabelSchema.default(""),
  level: ShareLinkLevelSchema.default("view"),
  expiresAt: IsoTimestampSchema.nullable().optional(),
  grant: LinkGrantSchema.nullable().optional(),
  password: ShareLinkPasswordSchema.optional(),
  comments: ShareLinkCommentSettingsSchema.default(
    DEFAULT_SHARE_LINK_COMMENT_SETTINGS
  ),
})
export type CreateShareLinkInput = z.input<typeof CreateShareLinkInputSchema>

/** Only the fields present change. A new or removed password voids every unlocked visit. */
export const UpdateShareLinkInputSchema = z.strictObject({
  label: ShareLinkLabelSchema.optional(),
  level: ShareLinkLevelSchema.optional(),
  expiresAt: IsoTimestampSchema.nullable().optional(),
  password: ShareLinkPasswordSchema.nullable().optional(),
  grant: LinkGrantSchema.nullable().optional(),
  comments: CommentSettingsFieldsSchema.partial().optional(),
})
export type UpdateShareLinkInput = z.input<typeof UpdateShareLinkInputSchema>

export interface ShareLink {
  id: string
  spaceId: string
  documentId: string
  kind: ShareLinkKind
  /** Null when the document is no longer in its Space. */
  path: string | null
  title: string | null
  label: string
  level: ShareLinkLevel
  createdBy: { id: string; name: string }
  createdAt: string
  /** The earlier of the link's own expiry and the owner policy's longest expiry. */
  expiresAt: string | null
  hasPassword: boolean
  /** The human-approved live access, absent for static links. */
  grant?: LinkGrant
  lastUsedAt: string | null
  status: ShareLinkStatus
  /** Present when `status` is `blocked`. */
  blockedBy?: ShareLinkBlockedBy
  /** The token's last characters, to tell links apart. The full URL is shown only when a link is made. */
  tokenHint: string
  canManage: boolean
  comments: ShareLinkComments
}

/** A document's links, for its share dialog. */
export interface DocumentShareLinks {
  links: ShareLink[]
  canCreate: boolean
  /** Present when `canCreate` is false. */
  createBlockedBy?: Extract<ShareLinkBlockedBy, "paused" | "space" | "sharer">
  /** The owner policy as it limits the share dialog. */
  policy: SharerPolicy
}

/** Private, human-only preparation of the access a live link would open. */
export interface ShareLinkAccess {
  grant: LinkGrant
  effectiveGrant: LinkGrant
  collections: Record<string, RecordCollectionSchema>
  counts: Record<string, number>
  sentences: string[]
  fixedReads: Record<string, FixedRead[]>
  warnings: Array<{ code: string; collectionId?: string; message: string }>
  issues: Array<{ collectionId: string; message: string }>
  stateReadable: boolean
}

/** A link just made: the only time its URL is returned. */
export interface CreatedShareLink {
  link: ShareLink
  url: string
}

/** One page of the links a reader may manage, across Spaces. */
export interface ShareLinksPage {
  links: ShareLink[]
  nextCursor: string | null
  /** Spaces the reader may filter by. */
  spaces: { id: string; name: string }[]
}

/** Sharing on a document page, without a request of its own. */
export const DocumentSharingSummarySchema = z.object({
  activeLinks: z.number().int().min(0),
  /** Next count change due to expiry, so an open page refreshes once then. */
  nextExpiry: IsoTimestampSchema.optional(),
  canCreate: z.boolean(),
  /** Only for people who may read visitor comments. `available` controls whether its tab appears. */
  visitorComments: z.object({ documentId: z.string(), newCount: z.number().int().min(0), available: z.boolean().optional() }).optional(),
})
export type DocumentSharingSummary = z.infer<
  typeof DocumentSharingSummarySchema
>

// ---- Owner policy --------------------------------------------------------

/**
 * The widest record access a link may grant, narrowest first. `fixed` allows
 * summaries and saved reads; `scoped` allows any read inside the grant. A
 * collection whose mode the policy no longer allows becomes unavailable.
 */
export const SHARING_RECORD_ACCESS = [
  "none",
  "summaries",
  "fixed",
  "scoped",
] as const

const DAYS = z.number().int().min(1).max(3650)

/** A whole owner policy as an owner saves it: every field is required. */
export const SharingPolicyInputSchema = z.strictObject({
  /** Stops every link, and visitor comments, at once. */
  paused: z.boolean(),
  whoMayShare: z.enum(["owners", "space-managers", "editors"]),
  spaces: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("all") }),
    z.strictObject({
      mode: z.literal("selected"),
      spaceIds: z.array(CanonicalIdSchema).max(1000),
    }),
  ]),
  requirePassword: z.boolean(),
  maxExpiryDays: DAYS.nullable(),
  levels: z
    .array(ShareLinkLevelSchema)
    .min(1)
    .refine((levels) => new Set(levels).size === levels.length, {
      message: "Levels must be unique",
    }),
  liveLinks: z.boolean(),
  records: z.enum(SHARING_RECORD_ACCESS),
  /** The expiry a new link that reaches Records starts with, never past `maxExpiryDays`. */
  recordsDefaultExpiryDays: DAYS.nullable(),
  /** Comment links take comments. Off stops new comments without stopping the links. */
  allowComments: z.boolean(),
  /** Sharers may set a link's Visitors See to every comment on it. */
  allowVisitorsSeeAll: z.boolean(),
  /** Agents can't make links. A later version widens this to `view`. */
  agentLinks: z.enum(["off"]),
})
export type SharingPolicy = z.infer<typeof SharingPolicyInputSchema>

/** Sharing as it was before owner policy existed. */
const DEFAULT_SHARING_POLICY: Readonly<SharingPolicy> = {
  paused: false,
  whoMayShare: "space-managers",
  spaces: { mode: "all" },
  requirePassword: false,
  maxExpiryDays: null,
  levels: ["view"],
  liveLinks: false,
  records: "scoped",
  recordsDefaultExpiryDays: 30,
  allowComments: true,
  allowVisitorsSeeAll: true,
  agentLinks: "off",
}

/** A stored owner policy. Fields it lacks, such as ones added later, take their defaults. */
export const SharingPolicySchema = z.strictObject(
  withDefaults(SharingPolicyInputSchema.shape, DEFAULT_SHARING_POLICY)
)

export function defaultSharingPolicy(): SharingPolicy {
  return SharingPolicySchema.parse({})
}

/** Policy fields that keep their defaults unless the sharing preview is on. */
export const SHARING_PREVIEW_POLICY_KEYS = [
  "requirePassword",
  "levels",
  "liveLinks",
  "records",
  "recordsDefaultExpiryDays",
  "allowComments",
  "allowVisitorsSeeAll",
] as const satisfies readonly (keyof SharingPolicy)[]

/**
 * What the share dialog needs from the owner policy; sharers who aren't
 * owners see only this. Pause, Spaces and who may share reach the dialog as
 * `canCreate` and `createBlockedBy`.
 */
export type SharerPolicy = Omit<
  SharingPolicy,
  "paused" | "whoMayShare" | "spaces" | "agentLinks"
>

/** The owner policy, and whether the reader may change it. */
export interface SharingPolicyResponse {
  policy: SharingPolicy
  canEdit: boolean
  /**
   * Moves with every save. A save sends it back as `If-Match`, so one made
   * from an older copy is refused rather than undoing a newer change.
   */
  revision: number
}

// ---- Visitor comments ----------------------------------------------------

export const VISITOR_COMMENT_MAX_LENGTH = 2000
export const VISITOR_NAME_MAX_LENGTH = 60

export const VisitorCommentStatusSchema = z.enum([
  "new",
  "done",
  "passed",
  "deleted",
])
export type VisitorCommentStatus = z.infer<typeof VisitorCommentStatusSchema>

const CommentBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(VISITOR_COMMENT_MAX_LENGTH)

/** A visitor comment as members with Edit on the Space see it. Visitor names are never verified. */
export interface VisitorComment {
  id: string
  documentId: string
  linkId: string
  linkLabel: string
  /** Null when the visitor commented anonymously. */
  visitorName: string | null
  /** Null once erased: when deleted, and 30 days after passing on. */
  body: string | null
  receivedAt: string
  status: VisitorCommentStatus
  replies: VisitorCommentReply[]
  /** Set once a member passed it to the team as a comment or instruction. */
  passed: {
    by: { id: string; name: string }
    at: string
    annotationId: string
  } | null
  /** The link's creator, Space managers and owners may delete. */
  canDelete: boolean
}

export interface VisitorCommentReply {
  id: string
  author: { id: string; name: string }
  body: string
  createdAt: string
}

/** A document's visitor comments, for members. */
export interface VisitorCommentsResponse {
  comments: VisitorComment[]
  pausedLinks?: {id: string; label: string; canResume: boolean}[]
  nextCursor?: string | null
}

export const VisitorCommentReplyInputSchema = z.strictObject({
  body: CommentBodySchema,
})
export type VisitorCommentReplyInput = z.input<
  typeof VisitorCommentReplyInputSchema
>

/** The member's own words lead; the visitor's text follows as quoted outside input. */
export const PassVisitorCommentInputSchema = z.strictObject({
  category: AnnotationCategorySchema,
  /** What should happen. */
  note: z.string().trim().min(1).max(10_000),
  /** Starts as the visitor's text; the member may trim it. */
  quote: CommentBodySchema,
  includeName: z.boolean(),
})
export type PassVisitorCommentInput = z.input<
  typeof PassVisitorCommentInputSchema
>

/** A comment as visitors see it on the share page. Replies come from the team, never another visitor. */
export interface VisitorCommentForVisitor {
  id: string
  /** The name it was sent under; null when anonymous. */
  name: string | null
  body: string
  receivedAt: string
  /** Sent from this browser. */
  mine: boolean
  /** `from` is "The team", or the sharer's name when the link shows it. */
  replies: { body: string; from: string; at: string }[]
}

/** A link's comments as its share page shows them. With Visitors See `own`, every comment is the visitor's own. */
export interface VisitorCommentsForVisitor {
  accepting: boolean
  anonymousAllowed: boolean
  visitorsSee: VisitorsSee
  comments: VisitorCommentForVisitor[]
}

/** A visitor's new comment. A name is required unless the visitor comments anonymously. */
export const VisitorCommentInputSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(VISITOR_NAME_MAX_LENGTH)
      // Control characters, line and paragraph separators, and direction
      // overrides could break a name across lines or disguise it.
      .refine(
        (name) => !/[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u.test(name),
        { message: "Name must be one line of plain text" }
      )
      .optional(),
    anonymous: z.boolean().default(false),
    body: CommentBodySchema,
    /** Repeats with the same id from the same visitor store one comment. */
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .superRefine((input, ctx) => {
    if (input.anonymous === (input.name !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: input.anonymous
          ? "Anonymous comments have no name"
          : "Name is required",
      })
    }
  })
export type VisitorCommentInput = z.input<typeof VisitorCommentInputSchema>

export interface VisitorCommentCreated {
  id: string
  receivedAt: string
}
