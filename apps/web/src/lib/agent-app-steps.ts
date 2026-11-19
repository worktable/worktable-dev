// Which apps connect to Worktable, and the one best way for each, by where
// this Worktable runs. Onboarding, Getting Started and Settings show the same.
//
// `waysFor` is the only place that decides an app's best way and the others.
// The best way gives the agent both the connection and Worktable's skills
// when anything can: a plugin, or a command that adds the skills too. Each
// way says how its skills arrive, so a new way to deliver them changes this
// table and `connectCommand`, not the screens.
//
// The plugin comes from worktable/worktable-plugin and points at Worktable
// Cloud's shared address, which works in the Worktable chosen for that app
// (or the account's default). So it reaches a Worktable on Cloud, and a
// Worktable on a computer or server once Worktable Link is on. Claude updates
// it from there, and so do Antigravity and VS Code. Uploaded copies and
// Perplexity's imports keep the version they started with. On a Cloud
// Worktable the shared address doesn't reach, an app leads with this
// Worktable's own address.

import type {
  AgentPlatformId,
  ConnectorInstallableMcpClientId,
} from "@worktable/types"
import { cloudConnectorCommand } from "./always-on-agents"
import type { ConnectionInfo } from "./system-api"
import { isLoopbackHost } from "./worktable-menu"

/** Where this Worktable runs, which decides how an app reaches it. */
export type Place = "cloud" | "computer" | "server"

/** The page this setup is open in. */
export interface Page {
  hostname: string
  /** Inside Worktable Desktop. */
  desktop: boolean
}

/**
 * A Worktable is on this computer when the page is: opened on loopback, or
 * in Desktop with a Worktable that isn't public. A server opened from another
 * machine is a server, whatever it binds to; a local install with a password,
 * opened on loopback, is still this computer.
 */
export function placeOf(connection: ConnectionInfo, page: Page): Place {
  if (connection.mcpAuthMode === "oauth") return "cloud"
  if (isLoopbackHost(page.hostname)) return "computer"
  const exposed = connection.reachable || connection.originConfigured
  return page.desktop && !exposed ? "computer" : "server"
}

/** Where an app would work, for choosing its way. */
export interface Where {
  place: Place
  /**
   * On Cloud, whether the shared address the plugins use lands in this
   * Worktable for the app: Cloud says so, or this is the account's default
   * Worktable and Cloud says nothing else.
   */
  sharedHere: boolean
}

export type AppId =
  | "claude"
  | "chatgpt"
  | "claude-code"
  | "codex"
  | "openclaw"
  | "hermes"
  | "grok-bot"
  | "cursor"
  | "opencode"
  | "kilo"
  | "vscode"
  | "copilot"
  | "gemini"
  | "gemini-cli"
  | "antigravity"
  | "devin"
  | "junie"
  | "cline"
  | "pi"
  | "droid"
  | "amp"
  | "zed"
  | "warp"
  | "kiro"
  | "perplexity"
  | "other"

export interface AgentApp {
  id: AppId
  name: string
  platform: AgentPlatformId
  /** Apps that answer threads on their own. */
  alwaysOn?: boolean
}

/**
 * Every app, in the order the picker shows them. An app shows only where
 * `waysFor` has a way that works, so a new client can be added here before
 * its setup works anywhere.
 */
export const AGENT_APPS: AgentApp[] = [
  { id: "claude", name: "Claude", platform: "claude" },
  { id: "chatgpt", name: "ChatGPT", platform: "chatgpt" },
  { id: "claude-code", name: "Claude Code", platform: "claude-code" },
  { id: "codex", name: "Codex", platform: "codex" },
  { id: "openclaw", name: "OpenClaw", platform: "openclaw", alwaysOn: true },
  { id: "hermes", name: "Hermes", platform: "hermes", alwaysOn: true },
  { id: "grok-bot", name: "Grok Bot", platform: "grok-bot", alwaysOn: true },
  { id: "cursor", name: "Cursor", platform: "cursor" },
  { id: "opencode", name: "OpenCode", platform: "opencode" },
  { id: "kilo", name: "Kilo", platform: "kilo" },
  { id: "vscode", name: "VS Code", platform: "vscode" },
  { id: "copilot", name: "Copilot CLI", platform: "copilot" },
  { id: "gemini", name: "Gemini", platform: "gemini" },
  { id: "gemini-cli", name: "Gemini CLI", platform: "gemini-cli" },
  { id: "antigravity", name: "Antigravity", platform: "antigravity" },
  { id: "devin", name: "Devin", platform: "devin" },
  { id: "junie", name: "Junie", platform: "junie" },
  { id: "cline", name: "Cline", platform: "cline" },
  { id: "pi", name: "Pi", platform: "pi" },
  { id: "droid", name: "Factory Droid", platform: "droid" },
  { id: "amp", name: "Amp", platform: "amp" },
  { id: "zed", name: "Zed", platform: "zed" },
  { id: "warp", name: "Warp", platform: "warp" },
  { id: "kiro", name: "Kiro", platform: "kiro" },
  { id: "perplexity", name: "Perplexity", platform: "perplexity" },
  { id: "other", name: "Other", platform: "other" },
]

