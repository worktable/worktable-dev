import { Link } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  FilePlus2,
  MessageSquareText,
  Pencil,
  Reply,
} from "lucide-react"
import { useState, type ReactNode } from "react"
import type { ActivityActor, PendingItem } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { Textarea } from "@worktable/ui/components/textarea"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { ActorBadge, ThreadLink } from "@/components/home/activity-feed"
import { ProgressRing } from "@/components/getting-started/progress-ring"
import { useLifetimeActions } from "@/hooks/use-document-organize"
import { activityQueryKeys, usePending } from "@/lib/activity"
import { shortWhen } from "@/lib/activity-format"
import { replyAnnotation } from "@/lib/annotations-api"
import { createClientId } from "@/lib/client-id"
import {
  clearSend,
  failedBody,
  scheduleSend,
  undoSend,
  useSendPhase,
} from "@/lib/delayed-send"
import {
  formatArchiveDate,
  useRecentDocuments,
  type RecentDocument,
} from "@/lib/lifetime"
import { useSpaces } from "@/lib/queries"
import { useGettingStartedShortcut } from "@/lib/setup"
import { postThreadReply } from "@/lib/threads-api"
import { humanizeSegment } from "@/lib/tree"
import { useActorName } from "@/lib/use-actor-name"

// Every row on Home and Space Home shares one grid, so the actor, the title,
// one mark and the time line up across sections: who | what | mark | when.
const rowGrid =
  "grid grid-cols-[1.5rem_minmax(0,1fr)_1.75rem_4.25rem] items-center gap-x-3"
const rowClass = cn(rowGrid, "relative h-11 rounded-lg px-3 text-sm")
const rowHover = "transition-colors hover:bg-surface-hover"
const cardClass = "card-surface rounded-[14px] p-1.5"
// Stretches a row's link across it; buttons in the row sit above it.
const rowLink =
  "absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"

function SectionHeader({
  id,
  title,
  action,
}: {
  id: string
  title: string
  action?: ReactNode
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
      <h2 id={id} className="text-sm font-semibold text-foreground">
        {title}
      </h2>
      {action}
    </div>
  )
}

const quietLink =
  "inline-flex items-center gap-1 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:text-foreground"

function RowText({
  title,
  meta,
  place,
}: {
  title: string
  meta?: string
  /** Where the doc lives; left out on phones, where the title needs the room. */
  place?: boolean
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
      <span className="max-w-[65%] shrink-0 truncate font-medium text-foreground max-sm:max-w-full">
        {title}
      </span>
      {meta && (
        <span
          className={cn(
            "min-w-0 truncate text-[0.8rem] text-muted-foreground",
            place && "max-sm:hidden"
          )}
        >
          {meta}
        </span>
      )}
    </span>
  )
}

function When({ at }: { at?: string }) {
  return (
    <span className="justify-self-end text-xs whitespace-nowrap text-muted-foreground tabular-nums">
      {at ? shortWhen(at) : ""}
    </span>
  )
}

function Who({ actor }: { actor?: ActivityActor }) {
  const nameOf = useActorName()
  if (!actor) return <span />
  return (
    <span title={nameOf(actor)} className="flex">
      <ActorBadge actor={actor} />
    </span>
  )
}

// ── Pending ────────────────────────────────────────────────

const SHOWN = 3

function replyable(
  item: PendingItem
): item is Extract<PendingItem, { kind: "threadRequest" | "commentRequest" }> {
  return item.kind === "threadRequest" || item.kind === "commentRequest"
}

function sendReply(item: PendingItem, body: string, key: string) {
  if (item.kind === "threadRequest") {
    // An answer to an agent asks it to carry on, as replying in the thread does.
    return postThreadReply(
      item.spaceId
        ? { kind: "space", spaceId: item.spaceId }
        : { kind: "worktable" },
      item.threadId,
      {
        body,
        idempotencyKey: key,
        inReplyTo: item.messageId,
        responseTo: item.messageId,
        responseIdentityId:
          item.from.kind === "agent" ? (item.fromIdentityId ?? null) : null,
        waitSeconds: 0,
      }
    )
  }
  if (item.kind === "commentRequest") {
    return replyAnnotation(item.spaceId, item.annotationId, body)
  }
  return Promise.resolve()
}

