import type { ReactNode } from "react"
import { Check, ChevronRight } from "lucide-react"
import { AGENT_PLATFORMS, type AgentPlatformId } from "@worktable/types"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { Tabs, TabsList, TabsTrigger } from "@worktable/ui/components/tabs"
import { cn } from "@worktable/ui/lib/utils"
import { AgentAvatar } from "./agent-avatar"

export const AGENT_SETUP_CATEGORIES = {
  code: {
    title: "Coding agents",
    description: "Use Worktable from your terminal or editor",
    platforms: ["claude-code", "codex", "cursor"],
  },
  chat: {
    title: "Chat apps",
    description: "Use your Worktable in a conversation",
    platforms: ["claude", "chatgpt"],
  },
  always: {
    title: "Always-on agents",
    description: "Assign work and get replies in Threads",
    platforms: ["openclaw", "hermes", "grok-bot"],
  },
} satisfies Record<
  string,
  { title: string; description: string; platforms: AgentPlatformId[] }
>

/** How an agent comes to work, named the same wherever it's shown. */
export const AGENT_RUNTIMES = {
  "on-demand": {
    label: "On demand",
    description:
      "You start it. When you open a chat or session, your agent calls Worktable for what it needs.",
  },
  "always-on": {
    label: "Always on",
    description:
      "Worktable calls it. It keeps running, so it can answer a message in Threads without you starting it.",
  },
} as const

/** The two ways agents work, under the ways to connect them. */
export function AgentRuntimeTips() {
  return (
    <dl className="mt-4 space-y-1.5 text-xs leading-5 text-muted-foreground">
      {Object.values(AGENT_RUNTIMES).map((runtime) => (
        <div key={runtime.label}>
          <dt className="inline font-medium text-foreground/80">
            {runtime.label}.
          </dt>{" "}
          <dd className="inline">{runtime.description}</dd>
        </div>
      ))}
    </dl>
  )
}

export function AgentSetupCategory({
  title,
  description,
  platforms,
  open,
  onOpenChange,
  connectedName,
  keepMounted,
  children,
}: {
  title: string
  description: string
  platforms: AgentPlatformId[]
  open: boolean
  onOpenChange: (open: boolean) => void
  connectedName?: string
  keepMounted?: boolean
  children: ReactNode
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="border-border not-first:border-t"
    >
      <CollapsibleTrigger className="flex min-h-16 w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
        <span className="flex w-14 shrink-0" aria-hidden>
          {platforms.map((platform, index) => (
            <AgentAvatar
              key={platform}
              name={AGENT_PLATFORMS[platform].name}
              platform={platform}
              className={cn(
                "size-6 rounded-md ring-2 ring-card",
                index > 0 && "-ml-1.5"
              )}
            />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            {title}
          </span>
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        </span>
        {connectedName && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-4 text-success" aria-hidden />
            <span className="max-w-24 truncate">{connectedName}</span>
          </span>
        )}
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-300 motion-reduce:transition-none",
            open && "rotate-90"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted={keepMounted}>
        <div className="px-3.5 pt-3 pb-5 sm:pl-[5rem]">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function AgentSetupTabs<T extends string | number>({
  value,
  onValueChange,
  options,
}: {
  value: T
  onValueChange: (value: T) => void
  options: { value: T; label: string; platform?: AgentPlatformId }[]
}) {
  return (
    <Tabs value={value} onValueChange={(value) => onValueChange(value as T)}>
      <TabsList className="mb-4 max-w-full flex-wrap justify-start gap-1 group-data-horizontal/tabs:h-auto">
        {options.map((option) => (
          <TabsTrigger
            key={option.value}
            value={option.value}
            className="h-auto min-h-11 gap-1.5 px-2.5 text-xs sm:min-h-8"
          >
            {option.platform && (
              <span aria-hidden>
                <AgentAvatar
                  name={option.label}
                  platform={option.platform}
                  className="size-5 rounded-md"
                />
              </span>
            )}
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
