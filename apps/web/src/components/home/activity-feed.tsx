import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type {
  ActivityActor,
  ActivityEntry,
  ThreadSummary,
} from "@worktable/types"
import { cn } from "@worktable/ui/lib/utils"
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
        "relative mt-px flex size-5 shrink-0 items-center justify-center text-[10px] font-semibold",
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

// ── Grouping ───────────────────────────────────────────────

// ── Entry ──────────────────────────────────────────────────

export function ActivityItem({
  entry,
  spaceName,
  hideTime = false,
  leading,
}: {
  entry: ActivityEntry
  spaceName?: string
  hideTime?: boolean
  /** Content before the badge, such as the Activity page's time column. */
  leading?: ReactNode
}) {
  const meta = [spaceName, hideTime ? null : clockTime(entry.at)]
    .filter(Boolean)
    .join(" · ")
  return (
    <li className="flex gap-2.5 py-1.5">
      {leading}
      <ActorBadge actor={entry.actor} />
      <div className="min-w-0 flex-1 text-[0.8rem] leading-5 text-muted-foreground">
        <p className="break-words">
          <Sentence entry={entry} />
        </p>
        {entry.quote && entry.action.startsWith("comment.") && (
          <p className="mt-1 line-clamp-2 border-l-2 border-border pl-2 text-muted-foreground">
            {entry.quote}
          </p>
        )}
        {meta && <p className="text-xs text-muted-foreground/70">{meta}</p>}
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

function LiveReply({ thread }: { thread: ThreadSummary }) {
  const activity = thread.activity!
  const name =
    thread.identities.find((identity) => identity.id === activity.identityId)
      ?.name ??
    thread.members.find((member) => member.id === activity.participantId)
      ?.name ??
    "An agent"
  const spaceId = thread.location.kind === "space" ? thread.location.spaceId : null
  return (
    <li className="flex gap-2.5 py-1.5">
      <ActorBadge actor={{ kind: "agent", name }} live />
      <p className="min-w-0 flex-1 text-[0.8rem] leading-5 text-muted-foreground">
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

// ── Column ─────────────────────────────────────────────────

/** The side column on Home and Space Home. */
export function ActivityColumn({ spaceId }: { spaceId?: string }) {
  const { data, isPending } = useActivity({ spaceId, limit: 12 })
  const { data: spaces } = useSpaces()
  const live = useLiveReplies(spaceId)
  const names = new Map((spaces ?? []).map((space) => [space.id, space.name]))
  const entries = data?.entries ?? []

  return (
    <section aria-labelledby="activity-heading" className="min-w-0">
      <h2 id="activity-heading" className="mb-2 text-sm font-semibold text-foreground">
        Activity
      </h2>
      {isPending ? (
        <div className="space-y-3 pt-1">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex gap-2.5">
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
            <ul className="mb-1">
              {live.map((thread) => (
                <LiveReply key={thread.id} thread={thread} />
              ))}
            </ul>
          )}
          {groupByDay(entries).map((group, index) => (
            <div key={group.label}>
              <h3
                className={cn(
                  "mb-0.5 text-xs font-medium text-muted-foreground/70",
                  index === 0 && live.length === 0 ? "mt-1" : "mt-3"
                )}
              >
                {group.label}
              </h3>
              <ul>
                {group.items.map((entry) => (
                  <ActivityItem
                    key={entry.id}
                    entry={entry}
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
          {entries.length > 0 && (
            <Link
              to="/activity"
              search={spaceId ? { spaceId } : {}}
              className="mt-3 inline-block text-sm text-muted-foreground hover:text-foreground"
            >
              Show all
            </Link>
          )}
        </>
      )}
    </section>
  )
}
