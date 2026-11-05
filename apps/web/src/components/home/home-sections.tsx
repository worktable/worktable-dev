import { Link } from "@tanstack/react-router"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  FilePlus2,
  FileText,
  MessageSquareText,
  MessagesSquare,
  Paperclip,
  Pencil,
  Reply,
} from "lucide-react"
import { flushSync } from "react-dom"
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import type { ActivityActor, Annotation, PendingItem } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { Textarea } from "@worktable/ui/components/textarea"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { ActorBadge, ThreadLink } from "@/components/home/activity-feed"
import { ProgressRing } from "@/components/getting-started/progress-ring"
import { SpaceIcon } from "@/components/spaces/space-icon"
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
import { plainText, readableAgentName } from "@/lib/home-text"
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
// On phones the target grows to a thumb's size without moving the text.
const textAction =
  "-mx-1.5 -my-1 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[0.8rem] font-medium text-primary-text transition-colors hover:bg-primary/10 disabled:opacity-50 max-sm:-my-3 max-sm:py-3"
const quietAction = cn(
  textAction,
  "text-muted-foreground hover:bg-surface-hover hover:text-foreground"
)
const quietLink =
  "inline-flex items-center gap-1 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
const quietButton = cn(quietLink, "-my-2 py-2 max-sm:-my-3 max-sm:py-3")

// Lists show a few, then more in steps, so their height holds still as
// items come and go.
const STEP = 5
const DAY_MS = 24 * 60 * 60 * 1000
// Past this, what waits folds into one line: it has waited long enough that
// it isn't today's work.
const OLD_AFTER_MS = 7 * DAY_MS

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
            <span className="sr-only">, </span>
            {count}
          </span>
        ) : null}
      </h2>
      {action}
    </div>
  )
}

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

