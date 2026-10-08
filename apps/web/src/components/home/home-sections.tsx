import { Link } from "@tanstack/react-router"
import { AtSign, CircleAlert, Clock3, Reply } from "lucide-react"
import { useState } from "react"
import type { DocumentSummary, PendingItem } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { ThreadLink } from "@/components/home/activity-feed"
import { useLifetimeActions } from "@/hooks/use-document-organize"
import { usePending } from "@/lib/activity"
import { shortWhen } from "@/lib/activity-format"
import { formatArchiveDate } from "@/lib/lifetime"
import { useSpaces } from "@/lib/queries"
import { humanizeSegment } from "@/lib/tree"

const rowClass =
  "group flex h-10 min-w-0 items-center gap-3 rounded-lg px-2.5 text-sm transition-colors hover:bg-accent"

function folderOf(path: string): string | null {
  const parts = path.split("/")
  return parts.length > 1 ? parts.slice(0, -1).map(humanizeSegment).join(" / ") : null
}

// ── Pending ────────────────────────────────────────────────

function PendingRow({
  item,
  spaceName,
}: {
  item: PendingItem
  spaceName?: string
}) {
  const where = spaceName ? (
    <span className="shrink-0 text-muted-foreground/70">{spaceName}</span>
  ) : null
  const label = "min-w-0 flex-1 truncate font-medium text-foreground"
  switch (item.kind) {
    case "threadRequest":
      return (
        <ThreadLink spaceId={item.spaceId} threadId={item.threadId} className={rowClass}>
          <AtSign className="size-4 shrink-0 text-muted-foreground" />
          <span className={label}>
            {item.from.name ?? "Someone"} asked you in {item.threadTitle}
          </span>
          {where}
          <span className="shrink-0 text-xs text-muted-foreground">{shortWhen(item.at)}</span>
        </ThreadLink>
      )
    case "commentReply":
      return (
        <Link
          to="/spaces/$spaceId/documents/$"
          params={{ spaceId: item.spaceId, _splat: item.docPath }}
          className={rowClass}
        >
          <Reply className="size-4 shrink-0 text-muted-foreground" />
          <span className={label}>
            Reply to your comment on {item.docTitle ?? item.docPath}
          </span>
          {where}
          <span className="shrink-0 text-xs text-muted-foreground">{shortWhen(item.at)}</span>
        </Link>
      )
    case "deliveryFailed":
      return (
        <ThreadLink spaceId={item.spaceId} threadId={item.threadId} className={rowClass}>
          <CircleAlert className="size-4 shrink-0 text-destructive" />
          <span className={label}>
            Message to {item.agentName} wasn’t delivered
          </span>
          {where}
          <span className="shrink-0 text-xs text-muted-foreground">{shortWhen(item.at)}</span>
        </ThreadLink>
      )
  }
}

/** Shown only when something is waiting on the reader. */
export function PendingSection({ spaceId }: { spaceId?: string }) {
  const { data } = usePending()
  const { data: spaces } = useSpaces()
  const names = new Map((spaces ?? []).map((space) => [space.id, space.name]))
  const items = (data?.items ?? []).filter(
    (item) => !spaceId || item.spaceId === spaceId
  )
  if (items.length === 0) return null
  return (
    <section aria-labelledby="pending-heading">
      <h2 id="pending-heading" className="mb-2 text-sm font-semibold text-foreground">
        Pending
      </h2>
      <div className="rounded-xl border border-border bg-card p-1">
        {items.map((item) => (
          <PendingRow
            key={item.id}
            item={item}
            spaceName={
              spaceId || !item.spaceId ? undefined : names.get(item.spaceId)
            }
          />
        ))}
      </div>
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
        const folder = folderOf(document.path)
        const where = [spaceName, folder].filter(Boolean).join(" / ")
        return (
          <Link
            key={`${spaceId}/${document.path}`}
            to="/spaces/$spaceId/documents/$"
            params={{ spaceId, _splat: document.path }}
            className={rowClass}
          >
            <DocumentFormatIcon
              formatId={document.format.id}
              className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
            />
            <span className="min-w-0 truncate font-medium text-foreground">
              {document.title}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
              {where}
            </span>
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

const SOON_MS = 2 * 86_400_000

function archiveLabel(archiveOn: string, now: number): string {
  const days = Math.round(
    (new Date(archiveOn).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) /
      86_400_000
  )
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
  const soon = Date.parse(archiveOn) - now < SOON_MS
  const folder = folderOf(document.path)
  const where = [spaceName, folder].filter(Boolean).join(" / ")
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
        className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
      />
      <span className="min-w-0 truncate font-medium text-foreground">
        {document.title}
      </span>
      <span className="hidden min-w-0 flex-1 truncate text-muted-foreground/70 sm:inline">
        {where}
      </span>
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
            ? "bg-warning/10 text-warning"
            : "bg-surface-tint text-muted-foreground"
        )}
      >
        <Clock3 className="size-3" />
        <span className="hidden sm:inline">{archiveLabel(archiveOn, now)}</span>
        <span className="sm:hidden">
          {archiveLabel(archiveOn, now).replace(/^Archives (.)/, (_, first: string) =>
            first.toUpperCase()
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
        className="mb-1 flex items-center gap-2 text-[0.8rem] font-semibold text-foreground"
      >
        <Clock3 className="size-3.5 text-muted-foreground" />
        Temporary
      </h2>
      <div className="-mx-2.5">
        {shown.map((item) => (
          <TemporaryRow key={`${item.spaceId}/${item.document.path}`} item={item} />
        ))}
      </div>
      {more > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-sm text-muted-foreground hover:text-foreground"
        >
          +{more} more
        </button>
      )}
    </section>
  )
}
