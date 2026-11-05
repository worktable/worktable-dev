import { Link } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  MessageSquareText,
} from "lucide-react"
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { PendingItem } from "@worktable/types"
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
  SEND_DELAY_MS,
  undoSend,
  useSend,
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

// Every row on Home and Space Home has the same two lines: what it is, then
// who, where and when. A mark leads; one action may trail.
const rowGrid =
  "grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-3"
const rowClass = cn(rowGrid, "relative rounded-lg px-3 py-2.5 text-sm")
const rowHover = "transition-colors hover:bg-surface-hover"
const cardClass = "card-surface rounded-[14px] p-1.5"
// Stretches a row's link or button across it; links and buttons inside the
// row sit above it.
const rowCover =
  "absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
const above = "relative z-10"

function SectionHeader({
  id,
  title,
  count,
  action,
}: {
  id: string
  title: string
  count?: number
  action?: ReactNode
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
      <h2 id={id} className="text-sm font-semibold text-foreground">
        {title}
        {count ? (
          <span className="ml-2 font-normal text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
      </h2>
      {action}
    </div>
  )
}

const quietLink =
  "inline-flex items-center gap-1 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:text-foreground"

/** Who, where and when, in one quiet line. */
function Meta({ parts }: { parts: ReactNode[] }) {
  const shown = parts.filter((part) => part !== undefined && part !== null && part !== "")
  return (
    <p className="mt-0.5 truncate text-[0.8rem] text-muted-foreground">
      {shown.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          {part}
        </Fragment>
      ))}
    </p>
  )
}

function Lead({ children }: { children: ReactNode }) {
  return <span className="flex h-5 items-center justify-center">{children}</span>
}

function Skeleton({ rows }: { rows: number }) {
  return (
    <div className={cn(cardClass, "space-y-1")} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-[3.75rem] animate-pulse rounded-lg bg-surface-inset" />
      ))}
    </div>
  )
}

function LoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p className="px-0.5 text-sm text-muted-foreground">
      Couldn’t load {what}.{" "}
      <button
        type="button"
        className="text-primary-text hover:underline"
        onClick={onRetry}
      >
        Try again
      </button>
    </p>
  )
}

// ── Pending ────────────────────────────────────────────────

const SHOWN = 3
// Long enough to read "Sent" before the row leaves.
const SENT_LINGER_MS = 2_000

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

/** Where an item lives: its thread, or its doc. */
function PendingSource({
  item,
  className,
  children,
}: {
  item: PendingItem
  className: string
  children: ReactNode
}) {
  if (item.kind === "threadRequest" || item.kind === "deliveryFailed") {
    return (
      <ThreadLink spaceId={item.spaceId} threadId={item.threadId} className={className}>
        {children}
      </ThreadLink>
    )
  }
  return (
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

function sourceTitle(item: PendingItem): string {
  switch (item.kind) {
    case "threadRequest":
    case "deliveryFailed":
      return item.threadTitle
    case "commentRequest":
    case "visitorComments":
      return item.docTitle ?? item.docPath
    case "visitorCommentsPaused":
      return item.linkLabel || "Untitled link"
  }
}

/** What the reader is asked, or what happened. */
function pendingHeadline(item: PendingItem): string {
  switch (item.kind) {
    case "threadRequest":
    case "commentRequest":
      return item.excerpt
    case "deliveryFailed":
      return `Not delivered to ${item.agentName}`
    case "visitorComments":
      return `${item.count} visitor comment${item.count === 1 ? "" : "s"}`
    case "visitorCommentsPaused":
      return "Comments paused"
  }
}

function PendingLead({ item }: { item: PendingItem }) {
  if (replyable(item)) {
    return (
      <Lead>
        <ActorBadge actor={item.from} />
      </Lead>
    )
  }
  return (
    <Lead>
      {item.kind === "deliveryFailed" ? (
        <CircleAlert className="size-4 text-destructive" />
      ) : (
        <MessageSquareText className="size-4 text-muted-foreground" />
      )}
    </Lead>
  )
}

/** The wait as a filling bar, picking up where it was if the row remounts. */
function SendProgress({ sendAt }: { sendAt: number }) {
  const [delay] = useState(() => sendAt - SEND_DELAY_MS - Date.now())
  return (
    <span className="h-[3px] w-10 shrink-0 overflow-hidden rounded-full bg-surface-tint">
      <span
        className="block h-full w-full origin-left bg-primary motion-safe:animate-[send-wait_5s_linear_forwards]"
        style={{ animationDelay: `${delay}ms` }}
      />
    </span>
  )
}

/** Seconds until a waiting reply goes. */
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])
  return <>{Math.max(1, Math.ceil((at - now) / 1000))}s</>
}

