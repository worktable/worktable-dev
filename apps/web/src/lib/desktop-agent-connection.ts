import type { ConnectionInfo } from "./system-api"

export interface DesktopAgentConnectionDetails {
  endpoint: string
  needsToken: boolean
  publicUrlUsed: boolean
}

/** Shared setup posture for provider-native desktop applications. */
export function desktopAgentConnectionDetails(
  connection: Pick<
    ConnectionInfo,
    | "endpoint"
    | "remoteMcpUrl"
    | "reachable"
    | "originConfigured"
    | "mcpTokenRequired"
  >
): DesktopAgentConnectionDetails {
  const publicUrlUsed = connection.reachable || connection.originConfigured
  return {
    endpoint: publicUrlUsed ? connection.remoteMcpUrl : connection.endpoint,
    needsToken:
      connection.mcpTokenRequired || connection.reachable || publicUrlUsed,
    publicUrlUsed,
  }
}
