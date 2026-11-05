import { Link } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  FileText,
  MessageSquareText,
  MessagesSquare,
  Reply,
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
  scheduleSend,
  SEND_DELAY_MS,
  undoSend,
  unsentBody,
  useSend,
} from "@/lib/delayed-send"
import {
  formatArchiveDate,
  useRecentDocuments,
  type RecentDocument,
} from "@/lib/lifetime"
import { useSpaces } from "@/lib/queries"
import { isGettingStartedSpace, useGettingStartedShortcut } from "@/lib/setup"
import { postThreadReply } from "@/lib/threads-api"
import { humanizeSegment } from "@/lib/tree"
import { useActorName } from "@/lib/use-actor-name"

// Every row on Home and Space Home has the same shape: a mark; what it is,
// then who and where; and on the right, when, with one action under it.
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
// A text action with a comfortable target that looks like plain text.
const textAction =
  "-mx-1.5 -my-1 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[0.8rem] font-medium text-primary-text transition-colors hover:bg-primary/10 disabled:opacity-50"

function SectionHeader({
  id,
  title,
  count,
  urgent = false,
  action,
}: {
  id: string
  title: string
  count?: number
  /** The count asks for attention. */
  urgent?: boolean
  action?: ReactNode
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
      <h2 id={id} className="text-sm font-semibold text-foreground">
        {title}
        {count ? (
          <span
            className={cn(
              "ml-2 tabular-nums",
              urgent ? "text-primary-text" : "font-normal text-muted-foreground"
            )}
          >
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

const STEP = 5

/** "5 More" and "Show Less", at the end of a list shown a few at a time. */
function MoreLess({
  more,
  less,
  onMore,
  onLess,
}: {
  more: number
  less: boolean
  onMore: () => void
  onLess: () => void
}) {
  if (more <= 0 && !less) return null
  return (
    <div className="mt-2 flex justify-center gap-5">
      {more > 0 && (
        <button type="button" className={quietLink} onClick={onMore}>
          {more} More
        </button>
      )}
      {less && (
        <button type="button" className={quietLink} onClick={onLess}>
          Show Less
        </button>
      )}
    </div>
  )
}

/** Who, then where, in one quiet line. */
function Meta({ who, parts }: { who?: ReactNode; parts: ReactNode[] }) {
  const shown = parts.filter(
    (part) => part !== undefined && part !== null && part !== false && part !== ""
  )
  return (
    <p className="mt-0.5 truncate text-[0.8rem] text-muted-foreground">
      {who && <span className="text-foreground/75">{who}</span>}
      {shown.map((part, index) => (
        <Fragment key={index}>
          {(who || index > 0) && <span aria-hidden="true"> · </span>}
          {part}
        </Fragment>
      ))}
    </p>
  )
}

function Lead({ children }: { children: ReactNode }) {
  return <span className="flex h-5 items-center justify-center">{children}</span>
}

/** When, on the first line, and the row's action under it. */
function Trailing({ at, children }: { at?: string; children?: ReactNode }) {
  return (
    <span className="flex flex-col items-end gap-1.5">
      <span className="text-xs leading-5 whitespace-nowrap text-muted-foreground tabular-nums">
        {at ? shortWhen(at) : ""}
      </span>
      {children && <span className={above}>{children}</span>}
    </span>
  )
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

/**
 * Names and permissions of the reader's Spaces. With one Space, rows needn't
 * say which.
 */
function useSpaceFacts() {
  const { data: spaces } = useSpaces()
  const own = (spaces ?? []).filter((space) => !isGettingStartedSpace(space))
  const byId = new Map((spaces ?? []).map((space) => [space.id, space]))
  return {
    nameOf: (spaceId: string | null | undefined) =>
      spaceId && own.length > 1 ? byId.get(spaceId)?.name : undefined,
    canEdit: (spaceId: string) => byId.get(spaceId)?.permissions?.edit !== false,
  }
}

// ── Getting Started ────────────────────────────────────────

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1)

/** Home points to Getting Started until the person is done or unpins it. */
export function GettingStartedRow() {
  const { data: spaces } = useSpaces()
  const shortcut = useGettingStartedShortcut(spaces)
  if (!shortcut?.progress.next) return null
  const { space, progress } = shortcut
  return (
    <div className={cardClass}>
      <div className={cn(rowClass, rowHover)}>
        <Link
          to="/spaces/$spaceId"
          params={{ spaceId: space.id }}
          className={rowCover}
          aria-label={space.name}
        />
        <Lead>
          <ProgressRing done={progress.done} total={progress.total} />
        </Lead>
        <div className="min-w-0">
          <p className="truncate leading-snug font-medium text-foreground">
            {space.name}
          </p>
          <Meta
            parts={[
              `${progress.done} of ${progress.total}`,
              `Next: ${lowerFirst(progress.next?.title ?? "")}`,
            ]}
          />
        </div>
        <span />
      </div>
    </div>
  )
}

// ── Pending ────────────────────────────────────────────────

const SHOWN = 3
// The most one request for the rest lists.
const FULL_LIST = 500
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
  // A reply still on its way when the row remounts keeps its text, so Undo
  // or a failure can put it back.
  const [draft, setDraft] = useState(() => unsentBody(item.id) ?? "")
  const box = useRef<HTMLTextAreaElement>(null)
  const canReply = replyable(item)
  const headline = pendingHeadline(item)
  const source = sourceTitle(item)
  const asker = canReply ? nameOf(item.from) : undefined
  // A failed reply reopens its box with its text.
  const composing = canReply && (phase === "failed" || (open && !phase))
  const idle = canReply && !composing && !phase

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

  const cancel = () => {
    clearSend(item.id)
    onClose()
  }

  const SourceIcon = item.kind === "threadRequest" ? MessagesSquare : FileText
  return (
    <div className={cn(rowClass, idle && rowHover)}>
      {idle ? (
        // A click anywhere on the row opens its reply; Reply below is the
        // control keyboards and screen readers use.
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className={rowCover}
          onClick={onOpen}
        />
      ) : (
        !canReply && (
          <PendingSource item={item} className={rowCover}>
            <span className="sr-only">
              {headline} on {source}
            </span>
          </PendingSource>
        )
      )}
      <PendingLead item={item} />
      <div className="min-w-0">
        <p
          className={cn(
            "leading-snug text-foreground",
            !canReply
              ? "truncate font-medium"
              : // The whole question shows while it is being answered.
                !composing && "line-clamp-3 sm:line-clamp-2"
          )}
        >
          {headline}
        </p>
        <Meta
          who={asker}
          parts={[
            canReply ? (
              <PendingSource
                item={item}
                className={cn(
                  above,
                  "inline-flex items-center gap-1 rounded-sm align-bottom hover:text-foreground hover:underline"
                )}
              >
                <SourceIcon className="size-3 shrink-0" aria-hidden="true" />
                {source}
              </PendingSource>
            ) : (
              source
            ),
            spaceName,
          ]}
        />
        {composing && item.kind === "commentRequest" && item.quote && (
          <p className="mt-2 line-clamp-3 border-l-2 border-border pl-2.5 text-[0.8rem] leading-relaxed text-muted-foreground">
            {item.quote}
          </p>
        )}
        <div role="status" aria-live="polite">
          {(phase === "waiting" || phase === "sending" || phase === "sent") && sending && (
            <div className="mt-2 flex min-h-7 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8rem] text-muted-foreground">
              {phase === "sent" ? (
                <Check className="size-3.5 shrink-0 text-success" />
              ) : (
                <SendProgress sendAt={sending.sendAt} />
              )}
              <span className="min-w-0 truncate text-foreground">{sending.body}</span>
              <span className="flex shrink-0 items-center gap-2.5">
                {phase === "waiting" ? (
                  <>
                    <span>
                      Sends in <Countdown at={sending.sendAt} />
                    </span>
                    <button
                      type="button"
                      className={cn(above, textAction, "mx-0")}
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
                  </>
                ) : phase === "sending" ? (
                  "Sending"
                ) : (
                  "Sent"
                )}
              </span>
            </div>
          )}
          {phase === "failed" && (
            <p className="mt-2 text-[0.8rem] text-destructive">Couldn’t send.</p>
          )}
        </div>
        {composing && (
          <form
            className={cn(above, "mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-end")}
            onSubmit={(event) => {
              event.preventDefault()
              send()
            }}
          >
            <Textarea
              ref={box}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter starts a new line.
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  send()
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  cancel()
                }
              }}
              placeholder={`Reply to ${asker}`}
              aria-label={`Reply on ${source}`}
              rows={1}
              className="field-sizing-content max-h-40 min-h-9 resize-none bg-background py-2"
            />
            <div className="flex shrink-0 justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!draft.trim()}>
                Send
              </Button>
            </div>
          </form>
        )}
      </div>
      <Trailing at={item.at}>
        {idle && (
          <button
            type="button"
            className={textAction}
            aria-label={`Reply to ${asker}: ${headline}`}
            aria-expanded={open}
            onClick={onOpen}
          >
            <Reply className="size-3.5" />
            Reply
          </button>
        )}
      </Trailing>
    </div>
  )
}

