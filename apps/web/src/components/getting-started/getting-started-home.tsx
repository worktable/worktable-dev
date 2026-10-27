import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronRight } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { toast } from "@worktable/ui/components/sonner"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { PageWithActivity } from "@/components/home/page-with-activity"
import { AgentConnectOptions } from "@/components/onboarding/connect-agent"
import {
  EmailChips,
  InviteResult,
} from "@/components/onboarding/invite-people"
import { invitePeople, mergeInvited, type Invited } from "@/lib/invite-people"
import { PlanFullNotice } from "@/components/billing/plan-full-notice"
import { roomFor, useCloudPlan } from "@/lib/cloud-plan"
import type { SetupRecord } from "@/lib/onboarding-setups"
import { useSpaces } from "@/lib/queries"
import { openSettings } from "@/lib/settings-open"
import {
  canInvite,
  checklistFor,
  checklistProgress,
  GETTING_STARTED_SPACE_ID,
  noteSetupChanged,
  saveSetup,
  usePersonalSetup,
  type ChecklistItem,
  type SetupEvidence,
  type SetupItemId,
} from "@/lib/setup"
import { getTeamInvitations } from "@/lib/team-api"
import { humanizeSegment } from "@/lib/tree"
import { ProgressRing } from "./progress-ring"

const GUIDES = [
  {
    path: "what-agents-can-make",
    title: "What agents can make",
    description: "Docs, drawings, Records, HTML docs and Threads.",
    format: undefined,
  },
  {
    path: "prompts-to-try",
    title: "Prompts to try",
    description: "Requests that work well for common jobs.",
    format: "worktable.markdown",
  },
  {
    path: "reviewing-with-your-agent",
    title: "Reviewing with your agent",
    description: "Comment on a doc and have your agent revise it.",
    format: "worktable.markdown",
  },
  {
    path: "agents-that-stay-on",
    title: "Agents that stay on",
    description: "OpenClaw and Hermes pick up work from Threads.",
    format: "worktable.markdown",
  },
  {
    path: "tracking-work-in-records",
    title: "Tracking work in Records",
    description: "Rows your agents keep up to date, with a board on top.",
    format: "worktable.markdown",
  },
  {
    path: "launch-board",
    title: "Example: Launch Plan",
    description: "Records with a board an agent built.",
    format: "worktable.html",
  },
] as const

/**
 * Requests that start a Space with named docs, which completes the task step.
 * A first request must make its own Space, or the work lands in Getting
 * Started, whose Home shows only the guides.
 */
function taskPrompts(joinedSpaceName: string | undefined): string[] {
  if (joinedSpaceName) {
    return [
      `Read the ${joinedSpaceName} Space in Worktable and write a doc there listing what's missing.`,
      `Pick an open question in the ${joinedSpaceName} Space in Worktable and draft an answer as a doc there.`,
    ]
  }
  return [
    "Set up a Space in Worktable for the project we're working on, with these docs: Overview, Architecture, Current Work and Open Questions. Where you're unsure, make your best guess and add it to Open Questions.",
    "Create a personal Space for me in Worktable from what you know about me, with these docs: About Me, Current Work, Working Style and Notes for Agents. If you don't know me yet, ask me first.",
    "Set up a Space in Worktable for what I'm working on this week, with these docs: Plan, Task Board and Notes. Put my tasks on the board and what we've discussed recently in Notes.",
    "Start a Space in Worktable for [project]. In it, help me decide [decision]: the question, the options with their trade-offs, and your recommendation.",
    "Research [topic] and set up a Space in Worktable with these docs: Summary, Sources and Open Questions.",
  ]
}

function Prompt({ text, onCopied }: { text: string; onCopied?: () => void }) {
  const copy = useCopy(onCopied)
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-surface-inset py-2 pr-2 pl-3 text-sm leading-6 text-foreground">
      <span className="min-w-0 flex-1">{text}</span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-xs"
        onClick={() => void copy.copy(text)}
      >
        {copy.copied ? "Copied" : "Copy"}
      </Button>
    </li>
  )
}

function TaskBody({ joinedSpaceName }: { joinedSpaceName?: string }) {
  return (
    <ul className="space-y-2">
      {taskPrompts(joinedSpaceName).map((text) => (
        <Prompt key={text} text={text} />
      ))}
    </ul>
  )
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
  { agent: "Claude", place: "Settings → General → Personal preferences" },
  {
    agent: "ChatGPT",
    place: "Settings → Personalization → Custom instructions",
  },
  { agent: "Other agents", place: "Their global rules or custom instructions" },
]