/** "5 More" and "Show Less", at the end of a list, with any other controls for it. */
function MoreLess({
  more,
  less,
  loading = false,
  onMore,
  onLess,
  children,
}: {
  more: number
  less: boolean
  loading?: boolean
  onMore: () => void
  onLess: () => void
  children?: ReactNode
}) {
  if (more <= 0 && !less && !loading && !children) return null
  return (
    <div className="mt-2 flex items-center gap-5 px-0.5">
      {loading ? (
        <span className="text-[0.8rem] text-muted-foreground">Loading…</span>
      ) : (
        more > 0 && (
          <button type="button" className={quietButton} onClick={onMore}>
            {more} More
          </button>
        )
      )}
      {less && (
        <button type="button" className={quietButton} onClick={onLess}>
          Show Less
        </button>
      )}
      {children}
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
    // On phones it wraps to a second line rather than cut who or when.
    <p className="mt-0.5 text-[0.8rem] text-muted-foreground sm:truncate">
      {who && <span className="text-foreground/75">{who}</span>}
      {shown.map((part, index) => (
        <Fragment key={index}>
          {(who || index > 0) && <span aria-hidden="true"> · </span>}
          {part}
        </Fragment>
      ))}
      {at && (
        <span className="whitespace-nowrap sm:hidden">
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
    space: (spaceId: string) => byId.get(spaceId),
    nameOf: (spaceId: string | null | undefined) =>
      spaceId ? byId.get(spaceId)?.name : undefined,
    canEdit: (spaceId: string) => byId.get(spaceId)?.permissions?.edit !== false,
  }
}

/** Rows name their Space only when the list holds more than one. */
function oneSpace(spaceIds: Array<string | null>): boolean {
  return new Set(spaceIds).size <= 1
}

/** An actor's name as rows show it, with the full name on hover. */
function useShownName() {
  const nameOf = useActorName()
  return (actor: Pick<ActivityActor, "kind" | "id" | "name">) => {
    const full = nameOf(actor)
    const shown = actor.kind === "agent" ? readableAgentName(full) : full
    return { shown, full }
  }
}

/** An actor's mark, drawn from their readable name, so an agent shows as itself. */
function Badge({ actor }: { actor: ActivityActor }) {
  const named = useShownName()(actor)
  return <ActorBadge actor={actor.kind === "agent" ? { ...actor, name: named.shown } : actor} />
}

function ActorName({ actor }: { actor: Pick<ActivityActor, "kind" | "id" | "name"> }) {
  const named = useShownName()(actor)
  return <span title={named.full !== named.shown ? named.full : undefined}>{named.shown}</span>
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

// Comments are answered from Home now and then; their calls load when used,
// not with every page.
const annotationsApi = () => import("@/lib/annotations-api")

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

// ── Your Turn ──────────────────────────────────────────────

const SHOWN = 3
// The most one request for the rest lists.
const FULL_LIST = 500
// Long enough to read "Sent" before the row leaves.
const SENT_LINGER_MS = 2_000

type AnsweredItem = Extract<PendingItem, { kind: "answered" }>

function replyable(
  item: PendingItem
): item is Extract<PendingItem, { kind: "threadRequest" | "commentRequest" }> {
  return item.kind === "threadRequest" || item.kind === "commentRequest"
}

function usePendingRefresh() {
  const queryClient = useQueryClient()
  return (spaceId: string | null | undefined) => {
    for (const id of [undefined, spaceId ?? undefined]) {
      void queryClient.invalidateQueries({ queryKey: activityQueryKeys.pendingIn(id) })
    }
  }
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
      hash={
        item.kind === "visitorComments" || item.kind === "visitorCommentsPaused"
          ? "visitors"
          : undefined
      }
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
    case "answered":
      return item.docTitle ?? humanizeSegment(item.docPath.split("/").at(-1) ?? item.docPath)
    case "visitorCommentsPaused":
      return item.linkLabel || "Untitled link"
  }
}

/** What the reader is asked, or what happened. */
function pendingHeadline(item: PendingItem): string {
  switch (item.kind) {
    case "threadRequest": {
      // An agent often opens with the thread's title; it shows below already.
      const text = plainText(item.excerpt)
      const title = plainText(item.threadTitle)
      return text.startsWith(title) && text.length > title.length
        ? text.slice(title.length).replace(/^[\s:.,;-]+/, "")
        : text
    }
    case "commentRequest":
      return plainText(item.excerpt)
    case "deliveryFailed":
      return `Not delivered to ${item.agentName}`
    case "visitorComments":
      return `${item.count} visitor comment${item.count === 1 ? "" : "s"}`
    case "visitorCommentsPaused":
      return "Comments paused"
    case "answered":
      return sourceTitle(item)
  }
}

function PendingLead({ item }: { item: PendingItem }) {
  if (replyable(item)) {
    return (
      <Lead>
        <Badge actor={item.from} />
      </Lead>
    )
  }
  if (item.kind === "answered" && item.by[0]) {
    return (
      <Lead>
        <Badge actor={item.by[0]} />
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

/** Seconds until a waiting send goes. */
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])
  return <>{Math.max(1, Math.ceil((at - now) / 1000))}s</>
}

/**
 * A send's wait, on the row: what goes, how soon, and Undo. `label` says
 * what is waiting ("Resolving 3"); a reply shows its own text.
 */
function SendStatus({
  id,
  label,
  onUndo,
}: {
  id: string
  label?: string
  onUndo: (body: string) => void
}) {
  const sending = useSend(id)
  const phase = sending?.phase
  return (
    <div role="status" aria-live="polite">
      {(phase === "waiting" || phase === "sending" || phase === "sent") && sending && (
        <div className="mt-2 flex min-h-7 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8rem] text-muted-foreground">
          {phase === "sent" ? (
            <Check className="size-3.5 shrink-0 text-success" />
          ) : (
            <SendProgress sendAt={sending.sendAt} />
          )}
          <span className="min-w-0 truncate text-foreground">{label ?? sending.body}</span>
          <span className="flex shrink-0 items-center gap-2.5">
            {phase === "waiting" ? (
              <>
                <span>
                  {label ? "In" : "Sends in"} <Countdown at={sending.sendAt} />
                </span>
                <button
                  type="button"
                  className={cn(above, textAction, "mx-0")}
                  onClick={() => {
                    const body = undoSend(id)
                    if (body !== null) onUndo(body)
                  }}
                >
                  Undo
                </button>
              </>
            ) : phase === "sending" ? (
              label ? "…" : "Sending"
            ) : label ? (
              "Done"
            ) : (
              "Sent"
            )}
          </span>
        </div>
      )}
      {phase === "failed" && (
        <p className="mt-2 text-[0.8rem] text-destructive">
          {label ? "Couldn’t finish." : "Couldn’t send."}
        </p>
      )}
    </div>
  )
}

/** A reply box: Enter sends, Shift+Enter starts a new line, Escape cancels. */
function ReplyBox({
  draft,
  onDraft,
  onSend,
  onCancel,
  placeholder,
  label,
}: {
  draft: string
  onDraft: (draft: string) => void
  onSend: () => void
  onCancel: () => void
  placeholder: string
  label: string
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => box.current?.focus(), [])
  return (
    <form
      className={cn(above, "mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-end")}
      onSubmit={(event) => {
        event.preventDefault()
        onSend()
      }}
    >
      <Textarea
        ref={box}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onSend()
          }
          if (event.key === "Escape") {
            event.preventDefault()
            onCancel()
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        rows={1}
        className="field-sizing-content max-h-40 min-h-9 resize-none bg-background py-2"
      />
      <div className="flex shrink-0 justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          Send
        </Button>
      </div>
    </form>
  )
}

/** An ask: a question, a comment sent to the reader, or something that failed. */
function AskRow({
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
  const refresh = usePendingRefresh()
  const named = useShownName()
  const sending = useSend(item.id)
  const phase = sending?.phase
  // A reply still on its way when the row remounts keeps its text, so Undo
  // or a failure can put it back.
  const [draft, setDraft] = useState(() => unsentBody(item.id) ?? "")
  const canReply = replyable(item)
  const headline = pendingHeadline(item)
  const source = sourceTitle(item)
  const asker = canReply ? named(item.from) : undefined
  const composing = canReply && (phase === "failed" || (open && !phase))
  const idle = canReply && !composing && !phase

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
        window.setTimeout(() => refresh(item.spaceId), SENT_LINGER_MS)
      },
      onFailed: () => toast.error("Couldn’t send your reply. Try again."),
    })
  }

  const cancel = () => {
    clearSend(item.id)
    onClose()
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
            {plainText(quote)}
          </p>
        )}
        <Meta
          who={asker && <span title={asker.full !== asker.shown ? asker.full : undefined}>{asker.shown}</span>}
          at={item.at}
          parts={[
            canReply ? (
              <PendingSource
                item={item}
                className={cn(above, "rounded-sm hover:text-foreground hover:underline")}
              >
                <SourceIcon className="mr-1 inline size-3 -translate-y-px" aria-hidden="true" />
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
              aria-label={`Reply to ${asker?.shown}: ${headline}`}
              aria-expanded={open}
              onClick={onOpen}
            >
              <Reply className="size-3.5" />
              Reply
            </button>
          </Actions>
        )}
        <SendStatus
          id={item.id}
          onUndo={(body) => {
            setDraft(body)
            onOpen()
          }}
        />
        {composing && (
          <ReplyBox
            draft={draft}
            onDraft={setDraft}
            onSend={send}
            onCancel={cancel}
            placeholder={`Reply to ${asker?.shown}`}
            label={`Reply on ${source}`}
          />
        )}
      </div>
      <When at={item.at} />
    </div>
  )
}

