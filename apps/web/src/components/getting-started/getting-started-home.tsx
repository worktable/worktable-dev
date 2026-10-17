import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import type { SpaceView } from "@/lib/api"
import { SpaceIcon } from "@/components/spaces/space-icon"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { PageWithActivity } from "@/components/home/page-with-activity"
import { useSpaces } from "@/lib/queries"
import { openSettings } from "@/lib/settings-open"
import {
  checklistFor,
  checklistProgress,
  GETTING_STARTED_SPACE_ID,
  saveSetup,
  usePersonalSetup,
  type ChecklistItem,
  type SetupAction,
  type SetupEvidence,
} from "@/lib/setup"
import { getTeamInvitations } from "@/lib/team-api"
import { humanizeSegment } from "@/lib/tree"
import { ProgressRing } from "./progress-ring"

const GUIDES = [
  {
    path: "what-agents-can-make",
    title: "What agents can make",
    description: "Docs, drawings, Records, HTML docs, and Threads.",
    format: undefined,
  },
  {
    path: "prompts-to-try",
    title: "Prompts to try",
    description: "Ready-made requests for common work.",
    format: "worktable.markdown",
  },
  {
    path: "launch-board",
    title: "Example: Launch Plan",
    description: "Records with a board an agent built.",
    format: "worktable.html",
  },
] as const

function firstName(name: string | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0]
  return first && !["Owner", "User"].includes(first) ? first : null
}

function ActionButton({
  action,
  primary,
}: {
  action: SetupAction
  primary: boolean
}) {
  const variant = primary ? "default" : "outline"
  if (action.kind === "settings") {
    return (
      <Button size="sm" variant={variant} onClick={() => openSettings(action.section)}>
        {action.label}
      </Button>
    )
  }
  if (action.kind === "threads") {
    return (
      <Button
        size="sm"
        variant={variant}
        nativeButton={false}
        render={
          <Link to="/threads/$" params={{ _splat: "" }} search={{ location: "all" }} />
        }
      >
        {action.label}
      </Button>
    )
  }
  return (
    <Button
      size="sm"
      variant={variant}
      nativeButton={false}
      render={
        <Link
          to="/spaces/$spaceId/documents/$"
          params={{ spaceId: GETTING_STARTED_SPACE_ID, _splat: action.path }}
        />
      }
    >
      {action.label}
    </Button>
  )
}

