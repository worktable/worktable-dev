import type { AutoReply, GrokBotConnection } from "@worktable/types"

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

/** A Grok Bot answers threads on its own once it is ready. */
export function grokAutoReply(
  grok: GrokBotConnection | undefined
): AutoReply | undefined {
  if (!grok) return undefined
  return {
    kind: "called",
    state:
      grok.status === "needs-attention"
        ? "attention"
        : grok.status === "ready" || grok.status === "working"
          ? "on"
          : "off",
  }
}
