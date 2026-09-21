export type LabCommand =
  | "cloud"
  | "local"
  | "openclaw"
  | "auth"
  | "desktop"
  | "agent"
  | "client"
  | "clean"

export interface CommonOptions {
  command: LabCommand
  dryRun: boolean
  name?: string
  ttl: string
}

export type LabAuthMode = "ready" | "clean"

export interface AgentLabOptions {
  authMode: LabAuthMode
}

export interface CloudOptions extends CommonOptions {
  command: "cloud"
  origin: string
  authMode: LabAuthMode
}

export interface ClientOptions extends CommonOptions {
  command: "client"
  target?: string
  authMode: LabAuthMode
}

export type LocalSource = "release" | "checkout"

export interface LocalOptions extends CommonOptions, AgentLabOptions {
  command: "local"
  source: LocalSource
  fixture?: string
  hostPort?: number
  publicHost?: string
  rebuild: boolean
}

export interface OpenClawOptions extends CommonOptions, AgentLabOptions {
  command: "openclaw"
  source: LocalSource
  fixture?: string
  hostPort?: number
  publicHost?: string
  rebuild: boolean
  openclawSource?: string
}

export interface AuthOptions {
  command: "auth"
  dryRun: boolean
  ttl: string
  name?: string
  importHost: boolean
  openclawSource?: string
}

export interface DesktopOptions extends CommonOptions {
  command: "desktop"
  fixture?: string
  rebuild: boolean
  keep: boolean
}

export type DesktopLabAgent = "claude-code" | "codex" | "opencode"

export interface AgentOptions {
  command: "agent"
  client: DesktopLabAgent
  name?: string
  code?: string
  replace: boolean
}

export interface CleanOptions extends CommonOptions {
  command: "clean"
}

export type LabOptions =
  | CloudOptions
  | LocalOptions
  | OpenClawOptions
  | AuthOptions
  | DesktopOptions
  | AgentOptions
  | ClientOptions
  | CleanOptions

export interface NetworkInfo {
  lanAddress: string
  tailscaleAddress?: string
}

export interface AgentVersions {
  claude: string
  codex: string
  openclaw?: string
}

export type ProviderAuth =
  | {
      kind: "secret"
      envName:
        | "ANTHROPIC_API_KEY"
        | "CLAUDE_CODE_OAUTH_TOKEN"
        | "OPENAI_API_KEY"
      allowedHost: "api.anthropic.com" | "api.openai.com"
    }
  | { kind: "guest-login" }

export interface AgentPreflight {
  versions: AgentVersions
  auth: {
    claude: ProviderAuth
    codex: ProviderAuth
  }
}

export interface SandboxDescriptor {
  name: string
  owner: string
  callbackHostPort?: number
  worktableHostPort?: number
}

export interface LocalLabNetwork {
  hostPort: number
  publicHost: string
  publicOrigin: string
  lanOrigin: string
  loopbackOrigin: string
  tailscaleOrigin?: string
}
