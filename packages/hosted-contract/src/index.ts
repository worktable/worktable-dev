import { z } from "zod"

// ============================================================
// Worktable Cloud billing contract
// ============================================================

/**
 * The public, provider-neutral offer. Amounts are minor currency units.
 *
 * Provider product, price, checkout, customer, and subscription identifiers
 * intentionally live outside this package so they can never leak into a
 * browser-facing DTO.
 */
export const CLOUD_PERSONAL_PLAN = {
  id: "personal",
  name: "Worktable Cloud Early Access",
  amount: 799,
  currency: "usd",
  interval: "month",
  initialRefundDays: 14,
  pastDueGraceDays: 7,
  supportEmail: "support@worktable.dev",
} as const

export const PublicPlanDetails = z.object({
  id: z.literal(CLOUD_PERSONAL_PLAN.id),
  name: z.literal(CLOUD_PERSONAL_PLAN.name),
  amount: z.literal(CLOUD_PERSONAL_PLAN.amount),
  currency: z.literal(CLOUD_PERSONAL_PLAN.currency),
  interval: z.literal(CLOUD_PERSONAL_PLAN.interval),
  initialRefundDays: z.literal(CLOUD_PERSONAL_PLAN.initialRefundDays),
  pastDueGraceDays: z.literal(CLOUD_PERSONAL_PLAN.pastDueGraceDays),
  supportEmail: z.literal(CLOUD_PERSONAL_PLAN.supportEmail),
})
export type PublicPlanDetails = z.infer<typeof PublicPlanDetails>

export const BillingAccess = z.enum([
  "payment_required",
  "active",
  "grace",
  "locked",
  "complimentary",
])
export type BillingAccess = z.infer<typeof BillingAccess>

export const BillingSubscription = z.object({
  status: z.string().min(1),
  currentPeriodEnd: z.number().int().nonnegative().optional(),
  cancelAtPeriodEnd: z.boolean(),
  graceEndsAt: z.number().int().nonnegative().optional(),
})
export type BillingSubscription = z.infer<typeof BillingSubscription>

export const BillingStatus = z.object({
  plan: PublicPlanDetails,
  access: BillingAccess,
  subscription: BillingSubscription.optional(),
  canCheckout: z.boolean(),
  canManageBilling: z.boolean(),
  canExport: z.boolean(),
})
export type BillingStatus = z.infer<typeof BillingStatus>

/** Stable browser-facing billing failures shared by gateway and control plane. */
export const BILLING_ERROR_CODES = {
  REQUIRED: "BILLING_REQUIRED",
  LOCKED: "BILLING_LOCKED",
  UNAVAILABLE: "BILLING_UNAVAILABLE",
  CHECKOUT_IN_PROGRESS: "CHECKOUT_IN_PROGRESS",
  CUSTOMER_IDENTITY_CONFLICT: "CUSTOMER_IDENTITY_CONFLICT",
} as const

// ============================================================
// Hosted tenant contract
// ============================================================
//
// The single source of truth for what a Worktable Cloud tenant instance
// expects in its environment. The control-plane provisioner PRODUCES this
// env; the core server (packages/server) CONSUMES it. They live in one
// repo precisely so this contract cannot drift: change a name or a shape
// here and both sides move together under the typechecker.
//
// Dependency direction is one-way: control-plane and (optionally) core may
// import this package; this package imports neither. It carries no secrets
// and no runtime — just names, shapes, and pure derivations.

