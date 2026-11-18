import type { AgentPlatformId } from "@worktable/types"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { saveSetup, usePersonalSetup } from "@/lib/setup"
import { saveHelp } from "@/lib/help/state"
import { Prompt } from "./getting-started/prompt"

const PLACE_FOR_PLATFORM: Partial<Record<AgentPlatformId, string>> = {
  "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", cursor: "Cursor",
  claude: "Claude", "claude-desktop": "Claude", chatgpt: "ChatGPT", "chatgpt-desktop": "ChatGPT",
}

/** A line for the agent's own instructions, read in every conversation. */
const AGENT_INSTRUCTIONS =
  "I keep my work in Worktable. When I ask you to write, plan, research or track something, save it in Worktable without me saying so, and look there for context before asking me."

/** Where each agent keeps the rules it reads in every chat and project. */
const INSTRUCTION_PLACES: { agent: string; file?: string; place?: string }[] = [
  { agent: "Claude Code", file: "~/.claude/CLAUDE.md" },
  { agent: "Codex", file: "~/.codex/AGENTS.md" },
  { agent: "OpenCode", file: "~/.config/opencode/AGENTS.md" },
  { agent: "Cursor", place: "Cursor Settings → Rules → User Rules" },
  { agent: "Claude", place: "Settings → Your Claude → Instructions" },
  {
    agent: "ChatGPT",
    place: "Settings → Personalization → Custom instructions",
  },
  { agent: "Other agents", place: "Their global rules or custom instructions" },
]

export function AgentInstructions({ platforms, actionVariant = "default" }: { platforms?: AgentPlatformId[]; actionVariant?: "default" | "outline" }) {
  const queryClient = useQueryClient()
  const { setup } = usePersonalSetup()
  const added = Boolean(setup.items["agent-instructions"] && !setup.items["agent-instructions"].skipped)
  const save = useMutation({
    mutationFn: async () => {
      await saveHelp(queryClient, { evidence: "rules-added" })
      await saveSetup(queryClient, { done: "agent-instructions" })
    },
    onError: () => toast.error("Couldn’t save. Try again."),
  })
  const names = platforms?.map((platform) => PLACE_FOR_PLATFORM[platform] ?? "Other agents")
  const places = names ? INSTRUCTION_PLACES.filter(({ agent }) => names.includes(agent)) : INSTRUCTION_PLACES

  return (
    <>
      <ul>
        <Prompt text={AGENT_INSTRUCTIONS} />
      </ul>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {places.map(({ agent, file, place }) => (
          <div key={agent} className="contents">
            <dt className="text-muted-foreground">{agent}</dt>
            <dd className="text-foreground/80">
              {file ? (
                <code className="inline-code-accent font-mono">{file}</code>
              ) : (
                place
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button size="sm" variant={actionVariant} disabled={save.isPending || added} onClick={() => save.mutate()}>
          {added ? "Added" : "I Added It"}
        </Button>
      </div>
    </>
  )
}