/** One of the reader's comments, and the answer it got. */
function AnswerPair({
  spaceId,
  annotation,
  onDone,
}: {
  spaceId: string
  annotation: Annotation
  onDone: () => void
}) {
  const id = `answer:${annotation.id}`
  const sending = useSend(id)
  const [replying, setReplying] = useState(false)
  const [draft, setDraft] = useState(() => unsentBody(id) ?? "")
  const [resolving, setResolving] = useState(false)
  const [resolved, setResolved] = useState(false)
  const quote = "quote" in annotation.target ? annotation.target.quote : undefined
  // The agent had the last word; it answers the person's latest words before
  // it, which on a first exchange are the comment itself.
  const answer = annotation.thread.at(-1)
  const asked =
    annotation.thread
      .slice(0, -1)
      .reverse()
      .find((message) => message.author.type === "user")?.body ?? annotation.body
  const send = () => {
    const body = draft.trim()
    if (!body) return
    clearSend(id)
    scheduleSend(
      id,
      body,
      () => annotationsApi().then((api) => api.replyAnnotation(spaceId, annotation.id, body)),
      {
        onSent: () => {
          setDraft("")
          setReplying(false)
          window.setTimeout(onDone, SENT_LINGER_MS)
        },
        onFailed: () => toast.error("Couldn’t send your reply. Try again."),
      }
    )
  }
  const resolve = async () => {
    setResolving(true)
    try {
      const api = await annotationsApi()
      await api.resolveAnnotation(spaceId, annotation.id)
      setResolved(true)
      onDone()
      toast("Resolved", {
        action: {
          label: "Undo",
          onClick: () =>
            void api.reopenAnnotation(spaceId, annotation.id).then(() => {
              setResolved(false)
              onDone()
            }),
        },
      })
    } catch {
      toast.error("Couldn’t resolve. Try again.")
      setResolving(false)
    }
  }
  // Resolved here: it leaves before the list refreshes.
  if (resolved) return null
  return (
    <li className="space-y-1.5 border-t border-border/60 py-3 first:border-t-0 first:pt-1">
      {quote && (
        <p className="border-l-2 border-border pl-2.5 text-[0.8rem] leading-relaxed text-muted-foreground">
          {plainText(quote)}
        </p>
      )}
      <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground/75">You: </span>
        {plainText(asked)}
      </p>
      {answer && (
        <p className="text-sm leading-relaxed text-foreground">
          <span className="font-medium">
            <ActorName
              actor={{
                kind: answer.author.type === "user" ? "person" : answer.author.type,
                id: answer.author.id,
                ...(answer.author.name ? { name: answer.author.name } : {}),
              }}
            />
            :{" "}
          </span>
          {plainText(answer.body)}
        </p>
      )}
      {!replying && !sending && (
        <div className="flex items-center gap-4 pt-0.5">
          <button type="button" className={textAction} onClick={() => setReplying(true)}>
            <Reply className="size-3.5" />
            Reply
          </button>
          <button
            type="button"
            className={quietAction}
            disabled={resolving}
            onClick={() => void resolve()}
          >
            <Check className="size-3.5" />
            Resolve
          </button>
        </div>
      )}
      <SendStatus
        id={id}
        onUndo={(body) => {
          setDraft(body)
          setReplying(true)
        }}
      />
      {(replying || sending?.phase === "failed") && !(sending && sending.phase !== "failed") && (
        <ReplyBox
          draft={draft}
          onDraft={setDraft}
          onSend={send}
          onCancel={() => {
            clearSend(id)
            setReplying(false)
          }}
          placeholder="Reply"
          label="Reply to this answer"
        />
      )}
    </li>
  )
}