/** Env var names the tenant server reads. Mirror of packages/server usage. */
export const ENV = {
  /** Bind host — always 0.0.0.0 inside the sprite, behind the gateway. */
  HOST: "HOST",
  /** Listen port — the sprite service's http_port. */
  PORT: "PORT",
  /** Forces the exposed-surface posture on regardless of bind (PR #100). */
  HOSTED: "WORKTABLE_HOSTED",
  /** Machine-local app data root (tokens, caches, Yjs state). */
  APP_DIR: "WORKTABLE_APP_DIR",
  /** Portable workspace root (the user's files: docs, records, ...). */
  WORKSPACE: "WORKTABLE_WORKSPACE",
  /** Built web client served as static assets. */
  STATIC_DIR: "WORKTABLE_STATIC_DIR",
  /** Fleet updates ship as new images, never the in-instance updater. */
  NO_UPDATE_CHECK: "WORKTABLE_NO_UPDATE_CHECK",
  /** The server release baked into the sprite image. */
  VERSION: "WORKTABLE_VERSION",
  /** OAuth authorization server (WorkOS AuthKit). Switches on M1 auth. */
  AUTH_SERVER_URL: "WORKTABLE_AUTH_SERVER_URL",
  /** This tenant's canonical MCP resource URL; AS tokens bind to it. */
  RESOURCE_URL: "WORKTABLE_RESOURCE_URL",
  /** The AS subject (WorkOS user id) that owns this instance. */
  OWNER_SUBJECT: "WORKTABLE_OWNER_SUBJECT",
  /** Stable control-plane workspace identity used by browser assertions. */
  CLOUD_WORKSPACE_ID: "WORKTABLE_CLOUD_WORKSPACE_ID",
  /** JSON keyring used only to verify gateway-minted browser assertions. */
  BROWSER_ASSERTION_KEYRING: "WORKTABLE_BROWSER_ASSERTION_KEYRING",
  /** Per-tenant gateway admission secret (see GATEWAY_HEADER). */
  GATEWAY_SECRET: "WORKTABLE_GATEWAY_SECRET",
  /** Public origin where unlisted document links are opened. */
  SHARE_BASE_URL: "WORKTABLE_SHARE_BASE_URL",
  /** Separate, disposable origin used only for executable shared HTML. */
  HTML_SHARE_BASE_URL: "WORKTABLE_HTML_SHARE_BASE_URL",
} as const

/**
 * The header the cloud gateway injects to prove a request came through the
 * front door. Admission control, NOT authentication: identity is still the
 * AS-issued bearer. Without it, anyone holding a valid token could reach a
 * tenant's public sprite URL directly and skip the gateway — which is also
 * how a past-due tenant would evade billing enforcement.
 *
 * Mirrors GATEWAY_HEADER in packages/server/src/hosted.ts; they live in one
 * repo so the two sides cannot drift.
 */
export const GATEWAY_HEADER = "x-worktable-gateway"

/** Capability forwarded privately after the gateway strips it from the URL. */
export const SHARE_CAPABILITY_HEADER = "x-worktable-share-capability"

const publicSourceUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === "https:" && !url.username && !url.password
    } catch {
      return false
    }
  }, "Expected an HTTPS source URL without credentials")

/**
 * Scriptless document projection returned by a tenant to the Cloud gateway.
 * The gateway owns the public viewer chrome and constructs the HTML-content
 * origin, so neither presentation assets nor the capability URL cross into
 * the tenant contract.
 */
export const PublicShareProjection = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("doc"),
      sourceUrl: publicSourceUrl.optional(),
      format: z.enum(["blocknote", "markdown"]),
      title: z.string(),
      projectionHtml: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("html"),
      sourceUrl: publicSourceUrl.optional(),
      title: z.string(),
    })
    .strict(),
])
export type PublicShareProjection = z.infer<typeof PublicShareProjection>

/** Trusted actor context injected only after gateway JWT verification. */
export const ACTOR_HEADERS = {
  ID: "x-worktable-actor-id",
  TYPE: "x-worktable-actor-type",
  NAME: "x-worktable-actor-name",
  AUTHORIZED_BY: "x-worktable-actor-authorized-by",
  /** JSON array of exact scopes, applied only as a ceiling to the bearer. */
  SCOPES: "x-worktable-actor-scopes",
} as const

/**
 * Optional self-presentation accepted only after Agent Registration verifies.
 * The gateway consumes and strips these before proxying to the tenant.
 */
export const AGENT_PRESENTATION_HEADERS = {
  ADAPTER: "x-worktable-agent-adapter",
  INSTALLATION: "x-worktable-agent-installation",
  LABEL: "x-worktable-agent-label",
  MACHINE: "x-worktable-agent-machine",
} as const

export type AuthorizationServerMetadataName =
  | "oauth-authorization-server"
  | "openid-configuration"

/** Issuer equality is exact except for an optional trailing slash. */
export function sameAuthorizationServerIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "")
}

