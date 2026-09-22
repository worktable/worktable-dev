import { z } from "zod"

/** Separate from browser assertions and from the local owner's credentials. */
export const LINKED_ASSERTION_HEADER = "x-worktable-linked-assertion"
export const LINKED_ASSERTION_TYPE = "worktable-linked-request+jwt"
export const LINKED_ASSERTION_ISSUER = "worktable-cloud-linked-access"
export const LINKED_ASSERTION_TTL_SECONDS = 60
export const LINKED_REQUEST_MAX_BYTES = 8 * 1024 * 1024

export const LinkedEnrollment = z
  .object({
    controlHash: z.string().regex(/^[a-f0-9]{64}$/),
    workspaceEpoch: z.string().min(1).max(256),
    label: z.string().trim().min(1).max(80),
  })
  .strict()

export const LinkedHeartbeat = z
  .object({
    workspaceEpoch: z.string().min(1).max(256),
    bootSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    bootNonce: z.string().min(1).max(256),
    port: z.number().int().min(1024).max(65535),
    connected: z.boolean(),
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
      scopes: z.array(z.string().min(1).max(128)).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("share"),
      capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
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
      "/linked/health",
    ]),
    bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type LinkedRequestClaims = z.infer<typeof LinkedRequestClaims>
