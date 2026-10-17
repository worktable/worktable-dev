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
import type { SetupRecord } from "@/lib/onboarding-setups"
import { useSpaces } from "@/lib/queries"
import { openSettings } from "@/lib/settings-open"
import {
  canInvite,
  checklistFor,
  checklistProgress,
  GETTING_STARTED_SPACE_ID,
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

/** Requests that end with a doc saved, which completes the task step. */
function taskPrompts(joinedSpaceName: string | undefined): string[] {
  if (joinedSpaceName) {
    return [
      `Read the ${joinedSpaceName} Space in Worktable and write a doc there listing what's missing.`,
      `Pick an open question in the ${joinedSpaceName} Space in Worktable and draft an answer as a doc there.`,
    ]
  }
  return [
    "Write a one-page brief for [project] in Worktable: goals, timeline and open questions.",
    "Turn these notes into a doc in Worktable: [paste notes]",
    "Research [topic] and save a summary with sources in Worktable.",
  ]
}

function Prompt({ text }: { text: string }) {
  const copy = useCopy()
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

function DoneWhen({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-xs text-muted-foreground">{children}</p>
}

function TaskBody({ joinedSpaceName }: { joinedSpaceName?: string }) {
  return (
    <>
      <p className="mb-2 text-sm text-foreground/80">
        Copy one into your agent, or ask in your own words:
      </p>
      <ul className="space-y-2">
        {taskPrompts(joinedSpaceName).map((text) => (
          <Prompt key={text} text={text} />
        ))}
      </ul>
      <DoneWhen>Done when your agent saves its first doc.</DoneWhen>
    </>
  )
}

function ConnectBody() {
  const [setups, setSetups] = useState<SetupRecord[]>([])
  return <AgentConnectOptions setups={setups} onSetupsChange={setSetups} />
}

function InviteBody({ cloud, teams }: { cloud: boolean; teams: boolean }) {
  const queryClient = useQueryClient()
  const [emails, setEmails] = useState<string[]>([])
  const [invited, setInvited] = useState<Invited[]>([])
  const invitations = useQuery({
    queryKey: ["team", "invitations"],
    queryFn: getTeamInvitations,
    enabled: teams,
    staleTime: 60_000,
  })
  const send = useMutation({
    mutationFn: () => invitePeople(emails),
    onSuccess: (results) => {
      setEmails([])
      setInvited((current) => mergeInvited(current, results))
      void queryClient.invalidateQueries({ queryKey: ["team", "invitations"] })
    },
  })
  if (!teams) {
    return (
      <>
        <p className="mb-3 text-sm text-foreground/80">
          Each person needs their own account. Turn on Teams to invite them.
        </p>
        <Button size="sm" onClick={() => openSettings("team")}>
          Turn on Teams
        </Button>
      </>
    )
  }
  const waiting = (invitations.data?.invitations ?? []).filter(
    (invitation) =>
      invitation.status === "pending" &&
      !invitation.expired &&
      !invited.some((item) => item.email === invitation.email)
  )
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (emails.length) send.mutate()
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <EmailChips
            emails={emails}
            onChange={setEmails}
            onSubmit={() => send.mutate()}
          />
        </div>
        <Button type="submit" disabled={!emails.length || send.isPending}>
          {send.isPending ? "Inviting…" : cloud ? "Send invites" : "Create links"}
        </Button>
      </div>
      {invited.length || waiting.length ? (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
          {invited.map((item) => (
            <InviteResult key={item.email} invited={item} cloud={cloud} />
          ))}
          {waiting.map((invitation) => (
            <li
              key={invitation.id}
              className="flex min-w-0 items-center gap-3 px-4 py-3 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-foreground">
                {invitation.email}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                Invited, not joined yet
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <DoneWhen>Done when someone joins.</DoneWhen>
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
  onOpenChange,
  children,
}: {
  item: ChecklistItem
  number: number
  evidence: SetupEvidence | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  const done = Boolean(evidence)
  return (
    <Collapsible
      open={open && !done}
      onOpenChange={onOpenChange}
      disabled={done}
      className="border-border not-first:border-t"
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors focus-visible:bg-surface-hover focus-visible:outline-none",
          !done && "hover:bg-surface-hover"
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
        {done ? (
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
        <div className="px-4 pt-0.5 pb-5 sm:pl-[3.375rem]">{children}</div>
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
  })
  const progress = checklistProgress(items, setup.items)
  // Null follows the next step; "none" means the person closed it.
  const [chosen, setChosen] = useState<SetupItemId | "none" | null>(null)
  const openId =
    chosen === "none"
      ? null
      : chosen && !setup.items[chosen]
        ? chosen
        : (progress.next?.id ?? null)
  const unpin = useMutation({
    mutationFn: () => saveSetup(queryClient, { hidden: true }),
    onError: () => toast.error("Couldn’t save. Try again."),
  })
  const worktableName = workspace?.name ?? "this Worktable"
  const cloud = person?.signOut === "cloud"

  function body(id: SetupItemId) {
    switch (id) {
      case "connect-agent":
        return <ConnectBody />
      case "first-task":
        return <TaskBody joinedSpaceName={joinedSpaceName} />
      case "invite-team":
        return (
          <InviteBody cloud={cloud} teams={person?.signOut !== "password"} />
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
              onOpenChange={(next) => setChosen(next ? item.id : "none")}
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
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
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
