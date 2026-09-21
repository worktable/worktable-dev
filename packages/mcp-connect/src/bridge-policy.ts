import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"

const ALLOWED_CAPABILITIES = new Set(["tools"])

export type McpBridgeErrorCode =
  | "BAD_ENDPOINT"
  | "UNAUTHORIZED"
  | "UNAVAILABLE"
  | "TLS_OR_DNS"
  | "TIMEOUT"
  | "REDIRECT_REFUSED"
  | "PROTOCOL_MISMATCH"
  | "UNKNOWN"

export class McpBridgeError extends Error {
  readonly code: McpBridgeErrorCode

  constructor(
    code: McpBridgeErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "McpBridgeError"
    this.code = code
  }
}

export function parseMcpBridgeEndpoint(value: string): URL {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new McpBridgeError(
      "BAD_ENDPOINT",
      "Worktable MCP endpoint must be an absolute http:// or https:// URL."
    )
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new McpBridgeError(
      "BAD_ENDPOINT",
      "Worktable MCP endpoint must use http:// or https://."
    )
  }
  if (endpoint.username || endpoint.password) {
    throw new McpBridgeError(
      "BAD_ENDPOINT",
      "Worktable MCP endpoint must not contain embedded credentials."
    )
  }
  if (endpoint.hash) {
    throw new McpBridgeError(
      "BAD_ENDPOINT",
      "Worktable MCP endpoint must not contain a URL fragment."
    )
  }
  return endpoint
}

export function optionalMcpUserConfigValue(
  value: string | undefined
): string | undefined {
  const resolved = value?.trim()
  if (!resolved || /^\$\{user_config\.[A-Za-z0-9_.-]+\}$/.test(resolved)) {
    return undefined
  }
  return resolved
}

function causeCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const direct = (error as NodeJS.ErrnoException).code
  if (typeof direct === "string") return direct
  return causeCode((error as { cause?: unknown }).cause)
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = (error as { name?: unknown }).name
  const code = (error as { code?: unknown }).code
  const message = (error as { message?: unknown }).message
  return (
    name === "AbortError" ||
    code === -32001 ||
    (typeof message === "string" &&
      /timed?\s*out|request timeout/i.test(message))
  )
}

export function classifyMcpBridgeError(error: unknown): McpBridgeError {
  if (error instanceof McpBridgeError) return error
  if (
    error instanceof StreamableHTTPError &&
    (error.code === 401 || error.code === 403)
  ) {
    return new McpBridgeError(
      "UNAUTHORIZED",
      "Worktable rejected the connection. Add the access token shown in Worktable Settings, or replace a revoked or incorrect token.",
      { cause: error }
    )
  }
  if (isTimeout(error)) {
    return new McpBridgeError(
      "TIMEOUT",
      "Worktable did not initialize before the connection timed out.",
      { cause: error }
    )
  }
  const code = causeCode(error)
  if (code === "ECONNREFUSED" || code === "ECONNRESET") {
    return new McpBridgeError(
      "UNAVAILABLE",
      "Worktable is unavailable. Open Worktable Desktop or start the Worktable server, then try again.",
      { cause: error }
    )
  }
  if (
    code &&
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].includes(code)
  ) {
    return new McpBridgeError(
      "TLS_OR_DNS",
      "The self-hosted Worktable endpoint could not be reached securely. Check its address, DNS, and TLS certificate.",
      { cause: error }
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) {
    return new McpBridgeError(
      "UNAUTHORIZED",
      "Worktable rejected the connection. Add the access token shown in Worktable Settings, or replace a revoked or incorrect token.",
      { cause: error }
    )
  }
  if (/fetch failed|connect|socket|network/i.test(message)) {
    return new McpBridgeError(
      "UNAVAILABLE",
      "Worktable is unavailable. Open Worktable Desktop or start the Worktable server, then try again.",
      { cause: error }
    )
  }
  return new McpBridgeError(
    "UNKNOWN",
    "The Worktable MCP bridge stopped because of an unexpected error.",
    { cause: error }
  )
}

export function assertMcpBridgeToolsOnly(
  capabilities: Record<string, unknown> | undefined
): void {
  if (!capabilities?.["tools"]) {
    throw new McpBridgeError(
      "PROTOCOL_MISMATCH",
      "The Worktable server did not advertise the tools capability expected by this extension."
    )
  }
  const unsupported = Object.keys(capabilities).filter(
    (capability) => !ALLOWED_CAPABILITIES.has(capability)
  )
  if (unsupported.length > 0) {
    throw new McpBridgeError(
      "PROTOCOL_MISMATCH",
      `The Worktable server advertises unsupported MCP capabilities (${unsupported.join(", ")}). Update the Worktable Claude extension.`
    )
  }
}

export function sameOriginMcpFetch(
  origin: string,
  baseFetch: FetchLike = fetch
): FetchLike {
  return async (input, init) => {
    const requestUrl = new URL(typeof input === "string" ? input : input.href)
    if (requestUrl.origin !== origin) {
      throw new McpBridgeError(
        "REDIRECT_REFUSED",
        "Worktable redirected the MCP connection to another origin. The bridge refused to forward credentials."
      )
    }
    const response = await baseFetch(input, { ...init, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) {
      throw new McpBridgeError(
        "REDIRECT_REFUSED",
        "Worktable redirected the MCP connection. Update the extension endpoint to the final Worktable MCP URL."
      )
    }
    return response
  }
}
