import { Link } from "@tanstack/react-router"
import { useId, type ReactNode } from "react"
import type { ActivityEntry, ThreadListItem } from "@worktable/types"
import { cn } from "@worktable/ui/lib/utils"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useActivity } from "@/lib/activity"
import { clockTime, groupByDay } from "@/lib/activity-format"
import {
  ActivitySentence,
  ActorBadge,
  ThreadLink,
} from "@/components/home/activity-sentence"
import { useSpaces } from "@/lib/queries"
import { useQuery } from "@tanstack/react-query"
import { threadsQueryOptions } from "@/lib/threads-queries"

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
          <ActivitySentence entry={entry} />
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
        className="scroll-fade min-h-0 flex-1 overflow-y-auto"
      >
        {isPending ? (
          <div className="space-y-4 pt-1">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex gap-3">
                <div className="size-5 shrink-0 animate-pulse rounded-full bg-muted" />
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