/**
 * What only the reader can act on, answered in place. Home always shows it,
 * so its place doesn't jump; a Space shows it only when something waits.
 */
export function PendingSection({ spaceId }: { spaceId?: string }) {
  const [visible, setVisible] = useState(SHOWN)
  // Past the first request's ten, one more asks for the rest.
  const [all, setAll] = useState(false)
  const pending = usePending(spaceId, all)
  const spaces = useSpaceFacts()
  const [open, setOpen] = useState<string | null>(null)
  const items = pending.data?.items ?? []
  const total = pending.data?.total ?? items.length
  const failed = pending.isError && !pending.data
  const onHome = spaceId === undefined
  if (!onHome && !pending.isLoading && items.length === 0 && !failed) return null
  const shown = items.slice(0, visible)
  // What another step could still show: everything a full list holds, until
  // that list has come.
  const reachable = all ? items.length : Math.min(total, FULL_LIST)
  const more =
    all && pending.isPlaceholderData ? 0 : Math.min(STEP, reachable - shown.length)
  return (
    <section aria-labelledby="pending-heading">
      <SectionHeader id="pending-heading" title="Pending" count={total} urgent />
      {pending.isLoading ? (
        <Skeleton rows={onHome ? 2 : 1} />
      ) : failed ? (
        <LoadFailed what="what’s pending" onRetry={() => void pending.refetch()} />
      ) : items.length === 0 ? (
        <p className="flex h-6 items-center gap-2 px-0.5 text-sm text-muted-foreground">
          <Check className="size-4 text-success" />
          Nothing waiting
        </p>
      ) : (
        <>
          <div className={cardClass}>
            {shown.map((item) => (
              <PendingRow
                key={item.id}
                item={item}
                spaceName={onHome ? spaces.nameOf(item.spaceId) : undefined}
                open={open === item.id}
                onOpen={() => setOpen(item.id)}
                onClose={() => setOpen((current) => (current === item.id ? null : current))}
              />
            ))}
          </div>
          <MoreLess
            more={more}
            less={visible > SHOWN}
            onMore={() => {
              const next = shown.length + STEP
              if (next > items.length && total > items.length) setAll(true)
              setVisible(next)
            }}
            onLess={() => setVisible(SHOWN)}
          />
        </>
      )}
    </section>
  )
}