/**
 * Candidate discovery URLs in each specification's preferred order.
 * RFC 8414 inserts the well-known segment before an issuer path, while OIDC
 * appends it. Trying both keeps every hosted auth consumer in parity.
 */
export function authorizationServerMetadataCandidates(
  authorizationServer: string,
  name: AuthorizationServerMetadataName
): URL[] {
  const issuer = new URL(authorizationServer)
  const path = issuer.pathname.replace(/\/+$/, "")
  const inserted = new URL(`/.well-known/${name}${path}`, issuer.origin)
  if (!path) return [inserted]
  const appended = new URL(`${path}/.well-known/${name}`, issuer.origin)
  return name === "openid-configuration"
    ? [appended, inserted]
    : [inserted, appended]
}

/**
 * Exact hosted agent vocabulary used to intersect an AS bearer with the
 * gateway's per-connection ceiling. Keep this explicit: intersecting wildcard
 * strings directly can accidentally turn a narrow ceiling into broad access.
 */
export const HOSTED_AGENT_SCOPES = [
  "annotations:read",
  "annotations:write",
  "documents:read",
  "documents:write",
  "docs:read",
  "docs:write",
  "records:read",
  "records:write",
  "search:read",
  "threads:participate",
  "threads:read",
  "threads:write",
  "widgets:read",
  "widgets:write",
  "workspace:export",
] as const

export const HOSTED_AGENT_PERMISSION_SCOPES = {
  "workspace-read": [
    "annotations:read",
    "documents:read",
    "docs:read",
    "records:read",
    "search:read",
    "widgets:read",
  ],
  "workspace-write": [
    "annotations:read",
    "annotations:write",
    "documents:read",
    "documents:write",
    "docs:read",
    "docs:write",
    "records:read",
    "records:write",
    "search:read",
    "widgets:read",
    "widgets:write",
  ],
  conversations: ["threads:participate", "threads:read", "threads:write"],
  export: ["workspace:export"],
} as const

export type HostedAgentPermissionGroup =
  keyof typeof HOSTED_AGENT_PERMISSION_SCOPES

export function scopesForHostedPermissionGroups(
  groups: readonly HostedAgentPermissionGroup[]
): string[] {
  return [
    ...new Set(
      groups.flatMap((group) => HOSTED_AGENT_PERMISSION_SCOPES[group])
    ),
  ]
}

/** Fixed hosted ceilings shared by admission, inventory, and audit records. */
export const HOSTED_AGENT_REGISTRATION_PERMISSION_GROUPS = [
  "conversations",
] as const satisfies readonly HostedAgentPermissionGroup[]

export const HOSTED_OAUTH_PERMISSION_GROUPS = [
  "workspace-read",
  "workspace-write",
  "conversations",
  "export",
] as const satisfies readonly HostedAgentPermissionGroup[]

export const HOSTED_AGENT_REGISTRATION_SCOPES = scopesForHostedPermissionGroups(
  HOSTED_AGENT_REGISTRATION_PERMISSION_GROUPS
)

export const HOSTED_OAUTH_SCOPES = scopesForHostedPermissionGroups(
  HOSTED_OAUTH_PERMISSION_GROUPS
)

/** Stable OAuth principal key shared by gateway attribution and revocation. */
export function hostedOAuthPrincipalId(
  clientId: string,
  ownerSubject: string
): string {
  return `oauth:${clientId}:${ownerSubject}`
}

// Fixed image contract — the layout baked into deploy/sprite (PR #100).
// Per-tenant values are the inputs below; these are constant across the fleet.
export const IMAGE = {
  /** Durable, object-storage-backed mount inside a Fly Sprite. */
  DATA_ROOT: "/data",
  WORKSPACE_DIR: "/data/workspace",
  APP_DIR: "/data/app",
  /** Static web assets shipped in the image (disposable, non-/data). */
  STATIC_DIR: "/app/web",
  /** The service's http port; the sprite proxy routes the public URL here. */
  PORT: 8080,
} as const

/**
 * The MCP endpoint path on a hosted tenant. NOT `/mcp`: the Fly Sprites
 * proxy reserves the literal `/mcp` path on every sprite URL for its own
 * feature and swallows non-POST methods there (found live in M1). Hosted
 * MCP lives at `/api/mcp`; the resource URL below is built from it.
 */
