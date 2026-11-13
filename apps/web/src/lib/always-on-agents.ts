/** Agents that run continuously and answer Worktable thread messages themselves. */
export interface AlwaysOnAgent {
  adapter: "openclaw" | "hermes"
  name: string
  installCommand: string
  restartCommand: string
  /** Whether the gateway restarts before connecting (OpenClaw) or after (Hermes). */
  restartBeforeConnect: boolean
  /** How the agent joins Worktable Cloud: approved at a link it prints, or signed in. */
  cloudAuth: "approval" | "oauth"
  localConnectCommand(serverOrigin: string, code: string): string
  cloudConnectCommand(serverOrigin: string, participantName?: string): string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export const OPENCLAW_INSTALL_COMMAND =
  "openclaw plugins install clawhub:@worktable/openclaw"

export const OPENCLAW: AlwaysOnAgent = {
  adapter: "openclaw",
  name: "OpenClaw",
  installCommand: OPENCLAW_INSTALL_COMMAND,
  restartCommand: "openclaw gateway restart",
  restartBeforeConnect: true,
  cloudAuth: "approval",
  localConnectCommand: (serverOrigin, code) =>
    `openclaw worktable connect --server ${serverOrigin} --pairing-code ${code}`,
  cloudConnectCommand: (serverOrigin, participantName) =>
    `openclaw worktable connect --server ${serverOrigin}${participantName ? ` --participant-name ${shellQuote(participantName)}` : ""}`,
}

export const HERMES: AlwaysOnAgent = {
  adapter: "hermes",
  name: "Hermes",
  installCommand:
    "hermes plugins install worktable/worktable-dev#packages/hermes-plugin --enable",
  restartCommand: "hermes gateway restart",
  restartBeforeConnect: false,
  cloudAuth: "oauth",
  localConnectCommand: (serverOrigin, code) =>
    `hermes worktable connect ${serverOrigin} --pairing-code ${code}`,
  cloudConnectCommand: (serverOrigin, participantName) =>
    `hermes worktable connect ${serverOrigin}${participantName ? ` --name ${shellQuote(participantName)}` : ""}`,
}

export const ALWAYS_ON_AGENTS = [OPENCLAW, HERMES] as const

/** Keep the selected Worktable's complete OAuth resource in every copied install command. */
export function cloudConnectorCommand(
  mcpUrl: string,
  client: string = "auto"
): string {
  const origin = new URL(mcpUrl).origin
  return `curl -fsSL ${origin}/connect.sh | sh -s -- --oauth --server ${origin} --mcp-url ${shellQuote(mcpUrl)}${client === "auto" ? "" : ` --client ${client}`}`
}
