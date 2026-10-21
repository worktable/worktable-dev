import { z } from "zod"
import { AnnotationCategorySchema } from "./annotations"
import { IsoTimestampSchema } from "./widgets"

// Share links: several per document, each with its own label, level, expiry
// and password, revocable on its own. Owner policy applies every time a link
// is used. Every route here is for people only; agents never reach them.

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

export const SHARE_LINK_LABEL_MAX_LENGTH = 80
const ShareLinkLabelSchema = z.string().trim().max(SHARE_LINK_LABEL_MAX_LENGTH)
const ShareLinkPasswordSchema = z.string().min(8).max(128)

/** Who sees a link's visitor comments: each visitor their own, or everyone holding the link. */
export const VisitorsSeeSchema = z.enum(["own", "all"])
export type VisitorsSee = z.infer<typeof VisitorsSeeSchema>

// Without defaults, so a partial update never resets the settings it omits.
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

const { shape: commentFields } = CommentSettingsFieldsSchema
export const ShareLinkCommentSettingsSchema = z.strictObject({
  acceptComments: commentFields.acceptComments.default(
    DEFAULT_SHARE_LINK_COMMENT_SETTINGS.acceptComments
  ),
  anonymousAllowed: commentFields.anonymousAllowed.default(
    DEFAULT_SHARE_LINK_COMMENT_SETTINGS.anonymousAllowed
  ),
  showSharerName: commentFields.showSharerName.default(
    DEFAULT_SHARE_LINK_COMMENT_SETTINGS.showSharerName
  ),
  visitorsSee: commentFields.visitorsSee.default(
    DEFAULT_SHARE_LINK_COMMENT_SETTINGS.visitorsSee
  ),
})

export interface ShareLinkComments extends ShareLinkCommentSettings {
  /** Comments were paused automatically after a burst; `acceptComments: true` resumes them. */
  autoPaused: boolean
}

export const ShareTargetSchema = z.strictObject({
  kind: ShareLinkKindSchema,
  spaceId: z.string().min(1).max(256),
  path: z.string().min(1).max(2048),
})
export type ShareTarget = z.infer<typeof ShareTargetSchema>

export const CreateShareLinkInputSchema = z.strictObject({
  target: ShareTargetSchema,
  label: ShareLinkLabelSchema.default(""),
  level: ShareLinkLevelSchema.default("view"),
  expiresAt: IsoTimestampSchema.nullable().default(null),
  password: ShareLinkPasswordSchema.optional(),
  comments: ShareLinkCommentSettingsSchema.default(
    DEFAULT_SHARE_LINK_COMMENT_SETTINGS
  ),
})
export type CreateShareLinkInput = z.infer<typeof CreateShareLinkInputSchema>

/** Only the fields present change. A new or removed password voids every unlocked visit. */
export const UpdateShareLinkInputSchema = z.strictObject({
  label: ShareLinkLabelSchema.optional(),
  level: ShareLinkLevelSchema.optional(),
  expiresAt: IsoTimestampSchema.nullable().optional(),
  password: ShareLinkPasswordSchema.nullable().optional(),
  comments: CommentSettingsFieldsSchema.partial().optional(),
})
export type UpdateShareLinkInput = z.infer<typeof UpdateShareLinkInputSchema>

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
  lastUsedAt: string | null
  status: ShareLinkStatus
  /** Present when `status` is `blocked`. */
  blockedBy?: ShareLinkBlockedBy
  /** The token's last characters, to tell links apart. The full URL is shown only when a link is made. */
  tokenHint: string
  canManage: boolean
  comments: ShareLinkComments
}

/** `GET /api/shares?kind&spaceId&path`. */
export interface DocumentShareLinks {
  links: ShareLink[]
  canCreate: boolean
  /** Present when `canCreate` is false. */
  createBlockedBy?: Extract<ShareLinkBlockedBy, "paused" | "space" | "sharer">
  /** The owner policy as it limits the share dialog. */
  policy: SharerPolicy
}

