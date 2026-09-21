import { timingSafeEqual } from "node:crypto"
import type { Context, Next } from "hono"
import {
  hasActiveTokens,
  hasScope,
  verifyToken,
  type TokenIdentity,
} from "./token-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { verifyOwnerSessionCookie } from "./session-store.ts"
import { getServerSettings, settingsFailClosed } from "./settings-store.ts"
import { asHttpOrigin } from "./public-origin.ts"
import { isHosted } from "./hosted.ts"
import {
  trustedGatewayPrincipal,
  trustedGatewayScopeCeiling,
} from "./hosted.ts"
import { HOSTED_AGENT_SCOPES } from "@worktable/hosted-contract"
import {
  getAuthServerUrl,
  getExpectedAudience,
  getOwnerSubject,
  verifyAuthServerJwt,
} from "./oauth-jwt.ts"
import {
  HostedCredentialError,
  verifyHostedBrowserAssertion,
  verifyHostedResourceToken,
} from "./hosted-auth.ts"

// ============================================================
// Request identity
// ============================================================
//
// Every authenticated request resolves to one TokenIdentity. Policy:
//
//   Bearer presented   -> must verify (minted token, the legacy
//                         WORKTABLE_MCP_TOKEN env value -> owner identity,
//                         or an AS-issued JWT -> owner/agent authorization
//                         when an authorization server fronts this core; see
//                         oauth-jwt.ts)
//   No credentials     -> implicit owner identity only for a literal same-machine
//                         loopback request while the exposure/explicit-auth gate
//                         is off. Minted tokens may coexist with this path; they
//                         identify individual connections rather than changing
//                         the deployment-wide trust model.
//
// trustedLocalIdentity() is the looser REST-era bridge: bare requests
// stay owner regardless (today's open REST behavior), but a presented
// bearer must still verify — so scoped agents can't escalate by simply
// omitting credentials they were given. Tightens in the REST-hardening
// step (sessions).

declare module "hono" {
  interface ContextVariableMap {
    identity: TokenIdentity
  }
}

export function ownerIdentity(): TokenIdentity {
  return {
    user: "owner",
    workspace: getWorkspaceRoot(),
    credentialClass: "local",
    scopes: ["*"],
    agent: null,
    principal: {
      id: "local:owner",
      type: "human",
      displayName: "Owner",
    },
  }
}

/** Whether the resolved request identity carries local owner authority. */
export function isLocalOwner(c: Context): boolean {
  const identity = c.get("identity")
  return Boolean(identity && identity.scopes.includes("*"))
}

/**
 * Whether this is the hosted workspace owner using Worktable Cloud in a
 * browser. The actor header is essential: the same AS bearer can be held by an
 * OAuth client, and the gateway deliberately classifies that path as an agent.
 */
export function isHostedBrowserOwner(c: Context): boolean {
  if (!isHosted()) return false
  const ownerSubject = getOwnerSubject()
  const principal = trustedGatewayPrincipal(c.req.raw)
  return Boolean(
    ownerSubject &&
    principal?.type === "human" &&
    principal.id === `workos:${ownerSubject}`
  )
}

/** Human-facing workspace preferences are manageable by either deployment's owner. */
export function canManageUserSettings(c: Context): boolean {
  return isLocalOwner(c) || isHostedBrowserOwner(c)
}

function withTrustedGatewayPrincipal(
  request: Request,
  identity: TokenIdentity
): TokenIdentity {
  const principal = trustedGatewayPrincipal(request)
  if (!principal) return identity
  const ceiling = trustedGatewayScopeCeiling(request)
  if (ceiling === null || principal.type === "human") {
    return { ...identity, principal }
  }
  const scopes = HOSTED_AGENT_SCOPES.filter(
    (scope) => hasScope(identity.scopes, scope) && hasScope(ceiling, scope)
  )
  return { ...identity, principal, scopes }
}

export { getAuthServerUrl } from "./oauth-jwt.ts"

/**
 * 401 with the RFC 9728 discovery hint when an authorization server is
 * configured — this header is what sends MCP clients into their OAuth
 * flow instead of a dead end. The hint prefers the configured canonical
 * resource URL (WORKTABLE_RESOURCE_URL): behind the hosted proxy the
 * request origin reads as the internal bind, not the public https origin
 * clients must fetch.
 */
export function unauthorized(c: Context) {
  if (getAuthServerUrl()) {
    let origin: string
    try {
      const configured = getExpectedAudience()
      origin = new URL(configured ?? c.req.url).origin
    } catch {
      origin = new URL(c.req.url).origin
    }
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
    )
  }
  return c.json({ error: "Unauthorized" }, 401)
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

