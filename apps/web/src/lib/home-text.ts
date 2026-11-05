// Text on Home, made for reading at a glance.

// Agents connect under the name of the machine or service that runs them
// ("claude-code@laptop", "managed:claude-code"). Rows say which agent it is;
// the full name stays on hover, and each identity stays its own.
const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude",
  codex: "Codex",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
  openclaw: "OpenClaw",
  grok: "Grok",
  gemini: "Gemini",
}

export function readableAgentName(name: string): string {
  const bare = name.replace(/^managed:/i, "").replace(/@.*$/, "").trim()
  if (!bare) return name
  const known = AGENT_NAMES[bare.toLowerCase()]
  if (known) return known
  if (bare === name) return name
  return bare.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/** Text an agent wrote in Markdown, as one plain line of reading. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S.*?\S|\S)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
    .replace(/^\s{0,3}(#{1,6}|>|[-+*]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
}

