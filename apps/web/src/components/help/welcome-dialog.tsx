import { useEffect, useEffectEvent, useRef, useState } from "react"
import { ArrowDown, Check, Link2 } from "lucide-react"
import { AGENT_PLATFORMS, type AgentPlatformId } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import {
  AgentAvatar,
  PersonAvatar,
  SpaceIcon,
} from "@/components/identity-icons"
import { WorktableAppIcon } from "@/components/worktable-app-icon"
import { WELCOME_PICTURES } from "@/lib/help/registry"
import { welcomeKey, type WelcomeRole, type WelcomeStep } from "@/lib/help/welcome"
import {
  welcomeContent,
  type WelcomePicture,
} from "@/lib/help/welcome-content"

/**
 * What Worktable gives you, in three screens with still pictures. There is
 * no Skip and no close button; Escape finishes from the last screen.
 */
export function WelcomeDialog({
  role,
  team,
  finishLabel,
  onFinish,
}: {
  role: WelcomeRole
  /** The Worktable's name, for someone joining its team. */
  team: string
  finishLabel: string
  onFinish: () => void
}) {
  const content = welcomeContent(role, team)
  const count = content.screens.length
  const [at, setAt] = useState(0)
  const last = at === count - 1
  const picture = content.screens[at]!.picture
  const next = useRef<HTMLButtonElement>(null)

  const step = (move: WelcomeStep | null) => {
    if (move === "next") setAt((current) => Math.min(current + 1, count - 1))
    else if (move === "back") setAt((current) => Math.max(current - 1, 0))
    else if (move === "finish") onFinish()
  }

  // Back hides on the first screen; keep focus on Next.
  useEffect(() => {
    if (at === 0) next.current?.focus()
  }, [at])

  // On the window, before the dialog's own focus handling stops the arrows,
  // so the keys work wherever focus is. Escape comes through onOpenChange;
  // a focused button takes its own Enter.
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") return
    if (
      event.key === "Enter" &&
      event.target instanceof Element &&
      event.target.closest("button, a, input, textarea")
    )
      return
    const move = welcomeKey(event.key, at, count)
    if (!move) return
    event.preventDefault()
    step(move)
  })
  useEffect(() => {
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (!open && details.reason === "escape-key")
          step(welcomeKey("Escape", at, count))
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={next}
        className="gap-0 p-5 sm:max-w-[38rem] sm:p-7 sm:pb-6"
      >
        <p className="flex items-center gap-2 text-[0.8125rem] font-semibold text-primary-text">
          <WorktableAppIcon className="size-5" />
          {content.eyebrow}
        </p>
        <div
          aria-hidden
          className="mt-4 grid h-56 place-items-center overflow-hidden rounded-xl border border-card-border bg-surface-inset sm:mt-5 sm:h-76"
        >
          {/* The agents picture is the widest; phones draw it a step smaller. */}
          <div
            className={cn(
              "sm:[zoom:1.4]",
              picture === "agents" ? "[zoom:0.9]" : "[zoom:1]"
            )}
          >
            <Picture picture={picture} role={role} />
          </div>
        </div>
        {/* Every screen's words share one cell, so the dialog keeps the
            height of the longest and never jumps between screens. */}
        <div className="mt-6 grid">
          {content.screens.map((screen, index) => {
            const shown = index === at
            const Title = shown ? DialogTitle : "h2"
            const Line = shown ? DialogDescription : "p"
            return (
              <div
                key={screen.title}
                aria-hidden={!shown}
                className={cn(
                  "[grid-area:1/1]",
                  !shown && "invisible"
                )}
              >
                <Title className="font-display text-2xl leading-tight font-semibold tracking-tight text-foreground sm:text-3xl">
                  {screen.title}
                </Title>
                <Line className="mt-2 text-sm leading-relaxed text-muted-foreground sm:text-[0.9375rem]">
                  {screen.line}
                </Line>
              </div>
            )
          })}
        </div>
        {/* The dots stay put when the last button is wider: between the
            buttons in three columns, and on their own row on phones. */}
        <div className="mt-6 flex flex-col gap-4 sm:mt-7 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-3">
          <span
            aria-hidden
            className="flex gap-1.5 self-center sm:col-start-2 sm:row-start-1"
          >
            {content.screens.map((screen, index) => (
              <i
                key={screen.title}
                className={cn(
                  "h-1.5 rounded-full",
                  index === at ? "w-4 bg-primary" : "w-1.5 bg-border"
                )}
              />
            ))}
          </span>
          <div className="flex items-center justify-between gap-3 sm:contents">
            <Button
              variant="ghost"
              className={cn(
                "sm:col-start-1 sm:row-start-1 sm:justify-self-start",
                at === 0 && "invisible"
              )}
              tabIndex={at === 0 ? -1 : undefined}
              onClick={() => step("back")}
            >
              Back
            </Button>
            <Button
              ref={next}
              className="sm:col-start-3 sm:row-start-1 sm:justify-self-end"
              onClick={() => step(last ? "finish" : "next")}
            >
              {last ? finishLabel : "Next"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Picture({
  picture,
  role,
}: {
  picture: WelcomePicture
  role: WelcomeRole
}) {
  if (picture === "agents") return <AgentsPicture />
  if (picture === "space") return <SpacePicture chat={role === "owner"} />
  return <PagePicture />
}

const AGENTS: AgentPlatformId[] = ["chatgpt", "claude", "grok-bot"]
const agentName = (id: AgentPlatformId) => AGENT_PLATFORMS[id].name

function Agent({ id, className }: { id: AgentPlatformId; className?: string }) {
  return (
    <AgentAvatar
      name={agentName(id)}
      platform={id}
      className={cn("size-[1.125rem] text-[0.5rem]", className)}
    />
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 justify-self-center rounded-full border border-card-border bg-card py-0.5 pr-2 pl-0.5 text-[0.65625rem] font-medium whitespace-nowrap text-foreground">
      {children}
    </span>
  )
}

/** Three agents and more, each joined to one Doc they all work on. */
function AgentsPicture() {
  const words = WELCOME_PICTURES.agents
  return (
    <div className="flex w-[21rem] flex-col items-center">
      <div className="grid w-full grid-cols-4">
        {AGENTS.map((id) => (
          <Chip key={id}>
            <Agent id={id} />
            {agentName(id)}
          </Chip>
        ))}
        <span className="inline-flex items-center justify-self-center rounded-full border border-dashed border-border px-2 py-1 text-[0.65625rem] whitespace-nowrap text-muted-foreground">
          {words.more}
        </span>
      </div>
      {/* From each chip's center (the middle of its quarter) to the Doc. */}
      <svg
        viewBox="0 0 336 30"
        className="h-[1.875rem] w-full fill-none stroke-muted-foreground"
        strokeWidth={1.2}
        strokeDasharray="3 3"
      >
        {[42, 126, 210, 294].map((x, index) => (
          <path
            key={x}
            d={`M${x} 1 C${x} 18 168 12 168 29`}
            opacity={index === 3 ? 0.35 : 0.7}
          />
        ))}
      </svg>
      <div className="card-surface w-60 rounded-lg px-3 py-2.5">
        <p className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-foreground">
          <DocumentFormatIcon className="size-3.5 text-muted-foreground" />
          {words.doc}
        </p>
        <i className="mt-2 block h-1.5 w-[92%] rounded-full bg-border" />
        <i className="mt-1.5 block h-1.5 w-[70%] rounded-full bg-border" />
        <Byline id="chatgpt" text={words.wrote} />
        <Byline id="claude" text={words.added} />
      </div>
    </div>
  )
}

function Byline({ id, text }: { id: AgentPlatformId; text: string }) {
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
      <Agent id={id} className="size-4" />
      <span>
        <b className="font-medium text-foreground">{agentName(id)}</b> {text}
      </span>
    </p>
  )
}

/**
 * A chat that's over, and the work from it still in its Space. Someone
 * joining a team sees the Space alone, with who made what.
 */
function SpacePicture({ chat }: { chat: boolean }) {
  const words = WELCOME_PICTURES.space
  const [overview, research] = words.rows
  return (
    <div className="flex w-64 flex-col items-stretch">
      {chat ? (
        <>
          <div className="card-surface rounded-lg px-2.5 py-2 opacity-60">
            <p className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
              <Agent id="chatgpt" className="size-4" />
              {agentName("chatgpt")}
              <span className="ml-auto rounded border border-border px-1 text-[0.625rem]">
                {words.closed}
              </span>
            </p>
            <p className="mt-1.5 rounded-lg rounded-bl-sm border border-border bg-card px-2 py-1.5 text-[0.6875rem] leading-snug text-foreground">
              {words.chat}
            </p>
          </div>
          <ArrowDown className="mx-auto my-1.5 size-4 text-muted-foreground" />
        </>
      ) : null}
      <div className="card-surface rounded-lg p-1.5">
        <p className="flex items-center gap-1.5 px-1.5 pt-0.5 pb-1.5 text-[0.75rem] font-semibold text-foreground">
          <SpaceIcon space={{ id: words.name }} size="xs" />
          {words.name}
        </p>
        <Row name={overview} agent={chat ? undefined : "claude"} />
        <Row
          name={research}
          selected
          agent={chat ? undefined : "chatgpt"}
          tag={chat ? words.kept : undefined}
        />
        {chat ? null : (
          <Row name={WELCOME_PICTURES.agents.doc} agent="grok-bot" />
        )}
      </div>
    </div>
  )
}

function Row({
  name,
  selected = false,
  agent,
  tag,
}: {
  name: string
  selected?: boolean
  agent?: AgentPlatformId
  tag?: string
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[0.75rem] whitespace-nowrap",
        selected
          ? "bg-surface-selected text-primary-text"
          : "text-sidebar-item-foreground"
      )}
    >
      <DocumentFormatIcon className="size-3.5" />
      {name}
      {tag ? (
        <span className="ml-auto rounded bg-success/10 px-1.5 text-[0.625rem] text-success">
          {tag}
        </span>
      ) : null}
      {agent ? <Agent id={agent} className="ml-auto size-4" /> : null}
    </p>
  )
}