/** Where a finished item happened, when there is somewhere to go back to. */
function EvidenceLink({
  evidence,
  spaces,
}: {
  evidence: SetupEvidence
  spaces: SpaceView[] | undefined
}) {
  if (evidence.spaceId && evidence.path) {
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
  const space = evidence.spaceId
    ? spaces?.find((entry) => entry.id === evidence.spaceId)
    : undefined
  if (!space) return null
  return (
    <Link
      to="/spaces/$spaceId"
      params={{ spaceId: space.id }}
      className="min-w-0 truncate text-sm text-muted-foreground hover:text-foreground"
    >
      {space.name}
    </Link>
  )
}

function ChecklistRow({
  item,
  evidence,
  open,
  next,
  note,
  spaces,
  onOpen,
}: {
  item: ChecklistItem
  evidence: SetupEvidence | undefined
  open: boolean
  next: boolean
  note?: string | null
  spaces: SpaceView[] | undefined
  onOpen: () => void
}) {
  const done = Boolean(evidence)
  return (
    <li className="px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-full border",
            done
              ? "border-primary bg-primary text-primary-foreground"
              : open
                ? "border-primary"
                : "border-border"
          )}
        >
          {done && <Check className="size-3" strokeWidth={3} />}
        </span>
        {done ? (
          <>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {item.title}
            </span>
            {evidence && <EvidenceLink evidence={evidence} spaces={spaces} />}
          </>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            onClick={onOpen}
            className={cn(
              "min-w-0 flex-1 truncate text-left text-sm text-foreground",
              open && "font-medium"
            )}
          >
            {item.title}
          </button>
        )}
      </div>
      {!done && open && (
        <div className="mt-1.5 pl-8">
          <p className="text-sm leading-6 text-muted-foreground">
            {item.description}
          </p>
          {note && (
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{note}</p>
          )}
          {item.action && (
            <div className="mt-3">
              <ActionButton action={item.action} primary={next} />
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/** Who has been invited and hasn't joined yet, for the owner's invite step. */
function useWaitingInvitations(enabled: boolean): string | null {
  const invitations = useQuery({
    queryKey: ["team", "invitations"],
    queryFn: getTeamInvitations,
    enabled,
    staleTime: 60_000,
  })
  const waiting = (invitations.data?.invitations ?? []).filter(
    (invitation) => invitation.status === "pending" && !invitation.expired
  )
  if (!waiting.length) return null
  const names = waiting.map((invitation) => invitation.email)
  const list =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
  return `${list} ${waiting.length === 1 ? "hasn't" : "haven't"} joined yet.`
}

/** The Getting Started Space Home: the person's own first steps, then guides. */
export function GettingStartedHome({ space }: { space: SpaceView }) {
  const queryClient = useQueryClient()
  const { workspace, person, setup } = usePersonalSetup()
  const { data: spaces } = useSpaces()
  const role = person?.role ?? "owner"
  const joined = setup.items["join-space"]?.spaceId
  const joinedName = joined
    ? spaces?.find((entry) => entry.id === joined)?.name
    : undefined
  const sections = checklistFor(role, setup.audience, joinedName)
  const progress = checklistProgress(sections, setup.items)
  const [chosen, setChosen] = useState<string | null>(null)
  const openId =
    chosen && !setup.items[chosen as ChecklistItem["id"]]
      ? chosen
      : (progress.next?.id ?? null)
  const inviteWaiting = useWaitingInvitations(
    role === "owner" &&
      setup.audience !== "solo" &&
      !setup.items["invite-team"] &&
      Boolean(workspace?.teamContext)
  )
  const pinned = !setup.hidden
  const togglePinned = useMutation({
    mutationFn: () => saveSetup(queryClient, { hidden: pinned }),
    onError: () => toast.error("Couldn’t save. Try again."),
  })
  const name = firstName(person?.name)

  return (
    <PageWithActivity className="xl:h-auto xl:min-h-0 xl:flex-1">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <SpaceIcon space={space} size="lg" />
            <h1 className="min-w-0 font-display text-[1.65rem] leading-tight font-semibold tracking-tight text-foreground sm:text-[2rem]">
              {space.name}
            </h1>
          </div>
          <p className="mt-2 max-w-2xl text-[0.95rem] leading-6 text-muted-foreground">
            {progress.next
              ? `Your first steps in ${workspace?.name ?? "this Worktable"}${name ? `, ${name}` : ""}. They tick off as you go.`
              : "You've done everything here. The guides below stay for whenever you need them."}
          </p>
        </div>
        <span className="mt-1.5 flex shrink-0 items-center gap-2 text-sm text-muted-foreground tabular-nums">
          <ProgressRing done={progress.done} total={progress.total} className="size-5" />
          {progress.done} of {progress.total}
        </span>
      </header>

      {sections.map((section) => {
        const done = section.items.filter((item) => setup.items[item.id]).length
        return (
          <section key={section.title} aria-label={section.title}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-foreground">
                {section.title}
              </h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {done} of {section.items.length}
              </span>
            </div>
            <ol className="card-surface divide-y divide-border rounded-xl">
              {section.items.map((item) => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  evidence={setup.items[item.id]}
                  open={openId === item.id}
                  next={progress.next?.id === item.id}
                  note={item.id === "invite-team" ? inviteWaiting : null}
                  spaces={spaces}
                  onOpen={() => setChosen(item.id)}
                />
              ))}
            </ol>
          </section>
        )
      })}

      <section aria-labelledby="guides-heading">
        <h2 id="guides-heading" className="mb-2 text-sm font-semibold text-foreground">
          Guides
        </h2>
        <div className="grid gap-2.5 sm:grid-cols-3">
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

      <p className="text-sm text-muted-foreground">
        {pinned
          ? "Getting Started stays at the top of your sidebar until you unpin it."
          : "Getting Started is unpinned from your sidebar."}{" "}
        <button
          type="button"
          disabled={togglePinned.isPending}
          onClick={() => togglePinned.mutate()}
          className="text-primary-text hover:underline"
        >
          {pinned ? "Unpin" : "Pin it again"}
        </button>
      </p>
    </PageWithActivity>
  )
}