const SUPERVISED_HOST_VERIFICATION_PATHS = new Set([
  "/api/workspace",
  "/api/spaces",
])

function supervisedHostVerificationMatches(c: Context): boolean {
  if (isHosted() || c.req.method !== "GET") return false
  if (!SUPERVISED_HOST_VERIFICATION_PATHS.has(c.req.path)) return false
  const expected = process.env["WORKTABLE_HOST_VERIFICATION_TOKEN"]?.trim()
  const presented = c.req.header("X-Worktable-Host-Verification")?.trim()
  return Boolean(expected && presented && safeEqual(expected, presented))
}

function bearerOf(c: Context): string | null {
  const header = c.req.header("Authorization")
  if (!header?.startsWith("Bearer ")) return null
  const raw = header.slice("Bearer ".length).trim()
  return raw.length > 0 ? raw : null
}

/**
 * Local credentials only: the legacy env token or a locally minted wt_
 * token. This is the verifier for the REST bridge and the token-mint gate —
 * AS-issued JWTs are deliberately NOT accepted there. An OAuth bearer is a
 * short-lived, revocable-at-the-AS credential scoped to the MCP surface;
 * letting it drive owner REST (e.g. POST /api/tokens) would let any
 * connected OAuth client mint a PERMANENT local credential, escaping the
 * OAuth token lifetime/revocation boundary.
 */
async function verifyLocalBearer(raw: string): Promise<TokenIdentity | null> {
  const legacy = process.env["WORKTABLE_MCP_TOKEN"] ?? ""
  if (legacy && safeEqual(raw, legacy)) return ownerIdentity()
  return verifyToken(raw)
}

/**
 * Resolve a presented bearer to an identity: the legacy env token, a locally
 * minted wt_ token, or — when an authorization server fronts this core — an
 * AS-issued JWT (strictly pinned; see oauth-jwt.ts). This is the MCP-surface
 * verifier, also exported for the WS upgrade gate (`?token=`): WS carries the
 * same realtime doc traffic the MCP tools expose and has no privileged
 * routes, so the OAuth credential is valid there too.
 */
export async function verifyBearer(raw: string): Promise<TokenIdentity | null> {
  // A hosted tenant has exactly one routable credential model: an AS-issued
  // bearer admitted through the Cloud gateway. Local wt_ and legacy env
  // credentials may exist only as residue in reused app storage; accepting
  // them here would create a credential that Cloud cannot inventory or revoke.
  // Local and self-hosted installations retain the existing local-first path.
  if (!isHosted()) {
    const local = await verifyLocalBearer(raw)
    if (local) return local
  }
  return isHosted() ? verifyHostedResourceToken(raw) : verifyAuthServerJwt(raw)
}

/** Hosted realtime accepts the route's explicit human or agent credential class. */
export async function verifyRealtimeCredential(
  request: Request,
  raw: string
): Promise<TokenIdentity | null> {
  if (!isHosted()) return verifyBearer(raw)
  const actor = trustedGatewayPrincipal(request)
  if (!actor) return null
  if (actor.type === "human") {
    const assertion = await verifyHostedBrowserAssertion(request, raw)
    if (assertion) return assertion
    // Compatibility for a v1 browser cookie while legacy/registered sessions drain.
    const legacy = await verifyHostedResourceToken(raw)
    return legacy ? withTrustedGatewayPrincipal(request, legacy) : null
  }
  const resource = await verifyHostedResourceToken(raw)
  return resource ? withTrustedGatewayPrincipal(request, resource) : null
}

/**
 * Whether a credential currently EXISTS for the MCP surface: a legacy env token
 * or any active minted token. Credential inventory is deliberately separate from
 * the bearer gate: scoped agent identities may coexist with implicit same-machine
 * owner access on a literal loopback endpoint.
 */
export async function mcpAuthConfigured(): Promise<boolean> {
  return (
    Boolean(process.env["WORKTABLE_MCP_TOKEN"]) || (await hasActiveTokens())
  )
}

/**
 * Whether the operator explicitly configured one legacy shared MCP credential.
 * Unlike a scoped token minted for one agent, this is a deployment-level policy
 * choice, so bare loopback requests must not silently bypass it.
 */
export function explicitMcpCredentialConfigured(): boolean {
  return Boolean(process.env["WORKTABLE_MCP_TOKEN"]?.trim())
}

