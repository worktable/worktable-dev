import type { GrokBotConnection } from "@worktable/types"

export const GROK_BOT_STATUS_LABELS: Record<
  GrokBotConnection["status"],
  string
> = {
  configured: "Needs a connection check",
  checking: "Checking…",
  ready: "Connected",
  working: "Working",
  paused: "Paused",
  "needs-attention": "Needs attention",
}