/** The answers on one doc, loaded when the row opens. */
function AnswerPairs({
  item,
  onDone,
  onHide,
}: {
  item: AnsweredItem
  onDone: () => void
  onHide: () => void
}) {
  const answers = useQuery({
    // Any new answer, here or on the Doc, changes the ids or the newest time.
    queryKey: [
      "home-answers",
      item.spaceId,
      item.docPath,
      item.annotationIds.join(","),
      item.at,
    ],
    queryFn: async () => {
      const api = await annotationsApi()
      const { annotations } = await api.listAnnotations(item.spaceId, {
        docPath: item.docPath,
        status: ["open"],
        limit: 500,
      })
      const order = new Map(item.annotationIds.map((id, index) => [id, index]))
      return annotations
        .filter((annotation) => order.has(annotation.id))
        .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    },
    staleTime: Infinity,
    // After a reply or resolve the key changes; the pairs stay until the new
    // list arrives.
    placeholderData: keepPreviousData,
  })
  if (answers.isLoading) {
    return <div className="mt-2 h-16 animate-pulse rounded-lg bg-surface-inset" aria-hidden="true" />
  }
  if (answers.isError) {
    return <LoadFailed what="the answers" onRetry={() => void answers.refetch()} />
  }
  const pairs = answers.data ?? []
  return (
    <>
      <ul className={cn(above, "mt-2")}>
        {pairs.map((annotation) => (
          <AnswerPair
            key={annotation.id}
            spaceId={item.spaceId}
            annotation={annotation}
            onDone={onDone}
          />
        ))}
      </ul>
      {pairs.length > 3 && (
        <Actions>
          <button type="button" className={textAction} onClick={onHide}>
            <ChevronDown className="size-3.5 rotate-180" />
            Hide
          </button>
        </Actions>
      )}
    </>
  )
}

/**
 * A doc where agents answered the reader's comments: who, how many, when.
 * It opens to the answers; Resolve All settles them all after a 5-second
 * Undo.
 */
