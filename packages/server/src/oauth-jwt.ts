import { createRemoteJWKSet, jwtVerify } from "jose"
import {
  authorizationServerMetadataCandidates,
  sameAuthorizationServerIssuer,
  type AuthorizationServerMetadataName,
} from "@worktable/hosted-contract"
import type { TokenIdentity } from "./token-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"

// ============================================================
// AS-issued bearer validation (hosted auth)
// ============================================================
//
// When WORKTABLE_AUTH_SERVER_URL points at an OAuth authorization server
// (WorkOS AuthKit in Worktable Cloud), bearers may be JWTs issued by that
// server instead of locally minted wt_ tokens. Validation is strict and
// fail-closed:
//
//   - Discovery: RFC 8414 metadata at the AS supplies jwks_uri; keys are
//     fetched and cached by jose's remote JWK set (handles rotation).
//   - iss must equal the configured AS URL, aud must equal
//     WORKTABLE_RESOURCE_URL, alg is pinned to RS256, exp/nbf enforced.
//   - sub must equal WORKTABLE_OWNER_SUBJECT. The audience check alone
//     does not isolate tenants — any user of the shared AS can complete
//     an OAuth flow naming any instance's resource URL — so the subject
//     pin is what binds an instance to its owner. While either pin is
//     unset, NO AS bearer verifies.
//
// A verified JWT maps to the instance owner identity: v1 is one Personal
// instance per account, so the AS subject IS the owner. Scoped agent
// credentials remain locally minted wt_ tokens.

/**
 * The external OAuth authorization server, when one fronts this core.
 * Returned VERBATIM (whitespace aside): an issuer identifier is an exact
 * string, so it may legitimately carry a path (`/realms/acme`) or a
 * trailing slash, both of which appear unchanged in the JWT `iss`.
 * Normalize only for comparison (see `sameIssuer`), never for storage.
 */
export function getAuthServerUrl(): string | null {
  const url = process.env["WORKTABLE_AUTH_SERVER_URL"]?.trim()
  return url ? url : null
}

/** The AS subject (WorkOS user id) that owns this instance. */
export function getOwnerSubject(): string | null {
  const sub = process.env["WORKTABLE_OWNER_SUBJECT"]?.trim()
  return sub ? sub : null
}

/** The canonical resource URL AS-issued tokens must be audience-bound to. */
export function getExpectedAudience(): string | null {
  const aud = process.env["WORKTABLE_RESOURCE_URL"]?.trim()
  return aud ? aud : null
}

/**
 * What an AS-issued bearer may do: the content surface plus an explicit
 * portable workspace export, and nothing else.
 *
 * NOT `["*"]`. A hosted user's OAuth token is held by third-party MCP clients
 * (Claude, ChatGPT) and by a browser, and `"*"` makes `isLocalOwner()` true — which
 * would let any of them drive owner-only instance administration:
 * `POST /api/system/update`, `PUT /api/system/settings`. Those are operations
 * the FLEET performs, not something an MCP client should reach through a user's
 * token. The mint gate is already closed independently (requireMintAuth), and
 * omitting `tokens:manage` closes it a second way.
 *
 * Wildcards, so a new content tool is covered without a fleet-wide re-issue.
 */
const AS_BEARER_SCOPES = [
  "documents:*",
  "docs:*",
  "widgets:*",
  "records:*",
  "annotations:*",
  "threads:*",
  "search:read",
  "workspace:export",
]

// Three dot-separated base64url segments. wt_ tokens can never match.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function looksLikeJwt(raw: string): boolean {
  return JWT_SHAPE.test(raw)
}

// The AS's RFC 8414 metadata and jose's remote JWK set are cached per
// process (the JWK set refetches with a cooldown on unknown kid, which
// covers AS key rotation). Keyed by AS URL so a config change
// mid-process can't serve stale state.
interface AsMetadata {
  issuer?: unknown
  jwks_uri?: unknown
  scopes_supported?: unknown
}

/**
 * The well-known URLs to try for an issuer, in each spec's own order.
 * RFC 8414 §3.1 INSERTS the well-known segment between host and issuer
 * path (`https://host/.well-known/oauth-authorization-server/realms/acme`);
 * OIDC discovery APPENDS it (`https://host/realms/acme/.well-known/
 * openid-configuration`), which is what Keycloak-style providers serve —
 * so the appended form leads for the OIDC document and the inserted form
 * leads for OAuth metadata, with the other as fallback. A path-less
 * issuer collapses both forms to one URL.
 */