/**
 * Whether a public-origin posture is configured for this install — either the
 * WORKTABLE_PUBLIC_URL env override or the machine-local settings
 * (`network.publicUrl`) yields a valid http(s) origin, or settings are in a
 * fail-closed state after a corrupt/unreadable read. A configured public URL
 * means this loopback-bound server is fronted by a tunnel/reverse proxy: an
 * exposed front door, even though the bind itself is loopback. That exposure is
 * exactly why the MCP surface must require a bearer (see `mcpBearerRequired`).
 */
export function publicOriginConfigured(): boolean {
  const env = process.env["WORKTABLE_PUBLIC_URL"]?.trim()
  if (env && asHttpOrigin(env)) return true
  const configured = getServerSettings().network.publicUrl
  return Boolean(configured && asHttpOrigin(configured)) || settingsFailClosed()
}

/**
 * Whether the MCP surface demands a bearer. True when ANY of:
 *   - the bind is exposed (`authRequired()` — non-loopback / WORKTABLE_REQUIRE_AUTH), or
 *   - an explicit legacy shared credential is configured, or
 *   - a public origin is configured (`publicOriginConfigured()` — a saved tunnel
 *     URL is an exposed front door reachable by anyone with the URL, even on a
 *     loopback bind, so bearer-less access must be refused), or
 *   - an authorization server is configured (`getAuthServerUrl()` — an AS
 *     fronting this core means bearers are the contract; bare requests must
 *     not bypass the OAuth flow the 401 hint advertises).
 *
 * While false, bare loopback MCP requests act as owner (zero-ceremony local use).
 * `requireIdentity()` and GET /api/system/connection (`mcpTokenRequired`) BOTH
 * derive from this one predicate so the connect card and the server can never
 * disagree about whether a token is required.
 */
export async function mcpBearerRequired(): Promise<boolean> {
  return (
    authRequired() ||
    explicitMcpCredentialConfigured() ||
    publicOriginConfigured() ||
    getAuthServerUrl() !== null
  )
}

/**
 * Whether browser/REST surfaces must require an explicit owner credential. This
 * is broader than `authRequired()`: a saved public origin means a tunnel or
 * reverse proxy can reach this loopback process, so bearer-less REST must not
 * keep using the local implicit-owner bridge.
 */
export function publicSurfaceAuthRequired(): boolean {
  return authRequired() || publicOriginConfigured()
}

/**
 * Whether the WS upgrade gate must demand a credential. Everything that
 * engages the REST gate, PLUS a configured authorization server: an AS
 * fronting this core makes the MCP surface bearer-only, and /ws + /yjs
 * carry the same workspace document traffic, so they must not stay open
 * on a bind-looks-local process that is actually fronted by a proxy.
 */
export function wsAuthRequired(): boolean {
  return publicSurfaceAuthRequired() || getAuthServerUrl() !== null
}

function isLiteralLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  )
}

/**
 * Bare local access is a same-machine owner convenience, not a network authentication
 * mechanism. Bind posture alone is insufficient: validating the request host
 * closes DNS-rebinding and spoofed non-loopback Host paths, while the Origin
 * and Fetch Metadata checks stop a cross-origin browser from driving the local
 * endpoints with the owner's ambient local trust.
 */
export function implicitLoopbackRequestAllowed(request: Request): boolean {
  let target: URL
  try {
    target = new URL(request.url)
  } catch {
    return false
  }
  if (!isLiteralLoopbackHostname(target.hostname)) return false

  return sameOriginRequestAllowed(request, false)
}

/** Browser ambient authority must not cross origins, including sibling ports. */
export function sameOriginRequestAllowed(request: Request, allowProxy = publicSurfaceAuthRequired()): boolean {
  const fetchSite = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase()
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false
  const origin = request.headers.get("Origin")
  if (!origin) {
    // Node's native fetch sends only Sec-Fetch-Mode: cors. It is a supported
    // local non-browser client, including the packaged Claude Desktop bridge.
    // Browsers send Site/Dest as well; an opaque or foreign Origin is never
    // admitted by this exception.
    const mode = request.headers.get("Sec-Fetch-Mode")
    return fetchSite === "same-origin" || fetchSite === "none" ||
      (!fetchSite && !request.headers.has("Sec-Fetch-Dest") && (mode === null || mode === "cors"))
  }
  const parsed = asHttpOrigin(origin)
  if (!parsed) return false
  const target = new URL(request.url)
  if (parsed === target.origin.replace(/^ws/, "http")) return true
  if (!allowProxy) return false
  const configured = process.env["WORKTABLE_PUBLIC_URL"]?.trim() || getServerSettings().network.publicUrl
  if (configured && parsed === asHttpOrigin(configured)) return true
  // Exposed deployments already trust their reverse proxy's forwarded headers.
  const host = request.headers.get("X-Forwarded-Host")?.split(",")[0]?.trim()
  const protocol = request.headers.get("X-Forwarded-Proto")?.split(",")[0]?.trim() || target.protocol.replace(":", "")
  return Boolean(host && parsed === asHttpOrigin(`${protocol}://${host}`))
}

