// How apps that take the Worktable plugin, or a custom app with Worktable
// Cloud's address, connect. Onboarding and Settings show the same steps.
//
// The plugin comes from worktable/worktable-plugin. Claude updates it from
// there (Check for updates, or Sync automatically once the Claude GitHub App
// has access) and so does Antigravity. Uploaded copies and Perplexity's
// imports keep the version they started with.

/** Apps that take the plugin or a custom app, besides Claude and ChatGPT. */
export type PluginApp = "antigravity" | "gemini" | "gemini-cli" | "perplexity"

export const PLUGIN_REPOSITORY = "https://github.com/worktable/worktable-plugin"

/** What Claude's Add marketplace takes. */
export const CLAUDE_MARKETPLACE = "worktable/worktable-plugin"

export const CLAUDE_PLUGIN_STEP =
  "In Claude, open Plugins, choose Add, then Add marketplace, and paste this. Add Worktable, then connect it on its Connectors tab and sign in."

export const APP_STEPS: Record<PluginApp, string> = {
  antigravity:
    "In Antigravity, install Worktable from Plugins, or run this. Then open /plugin, expand Worktable and sign in.",
  gemini:
    "In Gemini, open Customize, then Connectors, and choose Custom. Paste this address and sign in.",
  "gemini-cli":
    "Run this in your terminal. Then in Gemini CLI, run /mcp auth worktable and sign in.",
  perplexity:
    "In Perplexity, open Plugins, choose Add custom, then Import plugin from GitHub, and paste this. Then connect Worktable and sign in.",
}

/** What each app's step has you paste or run. */
export function appValue(app: PluginApp, mcpUrl: string): string {
  switch (app) {
    case "antigravity":
      return `agy plugin install ${PLUGIN_REPOSITORY}`
    case "perplexity":
      return PLUGIN_REPOSITORY
    case "gemini":
      return mcpUrl
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

export function codingPluginStep(
  client: string | null
): { step: string; command: string } | null {
  return client && Object.hasOwn(CODING_PLUGIN_STEPS, client)
    ? CODING_PLUGIN_STEPS[client as keyof typeof CODING_PLUGIN_STEPS]
    : null
}

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
 * Whether the plugin reaches this Worktable. Every plugin uses Worktable
 * Cloud's shared address, which signs in to the account's default Worktable;
 * another Worktable has its own address (/api/mcp/w/<id>), so its agents add
 * that address instead, without the plugin's skills.
 */
export function pluginReaches(mcpUrl: string): boolean {
  try {
    return new URL(mcpUrl).pathname.replace(/\/+$/, "") === "/api/mcp"
  } catch {
    return false
  }
}

/** Claude's step when the plugin can't reach this Worktable. */
export const CLAUDE_CONNECTOR_STEP =
  "In Claude, open Settings, then Connectors, and add a custom connector. Paste this address and sign in."

/** Any app's step when the plugin can't reach this Worktable. */
export const ADDRESS_STEP = "Add this address as a custom connector or MCP server, then sign in."
