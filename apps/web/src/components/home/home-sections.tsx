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
  useSyncExternalStore,
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
import { useGettingStartedShortcut } from "@/lib/setup"
import { postThreadReply } from "@/lib/threads-api"
import { humanizeSegment } from "@/lib/tree"
import { useActorName } from "@/lib/use-actor-name"
import { useIsSelf } from "@/lib/use-is-self"

// Every row on Home and Space Home has the same shape: a mark; what it is;
// who and where; then its actions. On wider screens the time sits on the
// right; on phones it joins who and where, so the row keeps its width.
const rowClass =
  "relative grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg px-3 py-2.5 text-sm sm:grid-cols-[1.5rem_minmax(0,1fr)_auto]"
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

// A list shows its first few, then more in steps, so its height holds still
// as items come and go.
const STEP = 5

/** A list's first rows, then more in steps, with a way back. */
function useSteps(first: number) {
  const [extra, setExtra] = useState(0)
  return {
    visible: first + extra,
    expanded: extra > 0,
    more: () => setExtra((current) => current + STEP),
    less: () => setExtra(0),
  }
}

/** "5 More" and "Show Less", at the end of a list. */
function MoreLess({
  more,
  less,
  loading = false,
  onMore,
  onLess,
}: {
  more: number
  less: boolean
  loading?: boolean
  onMore: () => void
  onLess: () => void
}) {
  if (more <= 0 && !less && !loading) return null
  return (
    <div className="mt-2 flex justify-center gap-5">
      {loading ? (
        <span className="text-[0.8rem] text-muted-foreground">Loading…</span>
      ) : (
        more > 0 && (
          <button type="button" className={quietLink} onClick={onMore}>
            {more} More
          </button>
        )
      )}
      {less && (
        <button type="button" className={quietLink} onClick={onLess}>
          Show Less
        </button>
      )}
    </div>
  )
}

/** Who, then where, in one quiet line; on phones, when too. */
function Meta({
  who,
  parts,
  at,
}: {
  who?: ReactNode
  parts: ReactNode[]
  at?: string
}) {
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
      {at && (
        <span className="sm:hidden">
          {(who || shown.length > 0) && <span aria-hidden="true"> · </span>}
          {shortWhen(at)}
        </span>
      )}
    </p>
  )
}

function Lead({ children }: { children: ReactNode }) {
  return <span className="flex h-5 items-center justify-center">{children}</span>
}

/** When, on the right of wider screens. */
function When({ at }: { at?: string }) {
  return (
    <span className="text-xs leading-5 whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
      {at ? shortWhen(at) : ""}
    </span>
  )
}

/** A row's actions, on their own line. */
function Actions({ children }: { children: ReactNode }) {
  return <div className={cn(above, "mt-1.5 flex items-center gap-4")}>{children}</div>
}

