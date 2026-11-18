// Which apps connect to Worktable, and the one best way for each, by where
// this Worktable runs. Onboarding, Getting Started and Settings show the same.
//
// The best way gives the agent both the connection and Worktable's skills
// when anything can: a plugin, or a command that adds the skills too. The
// other ways stay one click away.
//
// The plugin comes from worktable/worktable-plugin and points at Worktable
// Cloud's shared address, which works in the Worktable chosen for that app
// (or the account's default). So it reaches a Worktable on Cloud, and a
// Worktable on a computer or server once Worktable Link is on. Claude updates
// it from there, and so does Antigravity. Uploaded copies and Perplexity's
// imports keep the version they started with.

import type {
  AgentPlatformId,
  ConnectorInstallableMcpClientId,
} from "@worktable/types"
import type { ConnectionInfo } from "./system-api"

/** Where this Worktable runs, which decides how an app reaches it. */
export type Place = "cloud" | "computer" | "server"

export function placeOf(connection: ConnectionInfo): Place {
  if (connection.mcpAuthMode === "oauth") return "cloud"
  return connection.reachable ? "server" : "computer"
}

export type AppId =
  | "claude"
  | "chatgpt"
  | "claude-code"
  | "codex"
  | "cursor"
  | "openclaw"
  | "hermes"
  | "gemini"
  | "gemini-cli"
  | "antigravity"
  | "perplexity"
  | "grok-bot"
  | "other"

export interface AgentApp {
  id: AppId
  name: string
  platform: AgentPlatformId
  /** Shown before More. */
  featured: boolean
  /** Apps that answer threads on their own. */
  alwaysOn?: boolean
  /** The Gemini app and Perplexity connect from their own servers: Cloud only. */
  cloudOnly?: boolean
}

export const AGENT_APPS: AgentApp[] = [
  { id: "claude", name: "Claude", platform: "claude", featured: true },
  { id: "chatgpt", name: "ChatGPT", platform: "chatgpt", featured: true },
  { id: "claude-code", name: "Claude Code", platform: "claude-code", featured: true },
  { id: "codex", name: "Codex", platform: "codex", featured: true },
  { id: "cursor", name: "Cursor", platform: "cursor", featured: true },
  { id: "openclaw", name: "OpenClaw", platform: "openclaw", featured: true, alwaysOn: true },
  { id: "hermes", name: "Hermes", platform: "hermes", featured: true, alwaysOn: true },
  { id: "gemini", name: "Gemini", platform: "gemini", featured: false, cloudOnly: true },
  { id: "gemini-cli", name: "Gemini CLI", platform: "gemini-cli", featured: false },
  { id: "antigravity", name: "Antigravity", platform: "antigravity", featured: false },
  { id: "perplexity", name: "Perplexity", platform: "perplexity", featured: false, cloudOnly: true },
  { id: "grok-bot", name: "Grok Bot", platform: "grok-bot", featured: false, alwaysOn: true },
  { id: "other", name: "Other", platform: "other", featured: false },
]

export function appsFor(place: Place): AgentApp[] {
  return AGENT_APPS.filter((app) => place === "cloud" || !app.cloudOnly)
}

/** Apps whose plugin or app is added in the app itself, after a copy. */
export type PluginApp = "antigravity" | "gemini-cli" | "perplexity"

/** One way to connect an app. */
export type Way =
  /** The Worktable plugin in Claude. `link` when it reaches this Worktable through Link. */
  | { kind: "claude-plugin"; link: boolean }
  /** The official Worktable app in ChatGPT. */
  | { kind: "chatgpt-app"; link: boolean }
  /** A coding agent's plugin, installed from the terminal. */
  | { kind: "coding-plugin"; client: "claude-code" | "codex" }
  /** A plugin added in the app from our repository. */
  | { kind: "app-plugin"; app: PluginApp }
  /** Worktable Cloud's address as a custom connector, with a sign-in. */
  | { kind: "address" }
  /** Claude's Add custom connector dialog, filled in. */
  | { kind: "claude-connector" }
  /** The connect command that signs in to Cloud and writes the agent's MCP settings. */
  | { kind: "cloud-command"; client: ConnectorInstallableMcpClientId | null }
  /** The connect command with a one-use code, then the skills. */
  | {
      kind: "pairing"
      client: ConnectorInstallableMcpClientId | null
      skills: "claude" | "agents" | null
    }
  /** OpenClaw or Hermes, with their own Worktable plugin. */
  | { kind: "always-on"; adapter: "openclaw" | "hermes" }
  | { kind: "grok" }
  /** Claude Desktop's extension, on this computer. */
  | { kind: "extension" }
  /** ChatGPT's desktop app, in Local chats on this computer. */
  | { kind: "chatgpt-local" }
  /** This Worktable's address and an access token. */
  | { kind: "token" }

export interface AppWays {
  best: Way
  others: Way[]
}

