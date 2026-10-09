import { Link } from "@tanstack/react-router"
import { useId, type ReactNode } from "react"
import type {
  ActivityActor,
  ActivityEntry,
  ThreadSummary,
} from "@worktable/types"
import { cn } from "@worktable/ui/lib/utils"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useActivity } from "@/lib/activity"
import {
  actorName,
  clockTime,
  groupByDay,
} from "@/lib/activity-format"
import { useSpaces } from "@/lib/queries"
import { useThreads } from "@/lib/threads-queries"

// ── Actor badge ────────────────────────────────────────────

/**
 * People are round; agents are square-cornered in the primary color. The
 * agent badge will carry each agent's own identity once agents have one.
 */
export function ActorBadge({
  actor,
  live = false,
}: {
  actor: Pick<ActivityActor, "kind" | "name">
  live?: boolean
}) {
  const initial = (actor.kind === "person" ? "You" : actor.name ?? "?")
    .trim()
    .charAt(0)
    .toUpperCase()
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center text-[10px] font-semibold",
        actor.kind === "agent"
          ? "rounded-md bg-primary/12 text-primary-text ring-1 ring-primary/25 ring-inset"
          : actor.kind === "person"
            ? "rounded-full bg-surface-tint text-foreground"
            : "rounded-full bg-surface-tint text-muted-foreground",
        live &&
          "after:absolute after:-inset-[3px] after:rounded-lg after:border-[1.5px] after:border-transparent after:border-t-primary after:border-r-primary motion-safe:after:animate-spin"
      )}
    >
      {initial}
    </span>
  )
}

// ── Sentences ──────────────────────────────────────────────

function TargetLink({ entry }: { entry: ActivityEntry }) {
  const target = entry.target
  const className = "font-medium text-foreground hover:text-primary-text"
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
    <span className="font-medium text-foreground">{actorName(entry.actor)}</span>
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
      return <>{who} created {what}</>
    case "doc.edited":
      return <>{who} edited {what}{times}</>
    case "doc.archived":
      return <>{who} archived {what}</>
    case "doc.restored":
      return <>{who} restored {what}</>
    case "doc.kept":
      return <>{who} kept {what}</>
    case "doc.madeTemporary":
      return <>{who} made {what} temporary</>
    case "doc.pinned":
      return <>{who} pinned {what}</>
    case "doc.unpinned":
      return <>{who} unpinned {what}</>
    case "comment.created":
      return entry.category === "instruction" ? (
        <>{who} left an instruction on {what}</>
      ) : (
        <>{who} commented on {what}</>
      )
    case "comment.replied":
      return <>{who} replied to a comment on {what}</>
    case "comment.resolved":
      return entry.category === "instruction" ? (
        <>{who} resolved an instruction on {what}</>
      ) : (
        <>{who} resolved a comment on {what}</>
      )
    case "thread.started":
      return <>{who} started {what}</>
    case "thread.replied":
      return <>{who} replied in {what}{times}</>
    case "records.added":
      return <>{who} added {records(entry.count)} to {what}</>
    case "records.updated":
      return <>{who} updated {records(entry.count)} in {what}</>
    case "records.removed":
      return <>{who} removed {records(entry.count)} from {what}</>
  }
}

// ── Entry ──────────────────────────────────────────────────

/** The badge on the timeline, joined to the next entry by a line. */
function Rail({ children, last }: { children: ReactNode; last: boolean }) {
  return (
    <div className="flex shrink-0 flex-col items-center">
      {children}
      {!last && (
        <span aria-hidden="true" className="my-1.5 w-px flex-1 bg-border" />
      )}
    </div>
  )
}

export function ActivityItem({
  entry,
  spaceName,
  hideTime = false,
  last = false,
  leading,
}: {
  entry: ActivityEntry
  spaceName?: string
  hideTime?: boolean
  /** The final entry in a run; its badge ends the line. */
  last?: boolean
  /** Content before the badge, such as the Activity page's time column. */
  leading?: ReactNode
}) {
  const meta = [spaceName, hideTime ? null : clockTime(entry.at)]
    .filter(Boolean)
    .join(" · ")
  return (
    <li className="flex gap-3">
      {leading}
      <Rail last={last}>
        <ActorBadge actor={entry.actor} />
      </Rail>
      <div
        className={cn(
          "min-w-0 flex-1 text-sm leading-5 text-muted-foreground",
          last ? "pb-1" : "pb-5"
        )}
      >
        <p className="break-words">
          <Sentence entry={entry} />
        </p>
        {entry.quote && entry.action.startsWith("comment.") && (
          <p className="mt-1.5 line-clamp-2 border-l-2 border-border pl-2.5 text-[0.8125rem] leading-[1.125rem]">
            {entry.quote}
          </p>
        )}
        {meta && (
          <p
            className={cn(
              "text-xs leading-4 text-muted-foreground/70",
              entry.quote && entry.action.startsWith("comment.")
                ? "mt-1.5"
                : "mt-0.5"
            )}
          >
            {meta}
          </p>
        )}
      </div>
    </li>
  )
}

// ── Live work ──────────────────────────────────────────────

/** Agents replying right now, from the threads' delivery state. */
function useLiveReplies(spaceId?: string): ThreadSummary[] {
  const { data } = useThreads(
    spaceId ? { kind: "space", spaceId } : { kind: "all" }
  )
  return (data?.threads ?? []).filter(
    (thread) =>
      thread.activity?.state === "working" ||
      thread.activity?.state === "receiving"
  )
}

function LiveReply({ thread, last }: { thread: ThreadSummary; last: boolean }) {
  const activity = thread.activity!
  const name =
    thread.identities.find((identity) => identity.id === activity.identityId)
      ?.name ??
    thread.members.find((member) => member.id === activity.participantId)
      ?.name ??
    "An agent"
  const spaceId = thread.location.kind === "space" ? thread.location.spaceId : null
  return (
    <li className="flex gap-3">
      <Rail last={last}>
        <ActorBadge actor={{ kind: "agent", name }} live />
      </Rail>
      <p
        className={cn(
          "min-w-0 flex-1 text-sm leading-5 text-muted-foreground",
          last ? "pb-1" : "pb-5"
        )}
      >
        <span className="font-medium text-foreground">{name}</span> is replying
        in{" "}
        <ThreadLink
          spaceId={spaceId}
          threadId={thread.id}
          className="font-medium text-foreground hover:text-primary-text"
        >
          {thread.title}
        </ThreadLink>
      </p>
    </li>
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
  const { data, isPending } = useActivity({ spaceId, limit }, enabled)
  const { data: spaces } = useSpaces()
  const live = useLiveReplies(spaceId)
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
        <h2
          id={headingId}
          className="text-sm font-semibold text-foreground"
        >
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
      <div ref={scrollRef} className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        {isPending ? (
          <div className="space-y-4 pt-1">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex gap-3">
                <div className="size-5 shrink-0 animate-pulse rounded-full bg-muted/30" />
                <div className="h-9 flex-1 animate-pulse rounded-md bg-muted/20" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 && live.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <>
            {live.length > 0 && (
              <ul>
                {live.map((thread, index) => (
                  <LiveReply
                    key={thread.id}
                    thread={thread}
                    last={index === live.length - 1 && entries.length === 0}
                  />
                ))}
              </ul>
            )}
            {groups.map((group, index) => (
              <div key={group.label}>
                <h3
                  className={cn(
                    "mb-3 text-xs leading-4 font-medium text-muted-foreground/70",
                    index > 0 && "mt-5"
                  )}
                >
                  {group.label}
                </h3>
                <ul>
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
                </ul>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  )
}