/** The apps that can connect here. */
export function appsFor(place: Place): AgentApp[] {
  return AGENT_APPS.filter(
    (app) => waysFor(app.id, { place, sharedHere: true }) !== null
  )
}

const PLUGIN_APPS = [
  "antigravity",
  "vscode",
  "copilot",
  "gemini-cli",
  "perplexity",
] as const

/** Apps whose plugin or app is added in the app itself, after a copy. */
export type PluginApp = (typeof PLUGIN_APPS)[number]

export function isPluginApp(app: AppId): app is PluginApp {
  return (PLUGIN_APPS as readonly AppId[]).includes(app)
}

/**
 * Worktable's skills as a catalog OpenCode and Kilo load from a URL and keep
 * current. A Worktable on a computer or server serves its own at
 * /.well-known/skills/, which the connect command adds; Cloud apps use this
 * one, from the docs site.
 */
export const SKILL_CATALOG = "https://docs.worktable.dev/.well-known/skills/"

/** The Gemini app takes one skill folder. */
export const GEMINI_SKILL_DOWNLOAD =
  "https://docs.worktable.dev/downloads/skills/gemini/worktable.tar"

/** How Worktable's skills reach the agent on a way. */
export type Skills =
  /** The plugin carries them and keeps them current. */
  | { via: "plugin" }
  /**
   * The connect command installs Worktable Skills, the plugin's skills
   * without its Cloud server, with the agent's own plugin command (VS Code
   * gets Copilot CLI's). When that can't work it copies them from
   * Worktable's installer instead; Antigravity builds the plugin from the
   * skills this Worktable serves, or on Cloud the public ones. Pi takes the
   * plugin's repository as a package. Junie, Cline, Amp, Zed and Warp, with
   * no plugin command, get the copy.
   */
  | { via: "connect-plugin" }
  /** Worktable's installer adds them, as its own command beside an address. */
  | { via: "url"; target: "claude" | "agents" }
  /**
   * The app loads them from a skills address and keeps them current: the
   * connect command adds this Worktable's, or on Cloud SKILL_CATALOG, which
   * Cloud's address setup has you paste with the server.
   */
  | { via: "catalog" }
  /** A skill file to upload in the app. */
  | { via: "files"; href: string }
  | { via: "none" }

const PLUGIN: Skills = { via: "plugin" }
const NONE: Skills = { via: "none" }

/** One way to connect an app, and how its skills arrive. */
export type Way =
  /** The Worktable plugin in Claude. `link` when it reaches this Worktable through Link. */
  (
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
    /** The connect command that signs in to Cloud with this Worktable's own address. */
    | { kind: "cloud-command"; client: ConnectorInstallableMcpClientId | null }
    /** The connect command with a one-use code, straight to this Worktable. */
    | { kind: "pairing"; client: ConnectorInstallableMcpClientId | null }
    /** OpenClaw or Hermes, with their own Worktable plugin. */
    | { kind: "always-on"; adapter: "openclaw" | "hermes" }
    | { kind: "grok" }
    /** Claude Desktop's extension, on this computer. */
    | { kind: "extension" }
    /** ChatGPT's desktop app, in Local chats on this computer. */
    | { kind: "chatgpt-local" }
    /** This Worktable's address and an access token. */
    | { kind: "token" }
  ) & { skills: Skills }

export interface AppWays {
  best: Way
  others: Way[]
}