/** The best way to connect an app here, then the others that work. */
export function waysFor(app: AppId, place: Place): AppWays {
  const cloud = place === "cloud"
  switch (app) {
    case "claude":
      return cloud
        ? { best: { kind: "claude-plugin", link: false }, others: [{ kind: "claude-connector" }] }
        : {
            best: { kind: "claude-plugin", link: true },
            others: place === "computer" ? [{ kind: "extension" }] : [],
          }
    case "chatgpt":
      return cloud
        ? { best: { kind: "chatgpt-app", link: false }, others: [] }
        : {
            best: { kind: "chatgpt-app", link: true },
            others: place === "computer" ? [{ kind: "chatgpt-local" }] : [],
          }
    case "claude-code":
    case "codex":
      return cloud
        ? {
            best: { kind: "coding-plugin", client: app },
            others: [{ kind: "cloud-command", client: app }],
          }
        : {
            best: {
              kind: "pairing",
              client: app,
              skills: app === "claude-code" ? "claude" : "agents",
            },
            others: [],
          }
    case "cursor":
      return cloud
        ? { best: { kind: "cloud-command", client: "cursor" }, others: [] }
        : { best: { kind: "pairing", client: "cursor", skills: null }, others: [] }
    case "openclaw":
    case "hermes":
      return { best: { kind: "always-on", adapter: app }, others: [] }
    case "grok-bot":
      return { best: { kind: "grok" }, others: [] }
    case "gemini":
      return { best: { kind: "address" }, others: [] }
    case "antigravity":
    case "gemini-cli":
      return cloud
        ? { best: { kind: "app-plugin", app }, others: [] }
        : { best: { kind: "token" }, others: [] }
    case "perplexity":
      return { best: { kind: "app-plugin", app }, others: [] }
    case "other":
      return cloud
        ? { best: { kind: "address" }, others: [{ kind: "cloud-command", client: null }] }
        : { best: { kind: "pairing", client: null, skills: null }, others: [{ kind: "token" }] }
  }
}

/** Whether a way brings Worktable's skills along with the connection. */
export function bringsSkills(way: Way): boolean {
  switch (way.kind) {
    case "claude-plugin":
    case "chatgpt-app":
    case "coding-plugin":
    case "app-plugin":
    case "always-on":
      return true
    case "pairing":
      return way.skills !== null
    default:
      return false
  }
}

export const PLUGIN_REPOSITORY = "https://github.com/worktable/worktable-plugin"

/** What Claude's Add marketplace takes. */
export const CLAUDE_MARKETPLACE = "worktable/worktable-plugin"

export const SKILLS_GUIDE = "https://docs.worktable.dev/agents/skills/"

/** The Gemini app takes one skill folder. */
export const GEMINI_SKILL_DOWNLOAD =
  "https://docs.worktable.dev/downloads/skills/gemini/worktable.tar"

/** Installs only the skills, where an agent reads them. */
export function skillsCommand(target: "claude" | "agents"): string {
  return `curl -fsSL https://worktable.dev/install-skills | sh -s -- --target ${target}`
}

export const APP_STEPS: Record<PluginApp, string> = {
  antigravity:
    "In Antigravity, install Worktable from Plugins, or run this. Then open /plugin, expand Worktable and sign in.",
  "gemini-cli":
    "Run this in your terminal. Then in Gemini CLI, run /mcp auth worktable and sign in.",
  perplexity:
    "In Perplexity, open Plugins, choose Add custom, then Import plugin from GitHub, and paste this. Then connect Worktable and sign in.",
}

/** What each app's step has you paste or run. */
export function appValue(app: PluginApp): string {
  switch (app) {
    case "antigravity":
      return `agy plugin install ${PLUGIN_REPOSITORY}`
    case "perplexity":
      return PLUGIN_REPOSITORY
    case "gemini-cli":
      return `gemini extensions install ${PLUGIN_REPOSITORY} --auto-update`
  }
}

/**
 * Coding agents whose plugin carries Worktable's skills and server and keeps
 * itself current, installed from the terminal. Claude Code takes ours; Codex
 * takes the official one in OpenAI's catalog, which ChatGPT uses too.
 */
export const CODING_PLUGIN_STEPS = {
  "claude-code": {
    step: "Run this in your terminal. Then in Claude Code, run /reload-plugins and /mcp, and sign in to Worktable.",
    command: "claude plugin marketplace add worktable/worktable-plugin\nclaude plugin install worktable@worktable",
  },
  codex: {
    step: "Run this in your terminal, then open Codex and sign in to Worktable when it asks.",
    command: "codex plugin add worktable@openai-curated-remote",
  },
} as const satisfies Record<string, { step: string; command: string }>

/** Claude's Add custom connector dialog, filled in with this address. */
export function claudeConnectorLink(mcpUrl: string): string {
  const query = new URLSearchParams({
    modal: "add-custom-connector",
    connectorName: "Worktable",
    connectorUrl: mcpUrl,
  })
  return `https://claude.ai/customize/connectors?${query}`
}

/**
 * Whether Cloud's shared address lands in this Worktable for an app that
 * hasn't chosen one: it does in the account's default Worktable, which is
 * the one Cloud gives the shared address. Another Worktable has its own
 * (/api/mcp/w/<id>), and an app is moved there after it signs in.
 */
export function sharedAddressLandsHere(mcpUrl: string): boolean {
  try {
    return new URL(mcpUrl).pathname.replace(/\/+$/, "") === "/api/mcp"
  } catch {
    return false
  }
}

/** The plugin as a file, for apps that take an upload. An uploaded copy never updates. */
export const PLUGIN_DOWNLOAD = `${PLUGIN_REPOSITORY}/archive/refs/heads/main.zip`
