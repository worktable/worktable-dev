import { Link } from "@tanstack/react-router"
import { useId, type ReactNode } from "react"
import type {
  ActivityActor,
  ActivityEntry,
  ThreadListItem,
} from "@worktable/types"
import { cn } from "@worktable/ui/lib/utils"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useActivity } from "@/lib/activity"
import { actorName, clockTime, groupByDay } from "@/lib/activity-format"
import { useSpaces } from "@/lib/queries"
import { useQuery } from "@tanstack/react-query"
import { threadsQueryOptions } from "@/lib/threads-queries"
import { ThreadParticipantAvatar } from "@/components/threads/thread-participant-avatar"

// ── Actor badge ────────────────────────────────────────────

/** Compact identities shared by activity, its filters, and document bylines. */
export function ActorBadge({
  actor,
  live = false,
}: {
  actor: ActivityActor
  live?: boolean
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex size-6 shrink-0 items-center justify-center text-[11px] font-semibold",
        actor.kind !== "system"
          ? "rounded-full"
          : "rounded-full bg-surface-tint text-muted-foreground",
        live &&
          "after:absolute after:-inset-[3px] after:rounded-full after:border-[1.5px] after:border-transparent after:border-t-primary after:border-r-primary motion-safe:after:animate-spin"
      )}
    >
      {actor.kind !== "system" ? (
        <ThreadParticipantAvatar
          participant={{
            kind: actor.kind === "person" ? "human" : "agent",
            id: actor.id,
            name: actor.name ?? (actor.kind === "person" ? "User" : "Agent"),
          }}
          className="size-6 [&_[data-slot=avatar-fallback]]:text-[11px]"
        />
      ) : (
        (actor.name ?? "?").trim().charAt(0).toUpperCase()
      )}
    </span>
  )
}

// ── Sentences ──────────────────────────────────────────────

// Stretch the existing destination link across its ActivityRow, keeping native
// link behavior and a single keyboard stop for each entry.
const activityLinkClass =
  "font-medium text-foreground outline-none after:absolute after:inset-0 after:z-10 after:rounded-lg hover:text-primary-text focus-visible:text-primary-text focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"

function TargetLink({ entry }: { entry: ActivityEntry }) {
  const target = entry.target
  const className = activityLinkClass
  if (target.kind === "doc" && entry.spaceId) {
    return (
      <Link
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId: entry.spaceId, _splat: target.path }}
        className={className}
      >
        {target.title ?? target.path.split("/").at(-1)}
      </Link>
    )
  }
  if (target.kind === "collection" && entry.spaceId) {
    return (
      <Link
        to="/spaces/$spaceId/records/$"
        params={{ spaceId: entry.spaceId, _splat: target.collectionId }}
        className={className}
      >
        {target.name ?? target.collectionId}
      </Link>
    )
  }
  if (target.kind === "thread") {
    return (
      <ThreadLink
        spaceId={entry.spaceId}
        threadId={target.threadId}
        className={className}
      >
        {target.title ?? "a thread"}
      </ThreadLink>
    )
  }
  return null
}

export function ThreadLink({
  spaceId,
  threadId,
  className,
  children,
}: {
  spaceId: string | null
  threadId: string
  className?: string
  children: ReactNode
}) {
  return spaceId ? (
    <Link
      to="/spaces/$spaceId/threads/$"
      params={{ spaceId, _splat: threadId }}
      className={className}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/threads/$"
      params={{ _splat: `worktable/${threadId}` }}
      search={{ location: "all" }}
      className={className}
    >
      {children}
    </Link>
  )
}

function records(count: number | undefined): string {
  const n = count ?? 1
  return n === 1 ? "a record" : `${n} records`
}