export const MCP_RESOURCE_PATH = "/api/mcp"

/** Browser assertions deliberately carry explicit content authority, never `*`. */
export const HOSTED_BROWSER_SCOPES = [
  "annotations:*",
  "docs:*",
  "records:*",
  "search:read",
  "system:*",
  "threads:*",
  "widgets:*",
  "workspace:*",
] as const

export const BROWSER_ASSERTION_TYPE = "wt-browser+jwt"
export const BROWSER_ASSERTION_TTL_SECONDS = 60

export const AssertionKey = z.object({
  kid: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/),
  /** A base64url-encoded, independently generated 32-byte secret. */
  secret: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/),
  state: z.union([z.literal("signing"), z.literal("verify-only")]),
})
export type AssertionKey = z.infer<typeof AssertionKey>

export const AssertionKeyring = z
  .array(AssertionKey)
  .min(1)
  .max(2)
  .superRefine((keys, ctx) => {
    if (new Set(keys.map((key) => key.kid)).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "key ids must be unique" })
    }
    if (keys.filter((key) => key.state === "signing").length !== 1) {
      ctx.addIssue({ code: "custom", message: "exactly one key must sign" })
    }
    if (keys.filter((key) => key.state === "verify-only").length > 1) {
      ctx.addIssue({
        code: "custom",
        message: "at most one key may verify only",
      })
    }
    if (new Set(keys.map((key) => key.secret)).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "key secrets must be unique" })
    }
  })
export type AssertionKeyring = z.infer<typeof AssertionKeyring>

export const BrowserAssertionClaims = z.object({
  iss: z.string().url(),
  aud: z.string().min(1),
  sub: z.string().min(1),
  iat: z.number().int(),
  nbf: z.number().int(),
  exp: z.number().int(),
  jti: z.string().uuid(),
  wt: z.object({
    credential: z.literal("browser"),
    workspaceId: z.string().min(1),
    requestHash: z
      .string()
      .length(43)
      .regex(/^[A-Za-z0-9_-]+$/),
    scopes: z.array(z.string().min(1)),
    principal: z.object({
      id: z.string().min(1),
      type: z.literal("human"),
      displayName: z.string().min(1),
    }),
  }),
})
export type BrowserAssertionClaims = z.infer<typeof BrowserAssertionClaims>

export function browserAssertionIssuer(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/_worktable/browser-assertions`
}

export function browserAssertionAudience(cloudWorkspaceId: string): string {
  return `urn:worktable:cloud:workspace:${cloudWorkspaceId}`
}

/** Exact input hashed by both gateway and tenant to bind an assertion to a request. */
export function browserRequestBinding(method: string, url: URL): string {
  return `${method.toUpperCase()}\n${url.pathname}${url.search}`
}

/**
 * The audience-bound MCP resource URL for a tenant.
 *
 * Built from the PUBLIC origin (the gateway), never the sprite: that is the
 * URL clients actually call, so it is what the token's audience must name and
 * what the 401 challenge must point at. Pointing it at the sprite would send a
 * re-authenticating client to a URL the gateway admission guard now blocks.
 *
 * Every tenant therefore shares one audience. That is safe only because the
 * tenant ALSO pins the token's `sub` to its owner (M1): audience alone cannot
 * isolate tenants on a shared authorization server, and never could.
 */
export function tenantResourceUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${MCP_RESOURCE_PATH}`
}

const httpUrl = z.string().refine(
  (value) => {
    try {
      const u = new URL(value)
      return u.protocol === "https:" || u.protocol === "http:"
    } catch {
      return false
    }
  },
  { message: "must be an http(s) URL" }
)

