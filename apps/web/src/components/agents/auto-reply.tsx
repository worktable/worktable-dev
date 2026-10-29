import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { AgentConnection, AutoReply } from "@worktable/types"
import { AGENT_PLATFORMS, agentConnectionPlatform } from "@worktable/types"
import { Button, buttonVariants } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { InfoTip } from "@worktable/ui/components/info-tip"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@worktable/ui/components/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"
import { removeCloudTask } from "@/lib/agent-connections-api"
import { SetupStep } from "./setup-step"

/** What a person pastes into their agent to turn auto-reply on. */
export const AUTO_REPLY_PROMPT =
  "Watch Worktable for comments and messages sent to you, and reply to each one there, following the Worktable skill."

const DOT_LABEL = {
  on: "Auto-reply on",
  attention: "Auto-reply needs attention",
} as const

/** A mark on an agent's avatar when it answers on its own, or can't. */
export function AutoReplyDot({
  autoReply,
  className,
}: {
  autoReply: AutoReply | undefined
  className?: string
}) {
  if (!autoReply || autoReply.state === "off") return null
  const label = DOT_LABEL[autoReply.state]
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-card",
              autoReply.state === "on" ? "bronze-knob" : "bg-warning",
              className
            )}
          />
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function stateLine(autoReply: AutoReply): string {
  if (autoReply.state === "attention")
    return autoReply.error ?? "Needs attention"
  if (autoReply.testing) return "Testing…"
  if (autoReply.state === "off") return "Off"
  const spaces = autoReply.spaceIds?.length
  return spaces ? `On · ${spaces === 1 ? "1 Space" : `${spaces} Spaces`}` : "On"
}

function About({ connection }: { connection: AgentConnection }) {
  const name = connection.displayName
  const kind = connection.autoReply?.kind
  if (kind === "chat")
    return (
      <>
        <p>
          {name} answers comments and messages you send it, even when the chat
          is closed. To pause it, open Scheduled in ChatGPT.
        </p>
        <a
          className="text-primary-text hover:underline"
          href="https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex"
          target="_blank"
          rel="noreferrer"
        >
          How ChatGPT tasks work ↗
        </a>
      </>
    )
  if (kind === "task")
    return (
      <>
        <p>
          Claude answers from the cloud, even when your computer is off. Each
          answer uses your Claude plan.
        </p>
        <a
          className="text-primary-text hover:underline"
          href="https://code.claude.com/docs/en/routines"
          target="_blank"
          rel="noreferrer"
        >
          About scheduled tasks ↗
        </a>
      </>
    )
  if (
    kind === "session" &&
    agentConnectionPlatform(connection) !== "claude-code"
  )
    return (
      <p>
        {name} answers what you send it while its conversation keeps running.
      </p>
    )
  if (kind === "session")
    return (
      <>
        <p>
          {name} answers what you send it while a terminal session is open. It
          isn’t available in Claude Desktop or VS Code.
        </p>
        <a
          className="text-primary-text hover:underline"
          href="https://code.claude.com/docs"
          target="_blank"
          rel="noreferrer"
        >
          Claude Code docs ↗
        </a>
      </>
    )
  return (
    <p>
      {name} answers thread messages on its own. It sees comments the next time
      it works in Worktable.
    </p>
  )
}

/** A line to paste into an agent, with its Copy button. */
export function CopyLine({ text }: { text: string }) {
  const copy = useCopy()
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-inset py-2.5 pr-2 pl-3">
      <p className="flex-1 text-sm leading-5">{text}</p>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2.5 text-xs"
        onClick={() => void copy.copy(text)}
      >
        {copy.copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

function TurnOn({ connection }: { connection: AgentConnection }) {
  const platform = agentConnectionPlatform(connection)
  const chatgpt = platform === "chatgpt"
  const app = AGENT_PLATFORMS[platform].name
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        Turn on
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <ol className="space-y-1">
          <SetupStep number={1} title="Copy this">
            <CopyLine text={AUTO_REPLY_PROMPT} />
          </SetupStep>
          <SetupStep
            number={2}
            title={
              connection.autoReply?.kind === "session"
                ? `Paste it into ${app} in your terminal`
                : `Paste it into ${app}`
            }
          >
            {chatgpt && (
              <a
                href="https://chatgpt.com/"
                target="_blank"
                rel="noreferrer"
                className={cn(buttonVariants({ size: "sm" }), "self-start")}
              >
                Open ChatGPT
              </a>
            )}
          </SetupStep>
        </ol>
        <p className="pl-9 text-xs text-muted-foreground">
          Replies appear in Worktable.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** A cloud task's actions: set it up or fix it, and remove it. */
function TaskActions({
  connection,
  onSetUp,
}: {
  connection: AgentConnection
  onSetUp?: () => void
}) {
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => removeCloudTask(connection),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] }),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Couldn’t remove the task."
      ),
  })
  const autoReply = connection.autoReply
  if (!autoReply || connection.canManage === false) return null
  const saved = autoReply.state !== "off" || autoReply.testing
  return (
    <>
      {saved && (
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          Remove
        </Button>
      )}
      {(!saved || autoReply.state === "attention") && onSetUp && (
        <Button variant="outline" size="sm" onClick={onSetUp}>
          {saved ? "Fix" : "Set up"}
        </Button>
      )}
    </>
  )
}

/** The agent's auto-reply setting: its state, and how to turn it on. */
export function AutoReplySetting({
  connection,
  onSetUp,
}: {
  connection: AgentConnection
  /** Opens a cloud task's setup steps. */
  onSetUp?: () => void
}) {
  const autoReply = connection.autoReply
  if (!autoReply) return null
  const canTurnOn =
    autoReply.state === "off" &&
    (autoReply.kind === "chat" || autoReply.kind === "session")
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          Auto-reply
          <InfoTip label="About auto-reply">
            <About connection={connection} />
          </InfoTip>
        </div>
        <p
          className={cn(
            "text-xs",
            autoReply.state === "attention"
              ? "text-warning"
              : "text-muted-foreground"
          )}
        >
          {stateLine(autoReply)}
        </p>
      </div>
      {canTurnOn && <TurnOn connection={connection} />}
      {autoReply.kind === "task" && (
        <TaskActions connection={connection} onSetUp={onSetUp} />
      )}
    </div>
  )
}