// Cached AS well-known documents, keyed by "<authServer> <name>". Serves
// both our own discovery needs (jwks_uri, scopes) and the passthrough
// well-known routes (clients that probe RFC 8414 / OIDC discovery on the
// RESOURCE origin must get the AS's JSON, never the SPA shell).
const wellKnownCache = new Map<string, Record<string, unknown>>()
let jwksCache: {
  authServer: string
  jwks: ReturnType<typeof createRemoteJWKSet>
} | null = null

let warnedMisconfigured = false

/** Test seam: drop the cached AS state and re-arm the misconfig warning. */
export function resetAuthServerJwtState(): void {
  wellKnownCache.clear()
  jwksCache = null
  warnedMisconfigured = false
}

// Hard cap on every AS network round-trip (discovery and JWKS). Without
// it, one stalled egress connection hangs every request awaiting the
// shared fetch — observed live as 13s bearer 401s that made both Claude
// and ChatGPT declare the whole server unreachable.
const AS_FETCH_TIMEOUT_MS = 3000

/**
 * Fetch (and cache) one of the AS's well-known documents. Throws on an
 * unreachable AS or a missing document; the 3s cap keeps a stalled
 * egress connection from hanging callers.
 */
export async function fetchAsWellKnown(
  authServer: string,
  name: AuthorizationServerMetadataName
): Promise<Record<string, unknown>> {
  const key = `${authServer} ${name}`
  const cached = wellKnownCache.get(key)
  if (cached) return cached
  let lastFailure = "no candidate URL"
  for (const url of authorizationServerMetadataCandidates(authServer, name)) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(AS_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      lastFailure = `status ${res.status}`
      continue
    }
    const document = (await res.json()) as Record<string, unknown>
    // RFC 8414 §3.3: the document's issuer MUST be the issuer we asked
    // about. Both discovery specs require the field. Without this check a
    // host-level document on a shared host could answer for a path-scoped
    // issuer and hand us ANOTHER tenant's jwks_uri — whose keys would
    // then verify tokens forged with our issuer's `iss`.
    const issuer = document["issuer"]
    if (
      typeof issuer !== "string" ||
      !sameAuthorizationServerIssuer(issuer, authServer)
    ) {
      lastFailure = `issuer mismatch at ${url.pathname}`
      continue
    }
    wellKnownCache.set(key, document)
    return document
  }
  throw new Error(`AS ${name} fetch failed: ${lastFailure}`)
}

async function asMetadataFor(authServer: string): Promise<AsMetadata> {
  return (await fetchAsWellKnown(
    authServer,
    "oauth-authorization-server"
  )) as AsMetadata
}

/**
 * The scope vocabulary of the configured AS, for the protected-resource
 * metadata to advertise. It must be the AS's scopes, not Worktable's
 * internal token scopes: MCP clients echo `scopes_supported` into their
 * authorize request, and an AS that doesn't know a scope error-redirects
 * the whole flow (`invalid_scope` — found live with Claude vs AuthKit).
 * Null (AS unreachable / nothing advertised) means omit the field.
 */
export async function authServerScopes(): Promise<string[] | null> {
  const authServer = getAuthServerUrl()
  if (!authServer) return null
  try {
    const metadata = await asMetadataFor(authServer)
    const scopes = metadata.scopes_supported
    if (
      Array.isArray(scopes) &&
      scopes.length > 0 &&
      scopes.every((s) => typeof s === "string")
    ) {
      return scopes as string[]
    }
    return null
  } catch {
    return null
  }
}

function jwksUriOf(document: Record<string, unknown>): string | null {
  const uri = document["jwks_uri"]
  return typeof uri === "string" && uri.length > 0 ? uri : null
}

