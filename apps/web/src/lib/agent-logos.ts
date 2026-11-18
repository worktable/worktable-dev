/**
 * How a mark sits in a round avatar. `pad` insets artwork drawn to its
 * edges; `inset` is artwork with its own margin, drawn a little larger;
 * `fill` covers the circle.
 */
export type AgentLogoFit = "pad" | "inset" | "fill"

export interface AgentLogo {
  /** Stored as the agent's icon, `logo-<id>`, which also passes icon-name checks. */
  key: string
  name: string
  /** File in the web app's `/agent-logos/` directory. */
  file: string
  /** Other words people search for it by. */
  aliases?: string
}

const FITS: Record<string, AgentLogoFit> = {
  "hermes.png": "fill",
  "openai.svg": "inset",
  "goose.png": "inset",
}

export function agentLogoFit(file: string): AgentLogoFit {
  return FITS[file] ?? "pad"
}

const logo = (
  id: string,
  name: string,
  file = `${id}.svg`,
  aliases?: string
): AgentLogo => ({ key: `logo-${id}`, name, file, aliases })

// Marks owners can pick for any agent, most familiar first. NOTICE.txt in
// the logo directory records where each file came from.
export const AGENT_LOGOS: readonly AgentLogo[] = [
  logo("claude", "Claude"),
  logo("claude-code", "Claude Code"),
  logo("anthropic", "Anthropic"),
  logo("openai", "OpenAI", "openai.svg", "chatgpt gpt"),
  logo("codex", "Codex", "codex.svg", "openai"),
  logo("gemini", "Gemini", "gemini.png", "google"),
  logo("gemini-cli", "Gemini CLI", "gemini-cli.svg", "google"),
  logo("grok", "Grok", "grok.svg", "xai"),
  logo("grok-bot", "Grok Bot", "grok-bot.svg", "xai"),
  logo("github-copilot", "GitHub Copilot"),
  logo("microsoft-copilot", "Microsoft Copilot"),
  logo("cursor", "Cursor"),
  logo("windsurf", "Windsurf", "windsurf.svg", "codeium"),
  logo("antigravity", "Antigravity", "antigravity.svg", "google"),
  logo("vscode", "VS Code", "vscode.svg", "visual studio code"),
  logo("zed", "Zed"),
  logo("opencode", "opencode"),
  logo("openclaw", "OpenClaw"),
  logo("hermes", "Hermes", "hermes.png", "nous research"),
  logo("goose", "Goose", "goose.png"),
  logo("perplexity", "Perplexity"),
  logo("cline", "Cline"),
  logo("roo-code", "Roo Code"),
  logo("kilo-code", "Kilo Code"),
  logo("kiro", "Kiro", "kiro.svg", "amazon aws"),
  logo("junie", "Junie", "junie.svg", "jetbrains"),
  logo("amp", "Amp", "amp.svg", "sourcegraph"),
  logo("devin", "Devin", "devin.svg", "cognition"),
  logo("openhands", "OpenHands"),
  logo("trae", "Trae"),
  logo("warp", "Warp"),
  logo("replit", "Replit"),
  logo("lovable", "Lovable"),
  logo("v0", "v0", "v0.svg", "vercel"),
  logo("manus", "Manus"),
  logo("mistral", "Mistral", "mistral.svg", "le chat"),
  logo("meta-ai", "Meta AI", "meta-ai.svg", "llama"),
  logo("deepseek", "DeepSeek"),
  logo("qwen", "Qwen", "qwen.svg", "alibaba"),
  logo("kimi", "Kimi", "kimi.svg", "moonshot"),
  logo("poe", "Poe"),
  logo("notion", "Notion"),
  logo("notebooklm", "NotebookLM", "notebooklm.svg", "google"),
  logo("ollama", "Ollama"),
  logo("lm-studio", "LM Studio"),
  logo("hugging-face", "Hugging Face"),
  logo("n8n", "n8n"),
  logo("zapier", "Zapier"),
  logo("crewai", "CrewAI"),
  logo("coze", "Coze"),
]

const BY_KEY = new Map(AGENT_LOGOS.map((entry) => [entry.key, entry]))

/** The logo an agent's stored icon names, if it names one. */
export function agentLogoForIcon(
  icon: string | null | undefined
): AgentLogo | null {
  return (icon && BY_KEY.get(icon)) || null
}