const CONNECT_PLUGIN: Skills = { via: "connect-plugin" }
const CATALOG: Skills = { via: "catalog" }

/** Clients the connect command connects and gives Worktable's skills. */
type CommandClient = Exclude<
  ConnectorInstallableMcpClientId,
  "cursor" | "kiro"
>

/**
 * The connect command first: with a one-use code off Cloud, through Cloud
 * with this Worktable's own address on it, where an app's own command or
 * file with the address is the other way, if it has one.
 */
function commandFirst(app: CommandClient, place: Place): AppWays {
  const skills =
    app === "opencode" || app === "kilo" ? CATALOG : CONNECT_PLUGIN
  if (place !== "cloud")
    return { best: { kind: "pairing", client: app, skills }, others: [] }
  const best: Way = { kind: "cloud-command", client: app, skills }
  const address = ADDRESS_SKILLS[app]
  return { best, others: address ? [{ kind: "address", skills: address }] : [] }
}

/** Apps whose own command or file adds Cloud's address, with their skills step. */
const ADDRESS_SKILLS: Partial<Record<CommandClient, Skills>> = {
  opencode: CATALOG,
  kilo: CATALOG,
  // Pi's and Droid's commands add the skills too.
  pi: PLUGIN,
  droid: PLUGIN,
  devin: { via: "url", target: "agents" },
  junie: { via: "url", target: "agents" },
  cline: { via: "url", target: "agents" },
  amp: { via: "url", target: "agents" },
  zed: { via: "url", target: "agents" },
  warp: { via: "url", target: "agents" },
}

/**
 * The best way to connect an app here, then the others that work. Null
 * where none works: the app isn't offered there.
 */
export function waysFor(app: AppId, where: Where): AppWays | null {
  const { place } = where
  const cloud = place === "cloud"
  switch (app) {
    case "claude":
      return cloud
        ? {
            best: { kind: "claude-plugin", link: false, skills: PLUGIN },
            others: [{ kind: "claude-connector", skills: NONE }],
          }
        : {
            best: { kind: "claude-plugin", link: true, skills: PLUGIN },
            others:
              place === "computer" ? [{ kind: "extension", skills: NONE }] : [],
          }
    case "chatgpt":
      return cloud
        ? {
            best: { kind: "chatgpt-app", link: false, skills: PLUGIN },
            others: [],
          }
        : {
            best: { kind: "chatgpt-app", link: true, skills: PLUGIN },
            others:
              place === "computer"
                ? [{ kind: "chatgpt-local", skills: NONE }]
                : [],
          }
    case "claude-code":
    case "codex": {
      if (!cloud) return commandFirst(app, place)
      const plugin: Way = { kind: "coding-plugin", client: app, skills: PLUGIN }
      // This Worktable's own address, so it works here whichever Worktable
      // the shared address picks.
      const command = commandFirst(app, place).best
      return where.sharedHere
        ? { best: plugin, others: [command] }
        : { best: command, others: [plugin] }
    }
    case "cursor":
      return cloud
        ? {
            best: { kind: "cloud-command", client: "cursor", skills: NONE },
            others: [],
          }
        : {
            best: { kind: "pairing", client: "cursor", skills: NONE },
            others: [],
          }
    // The connect command adds the skills: from a skills address for OpenCode
    // and Kilo, as a plugin or Pi package for Devin, Droid and Pi, and as a
    // copy for Junie, Cline and Amp. On Cloud, the app's own command or file
    // with the address stays under Other Ways.
    case "opencode":
    case "kilo":
    case "devin":
    case "junie":
    case "pi":
    case "droid":
    case "cline":
    case "amp":
      return commandFirst(app, place)
    // Zed and Warp have no command to see a connection work on a computer
    // or server, so they are offered on Cloud only, where they sign in in
    // the app. Kiro's connection needs a Kiro sign-in to check: not yet.
    case "zed":
    case "warp":
      return cloud ? commandFirst(app, place) : null
    case "kiro":
      return null
    case "openclaw":
    case "hermes":
      return {
        best: { kind: "always-on", adapter: app, skills: PLUGIN },
        others: [],
      }
    case "grok-bot":
      return { best: { kind: "grok", skills: NONE }, others: [] }
    // The Gemini app and Perplexity connect from their own servers: Cloud only.
    case "gemini":
      return cloud
        ? {
            best: {
              kind: "address",
              skills: { via: "files", href: GEMINI_SKILL_DOWNLOAD },
            },
            others: [],
          }
        : null
    // Their plugin comes first where Cloud's shared address lands here. Off
    // Cloud, and on Cloud for the others, the connect command adds Worktable
    // Skills with the app's plugin command.
    case "antigravity":
    case "vscode":
    case "copilot": {
      const command = commandFirst(app, place)
      if (!cloud) return command
      const plugin: Way = { kind: "app-plugin", app, skills: PLUGIN }
      return where.sharedHere
        ? { best: plugin, others: [command.best] }
        : { best: command.best, others: [plugin] }
    }
    case "perplexity":
    case "gemini-cli": {
      if (!cloud)
        return app === "gemini-cli"
          ? { best: { kind: "token", skills: NONE }, others: [] }
          : null
      const plugin: Way = { kind: "app-plugin", app, skills: PLUGIN }
      // This Worktable's own address, for when the plugin's lands elsewhere.
      const address: Way = { kind: "address", skills: NONE }
      return where.sharedHere
        ? { best: plugin, others: [address] }
        : { best: address, others: [plugin] }
    }
    case "other":
      return cloud
        ? {
            best: { kind: "address", skills: NONE },
            others: [{ kind: "cloud-command", client: null, skills: NONE }],
          }
        : {
            best: { kind: "pairing", client: null, skills: NONE },
            others: [{ kind: "token", skills: NONE }],
          }
  }
}