function Skeleton({ rows, tall = false }: { rows: number; tall?: boolean }) {
  return (
    <div className={cn(cardClass, "space-y-1")} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className={cn("animate-pulse rounded-lg bg-surface-inset", tall ? "h-[5.25rem]" : "h-[3.75rem]")}
        />
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

/** Some of a list's docs couldn't be read, so it may be missing some. */
function Incomplete({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="mt-2 px-0.5 text-[0.8rem] text-muted-foreground">
      Some docs couldn’t be read.{" "}
      <button type="button" className="text-primary-text hover:underline" onClick={onRetry}>
        Try again
      </button>
    </p>
  )
}

/** Names and permissions of the reader's Spaces. */
function useSpaceFacts() {
  const { data: spaces } = useSpaces()
  const byId = new Map((spaces ?? []).map((space) => [space.id, space]))
  return {
    nameOf: (spaceId: string | null | undefined) =>
      spaceId ? byId.get(spaceId)?.name : undefined,
    canEdit: (spaceId: string) => byId.get(spaceId)?.permissions?.edit !== false,
  }
}

/** Rows name their Space only when the list holds more than one. */
function oneSpace(spaceIds: Array<string | null>): boolean {
  return new Set(spaceIds).size <= 1
}

// Each page's previous visit, read once when the page opens and replaced by
// this one, so a visit compares against the one before it.
const lastVisits = new Map<string, number | null>()
const openPages = new Map<string, number>()

function readLastVisit(scope: string): number | null {
  if (!lastVisits.has(scope)) {
    const key = `worktable:last-visit:${scope}`
    let previous: number | null = null
    try {
      const stored = Number(window.localStorage.getItem(key))
      previous = stored > 0 ? stored : null
      window.localStorage.setItem(key, String(Date.now()))
    } catch {
      // Without storage there is no last visit to compare with.
    }
    lastVisits.set(scope, previous)
  }
  return lastVisits.get(scope) ?? null
}

const unchanging = () => () => {}

/**
 * When the reader last opened this page, before now; absent on a first
 * visit, when the browser keeps nothing, and in the server's render.
 */
function useLastVisit(scope: string): number | null {
  useEffect(() => {
    openPages.set(scope, (openPages.get(scope) ?? 0) + 1)
    return () => {
      openPages.set(scope, (openPages.get(scope) ?? 1) - 1)
      // Forgotten once the page is left, not when React remounts it in place.
      window.setTimeout(() => {
        if (!openPages.get(scope)) lastVisits.delete(scope)
      }, 0)
    }
  }, [scope])
  return useSyncExternalStore(
    unchanging,
    () => readLastVisit(scope),
    () => null
  )
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
    const { spaceId, annotationId } = item
    return annotationsApi().then((api) =>
      api.replyAnnotation(spaceId, annotationId, body)
    )
  }
  return Promise.resolve()
}

// Comments are answered from Home now and then; their calls load when used,
// not with every page.
const annotationsApi = () => import("@/lib/annotations-api")

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
  const [resolving, setResolving] = useState(false)
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

  const refresh = () => {
    for (const spaceId of [undefined, item.spaceId ?? undefined]) {
      void queryClient.invalidateQueries({
        queryKey: activityQueryKeys.pendingIn(spaceId),
      })
    }
  }

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
        window.setTimeout(refresh, SENT_LINGER_MS)
      },
      onFailed: () => toast.error("Couldn’t send your reply. Try again."),
    })
  }

  const cancel = () => {
    clearSend(item.id)
    onClose()
  }

  // A comment already settled elsewhere can be resolved without an answer.
  const resolve = async () => {
    if (item.kind !== "commentRequest") return
    setResolving(true)
    try {
      const api = await annotationsApi()
      await api.resolveAnnotation(item.spaceId, item.annotationId)
      refresh()
      toast("Resolved", {
        action: {
          label: "Undo",
          onClick: () =>
            void api.reopenAnnotation(item.spaceId, item.annotationId).then(refresh),
        },
      })
    } catch {
      toast.error("Couldn’t resolve. Try again.")
      setResolving(false)
    }
  }

  const quote = item.kind === "commentRequest" ? item.quote : undefined
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
                !composing && "line-clamp-4 sm:line-clamp-2"
          )}
        >
          {headline}
        </p>
        {quote && (
          <p
            className={cn(
              "mt-1.5 border-l-2 border-border pl-2.5 text-[0.8rem] leading-relaxed text-muted-foreground",
              composing ? "line-clamp-4" : "line-clamp-1"
            )}
          >
            {quote}
          </p>
        )}
        <Meta
          who={asker}
          at={item.at}
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
        {idle && (
          <Actions>
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
            {item.kind === "commentRequest" && (
              <button
                type="button"
                className={cn(textAction, "text-muted-foreground hover:bg-surface-hover hover:text-foreground")}
                disabled={resolving}
                onClick={() => void resolve()}
              >
                <Check className="size-3.5" />
                Resolve
              </button>
            )}
          </Actions>
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
      <When at={item.at} />
    </div>
  )
}

/**
 * What only the reader can act on, answered in place. Home always shows it,
 * so its place doesn't jump; a Space shows it only when something waits.
 */