/** The per-tenant inputs the provisioner resolves before building env. */
export const TenantProvisionInput = z
  .object({
    /** Stable Cloud workspace id. In v1 this is the Convex workspace row id. */
    cloudWorkspaceId: z.string().min(1),
    /** The sprite's public base URL, e.g. https://<name>-<shard>.sprites.app.
     *  Taken from the Sprites create response, never reconstructed. */
    spriteBaseUrl: httpUrl,
    /** The public origin clients actually call — the gateway
     *  (https://app.worktable.cloud). Drives the MCP resource URL. */
    publicBaseUrl: httpUrl,
    /** The AuthKit authorization-server domain. */
    authServerUrl: httpUrl,
    /** The WorkOS user id that owns this instance (JWT `sub` must match). */
    ownerSubject: z.string().min(1),
    /** The server release baked into the sprite image (e.g. "0.0.25"). */
    version: z.string().min(1),
    /**
     * Per-tenant gateway admission secret. Per-tenant, never fleet-wide: one
     * leaked secret must compromise exactly one instance. Generated by the
     * provisioner and stored on the instance's registry row so the gateway can
     * look it up when it resolves the tenant.
     */
    gatewaySecret: z.string().min(32),
    /** Independent assertion keys. Never derived from the admission secret. */
    browserAssertionKeyring: AssertionKeyring,
    /** Both sharing origins are optional together, keeping rollout disabled by default. */
    shareBaseUrl: httpUrl.optional(),
    htmlShareBaseUrl: httpUrl.optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.browserAssertionKeyring.some(
        (key) => key.secret === input.gatewaySecret
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["browserAssertionKeyring"],
        message: "assertion keys must be independent from gateway admission",
      })
    }
    if (Boolean(input.shareBaseUrl) !== Boolean(input.htmlShareBaseUrl)) {
      ctx.addIssue({
        code: "custom",
        path: [input.shareBaseUrl ? "htmlShareBaseUrl" : "shareBaseUrl"],
        message: "both sharing origins must be configured together",
      })
    }
    if (input.shareBaseUrl && input.htmlShareBaseUrl) {
      const share = new URL(input.shareBaseUrl)
      const html = new URL(input.htmlShareBaseUrl)
      if (share.origin === html.origin) {
        ctx.addIssue({
          code: "custom",
          path: ["htmlShareBaseUrl"],
        message: "shared HTML projections must use a separate origin",
        })
      }
    }
  })
export type TenantProvisionInput = z.infer<typeof TenantProvisionInput>

/**
 * Build the exact environment a tenant service must run with. This is the
 * payload the provisioner hands to `sprite-env services create` (service
 * creation is guest-side over exec, not a REST route — the Sprites REST
 * `POST /services` returns 405). Deliberately sets NO static owner token:
 * M1 replaced the WORKTABLE_MCP_TOKEN bootstrap with AS-issued bearers on
 * both HTTP and the WS `?token=` gate, so a hosted tenant carries no
 * permanent owner-equivalent credential.
 */
export function buildTenantEnv(
  input: TenantProvisionInput
): Record<string, string> {
  const parsed = TenantProvisionInput.parse(input)
  return {
    [ENV.HOST]: "0.0.0.0",
    [ENV.PORT]: String(IMAGE.PORT),
    [ENV.HOSTED]: "1",
    [ENV.APP_DIR]: IMAGE.APP_DIR,
    [ENV.WORKSPACE]: IMAGE.WORKSPACE_DIR,
    [ENV.STATIC_DIR]: IMAGE.STATIC_DIR,
    [ENV.NO_UPDATE_CHECK]: "1",
    [ENV.VERSION]: parsed.version,
    [ENV.AUTH_SERVER_URL]: parsed.authServerUrl,
    [ENV.RESOURCE_URL]: tenantResourceUrl(parsed.publicBaseUrl),
    [ENV.OWNER_SUBJECT]: parsed.ownerSubject,
    [ENV.CLOUD_WORKSPACE_ID]: parsed.cloudWorkspaceId,
    [ENV.BROWSER_ASSERTION_KEYRING]: JSON.stringify(
      parsed.browserAssertionKeyring
    ),
    [ENV.GATEWAY_SECRET]: parsed.gatewaySecret,
    ...(parsed.shareBaseUrl && parsed.htmlShareBaseUrl
      ? {
          [ENV.SHARE_BASE_URL]: new URL(parsed.shareBaseUrl).origin,
          [ENV.HTML_SHARE_BASE_URL]: new URL(parsed.htmlShareBaseUrl).origin,
        }
      : {}),
  }
}
export * from "./linked-access.ts"

export * from "./public-share-policy.ts"
