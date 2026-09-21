import { formatMcpBridgeError, runMcpBridge } from "./bridge.ts"
import { optionalMcpUserConfigValue } from "./bridge-policy.ts"

const endpoint = process.env["WORKTABLE_MCP_URL"]?.trim() ?? ""

// Claude keeps optional MCPB environment entries in the manifest even when the
// user leaves them blank. In that case current Desktop builds pass the literal
// `${user_config.<field>}` placeholder to the child process. Treat unresolved
// user-config substitutions as absent rather than forwarding the placeholder as
// a bearer credential and turning a tokenless loopback connection into a 401.
const token = optionalMcpUserConfigValue(process.env["WORKTABLE_MCP_TOKEN"])
const clientName =
  process.env["WORKTABLE_BRIDGE_CLIENT_NAME"]?.trim() ||
  "worktable-claude-desktop"
const clientVersion =
  process.env["WORKTABLE_BRIDGE_CLIENT_VERSION"]?.trim() || "0.0.0"

async function main(): Promise<void> {
  try {
    await runMcpBridge({ endpoint, token, clientName, clientVersion })
  } catch (error) {
    process.stderr.write(`${formatMcpBridgeError(error)}\n`)
    process.exitCode = 1
  }
}

void main()