export function PendingSection({ spaceId }: { spaceId?: string }) {
  // Past the first request's ten, one more asks for the rest.
  const [all, setAll] = useState(false)
  const pending = usePending(spaceId, all)
  const spaces = useSpaceFacts()
  const [open, setOpen] = useState<string | null>(null)
  const items = pending.data?.items ?? []
  const total = pending.data?.total ?? items.length
  const steps = useSteps(SHOWN)
  const failed = pending.isError && !pending.data
  const onHome = spaceId === undefined
  if (!onHome && !pending.isLoading && items.length === 0 && !failed) return null
  const shown = items.slice(0, steps.visible)
  // What another step could still show: everything a full list holds, until
  // that list has come.
  const reachable = all ? items.length : Math.min(total, FULL_LIST)
  const loadingMore = all && pending.isPlaceholderData
  const named = onHome && !oneSpace(items.map((item) => item.spaceId))
  return (
    <section aria-labelledby="pending-heading">
      <SectionHeader id="pending-heading" title="Pending" count={total} urgent />
      {pending.isLoading ? (
        <Skeleton rows={onHome ? 2 : 1} tall />
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
                spaceName={named ? spaces.nameOf(item.spaceId) : undefined}
                open={open === item.id}
                onOpen={() => setOpen(item.id)}
                onClose={() => setOpen((current) => (current === item.id ? null : current))}
              />
            ))}
          </div>
          <MoreLess
            more={Math.min(STEP, reachable - shown.length)}
            less={steps.expanded}
            loading={loadingMore}
            onMore={() => {
              if (steps.visible + STEP > items.length && total > items.length) setAll(true)
              steps.more()
            }}
            onLess={steps.less}
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

type Place = "space" | "folder" | { inFolder: string } | "none"

/**
 * Where a doc lives: on Home, its Space; in a Space, its folder; in a
 * folder, the folder inside it, if any.
 */
function placeOf(
  item: RecentDocument,
  place: Place,
  spaceName: (spaceId: string) => string | undefined
): string | undefined {
  if (place === "none") return undefined
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
 * archives, beside Keep.
 */
function DocRow({
  item,
  place,
  now,
  since,
}: {
  item: RecentDocument
  place: Place
  now: number
  /** The reader's last visit: others' changes after it are marked. */
  since?: number | null
}) {
  const nameOf = useActorName()
  const isSelf = useIsSelf()
  const spaces = useSpaceFacts()
  const { updatedAt, archiveOn, lifetime } = item.document
  const editor = item.lastEditor
  const unusual = !PLAIN_FORMATS.has(item.document.format.id)
  const temporary = lifetime === "temporary" && archiveOn !== undefined
  const soon = temporary && daysUntil(archiveOn, now) <= 1
  const fresh =
    since != null &&
    updatedAt !== undefined &&
    Date.parse(updatedAt) > since &&
    editor !== undefined &&
    !(editor.kind === "person" && isSelf(editor))
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
          {fresh && (
            <span
              className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-primary"
              title="Changed since your last visit"
            >
              <span className="sr-only">Changed since your last visit:</span>
            </span>
          )}
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
          at={updatedAt}
          parts={[placeOf(item, place, spaces.nameOf)]}
        />
        {item.excerpt && (
          <p className="mt-1.5 line-clamp-2 text-[0.8125rem] leading-relaxed text-muted-foreground">
            {item.excerpt}
          </p>
        )}
        {temporary && (
          <Actions>
            <span
              className={cn(
                "inline-flex items-center gap-1 text-[0.8rem]",
                soon ? "text-warning" : "text-muted-foreground"
              )}
            >
              <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
              {archiveLabel(archiveOn, now)}
            </span>
            {spaces.canEdit(item.spaceId) && <KeepButton item={item} />}
          </Actions>
        )}
      </div>
      <When at={updatedAt} />
    </div>
  )
}

/**
 * What changed lately, and who changed it. On Home, the reader's and their
 * agents' docs across Spaces; in a Space, everyone's there. When the newest
 * is a doc an agent just made, it shows its opening lines. Others' changes
 * since the reader's last visit are marked.
 */
export function RecentSection({ spaceId }: { spaceId?: string }) {
  const inSpace = spaceId !== undefined
  const recent = useRecent(spaceId)
  const since = useLastVisit(inSpace ? `space:${spaceId}` : "home")
  const [now] = useState(() => Date.now())
  const items = recent.data?.items ?? []
  const place: Place = inSpace
    ? "folder"
    : oneSpace(items.map((item) => item.spaceId))
      ? "none"
      : "space"
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
      ) : items.length === 0 && !recent.data?.incomplete ? (
        <p className="px-0.5 text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <>
          {items.length > 0 && (
            <div className={cardClass}>
              {items.map((item) => (
                <DocRow
                  key={docKey(item)}
                  item={item}
                  place={place}
                  now={now}
                  since={since}
                />
              ))}
            </div>
          )}
          {recent.data?.incomplete && (
            <Incomplete onRetry={() => void recent.refetch()} />
          )}
        </>
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
      ) : items.length === 0 && !docs.data?.incomplete ? (
        <p className="px-0.5 text-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <>
          {items.length > 0 && (
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
          {docs.data?.incomplete && (
            <Incomplete onRetry={() => void docs.refetch()} />
          )}
        </>
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
  const inRecent = new Set((recent.data?.items ?? []).map(docKey))
  const soon = (recent.data?.temporary ?? [])
    .filter(
      (item) =>
        item.document.archiveOn &&
        !inRecent.has(docKey(item)) &&
        daysUntil(item.document.archiveOn, now) <= SOON_DAYS
    )
    .sort((a, b) => a.document.archiveOn!.localeCompare(b.document.archiveOn!))
  const steps = useSteps(SHOWN)
  if (soon.length === 0) return null
  const shown = soon.slice(0, steps.visible)
  const place: Place =
    spaceId !== undefined
      ? "folder"
      : oneSpace(soon.map((item) => item.spaceId))
        ? "none"
        : "space"
  return (
    <section aria-labelledby="archiving-heading">
      <SectionHeader id="archiving-heading" title="Archiving Soon" count={soon.length} />
      <div className={cardClass}>
        {shown.map((item) => (
          <DocRow key={docKey(item)} item={item} place={place} now={now} />
        ))}
      </div>
      <MoreLess
        more={Math.min(STEP, soon.length - shown.length)}
        less={steps.expanded}
        onMore={steps.more}
        onLess={steps.less}
      />
    </section>
  )
}