export const implicitLoopbackMcpAllowed = implicitLoopbackRequestAllowed

/** Strict policy (MCP surface). Sets `identity` on the context. */
export function requireIdentity() {
  return async (c: Context, next: Next) => {
    const bearer = bearerOf(c)
    if (c.req.header("Authorization") !== undefined && !bearer) return unauthorized(c)
    if (bearer) {
      const identity = await verifyBearer(bearer)
      if (!identity) return unauthorized(c)
      if (isHosted() && trustedGatewayPrincipal(c.req.raw)?.type !== "agent") {
        return unauthorized(c)
      }
      c.set("identity", withTrustedGatewayPrincipal(c.req.raw, identity))
      return next()
    }
    if (await mcpBearerRequired()) return unauthorized(c)
    if (!implicitLoopbackRequestAllowed(c.req.raw)) return unauthorized(c)
    c.set("identity", ownerIdentity())
    return next()
  }
}

function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === "127.0.0.1" || h === "localhost" || h === "::1"
}

/**
 * True when the server is bound to be reachable from other machines. The CLI sets
 * `WORKTABLE_REQUIRE_AUTH=1` on any non-loopback bind, but as defense-in-depth a
 * non-loopback `HOST` alone also counts as exposed — so a raw `bun run` with
 * `HOST=0.0.0.0` and no flag still engages the exposed-surface posture (e.g. the
 * `/api/tokens` mint gate) instead of leaving it unauthenticated over the network.
 * A hosted tenant instance (`WORKTABLE_HOSTED=1`) is exposed by definition —
 * it always sits behind the cloud gateway — so the flag forces this on too.
 */
export function authRequired(): boolean {
  if (isHosted()) return true
  if (process.env["WORKTABLE_REQUIRE_AUTH"] === "1") return true
  const host = process.env["HOST"]?.trim()
  return Boolean(host && !isLoopbackBindHost(host))
}

/**
 * Mint-route hardening for the exposed surface. When auth is required
 * (`WORKTABLE_REQUIRE_AUTH=1`), an UNAUTHENTICATED request to the token-mint
 * route is rejected with 401 — otherwise a remote attacker on an exposed bind
 * could mint a permanent owner-equivalent credential through the REST local-trust
 * bridge. Threat-model rationale is unchanged; two credentials clear the gate:
 *
 *   - a verifying bearer (minted token or the legacy owner value), and
 *   - a valid owner-password session cookie — the browser Settings UI drives the
 *     mint routes as the cookie-authenticated owner, and trustedLocalIdentity
 *     already 401s any bare (cookie-less AND bearer-less) remote request, so the
 *     bearer-only rule's only remaining effect was locking out that legitimate
 *     owner.
 *
 * A configured public origin is also treated as exposed for token management:
 * even on a loopback bind, the saved tunnel/reverse-proxy URL is a public front
 * door, so bare requests must not be able to mint the bearer that `/mcp` now
 * requires. The CLI mints in-process (not over HTTP), so setup is unaffected. A
 * presented bearer still flows on to requireScope, which enforces tokens:manage
 * — so a narrow-scoped bearer clears this gate but is still 403'd on escalation.
 */
export function requireMintAuth() {
  return async (c: Context, next: Next) => {
    if (publicSurfaceAuthRequired()) {
      const bearer = bearerOf(c)
      // Local credentials only — an AS-issued OAuth bearer must not clear
      // the gate that mints permanent local credentials (see
      // verifyLocalBearer).
      const identity = bearer ? await verifyLocalBearer(bearer) : null
      if (!identity && !(await verifyOwnerSessionCookie(c))) {
        return unauthorized(c)
      }
    }
    return next()
  }
}

