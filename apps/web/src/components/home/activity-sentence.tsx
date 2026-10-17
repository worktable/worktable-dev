import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { ActivityActor, ActivityEntry } from "@worktable/types"
import { cn } from "@worktable/ui/lib/utils"
import { actorName } from "@/lib/activity-format"

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
  const initial = (actor.kind === "person" ? "You" : (actor.name ?? "?"))
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
export function ActivitySentence({ entry }: { entry: ActivityEntry }) {
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
