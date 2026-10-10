/** Agents that run continuously and answer Worktable thread messages themselves. */
export interface AlwaysOnAgent {
  adapter: "openclaw" | "hermes"
  name: string
  installCommand: string
  restartCommand: string
  /** Whether the gateway restarts before connecting (OpenClaw) or after (Hermes). */
  restartBeforeConnect: boolean
  /** How the agent appears in Worktable Cloud's connections once it connects. */
  cloudAuth: "agent-registration" | "oauth"
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
  cloudAuth: "agent-registration",
  localConnectCommand: (serverOrigin, code) =>
    `openclaw worktable connect --server ${serverOrigin} --pairing-code ${code}`,
  cloudConnectCommand: (serverOrigin, participantName) =>
    `openclaw worktable connect --server ${serverOrigin} --agent-registration${participantName ? ` --participant-name ${shellQuote(participantName)}` : ""}`,
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
