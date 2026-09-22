import type { RequestPrincipal } from "../token-store.ts"

export const AGENT_ID = "worktable-agent"
export const DEFAULT_AGENT_PRINCIPAL: RequestPrincipal = {
  id: AGENT_ID,
  type: "agent",
  displayName: AGENT_ID,
  authorizedBy: "local:owner",
}

export function ok(data: unknown) {
  const structuredContent =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data),
      },
    ],
    ...(structuredContent ? { structuredContent } : {}),
  }
}

export function mkErr(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  }
}

export function mkAuthErr(
  message: string,
  origin: string,
  requiredScope: string
) {
  const resourceMetadata = new URL(
    "/.well-known/oauth-protected-resource" + (/^\/api\/mcp\/d\/[a-f0-9]{32}$/.test(new URL(origin).pathname) ? new URL(origin).pathname : ""),
    origin
  ).toString()
  return {
    ...mkErr(message),
    _meta: {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${resourceMetadata}", error="insufficient_scope", error_description="Additional authorization is required for this Worktable action.", scope="${requiredScope}"`,
      ],
    },
  }
}
