import { Link } from "@tanstack/react-router"
import { CircleAlert, MessageSquareText } from "lucide-react"
import { useState } from "react"
import type { PendingItem } from "@worktable/types"
import { cn } from "@worktable/ui/lib/utils"
import { ThreadLink } from "@/components/home/activity-feed"
import { ActorAvatar } from "@/components/home/home-latest"
import { usePending } from "@/lib/activity"
import { shortWhen } from "@/lib/activity-format"
import { useActorName } from "@/lib/use-actor-name"
import { useSpaces } from "@/lib/queries"
import { ProgressRing } from "@/components/getting-started/progress-ring"
import { useGettingStartedShortcut } from "@/lib/setup"

const rowClass =
  "group flex h-10 min-w-0 items-center gap-3 rounded-lg px-2.5 text-sm transition-colors hover:bg-accent"

// ── Pending ────────────────────────────────────────────────

/** Skill library proposals get their own rows once the web shows libraries. */
type ShownPendingItem = Exclude<PendingItem, { kind: "skillProposal" }>

const shownPending = (item: PendingItem): item is ShownPendingItem =>
  item.kind !== "skillProposal"

/** Pending items shown before the rest fold behind More. */
const PENDING_ROWS = 3

/**
 * One thing waiting on the reader, in the rhythm of Latest's rows: what was
 * asked, then who asked and where.
 */
function PendingRow({
  item,
  spaceName,
}: {
  item: ShownPendingItem
  spaceName?: string
}) {
  const nameOf = useActorName()
  const from =
    item.kind === "threadRequest" || item.kind === "commentRequest"
      ? item.from
      : null
  // The thread or doc names the row; a message's own words can be long, and
  // carry their formatting marks.
  const title =
    item.kind === "threadRequest" || item.kind === "deliveryFailed"
      ? item.threadTitle
      : item.kind === "visitorCommentsPaused"
        ? item.linkLabel || "Untitled link"
        : (item.docTitle ?? item.docPath)
  const detail =
    item.kind === "visitorComments"
      ? item.linkLabel || "Untitled link"
      : spaceName
  const what =
    item.kind === "threadRequest"
      ? "asked you"
      : item.kind === "commentRequest"
        ? "commented"
        : item.kind === "deliveryFailed"
          ? `Not delivered to ${item.agentName}`
          : item.kind === "visitorCommentsPaused"
            ? "Comments paused"
            : `${item.count} visitor comment${item.count === 1 ? "" : "s"}`
  const Icon =
    item.kind === "deliveryFailed" ? CircleAlert : MessageSquareText
  const className =
    "group grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-px rounded-xl px-2.5 py-3 transition-colors hover:bg-surface-hover"
  const children = (
    <>
      {from ? (
        <ActorAvatar
          actor={from}
          className="row-span-2 size-8 self-start text-xs @lg/page:self-center"
        />
      ) : (
        <span
          className={cn(
            "row-span-2 flex size-8 items-center justify-center self-start rounded-full bg-surface-tint @lg/page:self-center",
            item.kind === "deliveryFailed"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          <Icon className="size-3.5" />
        </span>
      )}
      <span className="line-clamp-2 min-w-0 text-[0.9375rem] leading-6 font-medium text-foreground @lg/page:line-clamp-none @lg/page:truncate">
        {title}
      </span>
      <span className="shrink-0 self-start pt-1 text-xs text-muted-foreground tabular-nums @lg/page:row-span-2">
        {shortWhen(item.at)}
      </span>
      <span className="col-span-2 col-start-2 flex min-w-0 items-center gap-1.5 text-[0.8125rem] leading-5 text-muted-foreground @lg/page:col-span-1">
        <span className="shrink-0">
          {from ? `${nameOf(from)} ${what}` : what}
        </span>
        {detail && (
          <>
            <span aria-hidden className="shrink-0 opacity-50">
              ·
            </span>
            <span className="min-w-0 truncate">{detail}</span>
          </>
        )}
      </span>
    </>
  )
  return item.kind === "threadRequest" || item.kind === "deliveryFailed" ? (
    <ThreadLink
      spaceId={item.spaceId}
      threadId={item.threadId}
      className={className}
    >
      {children}
    </ThreadLink>
  ) : (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId: item.spaceId, _splat: item.docPath }}
      hash={item.kind === "commentRequest" ? undefined : "visitors"}
      className={className}
    >
      {children}
    </Link>
  )
}

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1)

/** Shown when something is waiting on the reader, or when that is unknown. */
export function PendingSection({ spaceId }: { spaceId?: string }) {
  const pending = usePending(spaceId)
  const { data: spaces } = useSpaces()
  const [showAll, setShowAll] = useState(false)
  const names = new Map((spaces ?? []).map((space) => [space.id, space.name]))
  const items = (pending.data?.items ?? []).filter(shownPending)
  const failed = pending.isError && !pending.data
  // Home points to Getting Started until the person is done or unpins it.
  const shortcut = useGettingStartedShortcut(spaces)
  const gettingStarted = !spaceId && shortcut?.progress.next ? shortcut : null
  if (items.length === 0 && !failed && !gettingStarted) return null
  const shown = showAll ? items : items.slice(0, PENDING_ROWS)
  return (
    <section aria-labelledby="pending-heading" className="min-w-0">
      <h2
        id="pending-heading"
        className="mb-2.5 text-sm font-semibold text-foreground"
      >
        Pending
      </h2>
      {failed && !gettingStarted ? (
        <p className="text-sm text-muted-foreground">
          Couldn’t load what’s pending.{" "}
          <button
            type="button"
            className="text-primary-text hover:underline"
            onClick={() => void pending.refetch()}
          >
            Try again
          </button>
        </p>
      ) : (
        <div className="-mx-2.5">
          {shown.map((item) => (
            <PendingRow
              key={item.id}
              item={item}
              spaceName={
                spaceId || !item.spaceId ? undefined : names.get(item.spaceId)
              }
            />
          ))}
          {items.length > shown.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="ml-[3.5rem] flex h-8 items-center text-[0.8125rem] text-muted-foreground hover:text-foreground"
            >
              {items.length - shown.length} More
            </button>
          )}
          {gettingStarted && (
            <Link
              to="/spaces/$spaceId"
              params={{ spaceId: gettingStarted.space.id }}
              className={rowClass}
            >
              <ProgressRing
                done={gettingStarted.progress.done}
                total={gettingStarted.progress.total}
              />
              <span className="shrink-0 font-medium text-foreground">
                {gettingStarted.space.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {gettingStarted.progress.done} of{" "}
                {gettingStarted.progress.total} · Next:{" "}
                {lowerFirst(gettingStarted.progress.next?.title ?? "")}
              </span>
            </Link>
          )}
        </div>
      )}
    </section>
  )
}