/** `POST /api/shares`. The only response that carries the link's URL. */
export interface CreatedShareLink {
  link: ShareLink
  url: string
}

/** `GET /api/shares/all`. */
export interface ShareLinksPage {
  links: ShareLink[]
  nextCursor: string | null
  /** Spaces the reader may filter by. */
  spaces: { id: string; name: string }[]
}

/** Sharing on a document page, without a request of its own. */
export const DocumentSharingSummarySchema = z.object({
  activeLinks: z.number().int().min(0),
  canCreate: z.boolean(),
  /** Present only to readers who may read visitor comments, when the document has a comment link or comments. */
  visitorComments: z.object({ newCount: z.number().int().min(0) }).optional(),
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

/** Defaults reproduce sharing as it was before owner policy existed. */
export const SharingPolicySchema = z.strictObject({
  /** Stops every link, and visitor comments, at once. */
  paused: z.boolean().default(false),
  whoMayShare: z
    .enum(["owners", "space-managers", "editors"])
    .default("space-managers"),
  spaces: z
    .discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("all") }),
      z.strictObject({
        mode: z.literal("selected"),
        spaceIds: z.array(z.string().min(1).max(256)).max(1000),
      }),
    ])
    .default({ mode: "all" }),
  requirePassword: z.boolean().default(false),
  maxExpiryDays: DAYS.nullable().default(null),
  levels: z
    .array(ShareLinkLevelSchema)
    .min(1)
    .refine((levels) => new Set(levels).size === levels.length, {
      message: "Levels must be unique",
    })
    .default(["view"]),
  liveLinks: z.boolean().default(false),
  records: z.enum(SHARING_RECORD_ACCESS).default("scoped"),
  /** The expiry a new link that reaches Records starts with. */
  recordsDefaultExpiryDays: DAYS.nullable().default(30),
  /** Comment links take comments. Off stops new comments without stopping the links. */
  allowComments: z.boolean().default(true),
  /** Sharers may set a link's Visitors See to every comment on it. */
  allowVisitorsSeeAll: z.boolean().default(true),
  /** Agents can't make links. A later version widens this to `view`. */
  agentLinks: z.enum(["off"]).default("off"),
})
export type SharingPolicy = z.infer<typeof SharingPolicySchema>

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

/** What the share dialog needs from the owner policy; sharers who aren't owners see only this. */
export type SharerPolicy = Pick<
  SharingPolicy,
  | "levels"
  | "maxExpiryDays"
  | "requirePassword"
  | "recordsDefaultExpiryDays"
  | "allowComments"
  | "allowVisitorsSeeAll"
>

/** `GET` and `PUT /api/shares/policy`. `PUT` takes a whole policy. */
export interface SharingPolicyResponse {
  policy: SharingPolicy
  canEdit: boolean
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

/** `GET /api/spaces/:spaceId/visitor-comments?documentId&status`. */
export interface VisitorCommentsResponse {
  comments: VisitorComment[]
}

export const VisitorCommentReplyInputSchema = z.strictObject({
  body: CommentBodySchema,
})
export type VisitorCommentReplyInput = z.infer<
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
export type PassVisitorCommentInput = z.infer<
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

/** `GET /comments` on a share link. With Visitors See `own`, every comment is the visitor's own. */
export interface VisitorCommentsForVisitor {
  accepting: boolean
  anonymousAllowed: boolean
  visitorsSee: VisitorsSee
  comments: VisitorCommentForVisitor[]
}

/** `POST /comments` on a share link. A name is required unless the visitor comments anonymously. */
export const VisitorCommentInputSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(VISITOR_NAME_MAX_LENGTH)
      .refine((name) => !/[\r\n]/.test(name), {
        message: "Name must be one line",
      })
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
export type VisitorCommentInput = z.infer<typeof VisitorCommentInputSchema>

export interface VisitorCommentCreated {
  id: string
  receivedAt: string
}