// ── Recent ─────────────────────────────────────────────────

const RECENT_ROWS = 5
const FOLDER_ROWS = 500
// Temporary docs further out than this aren't "soon".
const SOON_DAYS = 7
const SOON_SHOWN = 3
// Docs and rich docs are the usual kind; anything else says what it is.
const PLAIN_FORMATS = new Set(["worktable.markdown", "worktable.rich-text"])

/**
 * Home's and Space Home's one read of recent docs: Recent and Archiving Soon
 * share it.
 */
function useRecent(spaceId?: string) {
  return useRecentDocuments({
    sort: "updated",
    includeTemporary: true,
    limit: RECENT_ROWS,
    temporaryLimit: 100,
    excerpt: true,
    ...(spaceId !== undefined ? { spaceId } : { mine: true }),
  })
}

const docKey = (item: RecentDocument) => `${item.spaceId}/${item.document.path}`

type Place = "space" | "folder" | { inFolder: string }

/**
 * Where a doc lives: on Home, its Space; in a Space, its folder; in a
 * folder, the folder inside it, if any.
 */
function placeOf(
  item: RecentDocument,
  place: Place,
  spaceName: (spaceId: string) => string | undefined
): string | undefined {
  if (place === "space") return spaceName(item.spaceId)
  const path = item.document.path.split("/")
  const within = place === "folder" ? path : path.slice(place.inFolder.split("/").length)
  return within.length > 1 ? humanizeSegment(within[0]!) : undefined
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
  if (days <= 0) return "Archives today"
  if (days === 1) return "Archives tomorrow"
  if (days < 7) {
    return `Archives ${new Date(archiveOn).toLocaleDateString(undefined, { weekday: "long" })}`
  }
  return `Archives ${formatArchiveDate(archiveOn)}`
}

function KeepButton({ item }: { item: RecentDocument }) {
  const { keep } = useLifetimeActions(item.spaceId, item.document.path)
  const [keeping, setKeeping] = useState(false)
  return (
    <button
      type="button"
      disabled={keeping}
      className={textAction}
      onClick={() => {
        setKeeping(true)
        void keep().finally(() => setKeeping(false))
      }}
    >
      {keeping ? "Keeping…" : "Keep"}
    </button>
  )
}

function FormatIcon({ item, className }: { item: RecentDocument; className: string }) {
  return (
    <DocumentFormatIcon
      formatId={item.document.format.id}
      name={item.document.path}
      className={className}
    />
  )
}

/**
 * A doc, led by whoever changed it last. A temporary one says when it
 * archives and offers Keep.
 */