async function jwksFor(
  authServer: string
): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (jwksCache?.authServer === authServer) return jwksCache.jwks

  // RFC 8414 metadata is the primary source. When an AS omits jwks_uri
  // there, fall back to its OIDC discovery document, where the field is
  // REQUIRED (OIDC Discovery 1.0 §3) — generic, not a guess at one
  // vendor's key path. Only if both omit it do we fail closed.
  let jwksUri = jwksUriOf(
    await fetchAsWellKnown(authServer, "oauth-authorization-server")
  )
  if (!jwksUri) {
    jwksUri = jwksUriOf(
      await fetchAsWellKnown(authServer, "openid-configuration")
    )
  }
  if (!jwksUri) {
    throw new Error("AS publishes no jwks_uri (RFC 8414 or OIDC discovery)")
  }
  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: AS_FETCH_TIMEOUT_MS,
  })
  jwksCache = { authServer, jwks }
  return jwks
}

/**
 * Best-effort boot-time warmup of the AS discovery metadata and JWKS.
 * The caches are per-process, so every restart starts cold — without
 * warmup the FIRST bearer after a restart pays (or hangs on) the AS
 * round-trips, because jose only fetches keys lazily on first verify.
 */
export async function warmAuthServerCaches(): Promise<void> {
  const authServer = getAuthServerUrl()
  if (!authServer) return
  try {
    const jwks = await jwksFor(authServer)
    await jwks.reload()
  } catch {
    // Unreachable AS at boot is not fatal: verification retries per
    // request and fails closed meanwhile.
  }
}

/**
 * Verify an AS-issued JWT bearer. Returns the owner identity on success,
 * null on any failure (bad signature, wrong iss/aud/sub, expired, AS
 * unreachable, or the AS/subject/resource pins not configured).
 */
export async function verifyAuthServerJwt(
  raw: string
): Promise<TokenIdentity | null> {
  const authServer = getAuthServerUrl()
  if (!authServer || !looksLikeJwt(raw)) return null

  const ownerSubject = getOwnerSubject()
  const audience = getExpectedAudience()
  if (!ownerSubject || !audience) {
    if (!warnedMisconfigured) {
      warnedMisconfigured = true
      console.warn(
        "[auth] WORKTABLE_AUTH_SERVER_URL is set but " +
          "WORKTABLE_OWNER_SUBJECT/WORKTABLE_RESOURCE_URL are not — " +
          "AS-issued bearers will be rejected until both are configured."
      )
    }
    return null
  }

  try {
    // The expected `iss` is the AS's OWN published issuer, not the
    // configured URL: an issuer identifier is an exact string and the
    // configured value may differ by a trailing slash. Guard the
    // substitution with the RFC 8414 §3.3 check (metadata issuer must
    // match the discovery URL it came from) so a hostile metadata
    // document can't redirect us to a different issuer.
    const metadata = await asMetadataFor(authServer)
    const issuer = typeof metadata.issuer === "string" ? metadata.issuer : null
    if (!issuer || !sameAuthorizationServerIssuer(issuer, authServer))
      return null

    const jwks = await jwksFor(authServer)
    const { payload } = await jwtVerify(raw, jwks, {
      issuer,
      audience,
      algorithms: ["RS256"],
      // jose validates exp only when present; a token template that omits
      // it would otherwise mint a NEVER-expiring owner bearer. This path
      // exists for short-lived AS tokens, so absence is a hard reject.
      requiredClaims: ["exp", "sub"],
    })
    if (typeof payload.sub !== "string") return null
    const subject = payload.sub
    const delegatedBy =
      payload.act &&
      typeof payload.act === "object" &&
      typeof (payload.act as { sub?: unknown }).sub === "string"
        ? (payload.act as { sub: string }).sub
        : null
    const workspaceOwner = delegatedBy ?? subject
    if (workspaceOwner !== ownerSubject) return null
    const isDelegatedAgent = delegatedBy !== null
    return {
      user: "owner",
      workspace: getWorkspaceRoot(),
      credentialClass: "resource",
      scopes: AS_BEARER_SCOPES,
      agent: isDelegatedAgent ? subject : null,
      principal: isDelegatedAgent
        ? {
            id: `workos-agent:${subject}`,
            type: "agent",
            displayName: "Connected agent",
            authorizedBy: `workos:${delegatedBy}`,
          }
        : {
            id: `workos:${subject}`,
            type: "human",
            displayName: "Worktable user",
          },
    }
  } catch {
    return null
  }
}
