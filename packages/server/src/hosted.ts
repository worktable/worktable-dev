import {
  ACTOR_HEADERS,
  GATEWAY_HEADER,
  HOSTED_AGENT_SCOPES,
  SHARE_CAPABILITY_HEADER,
} from "@worktable/hosted-contract"
import type { RequestPrincipal } from "./token-store.ts"

/**
 * Hosted-deployment posture flag.
 *
 * `WORKTABLE_HOSTED=1` marks this process as a Worktable Cloud tenant instance:
 * one customer's instance running in a per-tenant microVM behind the cloud
 * gateway, never a machine the owner shells into. The flag only ever tightens
 * posture — it forces the exposed-surface rules on regardless of bind address
 * or env ordering, so a hosted image can't silently boot into the
 * zero-ceremony local-trust mode if HOST/WORKTABLE_REQUIRE_AUTH get lost in a
 * runtime config change.
 *
 * Later milestones anchor hosted-only behavior here (AS-issued JWT validation,
 * trust-proxy handling for gateway-forwarded requests).
 */
export function isHosted(): boolean {
  return process.env["WORKTABLE_HOSTED"] === "1"
}

// ============================================================
// Gateway admission (hosted only)
// ============================================================
//
// A tenant sprite has a public URL, so without this anyone holding a valid
// AS-issued token could reach their instance DIRECTLY, bypassing the cloud
// gateway. That is not merely a wider attack surface: it is the hole through
// which a past-due tenant would keep working after the gateway stopped
// admitting them, so billing enforcement would not actually enforce.
//
// Every hosted request must therefore carry a per-tenant shared secret that
// only the gateway knows (it resolves the tenant, then injects the header).
// Per-tenant, not fleet-wide: one leaked secret compromises one instance.
//
// This is admission control, NOT authentication — it says "you came through
// the front door", never "you are the owner". Identity remains the AS-issued
// bearer (M1). Both must hold.

export { ACTOR_HEADERS, GATEWAY_HEADER, SHARE_CAPABILITY_HEADER }

export interface HostedDocumentSharingConfig {
  workspaceId: string
  shareOrigin: string
  htmlShareOrigin: string
}

function configuredHttpsOrigin(name: string): string | null {
  const value = process.env[name]?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/, "")) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

/** Sharing exists only on explicitly configured hosted deployments. */
export function getHostedDocumentSharingConfig(): HostedDocumentSharingConfig | null {
  if (!isHosted()) return null
  const workspaceId = process.env["WORKTABLE_CLOUD_WORKSPACE_ID"]?.trim()
  const shareOrigin = configuredHttpsOrigin("WORKTABLE_SHARE_BASE_URL")
  const htmlShareOrigin = configuredHttpsOrigin("WORKTABLE_HTML_SHARE_BASE_URL")
  if (
    !workspaceId ||
    !shareOrigin ||
    !htmlShareOrigin ||
    shareOrigin === htmlShareOrigin
  ) {
    return null
  }
  return { workspaceId, shareOrigin, htmlShareOrigin }
}

/** The tenant's expected gateway secret, when one is configured. */
export function gatewaySecret(): string | null {
  const secret = process.env["WORKTABLE_GATEWAY_SECRET"]?.trim()
  return secret ? secret : null
}

/**
 * Whether this request is admitted by the gateway guard.
 *
 * Only enforced when hosted; a local or self-hosted install has no gateway and
 * is unaffected. Hosted mode fails closed when the secret is missing as well
 * as when the presented value is absent or wrong.
 *
 * `/health` is deliberately exempt: it is the unauthenticated liveness probe
 * (the provisioner polls it before the tenant is reachable through any
 * gateway, and it leaks nothing).
 */
export function gatewayAdmits(req: Request): boolean {
  if (!isHosted()) return true
  const path = new URL(req.url).pathname
  if (path === "/health") return true

  const expected = gatewaySecret()
  if (!expected) return false

  const presented = req.headers.get(GATEWAY_HEADER)
  if (!presented) return false
  return timingSafeEqualStrings(presented, expected)
}

function validHeaderText(value: string | null, max: number): value is string {
  if (!value || value.length > max) return false
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code <= 31 || code === 127) return false
  }
  return true
}

/**
 * Actor context is trustworthy only on a fully admitted hosted request. It
 * refines attribution and never replaces bearer authorization.
 */
export function trustedGatewayPrincipal(req: Request): RequestPrincipal | null {
  if (!isHosted() || !gatewaySecret() || !gatewayAdmits(req)) return null
  const id = req.headers.get(ACTOR_HEADERS.ID)
  const type = req.headers.get(ACTOR_HEADERS.TYPE)
  const displayName = req.headers.get(ACTOR_HEADERS.NAME)
  const authorizedBy = req.headers.get(ACTOR_HEADERS.AUTHORIZED_BY)
  if (
    !validHeaderText(id, 256) ||
    !validHeaderText(displayName, 160) ||
    (type !== "human" && type !== "agent" && type !== "system") ||
    (authorizedBy !== null && !validHeaderText(authorizedBy, 256))
  ) {
    return null
  }
  return {
    id,
    type,
    displayName,
    ...(authorizedBy ? { authorizedBy } : {}),
  }
}

/**
 * A gateway policy can only remove authority already present in the bearer.
 * Missing scope context preserves the pre-policy rollout behavior; malformed
 * context fails closed to no agent scopes.
 */
export function trustedGatewayScopeCeiling(req: Request): string[] | null {
  if (!isHosted() || !gatewaySecret() || !gatewayAdmits(req)) return null
  const raw = req.headers.get(ACTOR_HEADERS.SCOPES)
  if (raw === null) return null
  if (raw.length > 2048) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !Array.isArray(parsed) ||
      parsed.some((scope) => typeof scope !== "string")
    ) {
      return []
    }
    const allowed = new Set<string>(HOSTED_AGENT_SCOPES)
    return [...new Set(parsed.filter((scope) => allowed.has(scope)))]
  } catch {
    return []
  }
}

/** Constant-time compare; a length mismatch is an immediate, safe reject. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