function PendingDestination({
  item,
  label,
}: {
  item: PendingItem
  label: string
}) {
  if (item.kind === "threadRequest" || item.kind === "deliveryFailed") {
    return (
      <ThreadLink
        spaceId={item.spaceId}
        threadId={item.threadId}
        className={rowLink}
      >
        <span className="sr-only">{label}</span>
      </ThreadLink>
    )
  }
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId: item.spaceId, _splat: item.docPath }}
      hash={item.kind === "commentRequest" ? undefined : "visitors"}
      className={rowLink}
      aria-label={label}
    />
  )
}

function pendingText(item: PendingItem): { title: string; meta?: string } {
  switch (item.kind) {
    case "threadRequest":
      return { title: item.threadTitle, meta: item.excerpt }
    case "commentRequest":
      return { title: item.docTitle ?? item.docPath, meta: item.excerpt }
    case "deliveryFailed":
      return { title: item.threadTitle, meta: `Not delivered to ${item.agentName}` }
    case "visitorComments":
      return {
        title: item.docTitle ?? item.docPath,
        meta: `${item.count} visitor comment${item.count === 1 ? "" : "s"}`,
      }
    case "visitorCommentsPaused":
      return { title: item.linkLabel || "Untitled link", meta: "Comments paused" }
  }
}

function PendingMark({ item }: { item: PendingItem }) {
  if (item.kind === "threadRequest" || item.kind === "commentRequest") {
    return <Who actor={item.from} />
  }
  return (
    <span className="flex justify-center">
      {item.kind === "deliveryFailed" ? (
        <CircleAlert className="size-4 text-destructive" />
      ) : (
        <MessageSquareText className="size-4 text-muted-foreground" />
      )}
    </span>
  )
}

function PendingRow({
  item,
  spaceName,
  open,
  onOpen,
}: {
  item: PendingItem
  spaceName?: string
  open: boolean
  onOpen: () => void
}) {
  const queryClient = useQueryClient()
  const phase = useSendPhase(item.id)
  // A reply that failed while the row was away comes back to its box.
  const [draft, setDraft] = useState(() => failedBody(item.id) ?? "")
  const { title, meta } = pendingText(item)
  const canReply = replyable(item)
  const send = () => {
    const body = draft.trim()
    if (!body) return
    clearSend(item.id)
    const key = createClientId("home-reply")
    scheduleSend(item.id, body, () => sendReply(item, body, key), {
      onSent: () => {
        setDraft("")
        for (const spaceId of [undefined, item.spaceId ?? undefined]) {
          void queryClient.invalidateQueries({
            queryKey: activityQueryKeys.pendingIn(spaceId),
            exact: true,
          })
        }
      },
      onFailed: () => toast.error("Couldn’t send your reply. Try again."),
    })
  }

  if (!open || !canReply) {
    return (
      <div className={cn(rowClass, rowHover)}>
        <PendingDestination item={item} label={title} />
        <PendingMark item={item} />
        <RowText title={title} meta={open ? undefined : (meta ?? spaceName)} />
        <span className="relative flex justify-center">
          {canReply && (
            <Button
              size="icon-xs"
              variant="outline"
              className="size-7"
              aria-label="Reply"
              title="Reply"
              onClick={onOpen}
            >
              <Reply className="size-3.5" />
            </Button>
          )}
        </span>
        <When at={item.at} />
      </div>
    )
  }

  return (
    <div className="rounded-lg px-3 pb-3">
      <div className={cn(rowGrid, "relative h-11 text-sm")}>
        <PendingDestination item={item} label={title} />
        <PendingMark item={item} />
        <RowText title={title} meta={spaceName} place />
        <span />
        <When at={item.at} />
      </div>
      <div className="ml-9 space-y-2.5">
        {meta && (
          <p className="text-sm leading-relaxed text-reading-foreground">
            {meta}
          </p>
        )}
        {phase === "waiting" || phase === "sending" ? (
          <div className="flex h-9 items-center gap-3 text-[0.8rem] text-muted-foreground">
            <span className="h-[3px] w-24 overflow-hidden rounded-full bg-surface-tint">
              <span className="block h-full w-full origin-left bg-primary motion-safe:animate-[send-wait_5s_linear_forwards]" />
            </span>
            <span>Sending</span>
            {phase === "waiting" && (
              <button
                type="button"
                className="font-medium text-primary-text hover:underline"
                onClick={() => {
                  const body = undoSend(item.id)
                  if (body !== null) setDraft(body)
                }}
              >
                Undo
              </button>
            )}
          </div>
        ) : phase === "sent" ? (
          <div className="flex h-9 items-center gap-2 text-[0.8rem] text-muted-foreground">
            <Check className="size-4 text-success" />
            Sent
          </div>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              send()
            }}
          >
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  send()
                }
              }}
              placeholder="Reply"
              aria-label={`Reply on ${title}`}
              rows={1}
              className="min-h-9 resize-none py-2"
            />
            <Button type="submit" size="sm" disabled={!draft.trim()}>
              Send
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1)

