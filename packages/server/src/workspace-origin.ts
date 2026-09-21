import { asHttpOrigin } from "./public-origin.ts"
import { isHosted } from "./hosted.ts"
import { getExpectedAudience } from "./oauth-jwt.ts"
import { getServerSettings } from "./settings-store.ts"

export type WorkspaceOriginSource =
  | "env"
  | "config"
  | "resource"
  | "request"
  | "fallback"

/**
 * Resolve an explicitly configured front door for this install. These values
 * are machine-local presentation state, never portable workspace metadata.
 */
export function resolveConfiguredWorkspaceOrigin(): {
  origin: string
  originSource: "env" | "config" | "resource"
} | null {
  const configured = process.env["WORKTABLE_PUBLIC_URL"]?.trim()
  if (configured) {
    const origin = asHttpOrigin(configured)
    if (origin) return { origin, originSource: "env" }
  }

  const fromConfig = getServerSettings().network.publicUrl
  if (fromConfig) {
    const origin = asHttpOrigin(fromConfig)
    if (origin) return { origin, originSource: "config" }
  }

  // Hosted/OAuth deployments expose the canonical MCP resource URL rather
  // than WORKTABLE_PUBLIC_URL. Its path identifies the MCP resource; its
  // origin is the public app front door used for document links.
  const resourceUrl = getExpectedAudience()
  if (resourceUrl) {
    const origin = asHttpOrigin(resourceUrl)
    if (origin) return { origin, originSource: "resource" }
  }

  return null
}

function localPort(): number {
  const parsed = Number(process.env["PORT"])
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : 7480
}

/**
 * Map a bind address to an address a client on this machine can reach.
 * Wildcard binds listen on loopback too; explicit hosts remain explicit.
 */
export function localClientHost(host: string): string {
  const trimmed = host.trim()
  const normalized = trimmed.toLowerCase()
  if (
    !trimmed ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  ) {
    return "127.0.0.1"
  }
  return trimmed
}

function hostForUrl(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host
  return host.includes(":") ? `[${host}]` : host
}

/** The connectable origin of the local HTTP service, using effective HOST/PORT. */
export function localServiceOrigin(): string {
  const host = hostForUrl(localClientHost(process.env["HOST"] ?? ""))
  return (
    asHttpOrigin(`http://${host}:${localPort()}`) ??
    `http://127.0.0.1:${localPort()}`
  )
}

/** The connectable local MCP endpoint, sharing the same HOST/PORT authority. */
export function localMcpEndpoint(): string {
  return `${localServiceOrigin()}/mcp`
}

/**
 * Resolve the best current-install origin for an HTTP request. Explicit
 * configuration wins over proxy/request metadata so every server surface uses
 * the same front door when an operator has chosen one.
 */
export function resolveWorkspaceOriginForRequest(request: Request): {
  origin: string
  originSource: WorkspaceOriginSource
} {
  const configured = resolveConfiguredWorkspaceOrigin()
  if (configured) return configured

  const forwardedHost = request.headers
    .get("X-Forwarded-Host")
    ?.split(",")[0]
    ?.trim()
  const forwardedProto = request.headers
    .get("X-Forwarded-Proto")
    ?.split(",")[0]
    ?.trim()
  if (forwardedHost) {
    const forwardedOrigin = asHttpOrigin(
      `${forwardedProto || "http"}://${forwardedHost}`
    )
    if (forwardedOrigin) {
      return {
        origin: forwardedOrigin,
        originSource: "request",
      }
    }
  }

  const requestOrigin = asHttpOrigin(request.url)
  if (requestOrigin) {
    return { origin: requestOrigin, originSource: "request" }
  }

  return { origin: localServiceOrigin(), originSource: "fallback" }
}

/**
 * Best origin available when there is no HTTP request to inspect, as with the
 * stdio MCP transport. Explicit public configuration wins; otherwise the URL
 * points at the local Worktable service.
 */
export function resolveLocalWorkspaceOrigin(): string {
  return resolveConfiguredWorkspaceOrigin()?.origin ?? localServiceOrigin()
}

/**
 * The MCP URL a remote client should use. Hosted deployments publish a
 * canonical resource URL at /api/mcp; other installs use the public origin's
 * /mcp mount.
 */
export function remoteMcpUrl(origin: string): string {
  const canonical = getExpectedAudience()
  if (canonical && asHttpOrigin(canonical)) return canonical
  return `${asHttpOrigin(origin) ?? localServiceOrigin()}${
    isHosted() ? "/api/mcp" : "/mcp"
  }`
}