/**
 * A page drawn small, as Home shows pinned pages, with its share link
 * copied and a comment pinned on it.
 */
function PagePicture() {
  const words = WELCOME_PICTURES.page
  return (
    <div className="card-surface w-64 rounded-xl p-1.5">
      <div className="relative aspect-[16/10] overflow-hidden rounded-lg border border-card-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
          <i className="size-2 rounded-sm bg-primary" />
          <i className="h-1 w-6 rounded-full bg-border" />
          <i className="ml-auto h-1 w-4 rounded-full bg-border" />
          <i className="h-1 w-4 rounded-full bg-border" />
          <i className="h-1 w-4 rounded-full bg-border" />
        </div>
        <div className="px-2.5 pt-2">
          <p className="font-display text-[0.8125rem] leading-none font-semibold text-foreground">
            {words.title}
          </p>
          <i className="mt-1.5 block h-1 w-28 rounded-full bg-border" />
          <i className="mt-1 block h-1 w-20 rounded-full bg-border" />
          <i className="mt-2 block h-2.5 w-11 rounded-[3px] bg-primary" />
          <div className="mt-2.5 grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="rounded-[4px] border border-card-border bg-card p-1"
              >
                <i className="block size-1.5 rounded-full bg-primary/70" />
                <i className="mt-1 block h-1 w-[80%] rounded-full bg-border" />
                <i className="mt-0.5 block h-1 w-[55%] rounded-full bg-border" />
              </div>
            ))}
          </div>
        </div>
        <span className="absolute top-[5.1rem] left-[3.4rem] flex items-center gap-1">
          <i className="bronze-knob size-2 rounded-full" />
          <span className="overlay-floating flex items-center gap-1 rounded-lg rounded-tl-sm bg-popover py-0.5 pr-2 pl-0.5 text-[0.625rem] whitespace-nowrap text-foreground">
            <PersonAvatar
              id={words.commenter}
              name={words.commenter}
              className="size-3.5 text-[0.5rem]"
            />
            {words.comment}
          </span>
        </span>
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[0.6875rem] text-muted-foreground">
        <Link2 className="size-3.5" />
        {words.link}
        <span className="ml-auto flex items-center gap-1 font-medium text-success">
          <Check className="size-3" />
          {words.copied}
        </span>
      </p>
    </div>
  )
}