/**
 * Local-trust policy (REST bridge). Sets `identity` on the context.
 *
 * Bare (bearer-less) behavior depends on exposure:
 *   - flag off (loopback/default): implicit owner only for same-origin local
 *     app requests and non-browser callers addressing a literal loopback host.
 *   - flag/public-origin on (exposed): a valid owner-password session cookie
 *     is required; otherwise 401. The cookie surface is entirely separate from
 *     MCP's bearer surface (requireIdentity is untouched).
 *
 * A presented bearer ALWAYS takes the bearer path: it must verify, and a
 * verifying bearer (including the legacy WORKTABLE_MCP_TOKEN owner value) remains
 * an owner/agent credential on REST even when exposed — intended, so non-browser
 * tooling can drive REST with a token instead of a cookie.
 */
export function trustedLocalIdentity() {
  return async (c: Context, next: Next) => {
    // A supervised local host gets a fresh in-memory secret from its native
    // parent. It authenticates only the two read paths Desktop needs to verify
    // workspace identity and starter readiness; it is never persisted or
    // exposed by /health, and cannot authorize mutations or any hosted route.
    if (supervisedHostVerificationMatches(c)) {
      c.set("identity", ownerIdentity())
      return next()
    }
    const bearer = bearerOf(c)
    if (c.req.header("Authorization") !== undefined && !bearer) return unauthorized(c)
    if (bearer) {
      // AS-issued bearers ARE accepted here. A hosted tenant's whole web app
      // talks to /api/*, and its user authenticates with an AS bearer — REST
      // that rejected them would leave the cloud product with no working UI.
      //
      // This does NOT reopen the escalation M1 closed. That fix was never
      // about REST in general: it was about an OAuth bearer minting a
      // PERMANENT wt_ credential and escaping the AS's revocation. The mint
      // gate (requireMintAuth) verifies independently with verifyLocalBearer,
      // so /api/tokens stays local-only regardless of what happens here.
      // Locally nothing changes: with no AS configured, verifyBearer's AS path
      // returns null and this is byte-for-byte the old behavior.
      let identity: TokenIdentity | null
      try {
        if (isHosted()) {
          identity = await verifyHostedBrowserAssertion(c.req.raw, bearer)
          if (
            !identity &&
            trustedGatewayPrincipal(c.req.raw)?.type === "human"
          ) {
            // Existing v1 cookies remain usable during mode rollback/drain.
            identity = await verifyHostedResourceToken(bearer)
          }
        } else {
          identity = await verifyBearer(bearer)
        }
      } catch (error) {
        if (error instanceof HostedCredentialError) {
          return error.status === 503
            ? c.json(
                {
                  error: "Authentication replay guard is busy",
                  code: error.code,
                },
                503
              )
            : c.json({ error: "Unauthorized", code: error.code }, error.status)
        }
        throw error
      }
      if (!identity) return unauthorized(c)
      c.set("identity", withTrustedGatewayPrincipal(c.req.raw, identity))
      return next()
    }
    if (publicSurfaceAuthRequired()) {
      if (!sameOriginRequestAllowed(c.req.raw) || !(await verifyOwnerSessionCookie(c))) return unauthorized(c)
      c.set("identity", ownerIdentity())
      return next()
    }
    if (!implicitLoopbackRequestAllowed(c.req.raw)) return unauthorized(c)
    c.set("identity", ownerIdentity())
    return next()
  }
}

/** Guard a route on a scope. Use after an identity middleware. */
export function requireScope(scope: string) {
  return async (c: Context, next: Next) => {
    const identity = c.get("identity")
    if (!identity || !hasScope(identity.scopes, scope)) {
      return c.json({ error: "Forbidden", required: scope }, 403)
    }
    return next()
  }
}

/** Cross-domain workspace operations require the local or hosted browser owner. */
export function requireWorkspaceOwner() {
  return async (c: Context, next: Next) => {
    if (!canManageUserSettings(c)) return c.json({ error: "Forbidden", required: "owner" }, 403)
    return next()
  }
}

/** Human review is stronger than content-write permission, even for agents with `*`. */
export function requireHumanWorkspaceOwner() {
  return async (c: Context, next: Next) => {
    if (!canManageUserSettings(c) || c.get("identity")?.principal.type !== "human") {
      return c.json({ error: "Forbidden", required: "human-owner" }, 403)
    }
    return next()
  }
}

/** A credentialed agent cannot choose a human attribution through a REST body. */
export function restWriteActor(c: Context, requested?: string): string {
  const principal = c.get("identity")?.principal
  if (principal?.type === "human") return requested ?? "user"
  if (principal?.type === "agent") return `agent:${principal.id}`
  return "system"
}