function InstructionsBody({ onCopied }: { onCopied: () => void }) {
  return (
    <>
      <ul>
        <Prompt text={AGENT_INSTRUCTIONS} onCopied={onCopied} />
      </ul>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        {INSTRUCTION_PLACES.map(({ agent, file, place }) => (
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
    </>
  )
}

function ConnectBody() {
  const [setups, setSetups] = useState<SetupRecord[]>([])
  return <AgentConnectOptions setups={setups} onSetupsChange={setSetups} />
}

function SkipButton({
  onSkip,
  skipping,
}: {
  onSkip: () => void
  skipping: boolean
}) {
  return (
    <button
      type="button"
      disabled={skipping}
      onClick={onSkip}
      className="shrink-0 text-sm text-primary-text hover:underline disabled:opacity-50"
    >
      Skip for now
    </button>
  )
}

function InviteBody({
  cloud,
  teams,
  onSkip,
  skipping,
}: {
  cloud: boolean
  teams: boolean
  onSkip: () => void
  skipping: boolean
}) {
  const queryClient = useQueryClient()
  const [emails, setEmails] = useState<string[]>([])
  const [invited, setInvited] = useState<Invited[]>([])
  const invitations = useQuery({
    queryKey: ["team", "invitations"],
    queryFn: getTeamInvitations,
    enabled: teams,
    staleTime: 60_000,
  })
  const { plan, worktableName } = useCloudPlan()
  const send = useMutation({
    mutationFn: () => invitePeople(emails),
    onSuccess: (results) => {
      // What couldn't be invited stays typed, to try again.
      setEmails(results.flatMap((result) => (result.error ? [result.email] : [])))
      setInvited((current) => mergeInvited(current, results))
      void queryClient.invalidateQueries({ queryKey: ["team", "invitations"] })
      // The plan's room depends on who is invited.
      noteSetupChanged(queryClient)
    },
  })
  const fits = roomFor(plan, emails.length)
  if (!teams) {
    return (
      <>
        <p className="mb-3 text-sm text-foreground/80">
          Each person needs their own account. Turn on Teams to invite them.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button size="sm" onClick={() => openSettings("team")}>
            Turn on Teams
          </Button>
          <SkipButton onSkip={onSkip} skipping={skipping} />
        </div>
      </>
    )
  }
  const waiting = (invitations.data?.invitations ?? []).filter(
    (invitation) =>
      invitation.status === "pending" &&
      !invitation.expired &&
      !invited.some((item) => item.email === invitation.email)
  )
  // Enter and the button both send, once at a time.
  const submit = () => {
    if (emails.length && fits && !send.isPending) send.mutate()
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <EmailChips
            emails={emails}
            onChange={setEmails}
            onSubmit={submit}
          />
        </div>
        <Button
          type="submit"
          disabled={!emails.length || !fits || send.isPending}
        >
          {send.isPending ? "Inviting…" : cloud ? "Send invites" : "Create links"}
        </Button>
      </div>
      {plan && !fits ? (
        <div className="mt-3">
          <PlanFullNotice
            plan={plan}
            worktableName={worktableName}
            adding={emails.length}
            invitees={emails}
          />
        </div>
      ) : null}
      {invited.length || waiting.length ? (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {invited.map((item) => (
            <InviteResult
              key={item.email}
              invited={item}
              onChange={(next) =>
                setInvited((current) => mergeInvited(current, [next]))
              }
            />
          ))}
          {waiting.map((invitation) => (
            <InviteResult
              key={invitation.id}
              invited={{
                email: invitation.email,
                id: invitation.id,
                url: invitation.url,
                status: invitation.emailStatus,
              }}
            />
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Done when someone joins.
        </p>
        <SkipButton onSkip={onSkip} skipping={skipping} />
      </div>
    </form>
  )
}

/** Where a finished task happened. */
function Evidence({ evidence }: { evidence: SetupEvidence }) {
  if (!evidence.spaceId || !evidence.path) return null
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId: evidence.spaceId, _splat: evidence.path }}
      className="min-w-0 truncate text-sm text-muted-foreground hover:text-foreground"
    >
      {humanizeSegment(evidence.path.split("/").pop() ?? evidence.path)}
    </Link>
  )
}

function StepRow({
  item,
  number,
  evidence,
  open,
  kept = false,
  onOpenChange,
  children,
}: {
  item: ChecklistItem
  number: number
  evidence: SetupEvidence | undefined
  open: boolean
  /** Finished here just now, so it stays open until the person moves on. */
  kept?: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  const done = Boolean(evidence)
  return (
    <Collapsible
      open={open && (!done || kept)}
      onOpenChange={onOpenChange}
      disabled={done && !kept}
      className="border-border not-first:border-t"
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors focus-visible:bg-surface-hover focus-visible:outline-none",
          (!done || kept) && "hover:bg-surface-hover"
        )}
      >
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full border text-xs font-medium tabular-nums transition-colors",
            done
              ? "border-transparent bg-success text-background"
              : open
                ? "border-primary text-primary-text"
                : "border-border text-muted-foreground"
          )}
        >
          {done ? <Check className="size-3.5" strokeWidth={3} /> : number}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-sm font-medium",
              done ? "text-muted-foreground" : "text-foreground"
            )}
          >
            {item.title}
          </span>
          {done ? null : (
            <span className="block text-xs text-muted-foreground">
              {item.description}
            </span>
          )}
        </span>
        {evidence?.skipped ? (
          <span className="text-sm text-muted-foreground">Skipped</span>
        ) : done && !kept ? (
          evidence && <Evidence evidence={evidence} />
        ) : (
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-300 motion-reduce:transition-none",
              open && "rotate-90"
            )}
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pt-3 pb-5 sm:pl-[3.375rem]">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The Getting Started Space Home: the person's own first steps, then guides. */
export function GettingStartedHome() {
  const queryClient = useQueryClient()
  const { workspace, person, setup } = usePersonalSetup()
  const { data: spaces } = useSpaces()
  const role = person?.role ?? "owner"
  const joined = setup.items["join-space"]?.spaceId
  const joinedSpaceName = joined
    ? spaces?.find((entry) => entry.id === joined)?.name
    : undefined
  const items = checklistFor(role, {
    canInvite: canInvite(person),
    joinedSpaceName,
    items: setup.items,
  })
  const progress = checklistProgress(items, setup.items)
  // Null follows the next step; "none" means the person closed it.
  const [chosen, setChosen] = useState<SetupItemId | "none" | null>(null)
  // Copying the instructions finishes that step, but where to paste them
  // stays on show until the person moves on.
  const [kept, setKept] = useState<SetupItemId | null>(null)
  const openId =
    chosen === "none"
      ? null
      : chosen && (!setup.items[chosen] || chosen === kept)
        ? chosen
        : (progress.next?.id ?? null)
  const unpin = useMutation({
    mutationFn: () => saveSetup(queryClient, { hidden: true }),
    onError: () => toast.error("Couldn’t save. Try again."),
  })
  const copied = useMutation({
    mutationFn: () => saveSetup(queryClient, { done: "agent-instructions" }),
    onError: () => toast.error("Couldn’t save. Try again."),
  })
  const skip = useMutation({
    mutationFn: () => saveSetup(queryClient, { skip: "invite-team" }),
    onError: () => toast.error("Couldn’t save. Try again."),
  })
  const worktableName = workspace?.name ?? "this Worktable"
  const cloud = person?.signOut === "cloud"

  function body(id: SetupItemId) {
    switch (id) {
      case "connect-agent":
        return <ConnectBody />
      case "agent-instructions":
        return (
          <InstructionsBody
            onCopied={() => {
              setChosen("agent-instructions")
              setKept("agent-instructions")
              if (!setup.items["agent-instructions"]) copied.mutate()
            }}
          />
        )
      case "first-task":
        return <TaskBody joinedSpaceName={joinedSpaceName} />
      case "invite-team":
        return (
          <InviteBody
            cloud={cloud}
            teams={person?.signOut !== "password"}
            onSkip={() => skip.mutate()}
            skipping={skip.isPending}
          />
        )
      default:
        return null
    }
  }

  return (
    <PageWithActivity className="xl:h-auto xl:min-h-0 xl:flex-1">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-[1.65rem] leading-tight font-semibold tracking-tight text-foreground sm:text-[2rem]">
            Getting Started
          </h1>
          <p className="mt-1.5 text-[0.95rem] leading-6 text-muted-foreground">
            {role === "member"
              ? `Get set up in ${worktableName}.`
              : `Finish setting up ${worktableName}.`}
          </p>
        </div>
        {progress.next ? (
          <span className="mt-2 flex shrink-0 items-center gap-2 text-sm text-muted-foreground tabular-nums">
            <ProgressRing
              done={progress.done}
              total={progress.total}
              className="size-5"
            />
            {progress.done} of {progress.total}
          </span>
        ) : null}
      </header>

      <div className="card-surface overflow-hidden rounded-xl">
        {progress.next ? (
          items.map((item, index) => (
            <StepRow
              key={item.id}
              item={item}
              number={index + 1}
              evidence={setup.items[item.id]}
              open={openId === item.id}
              kept={kept === item.id}
              onOpenChange={(next) => {
                setChosen(next ? item.id : "none")
                if (kept !== item.id || !next) setKept(null)
              }}
            >
              {body(item.id)}
            </StepRow>
          ))
        ) : (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3.5 animate-in fade-in duration-300 motion-reduce:animate-none">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-success text-background">
              <Check className="size-3.5" strokeWidth={3} />
            </span>
            <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
              {role === "member" ? "You're set up." : `${worktableName} is set up.`}
            </span>
            {setup.hidden ? null : (
              <button
                type="button"
                disabled={unpin.isPending}
                onClick={() => unpin.mutate()}
                className="text-sm text-primary-text hover:underline"
              >
                Remove from sidebar
              </button>
            )}
          </div>
        )}
      </div>

      <section aria-labelledby="guides-heading">
        <h2 id="guides-heading" className="mb-2 text-sm font-semibold text-foreground">
          Guides
        </h2>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {GUIDES.map((guide) => (
            <Link
              key={guide.path}
              to="/spaces/$spaceId/documents/$"
              params={{ spaceId: GETTING_STARTED_SPACE_ID, _splat: guide.path }}
              className="card-surface card-surface-interactive rounded-xl px-4 py-3.5"
            >
              <span className="flex items-center gap-2">
                <DocumentFormatIcon
                  formatId={guide.format}
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="truncate text-sm font-medium text-foreground">
                  {guide.title}
                </span>
              </span>
              <span className="mt-1.5 block text-[0.8rem] leading-5 text-muted-foreground">
                {guide.description}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </PageWithActivity>
  )
}