/** One plain sentence: who did what to which thing. */
function Sentence({ entry }: { entry: ActivityEntry }) {
  const who = (
    <span className="font-medium text-foreground">
      {actorName(entry.actor)}
    </span>
  )
  const what = <TargetLink entry={entry} />
  const times = entry.repeats > 1 ? ` ${entry.repeats} times` : ""
  if (entry.actor.kind === "system") {
    const passive: Partial<Record<ActivityEntry["action"], string>> = {
      "doc.archived": "was archived",
      "doc.edited": "changed outside Worktable",
      "doc.created": "was added",
    }
    return (
      <>
        {what} {passive[entry.action] ?? "changed"}
      </>
    )
  }
  switch (entry.action) {
    case "doc.created":
      return (
        <>
          {who} created {what}
        </>
      )
    case "doc.edited":
      return (
        <>
          {who} edited {what}
          {times}
        </>
      )
    case "doc.archived":
      return (
        <>
          {who} archived {what}
        </>
      )
    case "doc.restored":
      return (
        <>
          {who} restored {what}
        </>
      )
    case "doc.kept":
      return (
        <>
          {who} kept {what}
        </>
      )
    case "doc.madeTemporary":
      return (
        <>
          {who} made {what} temporary
        </>
      )
    case "doc.pinned":
      return (
        <>
          {who} pinned {what}
        </>
      )
    case "doc.unpinned":
      return (
        <>
          {who} unpinned {what}
        </>
      )
    case "comment.created":
      return entry.category === "instruction" ? (
        <>
          {who} left an instruction on {what}
        </>
      ) : (
        <>
          {who} commented on {what}
        </>
      )
    case "comment.replied":
      return (
        <>
          {who} replied to a comment on {what}
        </>
      )
    case "comment.resolved":
      return entry.category === "instruction" ? (
        <>
          {who} resolved an instruction on {what}
        </>
      ) : (
        <>
          {who} resolved a comment on {what}
        </>
      )
    case "thread.started":
      return (
        <>
          {who} started {what}
        </>
      )
    case "thread.replied":
      return (
        <>
          {who} replied in {what}
          {times}
        </>
      )
    case "records.added":
      return (
        <>
          {who} added {records(entry.count)} to {what}
        </>
      )
    case "records.updated":
      return (
        <>
          {who} updated {records(entry.count)} in {what}
        </>
      )
    case "records.removed":
      return (
        <>
          {who} removed {records(entry.count)} from {what}
        </>
      )
  }
}

// ── Entry ──────────────────────────────────────────────────

/** Row padding sits outside the headings' and timestamps' shared left edge. */
export function ActivityList({ children }: { children: ReactNode }) {
  return <ul className="-mx-2">{children}</ul>
}

function ActivityRow({ children }: { children: ReactNode }) {
  return (
    <li className="relative isolate flex min-h-11 gap-3 rounded-lg px-2 py-2.5 transition-colors has-[a:focus-visible]:bg-surface-hover has-[a:hover]:bg-surface-hover">
      {children}
    </li>
  )
}

/** The badge on the timeline, joined to the next entry by a line. */
function Rail({ children, last }: { children: ReactNode; last: boolean }) {
  return (
    <div className="relative flex shrink-0 flex-col items-center">
      {children}
      {!last && (
        <span
          aria-hidden="true"
          className="absolute top-7.5 -bottom-3.5 w-px bg-border"
        />
      )}
    </div>
  )
}

function ActivityTime({ at }: { at?: string }) {
  return (
    <span className="w-16 shrink-0 text-left text-xs leading-5 text-muted-foreground/70 tabular-nums">
      {at ? <time dateTime={at}>{clockTime(at)}</time> : "Now"}
    </span>
  )
}

export function ActivityItem({
  entry,
  spaceName,
  last = false,
}: {
  entry: ActivityEntry
  spaceName?: string
  /** The final entry in a run; its badge ends the line. */
  last?: boolean
}) {
  return (
    <ActivityRow>
      <ActivityTime at={entry.at} />
      <Rail last={last}>
        <ActorBadge actor={entry.actor} />
      </Rail>
      <div className="min-w-0 flex-1 text-sm leading-5 text-muted-foreground">
        <p className="break-words">
          <Sentence entry={entry} />
        </p>
        {entry.quote && entry.action.startsWith("comment.") && (
          <p className="mt-1.5 line-clamp-2 border-l-2 border-border pl-2.5 text-[0.8125rem] leading-[1.125rem]">
            {entry.quote}
          </p>
        )}
        {spaceName && (
          <p
            className={cn(
              "text-xs leading-4 text-muted-foreground/70",
              entry.quote && entry.action.startsWith("comment.")
                ? "mt-1.5"
                : "mt-0.5"
            )}
          >
            {spaceName}
          </p>
        )}
      </div>
    </ActivityRow>
  )
}

// ── Live work ──────────────────────────────────────────────

/**
 * Agents replying right now, from the threads' delivery state. Only the
 * placement on screen reads the thread list.
 */
