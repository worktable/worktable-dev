/** Agents that run continuously and answer Worktable thread messages themselves. */
export interface AlwaysOnAgent {
  adapter: "openclaw" | "hermes"
  name: string
  installCommand: string
  restartCommand: string
  /** The agent also uses its paired credential for the workspace tools. */
  workspaceAccess: boolean
  /** Whether the gateway restarts before connecting (OpenClaw) or after (Hermes). */
  restartBeforeConnect: boolean
  localConnectCommand(serverOrigin: string, code: string): string
  cloudConnectCommand(serverOrigin: string): string
}

export const OPENCLAW_INSTALL_COMMAND =
  "openclaw plugins install clawhub:@worktable/openclaw"

export const OPENCLAW: AlwaysOnAgent = {
  adapter: "openclaw",
  name: "OpenClaw",
  installCommand: OPENCLAW_INSTALL_COMMAND,
  restartCommand: "openclaw gateway restart",
  workspaceAccess: false,
  restartBeforeConnect: true,
  localConnectCommand: (serverOrigin, code) =>
    `openclaw worktable connect --server ${serverOrigin} --pairing-code ${code}`,
  cloudConnectCommand: (serverOrigin) =>
    `openclaw worktable connect --server ${serverOrigin} --agent-registration`,
}

export const HERMES: AlwaysOnAgent = {
  adapter: "hermes",
  name: "Hermes",
  installCommand:
    "hermes plugins install worktable/worktable-dev#packages/hermes-plugin --enable",
  restartCommand: "hermes gateway restart",
  workspaceAccess: true,
  restartBeforeConnect: false,
  localConnectCommand: (serverOrigin, code) =>
    `hermes worktable connect ${serverOrigin} --pairing-code ${code}`,
  cloudConnectCommand: (serverOrigin) =>
    `hermes worktable connect ${serverOrigin}`,
}

export const ALWAYS_ON_AGENTS = [OPENCLAW, HERMES] as const
