import { z } from "zod"

/** Separate from browser assertions and from the local owner's credentials. */
export const LINKED_ASSERTION_HEADER = "x-worktable-linked-assertion"
export const LINKED_ASSERTION_TYPE = "worktable-linked-request+jwt"
export const LINKED_ASSERTION_ISSUER = "worktable-cloud-linked-access"
export const LINKED_ASSERTION_TTL_SECONDS = 60
export const LINKED_REQUEST_MAX_BYTES = 8 * 1024 * 1024

/**
 * A linked Worktable's address in the account's directory, served at
 * `/api/mcp/w/<id>` like a hosted one. The prefix keeps it apart from hosted
 * ids, which never contain an underscore.
 */
export const LINKED_WORKTABLE_ID = /^wl_[a-f0-9]{32}$/
export const isLinkedWorktableId = (id: string): boolean =>
  LINKED_WORKTABLE_ID.test(id)
/** A new linked Worktable takes its first device's destination as its id. */
export const linkedWorktableIdFor = (destinationId: string): string =>
  `wl_${destinationId}`

export const LinkedEnrollment = z
  .object({
    controlHash: z.string().regex(/^[a-f0-9]{64}$/),
    workspaceEpoch: z.string().min(1).max(256),
    label: z.string().trim().min(1).max(80),
    /**
     * The folder's own id from its manifest. Relinking the same folder keeps
     * its directory entry and address. Devices released before it send none.
     */
    localWorkspaceId: z
      .string()
      .regex(/^ws_[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    /** The folder's Worktable name, for the account's list of Worktables. */
    localWorkspaceName: z.string().trim().min(1).max(100).optional(),
  })
  .strict()

/**
 * Share requests a device serves beyond the original contract. Each request
 * that needs one goes only to a device whose current boot named it in its
 * heartbeat. Older devices name none and reject the newer claims outright,
 * so a request sent without checking fails closed.
 */
export const LINKED_CAPABILITIES = {
  /**
   * `POST /public/share/unlock`, `unlock` on share grants, and a frame ticket
   * in place of the link token on `/public/share/content`.
   */
  SHARE_TICKETS: "share-tickets",
  /** `POST /public/share/bridge`. */
  SHARE_BRIDGE: "share-bridge",
  /** Signed client digests and conditional revisions on share reads. */
  SHARE_READ_HINTS: "share-read-hints",
  /** `GET` and `POST /public/share/comments`, and `visitor` on share grants. */
  SHARE_COMMENTS: "share-comments",
  /** Signed continuation markers on visitor-comment reads. */
  SHARE_COMMENT_PAGES: "share-comment-pages",
} as const

export const LinkedHeartbeat = z
  .object({
    workspaceEpoch: z.string().min(1).max(256),
    bootSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    bootNonce: z.string().min(1).max(256),
    port: z.number().int().min(1024).max(65535),
    connected: z.boolean(),
    /**
     * Names from LINKED_CAPABILITIES. Names Cloud doesn't know yet are
     * accepted and ignored, so a device can be newer than the gateway.
     */
    capabilities: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/))
      .max(32)
      .optional(),
    /**
     * Where the owner opens this Worktable on its device: the Workspace URL
     * from Settings, else the local address. Cloud links to it; it is never
     * a route into the Worktable.
     */
    openUrl: z
      .string()
      .max(2048)
      .url()
      .refine((value) => /^https?:\/\//.test(value))
      .optional(),
  })
  .strict()

const LinkedHostReplyBase = z.object({
  state: z.enum([
    "pending",
    "linked",
    "locked",
    "paused",
    "revoked",
    "superseded",
  ]),
  paused: z.boolean().optional(),
  installationId: z.string().optional(),
  destinationId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  /** Absent from Cloud versions before the directory; use `/d/` then. */
  worktableId: z.string().regex(LINKED_WORKTABLE_ID).optional(),
  ownerSubject: z.string().optional(),
  generation: z.number().int().positive().optional(),
  signingKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  tunnelToken: z.string().optional(),
  ready: z.boolean().default(false),
  publicOrigin: z.string().url(),
})
/** MCP-only deployments need no public document-sharing origins. */
export const LinkedHostReply = z.union([
  LinkedHostReplyBase.extend({
    sharingEnabled: z.literal(false).default(false),
  }),
  LinkedHostReplyBase.extend({
    sharingEnabled: z.literal(true),
    shareOrigin: z.string().url(),
    htmlShareOrigin: z.string().url(),
  }),
])

const identifier = z.string().min(1).max(256)

/** A link's token: 32 random bytes, base64url. */
export const ShareLinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/**
 * A short-lived ticket a Worktable mints for one of its links and alone
 * verifies: a password link's unlock ticket, or the frame ticket that stands
 * in for the link token in an HTML link's frame URL. Otherwise opaque, it is
 * dot-separated base64url parts, so it is never mistaken for a link token and
 * is safe in a header, a cookie and a URL path segment.
 */
export const ShareTicket = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/)

const visitorDigest = z.string().regex(/^[a-f0-9]{32,64}$/)

/** Opaque to the gateway; only the Worktable interprets its comment cursor. */
export const ShareCommentCursor = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/)

/**
 * What the gateway learned about a visitor commenting through a link. It is
 * the only party that sees the visitor's address or raw key; a Worktable
 * receives keyed digests of them.
 */
export const ShareVisitor = z
  .object({
    /** The gateway checked this visitor is a person, for this link. */
    verified: z.boolean(),
    /** Digest of the link and the visitor's own random key. */
    key: visitorDigest,
    /** Digest of the visitor's address and the day, for per-client limits. */
    client: visitorDigest.optional(),
  })
  .strict()
export type ShareVisitor = z.infer<typeof ShareVisitor>

export const LinkedDestinationBinding = z
  .object({
    installationId: identifier,
    destinationId: identifier,
    ownerSubject: identifier,
    workspaceEpoch: identifier,
    generation: z.number().int().positive(),
    bootNonce: identifier,
  })
  .strict()
export type LinkedDestinationBinding = z.infer<typeof LinkedDestinationBinding>

export const LinkedRequestGrant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("health") }).strict(),
  z
    .object({
      kind: z.literal("mcp"),
      principalId: identifier,
      displayName: z.string().min(1).max(256),
      credentialIssuedAt: z.number().int().positive().optional(),
      scopes: z.array(z.string().min(1).max(128)).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("share"),
      /** The link token, or on a frame request the frame ticket. */
      capability: z.union([ShareLinkToken, ShareTicket]),
      /** A password link's unlock ticket. */
      unlock: ShareTicket.optional(),
      clientAddress: z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .optional(),
      contentRevision: z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .optional(),
      visitor: ShareVisitor.optional(),
      /** Only on a comment GET/HEAD, with a pagination-capable current boot. */
      commentCursor: ShareCommentCursor.optional(),
    })
    .strict(),
])
export type LinkedRequestGrant = z.infer<typeof LinkedRequestGrant>

export const LinkedRequestClaims = z
  .object({
    binding: LinkedDestinationBinding,
    grant: LinkedRequestGrant,
    method: z.enum(["GET", "HEAD", "POST", "DELETE"]),
    path: z.enum([
      "/api/mcp",
      "/public/share",
      "/public/share/content",
      "/public/share/unlock",
      "/public/share/bridge",
      "/public/share/comments",
      "/linked/health",
    ]),
    bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type LinkedRequestClaims = z.infer<typeof LinkedRequestClaims>
