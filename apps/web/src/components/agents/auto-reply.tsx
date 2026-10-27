import type { AgentConnection, AutoReply } from "@worktable/types"
import { AGENT_PLATFORMS } from "@worktable/types"
import { Button, buttonVariants } from "@worktable/ui/components/button"
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

/** What a person pastes into their agent to turn auto-reply on. */
export const AUTO_REPLY_PROMPT =
  "Watch Worktable for comments and messages sent to you, and reply to each one there."

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
  if (autoReply.state === "attention") return "Needs attention"
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

function TurnOn({ connection }: { connection: AgentConnection }) {
  const copy = useCopy()
  const chatgpt = connection.platform === "chatgpt"
  const where =
    connection.autoReply?.kind === "chat"
      ? chatgpt
        ? "a Work chat in ChatGPT"
        : `a chat in ${AGENT_PLATFORMS[connection.platform].name}`
      : `${AGENT_PLATFORMS[connection.platform].name} in your terminal`
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        Turn on
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-3 p-3">
        <p className="text-sm">Paste this into {where}.</p>
        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-inset py-2.5 pr-2 pl-3">
          <p className="flex-1 text-sm leading-5">{AUTO_REPLY_PROMPT}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => void copy.copy(AUTO_REPLY_PROMPT)}
          >
            {copy.copied ? "Copied" : "Copy"}
          </Button>
        </div>
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
      </PopoverContent>
    </Popover>
  )
}

/** The agent's auto-reply setting: its state, and how to turn it on. */
export function AutoReplySetting({
  connection,
}: {
  connection: AgentConnection
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
    </div>
  )
}