function DocRow({
  item,
  place,
  now,
}: {
  item: RecentDocument
  place: Place
  now: number
}) {
  const nameOf = useActorName()
  const spaces = useSpaceFacts()
  const { updatedAt, archiveOn, lifetime } = item.document
  const editor = item.lastEditor
  const unusual = !PLAIN_FORMATS.has(item.document.format.id)
  const temporary = lifetime === "temporary" && archiveOn !== undefined
  const soon = temporary && daysUntil(archiveOn, now) <= 1
  return (
    <div className={cn(rowClass, rowHover)}>
      <Link
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId: item.spaceId, _splat: item.document.path }}
        className={rowCover}
        aria-label={item.document.title}
      />
      <Lead>
        {editor ? (
          <ActorBadge actor={editor} />
        ) : (
          <FormatIcon item={item} className="size-4 text-muted-foreground" />
        )}
      </Lead>
      <div className="min-w-0">
        <p className="flex min-w-0 items-start gap-1.5 leading-snug">
          <span className="min-w-0 font-medium text-foreground max-sm:line-clamp-2 sm:truncate">
            {item.document.title}
          </span>
          {editor && unusual && (
            <FormatIcon item={item} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          )}
        </p>
        <Meta
          who={
            editor &&
            `${nameOf(editor)}${item.lastAction ? ` ${item.lastAction}` : ""}`
          }
          parts={[
            temporary && (
              <span className={cn("inline-flex items-center gap-1 align-bottom", soon && "text-warning")}>
                <Clock3 className="size-3 shrink-0" aria-hidden="true" />
                {archiveLabel(archiveOn, now)}
              </span>
            ),
            placeOf(item, place, spaces.nameOf),
          ]}
        />
        {item.excerpt && (
          <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-reading-foreground">
            {item.excerpt}
          </p>
        )}
      </div>
      <Trailing at={updatedAt}>
        {temporary && spaces.canEdit(item.spaceId) && <KeepButton item={item} />}
      </Trailing>
    </div>
  )
}

/**
 * What changed lately, and who changed it. On Home, the reader's and their
 * agents' docs across Spaces; in a Space, everyone's there. When the newest
 * is a doc an agent just made, it shows its opening lines.
 */
export function RecentSection({ spaceId }: { spaceId?: string }) {
  const inSpace = spaceId !== undefined
  const recent = useRecent(spaceId)
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
            <DocRow
              key={docKey(item)}
              item={item}
              place={inSpace ? "folder" : "space"}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** Every doc in one folder of a Space, newest change first. */
export function FolderSection({
  spaceId,
  folder,
}: {
  spaceId: string
  folder: string
}) {
  const docs = useRecentDocuments({
    sort: "updated",
    includeTemporary: true,
    limit: FOLDER_ROWS,
    spaceId,
    folder,
  })
  const [now] = useState(() => Date.now())
  const items = docs.data?.items ?? []
  return (
    <section aria-label={humanizeSegment(folder)}>
      {docs.isLoading ? (
        <Skeleton rows={4} />
      ) : docs.isError && !docs.data ? (
        <LoadFailed what="this folder" onRetry={() => void docs.refetch()} />
      ) : items.length === 0 ? (
        <p className="px-0.5 text-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <div className={cardClass}>
          {items.map((item) => (
            <DocRow
              key={item.document.path}
              item={item}
              place={{ inFolder: folder }}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Archiving Soon ─────────────────────────────────────────

/**
 * Temporary docs that archive within the week and aren't already in Recent,
 * soonest first, each with Keep.
 */
export function ArchivingSoonSection({ spaceId }: { spaceId?: string }) {
  const recent = useRecent(spaceId)
  const [now] = useState(() => Date.now())
  const [visible, setVisible] = useState(SOON_SHOWN)
  const inRecent = new Set((recent.data?.items ?? []).map(docKey))
  const soon = (recent.data?.temporary ?? [])
    .filter(
      (item) =>
        item.document.archiveOn &&
        !inRecent.has(docKey(item)) &&
        daysUntil(item.document.archiveOn, now) <= SOON_DAYS
    )
    .sort((a, b) => a.document.archiveOn!.localeCompare(b.document.archiveOn!))
  if (soon.length === 0) return null
  const shown = soon.slice(0, visible)
  return (
    <section aria-labelledby="archiving-heading">
      <SectionHeader id="archiving-heading" title="Archiving Soon" count={soon.length} />
      <div className={cardClass}>
        {shown.map((item) => (
          <DocRow
            key={docKey(item)}
            item={item}
            place={spaceId !== undefined ? "folder" : "space"}
            now={now}
          />
        ))}
      </div>
      <MoreLess
        more={Math.min(STEP, soon.length - shown.length)}
        less={visible > SOON_SHOWN}
        onMore={() => setVisible(shown.length + STEP)}
        onLess={() => setVisible(SOON_SHOWN)}
      />
    </section>
  )
}