function PendingRow({
  item,
  spaceName,
  open,
  onOpen,
  onClose,
}: {
  item: PendingItem
  spaceName?: string
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const nameOf = useActorName()
  const sending = useSend(item.id)
  const phase = sending?.phase
  // A reply that failed while the row was away comes back to its box.
  const [draft, setDraft] = useState(() => failedBody(item.id) ?? "")
  const box = useRef<HTMLTextAreaElement>(null)
  const canReply = replyable(item)
  const headline = pendingHeadline(item)
  const source = sourceTitle(item)
  // A failed reply reopens its box with its text.
  const composing = canReply && (phase === "failed" || (open && !phase))

  useEffect(() => {
    if (open && !phase) box.current?.focus()
  }, [open, phase])

  const send = () => {
    const body = draft.trim()
    if (!body) return
    clearSend(item.id)
    const key = createClientId("home-reply")
    scheduleSend(item.id, body, () => sendReply(item, body, key), {
      onSent: () => {
        setDraft("")
        onClose()
        // The row says Sent for a moment, then leaves with the refresh.
        window.setTimeout(() => {
          for (const spaceId of [undefined, item.spaceId ?? undefined]) {
            void queryClient.invalidateQueries({
              queryKey: activityQueryKeys.pendingIn(spaceId),
            })
          }
        }, SENT_LINGER_MS)
      },
      onFailed: () => toast.error("Couldn’t send your reply. Try again."),
    })
  }

  return (
    <div className={cn(rowClass, !composing && rowHover)}>
      {canReply ? (
        !composing &&
        !phase && (
          <button
            type="button"
            className={rowCover}
            aria-label={`Reply to ${nameOf(item.from)}: ${headline}`}
            aria-expanded={open}
            onClick={onOpen}
          />
        )
      ) : (
        <PendingSource item={item} className={rowCover}>
          <span className="sr-only">
            {headline} on {source}
          </span>
        </PendingSource>
      )}
      <PendingLead item={item} />
      <div className="min-w-0">
        <p
          className={cn(
            "leading-snug text-foreground",
            canReply ? "line-clamp-2" : "truncate font-medium"
          )}
        >
          {headline}
        </p>
        <Meta
          parts={[
            canReply ? nameOf(item.from) : undefined,
            canReply ? (
              <PendingSource
                item={item}
                className={cn(above, "rounded-sm hover:text-foreground hover:underline")}
              >
                {source}
              </PendingSource>
            ) : (
              source
            ),
            spaceName,
            shortWhen(item.at),
          ]}
        />
        {(phase === "waiting" || phase === "sending" || phase === "sent") && sending && (
          <div className="mt-2 flex h-6 min-w-0 items-center gap-2.5 text-[0.8rem] text-muted-foreground">
            {phase === "sent" ? (
              <Check className="size-3.5 shrink-0 text-success" />
            ) : (
              <SendProgress sendAt={sending.sendAt} />
            )}
            <span className="min-w-0 truncate text-foreground">{sending.body}</span>
            <span className="shrink-0">
              {phase === "waiting" ? (
                <>
                  Sends in <Countdown at={sending.sendAt} />
                </>
              ) : phase === "sending" ? (
                "Sending"
              ) : (
                "Sent"
              )}
            </span>
          </div>
        )}
        {composing && (
          <form
            className={cn(above, "mt-2.5 space-y-2")}
            onSubmit={(event) => {
              event.preventDefault()
              send()
            }}
          >
            {phase === "failed" && (
              <p className="text-[0.8rem] text-destructive">Couldn’t send.</p>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                ref={box}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    send()
                  }
                  if (event.key === "Escape" && phase !== "failed") {
                    event.preventDefault()
                    onClose()
                  }
                }}
                placeholder="Reply"
                aria-label={`Reply on ${source}`}
                rows={1}
                className="min-h-9 resize-none bg-background py-2"
              />
              <Button type="submit" size="sm" disabled={!draft.trim()}>
                Send
              </Button>
            </div>
          </form>
        )}
      </div>
      <span className={cn(above, "flex h-5 items-center")}>
        {phase === "waiting" ? (
          <button
            type="button"
            className="text-[0.8rem] font-medium text-primary-text hover:underline"
            onClick={() => {
              const body = undoSend(item.id)
              if (body !== null) {
                setDraft(body)
                onOpen()
              }
            }}
          >
            Undo
          </button>
        ) : canReply && !composing && !phase ? (
          <span
            aria-hidden="true"
            className="pointer-events-none rounded-md border border-border px-2 py-0.5 text-[0.75rem] font-medium text-muted-foreground"
          >
            Reply
          </span>
        ) : null}
      </span>
    </div>
  )
}

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1)

