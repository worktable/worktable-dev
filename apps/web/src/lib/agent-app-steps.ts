// How apps that take the Worktable plugin, or a custom app with Worktable
// Cloud's address, connect. Onboarding and Settings show the same steps.
//
// The plugin comes from worktable/worktable-plugin. Claude updates it from
// there (Check for updates, or Sync automatically once the Claude GitHub App
// has access) and so does Antigravity. Uploaded copies and Perplexity's
// imports keep the version they started with.

/** Apps that take the plugin or a custom app, besides Claude and ChatGPT. */
export type PluginApp = "antigravity" | "gemini" | "perplexity"

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
  }
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
