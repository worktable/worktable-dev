import { Link } from "@tanstack/react-router"
import { CircleAlert, Clock3, MessageSquareText } from "lucide-react"
import { useState } from "react"
import type { DocumentSummary, PendingItem } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import {
  DocLocation,
  DocumentFormatIcon,
} from "@/components/document-format-icon"
import { ThreadLink } from "@/components/home/activity-feed"
import { ActorAvatar } from "@/components/home/home-latest"
import { useLifetimeActions } from "@/hooks/use-document-organize"
import { usePending } from "@/lib/activity"
import { shortWhen } from "@/lib/activity-format"
import { useActorName } from "@/lib/use-actor-name"
import { formatArchiveDate } from "@/lib/lifetime"
import { useSpaces } from "@/lib/queries"
import { ProgressRing } from "@/components/getting-started/progress-ring"
import { useGettingStartedShortcut } from "@/lib/setup"

const rowClass =
  "group flex h-10 min-w-0 items-center gap-3 rounded-lg px-2.5 text-sm transition-colors hover:bg-accent"

// ── Pending ────────────────────────────────────────────────

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
  item: PendingItem
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
    "group grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-xl px-2.5 py-2 transition-colors hover:bg-surface-hover"
  const children = (
    <>
      {from ? (
        <ActorAvatar
          actor={from}
          className="row-span-2 size-7 self-start text-xs @lg/page:self-center"
        />
      ) : (
        <span
          className={cn(
            "row-span-2 flex size-7 items-center justify-center self-start rounded-full bg-surface-tint @lg/page:self-center",
            item.kind === "deliveryFailed"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          <Icon className="size-3.5" />
        </span>
      )}
      <span className="line-clamp-2 min-w-0 text-sm leading-5 font-medium text-foreground @lg/page:line-clamp-none @lg/page:truncate">
        {title}
      </span>
      <span className="row-span-2 shrink-0 self-start pt-0.5 text-xs text-muted-foreground tabular-nums">
        {shortWhen(item.at)}
      </span>
      <span className="col-start-2 flex min-w-0 items-center gap-1.5 text-[0.8rem] leading-5 text-muted-foreground">
        {from && (
          <span className="shrink-0 font-medium text-reading-foreground">
            {nameOf(from)}
          </span>
        )}
        <span className="shrink-0">{what}</span>
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
  const items = pending.data?.items ?? []
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
              className="ml-[3.125rem] flex h-8 items-center text-[0.8125rem] text-muted-foreground hover:text-foreground"
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

// ── Recent ─────────────────────────────────────────────────

export interface RecentItem {
  spaceId: string
  spaceName?: string
  document: DocumentSummary
}

export function RecentRows({ items }: { items: RecentItem[] }) {
  return (
    <div className="-mx-2.5">
      {items.map(({ spaceId, spaceName, document }) => {
        return (
          <Link
            key={`${spaceId}/${document.path}`}
            to="/spaces/$spaceId/documents/$"
            params={{ spaceId, _splat: document.path }}
            className={rowClass}
          >
            <DocumentFormatIcon
              formatId={document.format.id}
              name={document.path}
              className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
            />
            <span className="min-w-0 truncate font-medium text-foreground">
              {document.title}
            </span>
            <DocLocation spaceName={spaceName} path={document.path} />
            {document.updatedAt && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {shortWhen(document.updatedAt)}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}

// ── Temporary ──────────────────────────────────────────────

/** Calendar days from today to the archive date, in the reader's time zone. */
function daysUntil(archiveOn: string, now: number): number {
  const day = (time: number) => {
    const date = new Date(time)
    return (
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000
    )
  }
  return day(Date.parse(archiveOn)) - day(now)
}

function archiveLabel(archiveOn: string, days: number): string {
  if (days <= 0) return "Archives today"
  if (days === 1) return "Archives tomorrow"
  if (days < 7) {
    return `Archives ${new Date(archiveOn).toLocaleDateString(undefined, { weekday: "short" })}`
  }
  return `Archives ${formatArchiveDate(archiveOn)}`
}

function TemporaryRow({ item }: { item: RecentItem }) {
  const { spaceId, spaceName, document } = item
  const { keep } = useLifetimeActions(spaceId, document.path)
  const [keeping, setKeeping] = useState(false)
  const [now] = useState(() => Date.now())
  const archiveOn = document.archiveOn!
  const days = daysUntil(archiveOn, now)
  const soon = days <= 1
  return (
    <div className={cn(rowClass, "relative")}>
      <Link
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId, _splat: document.path }}
        className="absolute inset-0 rounded-lg"
        aria-label={document.title}
      />
      <DocumentFormatIcon
        formatId={document.format.id}
        name={document.path}
        className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
      />
      <span className="min-w-0 truncate font-medium text-foreground">
        {document.title}
      </span>
      <DocLocation
        spaceName={spaceName}
        path={document.path}
        className="hidden sm:inline"
      />
      <span className="flex-1 sm:hidden" />
      <Button
        size="xs"
        variant="outline"
        disabled={keeping}
        onClick={() => {
          setKeeping(true)
          void keep().finally(() => setKeeping(false))
        }}
        className="relative shrink-0 opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
      >
        Keep
      </Button>
      <span
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium",
          soon
            ? "bg-warning/12 text-foreground"
            : "bg-surface-tint text-muted-foreground"
        )}
      >
        <Clock3 className={cn("size-3", soon && "text-warning")} />
        <span className="hidden sm:inline">
          {archiveLabel(archiveOn, days)}
        </span>
        <span className="sm:hidden">
          {archiveLabel(archiveOn, days).replace(
            /^Archives (.)/,
            (_, first: string) => first.toUpperCase()
          )}
        </span>
      </span>
    </div>
  )
}

/** The temporary docs that archive soonest; they disappear unless kept. */
export function TemporaryGroup({ items }: { items: RecentItem[] }) {
  const [expanded, setExpanded] = useState(false)
  const sorted = items
    .filter((item) => item.document.archiveOn)
    .sort((a, b) => a.document.archiveOn!.localeCompare(b.document.archiveOn!))
  if (sorted.length === 0) return null
  const shown = expanded ? sorted : sorted.slice(0, 3)
  const more = sorted.length - shown.length
  return (
    <section id="temporary" aria-labelledby="temporary-heading">
      <h2
        id="temporary-heading"
        className="mb-2 text-sm font-semibold text-foreground"
      >
        Temporary
      </h2>
      <div className="rounded-xl card-surface p-1">
        {shown.map((item) => (
          <TemporaryRow
            key={`${item.spaceId}/${item.document.path}`}
            item={item}
          />
        ))}
        {more > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className={cn(
              rowClass,
              "w-full text-muted-foreground hover:text-foreground"
            )}
          >
            Show {more} more
          </button>
        )}
      </div>
    </section>
  )
}