function AnsweredRow({
  item,
  spaceName,
  open,
  onOpen,
  onClose,
}: {
  item: AnsweredItem
  spaceName?: string
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const refresh = usePendingRefresh()
  const rowRef = useRef<HTMLDivElement>(null)
  const resolveId = `resolve-all:${item.id}`
  const resolving = useSend(resolveId)
  const count = item.annotationIds.length
  const title = sourceTitle(item)
  // Pending's refresh changes the row's ids or time, which reloads its answers.
  const done = () => refresh(item.spaceId)
  const resolveAll = () => {
    clearSend(resolveId)
    scheduleSend(
      resolveId,
      "",
      async () => {
        const api = await annotationsApi()
        const results = await Promise.allSettled(
          item.annotationIds.map((id) => api.resolveAnnotation(item.spaceId, id))
        )
        // Report a failure only once every resolve has settled.
        if (results.some((result) => result.status === "rejected")) {
          throw new Error("Some comments couldn’t be resolved")
        }
      },
      {
        onSent: () => window.setTimeout(done, SENT_LINGER_MS),
        // Some may have resolved; the row shows what is left.
        onFailed: () => {
          done()
          toast.error("Couldn’t resolve them all. Try again.")
        },
      }
    )
  }
  const busy = resolving && resolving.phase !== "failed"
  return (
    <div ref={rowRef} className={cn(rowClass, !open && !busy && rowHover)}>
      {!busy && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className={rowCover}
          onClick={open ? onClose : onOpen}
        />
      )}
      <PendingLead item={item} />
      <div className="min-w-0">
        <p className="flex min-w-0 items-start gap-1.5 leading-snug">
          <Link
            to="/spaces/$spaceId/documents/$"
            params={{ spaceId: item.spaceId, _splat: item.docPath }}
            className={cn(
              above,
              "min-w-0 rounded-sm font-medium text-foreground hover:underline max-sm:line-clamp-2 sm:truncate"
            )}
          >
            {title}
          </Link>
        </p>
        <Meta
          who={
            <>
              {item.by[0] && <ActorName actor={item.by[0]} />}
              {item.by.length > 1 && ` +${item.by.length - 1}`}{" "}
              {count === 1 ? "answered your comment" : `answered ${count} of your comments`}
            </>
          }
          at={item.at}
          parts={[spaceName]}
        />
        {!busy && (
          <Actions>
            <button
              type="button"
              className={textAction}
              aria-expanded={open}
              onClick={open ? onClose : onOpen}
            >
              <ChevronDown
                className={cn("size-3.5 transition-transform", open && "rotate-180")}
              />
              {open ? "Hide" : count === 1 ? "Answer" : "Answers"}
            </button>
            <button type="button" className={quietAction} onClick={resolveAll}>
              <Check className="size-3.5" />
              {count === 1 ? "Resolve" : "Resolve All"}
            </button>
          </Actions>
        )}
        <SendStatus
          id={resolveId}
          label={count === 1 ? "Resolving" : `Resolving ${count}`}
          onUndo={() => {}}
        />
        {open && !busy && (
          <AnswerPairs
            item={item}
            onDone={done}
            onHide={() => {
              // Hiding from the bottom of a long list keeps the reader at this
              // row: collapse it first, then bring what remains into view.
              flushSync(onClose)
              rowRef.current?.scrollIntoView({ block: "nearest" })
            }}
          />
        )}
      </div>
      <When at={item.at} />
    </div>
  )
}

/**
 * What's back in the reader's court: docs where agents answered their
 * comments, and what is asked of them, answered in place. Home always shows
 * it, so its place doesn't jump; a Space shows it only when something waits.
 */
export function YourTurnSection({ spaceId }: { spaceId?: string }) {
  // Past the first request's ten, one more asks for the rest.
  const [all, setAll] = useState(false)
  const pending = usePending(spaceId, all)
  const spaces = useSpaceFacts()
  const [open, setOpen] = useState<string | null>(null)
  const [showOld, setShowOld] = useState(false)
  const [now] = useState(() => Date.now())
  const items = pending.data?.items ?? []
  const total = pending.data?.total ?? items.length
  const fresh = items.filter((item) => now - Date.parse(item.at) <= OLD_AFTER_MS)
  const old = items.filter((item) => now - Date.parse(item.at) > OLD_AFTER_MS)
  const steps = useSteps(SHOWN)
  const failed = pending.isError && !pending.data
  const onHome = spaceId === undefined
  // A Space shows it only once something is known to wait, so its page
  // doesn't shift.
  if (!onHome && (pending.isLoading || (items.length === 0 && !failed))) return null
  const shown = fresh.slice(0, steps.visible)
  // What another step could still show: everything a full list holds, until
  // that list has come. Older items wait behind their own line.
  const reachable = (all ? items.length : Math.min(total, FULL_LIST)) - old.length
  const loadingMore = all && pending.isPlaceholderData
  const named = onHome && !oneSpace(items.map((item) => item.spaceId))
  const row = (item: PendingItem) => {
    const props = {
      spaceName: named ? spaces.nameOf(item.spaceId) : undefined,
      open: open === item.id,
      onOpen: () => setOpen(item.id),
      onClose: () => setOpen((current) => (current === item.id ? null : current)),
    }
    return item.kind === "answered" ? (
      <AnsweredRow key={item.id} item={item} {...props} />
    ) : (
      <AskRow key={item.id} item={item} {...props} />
    )
  }
  return (
    <section aria-labelledby="your-turn-heading">
      <SectionHeader
        id="your-turn-heading"
        title="Your Turn"
        count={total - old.length}
        urgent
      />
      {pending.isLoading ? (
        <Skeleton rows={onHome ? 2 : 1} tall />
      ) : failed ? (
        <LoadFailed what="what’s yours to do" onRetry={() => void pending.refetch()} />
      ) : items.length === 0 ? (
        <p className="flex h-6 items-center gap-2 px-0.5 text-sm text-muted-foreground">
          <Check className="size-4 text-success" />
          Nothing waiting
        </p>
      ) : (
        <>
          {(shown.length > 0 || showOld) && (
            <div className={cardClass}>
              {/* Older items open below every fresher one, never above. */}
              {(showOld ? fresh : shown).map(row)}
              {showOld && old.map(row)}
            </div>
          )}
          <MoreLess
            more={showOld ? 0 : Math.min(STEP, reachable - shown.length)}
            less={steps.expanded && !showOld}
            loading={loadingMore}
            onMore={() => {
              if (steps.visible + STEP > items.length && total > items.length) setAll(true)
              steps.more()
            }}
            onLess={steps.less}
          >
            {old.length > 0 && (
              <button
                type="button"
                className={quietButton}
                aria-expanded={showOld}
                onClick={() => setShowOld(!showOld)}
              >
                <ChevronDown className={cn("size-3.5 transition-transform", showOld && "rotate-180")} />
                {old.length} older
              </button>
            )}
          </MoreLess>
        </>
      )}
    </section>
  )
}