/** What only the reader can act on, answered in place. */
export function PendingSection({ spaceId }: { spaceId?: string }) {
  const pending = usePending(spaceId)
  const { data: spaces } = useSpaces()
  const [showAll, setShowAll] = useState(false)
  // Undefined until the reader picks a row: the newest one they can answer opens.
  const [chosen, setChosen] = useState<string | null>()
  const names = new Map((spaces ?? []).map((space) => [space.id, space.name]))
  const items = pending.data?.items ?? []
  const total = pending.data?.total ?? items.length
  const failed = pending.isError && !pending.data
  // Home points to Getting Started until the person is done or unpins it.
  const shortcut = useGettingStartedShortcut(spaces)
  const gettingStarted = !spaceId && shortcut?.progress.next ? shortcut : null
  if (items.length === 0 && !failed && !gettingStarted) return null
  const shown = showAll ? items : items.slice(0, SHOWN)
  const more = total - shown.length
  const open =
    chosen === undefined ? (items.find(replyable)?.id ?? null) : chosen
  return (
    <section aria-labelledby="pending-heading">
      <SectionHeader
        id="pending-heading"
        title="Pending"
        action={
          more > 0 && !showAll ? (
            <button
              type="button"
              className={quietLink}
              onClick={() => setShowAll(true)}
            >
              {more} More
            </button>
          ) : null
        }
      />
      {failed && !gettingStarted ? (
        <p className="px-0.5 text-sm text-muted-foreground">
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
        <div className={cardClass}>
          {shown.map((item) => (
            <PendingRow
              key={item.id}
              item={item}
              spaceName={
                spaceId || !item.spaceId ? undefined : names.get(item.spaceId)
              }
              open={open === item.id}
              onOpen={() => setChosen(item.id)}
            />
          ))}
          {gettingStarted && (
            <div className={cn(rowClass, rowHover)}>
              <Link
                to="/spaces/$spaceId"
                params={{ spaceId: gettingStarted.space.id }}
                className={rowLink}
                aria-label={gettingStarted.space.name}
              />
              <span className="flex justify-center">
                <ProgressRing
                  done={gettingStarted.progress.done}
                  total={gettingStarted.progress.total}
                />
              </span>
              <RowText
                title={gettingStarted.space.name}
                meta={`${gettingStarted.progress.done} of ${gettingStarted.progress.total} · Next: ${lowerFirst(gettingStarted.progress.next?.title ?? "")}`}
              />
              <span />
              <span />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ── Recent ─────────────────────────────────────────────────

const RECENT_ROWS = 4
// A doc whose last change came soon after it was made reads as made.
const CREATED_WITHIN_MS = 60 * 60 * 1000

function madeNotEdited(item: RecentDocument): boolean {
  const { createdAt, updatedAt } = item.document
  if (!createdAt || !updatedAt) return false
  return Date.parse(updatedAt) - Date.parse(createdAt) < CREATED_WITHIN_MS
}

function VerbMark({ item }: { item: RecentDocument }) {
  const made = madeNotEdited(item)
  const Icon = made ? FilePlus2 : Pencil
  return (
    <span className="flex justify-center" title={made ? "Created" : "Edited"}>
      <Icon className="size-[15px] text-muted-foreground" aria-label={made ? "Created" : "Edited"} />
    </span>
  )
}

/** On Home a row says which Space; inside a Space, which folder. */
function placeOf(item: RecentDocument, inSpace: boolean | "folder"): string | undefined {
  if (inSpace === "folder") return undefined
  if (!inSpace) return item.spaceName
  const [top, ...rest] = item.document.path.split("/")
  return top && rest.length > 0 ? humanizeSegment(top) : undefined
}

function DocLink({ item, label }: { item: RecentDocument; label: string }) {
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId: item.spaceId, _splat: item.document.path }}
      className={rowLink}
      aria-label={label}
    />
  )
}

function RecentRow({
  item,
  inSpace,
}: {
  item: RecentDocument
  inSpace: boolean | "folder"
}) {
  return (
    <div className={cn(rowClass, rowHover)}>
      <DocLink item={item} label={item.document.title} />
      {item.lastEditor ? (
        <Who actor={item.lastEditor} />
      ) : (
        <span className="flex justify-center">
          <DocumentFormatIcon
            formatId={item.document.format.id}
            name={item.document.path}
            className="size-4 text-muted-foreground"
          />
        </span>
      )}
      <RowText title={item.document.title} meta={placeOf(item, inSpace)} place />
      <VerbMark item={item} />
      <When at={item.document.updatedAt} />
    </div>
  )
}

function FeaturedRow({
  item,
  inSpace,
}: {
  item: RecentDocument & { excerpt?: string }
  inSpace: boolean
}) {
  const nameOf = useActorName()
  return (
    <div className={cn("relative rounded-lg px-3 pb-3.5", rowHover)}>
      <DocLink item={item} label={item.document.title} />
      <div className={cn(rowGrid, "h-11 text-sm")}>
        <Who actor={item.lastEditor} />
        <RowText
          title={item.lastEditor ? nameOf(item.lastEditor) : item.document.title}
          meta={placeOf(item, inSpace)}
          place
        />
        <span className="flex justify-center" title="Created">
          <FilePlus2 className="size-[15px] text-muted-foreground" aria-label="Created" />
        </span>
        <When at={item.document.createdAt} />
      </div>
      <div className="ml-9 min-w-0">
        <h3 className="font-display text-[1.3rem] leading-snug font-semibold tracking-tight text-balance text-foreground">
          {item.document.title}
        </h3>
        {item.excerpt && (
          <p className="mt-1 truncate text-sm text-reading-foreground">
            {item.excerpt}
          </p>
        )}
      </div>
    </div>
  )
}

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

function archiveLabel(archiveOn: string, now: number): string {
  const days = daysUntil(archiveOn, now)
  if (days <= 0) return "Archives Today"
  if (days === 1) return "Archives Tomorrow"
  if (days < 7) {
    return `Archives ${new Date(archiveOn).toLocaleDateString(undefined, { weekday: "short" })}`
  }
  return `Archives ${formatArchiveDate(archiveOn)}`
}

function TemporaryRow({
  item,
  inSpace,
  trailing,
}: {
  item: RecentDocument
  inSpace: boolean | "folder"
  trailing?: ReactNode
}) {
  const { keep } = useLifetimeActions(item.spaceId, item.document.path)
  const [keeping, setKeeping] = useState(false)
  const [now] = useState(() => Date.now())
  const archiveOn = item.document.archiveOn!
  const soon = daysUntil(archiveOn, now) <= 1
  const place = placeOf(item, inSpace)
  return (
    <div
      className={cn(
        "relative grid h-11 grid-cols-[1.5rem_minmax(0,1fr)_auto_auto] items-center gap-x-3 rounded-lg px-3 text-sm",
        rowHover
      )}
    >
      <DocLink item={item} label={item.document.title} />
      <span className="flex justify-center">
        <Clock3 className={cn("size-4", soon ? "text-warning" : "text-muted-foreground")} />
      </span>
      <RowText
        title={item.document.title}
        meta={[archiveLabel(archiveOn, now), place].filter(Boolean).join(" · ")}
      />
      <button
        type="button"
        disabled={keeping}
        className="relative text-[0.8rem] font-medium text-primary-text hover:underline disabled:opacity-50"
        onClick={() => {
          setKeeping(true)
          void keep().finally(() => setKeeping(false))
        }}
      >
        Keep
      </button>
      {trailing ?? <span />}
    </div>
  )
}

/** The temporary docs that archive soonest, as one line that opens. */
function TemporaryFooter({
  items,
  inSpace,
}: {
  items: RecentDocument[]
  inSpace: boolean | "folder"
}) {
  const [open, setOpen] = useState(false)
  const sorted = items
    .filter((item) => item.document.archiveOn)
    .sort((a, b) => a.document.archiveOn!.localeCompare(b.document.archiveOn!))
  if (sorted.length === 0) return null
  const [first, ...rest] = sorted
  return (
    <div id="temporary">
      <div className="mx-3 my-1 h-px bg-border" />
      <TemporaryRow
        item={first!}
        inSpace={inSpace}
        trailing={
          rest.length > 0 && !open ? (
            <button
              type="button"
              className={cn(quietLink, "relative")}
              onClick={() => setOpen(true)}
            >
              {rest.length} More
            </button>
          ) : undefined
        }
      />
      {open &&
        rest.map((item) => (
          <TemporaryRow
            key={`${item.spaceId}/${item.document.path}`}
            item={item}
            inSpace={inSpace}
          />
        ))}
    </div>
  )
}

/**
 * What changed lately, and who changed it. On Home, the reader's and their
 * agents' docs across Spaces; in a Space, everyone's in that Space. The
 * newest doc an agent made in the last day leads, with its opening line.
 */
export function RecentSection({
  spaceId,
  folder,
  onClearFolder,
  filters,
}: {
  spaceId?: string
  /** In a Space, only this folder's docs. */
  folder?: string | null
  onClearFolder?: () => void
  /** Ways to narrow the list, shown above it. */
  filters?: ReactNode
}) {
  const inSpace = spaceId !== undefined
  const recent = useRecentDocuments({
    sort: "updated",
    includeTemporary: false,
    limit: folder ? 8 : RECENT_ROWS,
    temporaryLimit: 100,
    featured: !folder,
    ...(inSpace ? { spaceId, ...(folder ? { folder } : {}) } : { mine: true }),
  })
  const featured = recent.data?.featured
  const items = recent.data?.items ?? []
  const temporary = recent.data?.temporary ?? []
  return (
    <section aria-labelledby="recent-heading">
      <SectionHeader
        id="recent-heading"
        title={folder ? humanizeSegment(folder) : "Recent"}
        action={
          folder ? (
            <button type="button" className={quietLink} onClick={onClearFolder}>
              Clear
            </button>
          ) : (
            <Link
              to="/activity"
              search={inSpace ? { spaceId } : {}}
              className={quietLink}
            >
              Activity
              <ArrowRight className="size-3.5" />
            </Link>
          )
        }
      />
      {filters && <div className="mb-3">{filters}</div>}
      {recent.isLoading ? (
        <div className={cn(cardClass, "space-y-1")}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-surface-inset" />
          ))}
        </div>
      ) : recent.isError ? (
        <p className="px-0.5 text-sm text-muted-foreground">
          Couldn’t load recent docs.{" "}
          <button
            type="button"
            className="text-primary-text hover:underline"
            onClick={() => void recent.refetch()}
          >
            Try again
          </button>
        </p>
      ) : !featured && items.length === 0 && temporary.length === 0 ? (
        <p className="px-0.5 text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <div className={cardClass}>
          {featured && <FeaturedRow item={featured} inSpace={inSpace} />}
          {featured && items.length > 0 && (
            <div className="mx-3 my-1 h-px bg-border" />
          )}
          {items.map((item) => (
            <RecentRow
              key={`${item.spaceId}/${item.document.path}`}
              item={item}
              inSpace={folder ? "folder" : inSpace}
            />
          ))}
          <TemporaryFooter items={temporary} inSpace={folder ? "folder" : inSpace} />
        </div>
      )}
    </section>
  )
}