function useLiveReplies(
  spaceId: string | undefined,
  enabled: boolean
): ThreadListItem[] {
  const { data } = useQuery({
    ...threadsQueryOptions(
      spaceId ? { kind: "space", spaceId } : { kind: "all" }
    ),
    enabled,
  })
  return (data?.threads ?? []).filter(
    (thread) =>
      thread.activity?.state === "working" ||
      thread.activity?.state === "receiving"
  )
}

function LiveReply({
  thread,
  last,
}: {
  thread: ThreadListItem
  last: boolean
}) {
  const activity = thread.activity!
  const name =
    thread.identities.find((identity) => identity.id === activity.identityId)
      ?.name ??
    thread.members.find((member) => member.id === activity.participantId)
      ?.name ??
    "An agent"
  const spaceId =
    thread.location.kind === "space" ? thread.location.spaceId : null
  return (
    <ActivityRow>
      <ActivityTime />
      <Rail last={last}>
        <ActorBadge
          actor={{ kind: "agent", id: activity.participantId, name }}
          live
        />
      </Rail>
      <p className="min-w-0 flex-1 text-sm leading-5 text-muted-foreground">
        <span className="font-medium text-foreground">{name}</span> is replying
        in{" "}
        <ThreadLink
          spaceId={spaceId}
          threadId={thread.id}
          className={activityLinkClass}
        >
          {thread.title}
        </ThreadLink>
      </p>
    </ActivityRow>
  )
}

// ── Panel ──────────────────────────────────────────────────

/**
 * Activity beside Home and Space Home: a full-height panel on wide screens,
 * a short section under the page on narrow ones.
 */
export function ActivityPanel({
  spaceId,
  limit,
  enabled = true,
  className,
}: {
  spaceId?: string
  limit: number
  /** Whether this placement is on screen and should load. */
  enabled?: boolean
  className?: string
}) {
  const { data, isPending, isError, refetch } = useActivity(
    { spaceId, limit },
    enabled
  )
  const { data: spaces } = useSpaces()
  const live = useLiveReplies(spaceId, enabled)
  const scrollRef = useScrollFade<HTMLDivElement>()
  const headingId = useId()
  const names = new Map((spaces ?? []).map((space) => [space.id, space.name]))
  const entries = data?.entries ?? []
  const groups = groupByDay(entries)

  return (
    <section
      aria-labelledby={headingId}
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
    >
      <div className="flex items-baseline justify-between gap-3 pb-4">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          Activity
        </h2>
        {entries.length > 0 && (
          <Link
            to="/activity"
            search={spaceId ? { spaceId } : {}}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Show all
          </Link>
        )}
      </div>
      <div
        ref={scrollRef}
        className="scroll-fade -mx-2 min-h-0 flex-1 overflow-y-auto px-2"
      >
        {isPending ? (
          <div className="space-y-4 pt-1">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex gap-3">
                <div className="h-3 w-16 shrink-0 animate-pulse rounded bg-muted" />
                <div className="size-6 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="h-9 flex-1 animate-pulse rounded-md bg-muted" />
              </div>
            ))}
          </div>
        ) : isError && !data ? (
          <p className="text-sm text-muted-foreground">
            Couldn’t load activity.{" "}
            <button
              type="button"
              className="text-primary-text hover:underline"
              onClick={() => void refetch()}
            >
              Try again
            </button>
          </p>
        ) : entries.length === 0 && live.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <>
            {live.length > 0 && (
              <ActivityList>
                {live.map((thread, index) => (
                  <LiveReply
                    key={thread.id}
                    thread={thread}
                    last={index === live.length - 1 && entries.length === 0}
                  />
                ))}
              </ActivityList>
            )}
            {groups.map((group, index) => (
              <div key={group.label}>
                <h3
                  className={cn(
                    "mb-1 text-xs leading-4 font-medium text-muted-foreground/70",
                    index > 0 && "mt-5"
                  )}
                >
                  {group.label}
                </h3>
                <ActivityList>
                  {group.items.map((entry, itemIndex) => (
                    <ActivityItem
                      key={entry.id}
                      entry={entry}
                      last={itemIndex === group.items.length - 1}
                      spaceName={
                        spaceId || !entry.spaceId
                          ? undefined
                          : names.get(entry.spaceId)
                      }
                    />
                  ))}
                </ActivityList>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  )
}