/** Whether a way brings Worktable's skills along with the connection. */
export function bringsSkills(way: Way): boolean {
  return way.skills.via !== "none"
}

/** Installs only the skills, where an agent reads them. */
export function skillsCommand(target: "claude" | "agents"): string {
  return `curl -fsSL https://worktable.dev/install-skills | sh -s -- --target ${target}`
}

/**
 * The one command a way runs in the terminal, which adds the skills too:
 * straight to this Worktable with a one-use code, or through Cloud with this
 * Worktable's address and the connector of its release.
 */
export function connectCommand(
  way: Extract<Way, { kind: "pairing" | "cloud-command" }>,
  to:
    | { connectScript: string; code: string }
    | { mcpUrl: string; release: string | null | undefined }
): string {
  return "code" in to
    ? `curl -fsSL ${to.connectScript} | sh -s -- ${to.code}${way.client ? ` --client ${way.client}` : ""}`
    : cloudConnectorCommand(to.mcpUrl, way.client ?? "auto", to.release)
}

export const PLUGIN_REPOSITORY = "https://github.com/worktable/worktable-plugin"

/** What Claude's Add marketplace takes. */
export const CLAUDE_MARKETPLACE = "worktable/worktable-plugin"

export const SKILLS_GUIDE = "https://docs.worktable.dev/agents/skills/"

export const APP_STEPS: Record<PluginApp, string> = {
  antigravity:
    "In Antigravity, install Worktable from Plugins, or run this. Then open /plugin, expand Worktable and sign in.",
  vscode:
    "In VS Code, run Chat: Install Plugin from Source and paste this. Then start worktable from its MCP servers list and sign in.",
  copilot:
    "Run this in your terminal. Then in Copilot CLI, run /mcp and sign in to worktable.",
  "gemini-cli":
    "Run this in your terminal. Then in Gemini CLI, run /mcp auth worktable and sign in.",
  perplexity:
    "In Perplexity, open Plugins, choose Add custom, then Import plugin from GitHub, and paste this. Then connect Worktable and sign in.",
}

/**
 * How an app adds this Worktable's address and signs in, and what it has you
 * paste or run.
 */