// ── Latest Work ────────────────────────────────────────────

const HOME_DOCS = 30
const SPACE_DOCS = 20
const FOLDER_ROWS = 500
// Per Space section on Home, and in Space Home's one list.
const SECTION_ROWS = 3
const SPACE_LIST_ROWS = 8
// Temporary docs further out than this aren't "soon".
const SOON_DAYS = 7
// Docs and rich docs are the usual kind; anything else says what it is.
const PLAIN_FORMATS = new Set(["worktable.markdown", "worktable.rich-text"])
const isFile = (item: RecentDocument) => item.document.format.id === "worktable.file"

/**
 * Home's and Space Home's one read of recent docs: Latest Work, Archiving
 * Soon and the summary line share it.
 */
function useRecent(spaceId?: string) {
  return useRecentDocuments({
    sort: "updated",
    includeTemporary: true,
    limit: spaceId !== undefined ? SPACE_DOCS : HOME_DOCS,
    filesBeyondLimit: true,
    temporaryLimit: 100,
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
  return within.length > 1 ? folderName(within[0]!) : undefined
}

/**
 * A folder's name to read. Agents often date a folder and sign it with their
 * own name; the row already has a time and an author.
 */
function folderName(segment: string): string {
  const undated = segment.replace(/^\d{4}-\d{2}-\d{2}[-_ ]*/, "")
  const named =
    undated === segment
      ? segment
      : undated.replace(/[-_ ](claude|codex|chatgpt|cursor|gemini|grok)$/i, "")
  return humanizeSegment(named || segment)
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

/** Made or changed, as a mark. */
function ActionMark({ action }: { action?: "created" | "edited" }) {
  if (!action) return null
  const Icon = action === "created" ? FilePlus2 : Pencil
  return (
    <Icon
      className="mr-1 inline size-3 -translate-y-px"
      aria-label={action === "created" ? "Created by" : "Edited by"}
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
          <Badge actor={editor} />
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
            editor && (
              <>
                <ActionMark action={item.lastAction} />
                <ActorName actor={editor} />
              </>
            )
          }
          at={updatedAt}
          parts={[placeOf(item, place, spaces.nameOf)]}
        />
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

/** Uploaded files, as one row that opens to list them. */
function FilesRow({
  files,
  place,
  now,
  capped,
}: {
  files: RecentDocument[]
  place: Place
  now: number
  /** The list stopped at its limit, so there may be more. */
  capped: boolean
}) {
  const [open, setOpen] = useState(false)
  const spaces = useSpaceFacts()
  const newest = files[0]!
  const places = [...new Set(files.map((file) => placeOf(file, place, spaces.nameOf)))]
  return (
    <>
      <div className={cn(rowClass, rowHover)}>
        <button
          type="button"
          className={rowCover}
          aria-expanded={open}
          aria-label={`${files.length}${capped ? "+" : ""} files`}
          onClick={() => setOpen(!open)}
        />
        <Lead>
          <Paperclip className="size-4 text-muted-foreground" />
        </Lead>
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-1.5 leading-snug font-medium text-foreground">
            {files.length}
            {capped ? "+" : ""} files
            <ChevronDown
              className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")}
            />
          </p>
          <Meta
            who={newest.lastEditor && <ActorName actor={newest.lastEditor} />}
            at={newest.document.updatedAt}
            parts={[places.length === 1 ? places[0] : undefined]}
          />
        </div>
        <When at={newest.document.updatedAt} />
      </div>
      {open && (
        <div className="ml-6 border-l border-border/60 pl-1">
          {files.map((file) => (
            <DocRow key={docKey(file)} item={file} place={place} now={now} />
          ))}
        </div>
      )}
    </>
  )
}

/** A row of Latest Work: one doc, or the uploaded files folded together. */
type Unit =
  | { kind: "doc"; item: RecentDocument }
  | { kind: "files"; items: RecentDocument[] }

/** Docs in order, with uploaded files folded into one row where the newest was. */
function toUnits(items: RecentDocument[]): Unit[] {
  const files = items.filter(isFile)
  return items.flatMap((item): Unit[] => {
    if (!isFile(item)) return [{ kind: "doc", item }]
    if (item !== files[0]) return []
    return files.length > 1 ? [{ kind: "files", items: files }] : [{ kind: "doc", item }]
  })
}

function Units({
  units,
  place,
  now,
  since,
  filesCapped,
}: {
  units: Unit[]
  place: Place
  now: number
  since?: number | null
  /** The list stopped at its file limit, so a files row may hold more. */
  filesCapped: boolean
}) {
  return (
    <>
      {units.map((unit) =>
        unit.kind === "doc" ? (
          <DocRow key={docKey(unit.item)} item={unit.item} place={place} now={now} since={since} />
        ) : (
          <FilesRow
            key="files"
            files={unit.items}
            place={place}
            now={now}
            capped={filesCapped}
          />
        )
      )}
    </>
  )
}

/** Docs Latest Work shows before anything is expanded. */
function shownInLatest(items: RecentDocument[], inSpace: boolean): Set<string> {
  const groups = new Map<string, RecentDocument[]>()
  for (const item of items) {
    const key = inSpace ? "" : item.spaceId
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const keys = new Set<string>()
  for (const group of groups.values()) {
    for (const unit of toUnits(group).slice(0, inSpace ? SPACE_LIST_ROWS : SECTION_ROWS)) {
      if (unit.kind === "doc") keys.add(docKey(unit.item))
    }
  }
  return keys
}

/** One Space's latest docs on Home: its newest few, the rest in place. */
function SpaceGroup({
  spaceId,
  items,
  now,
  since,
  filesCapped,
}: {
  spaceId: string
  items: RecentDocument[]
  now: number
  since: number | null
  /** The response stopped at its file limit, shared by every Space. */
  filesCapped: boolean
}) {
  const spaces = useSpaceFacts()
  const [all, setAll] = useState(false)
  const space = spaces.space(spaceId)
  const units = toUnits(items)
  const hidden = units.length - SECTION_ROWS
  return (
    <div className="py-1">
      <div className="flex items-center justify-between gap-3 px-3 pt-1.5 pb-0.5">
        <Link
          to="/spaces/$spaceId"
          params={{ spaceId }}
          className="flex min-w-0 items-center gap-2 text-[0.8rem] font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          {space && <SpaceIcon space={space} size="sm" />}
          <span className="truncate">{space?.name ?? items[0]!.spaceName}</span>
        </Link>
        {hidden > 0 && (
          <button
            type="button"
            className={cn(quietButton, "shrink-0")}
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? "Show Less" : `${hidden} More`}
          </button>
        )}
      </div>
      <Units
        units={all ? units : units.slice(0, SECTION_ROWS)}
        place="folder"
        now={now}
        since={since}
        filesCapped={filesCapped}
      />
    </div>
  )
}

/**
 * What changed lately, and who changed it. On Home, the reader's and their
 * agents' docs, by Space, newest Space first; in a Space, everyone's there,
 * in one list. Uploaded files fold into one row.
 */
export function LatestWorkSection({ spaceId }: { spaceId?: string }) {
  const inSpace = spaceId !== undefined
  const recent = useRecent(spaceId)
  const since = useLastVisit(inSpace ? `space:${spaceId}` : "home")
  const [now] = useState(() => Date.now())
  const steps = useSteps(SPACE_LIST_ROWS)
  const items = recent.data?.items ?? []
  const units = toUnits(items)
  // The server's file limit is for the whole response, so it is decided once.
  const filesCapped =
    items.filter(isFile).length >= (inSpace ? SPACE_DOCS : HOME_DOCS)
  // Newest first already, so each Space's first doc places its section.
  const groups = new Map<string, RecentDocument[]>()
  for (const item of items) {
    const group = groups.get(item.spaceId) ?? []
    group.push(item)
    groups.set(item.spaceId, group)
  }
  return (
    <section aria-labelledby="latest-heading">
      <SectionHeader
        id="latest-heading"
        title="Latest Work"
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
        <LoadFailed what="the latest work" onRetry={() => void recent.refetch()} />
      ) : items.length === 0 && !recent.data?.incomplete ? (
        <p className="px-0.5 text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <>
          {items.length > 0 && (
            <div className={cn(cardClass, !inSpace && "divide-y divide-border/60")}>
              {inSpace ? (
                <Units
                  units={units.slice(0, steps.visible)}
                  place="folder"
                  now={now}
                  since={since}
                  filesCapped={filesCapped}
                />
              ) : (
                [...groups].map(([id, group]) => (
                  <SpaceGroup
                    key={id}
                    spaceId={id}
                    items={group}
                    now={now}
                    since={since}
                    filesCapped={filesCapped}
                  />
                ))
              )}
            </div>
          )}
          {inSpace && (
            <MoreLess
              more={Math.min(STEP, units.length - steps.visible)}
              less={steps.expanded}
              onMore={steps.more}
              onLess={steps.less}
            />
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
    filesBeyondLimit: true,
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
              <Units
                units={toUnits(items)}
                place={{ inFolder: folder }}
                now={now}
                filesCapped={items.filter(isFile).length >= FOLDER_ROWS}
              />
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
 * Temporary docs that archive within the week and Latest Work doesn't show,
 * as one line: the soonest, with Keep, and the rest on request.
 */
export function ArchivingSoonSection({ spaceId }: { spaceId?: string }) {
  const recent = useRecent(spaceId)
  const spaces = useSpaceFacts()
  const [now] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const shown = shownInLatest(recent.data?.items ?? [], spaceId !== undefined)
  const soon = (recent.data?.temporary ?? [])
    .filter(
      (item) =>
        item.document.archiveOn &&
        !shown.has(docKey(item)) &&
        daysUntil(item.document.archiveOn, now) <= SOON_DAYS
    )
    .sort((a, b) => a.document.archiveOn!.localeCompare(b.document.archiveOn!))
  const first = soon[0]
  if (!first) return null
  const place: Place =
    spaceId !== undefined
      ? "folder"
      : oneSpace(soon.map((item) => item.spaceId))
        ? "none"
        : "space"
  const soonest = daysUntil(first.document.archiveOn!, now) <= 1
  return (
    <section aria-label="Archiving Soon">
      {/* On phones the title has its own line, so Keep says what it keeps. */}
      <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3.5 text-sm max-sm:grid-cols-[1rem_minmax(0,1fr)]">
        <Clock3
          className={cn("size-4 shrink-0", soonest ? "text-warning" : "text-muted-foreground")}
          aria-hidden="true"
        />
        <p className="flex min-w-0 items-baseline text-muted-foreground">
          <Link
            to="/spaces/$spaceId/documents/$"
            params={{ spaceId: first.spaceId, _splat: first.document.path }}
            className="min-w-0 truncate font-medium text-foreground hover:underline"
          >
            {first.document.title}
          </Link>
          <span className="shrink-0 whitespace-pre max-sm:hidden">
            {" · "}
            {archiveLabel(first.document.archiveOn!, now)}
          </span>
          {placeOf(first, place, spaces.nameOf) && (
            <span className="min-w-0 truncate whitespace-pre max-sm:hidden">
              {" · "}
              {placeOf(first, place, spaces.nameOf)}
            </span>
          )}
        </p>
        <div className="flex items-center gap-4 max-sm:col-start-2">
          <span className="text-muted-foreground sm:hidden">
            {archiveLabel(first.document.archiveOn!, now)}
          </span>
          {spaces.canEdit(first.spaceId) && <KeepButton item={first} />}
          {soon.length > 1 && (
            <button
              type="button"
              className={cn(quietButton, "shrink-0")}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? "Show Less" : `+${soon.length - 1}`}
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className={cn(cardClass, "mt-2")}>
          {soon.slice(1).map((item) => (
            <DocRow key={docKey(item)} item={item} place={place} now={now} />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Summary ────────────────────────────────────────────────

/**
 * One quiet line under the greeting: how much is the reader's to do, and how
 * much changed today. It reads what Your Turn and Latest Work already load.
 */
export function HomeSummary() {
  const pending = usePending()
  const recent = useRecent()
  const [now] = useState(() => Date.now())
  if (!pending.data && !recent.data) return <p className="mt-1 min-h-5" />
  const items = recent.data?.items ?? []
  // Older items fold away below, so they aren't counted as waiting.
  const old = (pending.data?.items ?? []).filter(
    (item) => now - Date.parse(item.at) > OLD_AFTER_MS
  ).length
  const turn = (pending.data?.total ?? 0) - old
  // The last day, so the night's agent work counts in the morning.
  const changed = items.filter(
    (item) =>
      !isFile(item) &&
      item.document.updatedAt !== undefined &&
      now - Date.parse(item.document.updatedAt) < DAY_MS
  )
  const parts = [
    turn > 0 ? `${turn} for you` : null,
    changed.length > 0
      ? `${changed.length}${changed.length >= HOME_DOCS ? "+" : ""} ${changed.length === 1 ? "change" : "changes"} since yesterday`
      : null,
  ].filter(Boolean)
  return (
    <p className="mt-1 min-h-5 text-sm text-muted-foreground">
      {parts.length > 0 ? parts.join(" · ") : "All quiet today"}
    </p>
  )
}
