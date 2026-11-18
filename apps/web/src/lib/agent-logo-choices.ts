import { AGENT_LOGO_PREFIX } from "./agent-logos"

export interface AgentLogoChoice {
  /** Stored as the agent's icon. */
  key: string
  name: string
  /** Lowercase words a search matches: the name and other names for it. */
  keywords: string
}

const choice = (id: string, name: string, aliases = ""): AgentLogoChoice => ({
  key: `${AGENT_LOGO_PREFIX}${id}`,
  name,
  keywords: `${name} ${aliases}`.toLowerCase(),
})

// Logos owners can pick for any agent, most familiar first. NOTICE.txt in
// the logo directory records where each file came from.
export const AGENT_LOGO_CHOICES: readonly AgentLogoChoice[] = [
  choice("claude", "Claude"),
  choice("claude-code", "Claude Code"),
  choice("anthropic", "Anthropic"),
  choice("openai", "OpenAI", "chatgpt gpt"),
  choice("codex", "Codex", "openai"),
  choice("gemini", "Gemini", "google"),
  choice("gemini-cli", "Gemini CLI", "google"),
  choice("grok", "Grok", "xai"),
  choice("grok-bot", "Grok Bot", "xai"),
  choice("github-copilot", "GitHub Copilot"),
  choice("microsoft-copilot", "Microsoft Copilot"),
  choice("cursor", "Cursor"),
  choice("windsurf", "Windsurf", "codeium"),
  choice("antigravity", "Antigravity", "google"),
  choice("vscode", "VS Code", "visual studio code"),
  choice("zed", "Zed"),
  choice("opencode", "opencode"),
  choice("openclaw", "OpenClaw"),
  choice("hermes", "Hermes", "nous research"),
  choice("goose", "Goose"),
  choice("perplexity", "Perplexity"),
  choice("cline", "Cline"),
  choice("roo-code", "Roo Code"),
  choice("kilo-code", "Kilo Code"),
  choice("kiro", "Kiro", "amazon aws"),
  choice("junie", "Junie", "jetbrains"),
  choice("amp", "Amp", "sourcegraph"),
  choice("devin", "Devin", "cognition"),
  choice("openhands", "OpenHands"),
  choice("trae", "Trae"),
  choice("warp", "Warp"),
  choice("replit", "Replit"),
  choice("lovable", "Lovable"),
  choice("v0", "v0", "vercel"),
  choice("manus", "Manus"),
  choice("mistral", "Mistral", "le chat"),
  choice("meta-ai", "Meta AI", "llama"),
  choice("deepseek", "DeepSeek"),
  choice("qwen", "Qwen", "alibaba"),
  choice("kimi", "Kimi", "moonshot"),
  choice("poe", "Poe"),
  choice("notion", "Notion"),
  choice("notebooklm", "NotebookLM", "google"),
  choice("ollama", "Ollama"),
  choice("lm-studio", "LM Studio"),
  choice("hugging-face", "Hugging Face"),
  choice("n8n", "n8n"),
  choice("zapier", "Zapier"),
  choice("crewai", "CrewAI"),
  choice("coze", "Coze"),
]