export function addressStep(
  app: AppId,
  mcpUrl: string
): { step: string; value: string } {
  switch (app) {
    case "gemini":
      return {
        step: "In Gemini, open Customize, then Connectors, and choose Custom. Paste this address and sign in.",
        value: mcpUrl,
      }
    case "gemini-cli":
      return {
        step: "Run this in your terminal. Then in Gemini CLI, run /mcp auth worktable and sign in.",
        value: `gemini mcp add --scope user --transport http worktable ${mcpUrl}`,
      }
    case "antigravity":
      return {
        step: "In Antigravity, add an MCP server with this address, then sign in.",
        value: mcpUrl,
      }
    case "vscode":
      return {
        step: "In VS Code, run MCP: Add Server, choose HTTP and paste this address. Then sign in.",
        value: mcpUrl,
      }
    case "copilot":
      return {
        // The full plugin's own server wins over a server added here.
        step: "If Copilot has the Worktable plugin, remove it first with copilot plugin uninstall worktable. Then run this in your terminal, and in Copilot CLI run /mcp and sign in to worktable.",
        value: `copilot mcp add --transport http worktable ${mcpUrl}`,
      }
    case "opencode":
      return {
        step: "Add this to ~/.config/opencode/opencode.json. Then run opencode mcp auth worktable and sign in.",
        value: catalogConfig(mcpUrl),
      }
    case "kilo":
      return {
        step: "Add this to ~/.config/kilo/kilo.jsonc. Then run kilo mcp auth worktable and sign in.",
        value: catalogConfig(mcpUrl),
      }
    case "devin":
      return {
        step: "Run this in your terminal, then sign in at the link it opens.",
        value: `devin mcp add --scope user worktable ${mcpUrl} && devin mcp login worktable`,
      }
    case "junie":
      return {
        step: "Add this to ~/.junie/mcp/mcp.json. Then in Junie, run /mcp, choose worktable and Authorize.",
        value: JSON.stringify(
          { mcpServers: { worktable: { url: mcpUrl } } },
          null,
          2
        ),
      }
    case "pi":
      return {
        step: "Run this in your terminal and sign in when your browser opens.",
        value: [
          `pi mcp add worktable --url ${mcpUrl}`,
          "pi mcp login worktable",
          `pi install git:github.com/${CLAUDE_MARKETPLACE}`,
        ].join("\n"),
      }
    case "droid":
      return {
        step: "Run this in your terminal and sign in when your browser opens.",
        value: [
          `droid mcp add worktable ${mcpUrl} --type http`,
          `droid plugin marketplace add ${CLAUDE_MARKETPLACE}`,
          "droid plugin install worktable-skills@worktable-plugin --scope user",
          "droid mcp auth",
        ].join("\n"),
      }
    case "amp":
      return {
        step: "Run this in your terminal. Then start a new Amp thread and sign in when Amp asks.",
        value: `amp mcp add worktable ${mcpUrl}`,
      }
    case "cline":
      return {
        step: "In Cline, open MCP Servers, then Configure, and add this. Then choose worktable and Authorize.",
        value: serverJson("mcpServers", { type: "streamableHttp", url: mcpUrl }),
      }
    case "zed":
      return {
        step: "Add this to your Zed settings, then sign in when Zed asks.",
        value: serverJson("context_servers", { url: mcpUrl }),
      }
    case "warp":
      return {
        step: "In Warp, open MCP servers, choose Add and paste this. Then start worktable and sign in.",
        value: serverJson("mcpServers", { url: mcpUrl }),
      }
    case "perplexity":
      return {
        step: "In Perplexity, open Connectors and add a custom connector with this address, then sign in.",
        value: mcpUrl,
      }
    default:
      return {
        step: "Add this address as a custom connector or MCP server, then sign in.",
        value: mcpUrl,
      }
  }
}

/** A server list holding Worktable alone, for pasting into an app's settings. */
function serverJson(key: string, server: Record<string, string>): string {
  return JSON.stringify({ [key]: { worktable: server } }, null, 2)
}

/** OpenCode's and Kilo's settings for Worktable on Cloud: the server and the skills. */
function catalogConfig(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcp: { servers: { worktable: { type: "remote", url: mcpUrl } } },
      skills: [SKILL_CATALOG],
    },
    null,
    2
  )
}

/** What each app's step has you paste or run. */
export function appValue(app: PluginApp): string {
  switch (app) {
    case "antigravity":
      return `agy plugin install ${PLUGIN_REPOSITORY}`
    case "vscode":
      return PLUGIN_REPOSITORY
    case "copilot":
      return `copilot plugin marketplace add ${CLAUDE_MARKETPLACE}\ncopilot plugin install worktable@worktable`
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
    command:
      "claude plugin marketplace add worktable/worktable-plugin\nclaude plugin install worktable@worktable",
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