/**
 * What only the reader can act on, answered in place. Home always shows it,
 * so its place doesn't jump; a Space shows it only when something waits.
 */
export function PendingSection({ spaceId }: { spaceId?: string }) {
  const [showAll, setShowAll] = useState(false)
  const pending = usePending(spaceId, showAll)
  const { data: spaces } = useSpaces()
  const [open, setOpen] = useState<string | null>(null)
  const names = new Map((spaces ?? []).map((space) => [space.id, space.name]))
  const items = pending.data?.items ?? []
  const total = pending.data?.total ?? items.length
  const failed = pending.isError && !pending.data
  const onHome = spaceId === undefined
  // Home points to Getting Started until the person is done or unpins it.
  const shortcut = useGettingStartedShortcut(spaces)
  const gettingStarted = onHome && shortcut?.progress.next ? shortcut : null
  const empty = items.length === 0 && !gettingStarted
  if (!onHome && (pending.isLoading || (empty && !failed))) return null
  const shown = showAll ? items : items.slice(0, SHOWN)
  const more = total - shown.length
  return (
    <section aria-labelledby="pending-heading">
      <SectionHeader
        id="pending-heading"
        title="Pending"
        count={total}
        action={
          more > 0 && !(showAll && pending.isFetching) ? (
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
      {pending.isLoading ? (
        <Skeleton rows={2} />
      ) : failed && !gettingStarted ? (
        <LoadFailed what="what’s pending" onRetry={() => void pending.refetch()} />
      ) : empty ? (
        <p className="flex h-6 items-center gap-2 px-0.5 text-sm text-muted-foreground">
          <Check className="size-4 text-success" />
          Nothing waiting
        </p>
      ) : (
        <div className={cardClass}>
          {shown.map((item) => (
            <PendingRow
              key={item.id}
              item={item}
              spaceName={onHome && item.spaceId ? names.get(item.spaceId) : undefined}
              open={open === item.id}
              onOpen={() => setOpen(item.id)}
              onClose={() => setOpen((current) => (current === item.id ? null : current))}
            />
          ))}
          {gettingStarted && (
            <div className={cn(rowClass, rowHover)}>
              <Link
                to="/spaces/$spaceId"
                params={{ spaceId: gettingStarted.space.id }}
                className={rowCover}
                aria-label={gettingStarted.space.name}
              />
              <Lead>
                <ProgressRing
                  done={gettingStarted.progress.done}
                  total={gettingStarted.progress.total}
                />
              </Lead>
              <div className="min-w-0">
                <p className="truncate leading-snug font-medium text-foreground">
                  {gettingStarted.space.name}
                </p>
                <Meta
                  parts={[
                    `${gettingStarted.progress.done} of ${gettingStarted.progress.total}`,
                    `Next: ${lowerFirst(gettingStarted.progress.next?.title ?? "")}`,
                  ]}
                />
              </div>
              <span />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ── Recent ─────────────────────────────────────────────────

const RECENT_ROWS = 5
const FOLDER_ROWS = 50
const DAY_MS = 24 * 60 * 60 * 1000
// Temporary docs further out than this aren't "soon".
const SOON_DAYS = 7
const SOON_SHOWN = 3

/**
 * Home's and Space Home's one read of recent docs: Recent and Archiving Soon
 * share it.
 */
function useRecent(spaceId?: string, folder?: string | null) {
  return useRecentDocuments({
    sort: "updated",
    includeTemporary: false,
    limit: folder ? FOLDER_ROWS : RECENT_ROWS,
    temporaryLimit: 100,
    excerpt: !folder,
    ...(spaceId !== undefined
      ? { spaceId, ...(folder ? { folder } : {}) }
      : { mine: true }),
  })
}

/** On Home a row says which Space; inside a Space, which folder. */
function placeOf(item: RecentDocument, inSpace: boolean | "folder"): string | undefined {
  if (inSpace === "folder") return undefined
  if (!inSpace) return item.spaceName
  const [top, ...rest] = item.document.path.split("/")
  return top && rest.length > 0 ? humanizeSegment(top) : undefined
}

function DocLink({ item }: { item: RecentDocument }) {
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId: item.spaceId, _splat: item.document.path }}
      className={rowCover}
      aria-label={item.document.title}
    />
  )
}

function DocLead({ item }: { item: RecentDocument }) {
  return (
    <Lead>
      <DocumentFormatIcon
        formatId={item.document.format.id}
        name={item.document.path}
        className="size-4 text-muted-foreground"
      />
    </Lead>
  )
}

function RecentRow({
  item,
  inSpace,
  now,
}: {
  item: RecentDocument
  inSpace: boolean | "folder"
  now: number
}) {
  const nameOf = useActorName()
  const { createdAt, updatedAt } = item.document
  const isNew = createdAt !== undefined && now - Date.parse(createdAt) < DAY_MS
  return (
    <div className={cn(rowClass, rowHover)}>
      <DocLink item={item} />
      <DocLead item={item} />
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-2 leading-snug">
          <span className="truncate font-medium text-foreground">
            {item.document.title}
          </span>
          {isNew && (
            <span className="shrink-0 rounded-[5px] bg-primary/10 px-1.5 text-[0.7rem] leading-[1.125rem] font-medium text-primary-text">
              New
            </span>
          )}
        </p>
        <Meta
          parts={[
            item.lastEditor ? nameOf(item.lastEditor) : undefined,
            placeOf(item, inSpace),
            updatedAt ? shortWhen(updatedAt) : undefined,
          ]}
        />
        {item.excerpt && (
          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-reading-foreground">
            {item.excerpt}
          </p>
        )}
      </div>
      <span />
    </div>
  )
}

/**
 * What changed lately, and who changed it. On Home, the reader's and their
 * agents' docs across Spaces; in a Space, everyone's there, or one folder's.
 * The newest doc an agent made in the last day shows its opening lines.
 */
export function RecentSection({
  spaceId,
  folder,
}: {
  spaceId?: string
  /** In a Space, every doc in this folder instead. */
  folder?: string | null
}) {
  const inSpace = spaceId !== undefined
  const recent = useRecent(spaceId, folder)
  const [now] = useState(() => Date.now())
  const items = recent.data?.items ?? []
  return (
    <section aria-labelledby="recent-heading">
      <SectionHeader
        id="recent-heading"
        title="Recent"
        action={
          <Link
            to="/activity"
            search={inSpace ? { spaceId } : {}}
            className={quietLink}
          >
            Activity
            <ArrowRight className="size-3.5" />
          </Link>
        }
      />
      {recent.isLoading ? (
        <Skeleton rows={4} />
      ) : recent.isError && !recent.data ? (
        <LoadFailed what="recent docs" onRetry={() => void recent.refetch()} />
      ) : items.length === 0 ? (
        <p className="px-0.5 text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <div className={cardClass}>
          {items.map((item) => (
            <RecentRow
              key={`${item.spaceId}/${item.document.path}`}
              item={item}
              inSpace={folder ? "folder" : inSpace}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Archiving Soon ─────────────────────────────────────────

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
  if (days <= 0) return "Archives today"
  if (days === 1) return "Archives tomorrow"
  if (days < 7) {
    return `Archives ${new Date(archiveOn).toLocaleDateString(undefined, { weekday: "long" })}`
  }
  return `Archives ${formatArchiveDate(archiveOn)}`
}

function TemporaryRow({
  item,
  inSpace,
  now,
}: {
  item: RecentDocument
  inSpace: boolean
  now: number
}) {
  const { keep } = useLifetimeActions(item.spaceId, item.document.path)
  const [keeping, setKeeping] = useState(false)
  const archiveOn = item.document.archiveOn!
  const soon = daysUntil(archiveOn, now) <= 1
  return (
    <div className={cn(rowClass, rowHover)}>
      <DocLink item={item} />
      <Lead>
        <Clock3 className={cn("size-4", soon ? "text-warning" : "text-muted-foreground")} />
      </Lead>
      <div className="min-w-0">
        <p className="truncate leading-snug font-medium text-foreground">
          {item.document.title}
        </p>
        <Meta parts={[archiveLabel(archiveOn, now), placeOf(item, inSpace)]} />
      </div>
      <span className={cn(above, "flex h-5 items-center")}>
        <button
          type="button"
          disabled={keeping}
          className="text-[0.8rem] font-medium text-primary-text hover:underline disabled:opacity-50"
          onClick={() => {
            setKeeping(true)
            void keep().finally(() => setKeeping(false))
          }}
        >
          Keep
        </button>
      </span>
    </div>
  )
}

/** Temporary docs that archive within the week, soonest first, each with Keep. */
export function ArchivingSoonSection({ spaceId }: { spaceId?: string }) {
  const recent = useRecent(spaceId)
  const [now] = useState(() => Date.now())
  const [showAll, setShowAll] = useState(false)
  const soon = (recent.data?.temporary ?? [])
    .filter(
      (item) =>
        item.document.archiveOn &&
        daysUntil(item.document.archiveOn, now) <= SOON_DAYS
    )
    .sort((a, b) => a.document.archiveOn!.localeCompare(b.document.archiveOn!))
  if (soon.length === 0) return null
  const shown = showAll ? soon : soon.slice(0, SOON_SHOWN)
  return (
    <section aria-labelledby="archiving-heading">
      <SectionHeader
        id="archiving-heading"
        title="Archiving Soon"
        action={
          soon.length > shown.length ? (
            <button type="button" className={quietLink} onClick={() => setShowAll(true)}>
              {soon.length - shown.length} More
            </button>
          ) : null
        }
      />
      <div className={cardClass}>
        {shown.map((item) => (
          <TemporaryRow
            key={`${item.spaceId}/${item.document.path}`}
            item={item}
            inSpace={spaceId !== undefined}
            now={now}
          />
        ))}
      </div>
    </section>
  )
}
