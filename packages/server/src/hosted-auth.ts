import {
  AssertionKeyring,
  BROWSER_ASSERTION_TYPE,
  BrowserAssertionClaims,
  ENV,
  HOSTED_BROWSER_SCOPES,
  browserAssertionAudience,
  browserAssertionIssuer,
  browserRequestBinding,
} from "@worktable/hosted-contract"
import { base64url, jwtVerify } from "jose"
import type { TokenIdentity } from "./token-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { gatewayAdmits, trustedGatewayPrincipal } from "./hosted.ts"
import { verifyAuthServerJwt } from "./oauth-jwt.ts"

const REPLAY_TTL_MS = 120_000
const REPLAY_CACHE_LIMIT = 10_000
const replayed = new Map<string, number>()

// Keep the signed gateway scope set stable across mixed-version fleet deploys.
// Once a tenant has verified that exact browser credential, it may derive new
// browser-only authorities locally without making old tenants reject assertions
// minted by a newly deployed gateway.
export const HOSTED_BROWSER_RUNTIME_SCOPES = [
  ...HOSTED_BROWSER_SCOPES,
  "documents:*",
] as const

export class HostedCredentialError extends Error {
  readonly code: string
  readonly status: 401 | 503

  constructor(code: string, status: 401 | 503 = 401) {
    super(code)
    this.code = code
    this.status = status
  }
}

function keyring() {
  const raw = process.env[ENV.BROWSER_ASSERTION_KEYRING]
  if (!raw) return null
  try {
    const parsed = AssertionKeyring.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function requestHash(request: Request): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      browserRequestBinding(request.method, new URL(request.url))
    )
  )
  return base64url.encode(new Uint8Array(digest))
}

function consumesReplayEntry(request: Request): boolean {
  return (
    !["GET", "HEAD"].includes(request.method.toUpperCase()) ||
    request.headers.get("Upgrade")?.toLowerCase() === "websocket"
  )
}

function consumeJti(jti: string, now = Date.now()): void {
  for (const [candidate, expiresAt] of replayed) {
    if (expiresAt <= now) replayed.delete(candidate)
  }
  if (replayed.has(jti)) throw new HostedCredentialError("AUTH_REPLAYED")
  if (replayed.size >= REPLAY_CACHE_LIMIT) {
    throw new HostedCredentialError("AUTH_REPLAY_GUARD_BUSY", 503)
  }
  replayed.set(jti, now + REPLAY_TTL_MS)
}

function sameScopes(scopes: readonly string[]): boolean {
  return (
    scopes.length === HOSTED_BROWSER_SCOPES.length &&
    HOSTED_BROWSER_SCOPES.every((scope) => scopes.includes(scope))
  )
}

/** Verify a gateway assertion, including route binding and human attribution. */
export async function verifyHostedBrowserAssertion(
  request: Request,
  rawToken: string
): Promise<TokenIdentity | null> {
  if (!gatewayAdmits(request) || rawToken.length > 16_384) return null
  const workspaceId = process.env[ENV.CLOUD_WORKSPACE_ID]?.trim()
  const ownerSubject = process.env[ENV.OWNER_SUBJECT]?.trim()
  const publicResource = process.env[ENV.RESOURCE_URL]?.trim()
  const keys = keyring()
  if (!workspaceId || !ownerSubject || !publicResource || !keys) return null

  const publicBaseUrl = new URL(publicResource).origin
  try {
    const verified = await jwtVerify(
      rawToken,
      async (header) => {
        if (header.typ !== BROWSER_ASSERTION_TYPE || !header.kid) {
          throw new Error("wrong assertion type")
        }
        const match = keys.find((key) => key.kid === header.kid)
        if (!match) throw new Error("unknown assertion key")
        return base64url.decode(match.secret)
      },
      {
        algorithms: ["HS256"],
        issuer: browserAssertionIssuer(publicBaseUrl),
        audience: browserAssertionAudience(workspaceId),
        requiredClaims: ["sub", "iat", "nbf", "exp", "jti"],
        clockTolerance: 5,
      }
    )
    const parsed = BrowserAssertionClaims.safeParse(verified.payload)
    if (!parsed.success) return null
    const claims = parsed.data
    const now = Math.floor(Date.now() / 1000)
    if (
      claims.sub !== ownerSubject ||
      claims.wt.workspaceId !== workspaceId ||
      claims.wt.principal.id !== `workos:${ownerSubject}` ||
      claims.exp !== claims.iat + 60 ||
      claims.nbf !== claims.iat - 5 ||
      claims.iat > now + 5 ||
      !sameScopes(claims.wt.scopes) ||
      claims.wt.requestHash !== (await requestHash(request))
    ) {
      return null
    }
    const actor = trustedGatewayPrincipal(request)
    if (
      !actor ||
      actor.id !== claims.wt.principal.id ||
      actor.type !== claims.wt.principal.type ||
      actor.displayName !== claims.wt.principal.displayName ||
      actor.authorizedBy !== undefined
    ) {
      return null
    }
    if (consumesReplayEntry(request)) consumeJti(claims.jti)
    return {
      user: "owner",
      workspace: getWorkspaceRoot(),
      credentialClass: "browser",
      scopes: [...HOSTED_BROWSER_RUNTIME_SCOPES],
      agent: null,
      principal: claims.wt.principal,
    }
  } catch (error) {
    if (error instanceof HostedCredentialError) throw error
    return null
  }
}

export async function verifyHostedResourceToken(
  rawToken: string
): Promise<TokenIdentity | null> {
  return verifyAuthServerJwt(rawToken)
}

export async function verifyHostedCredential(
  request: Request,
  rawToken: string,
  allowedClasses: readonly ("browser" | "resource")[]
): Promise<TokenIdentity | null> {
  if (allowedClasses.includes("browser")) {
    const browser = await verifyHostedBrowserAssertion(request, rawToken)
    if (browser) return browser
  }
  return allowedClasses.includes("resource")
    ? verifyHostedResourceToken(rawToken)
    : null
}
