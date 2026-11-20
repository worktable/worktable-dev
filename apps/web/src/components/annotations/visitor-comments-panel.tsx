import { Suspense, lazy, useCallback, useId, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { MoreVertical } from "lucide-react"
import type {
  Annotation,
  SendVisitorCommentsInput,
  VisitorComment,
} from "@worktable/types"
import { VISITOR_COMMENT_MAX_LENGTH } from "@worktable/types"
import { annotationSentTo, type SentCommentRef } from "@worktable/types/constants"
import { Badge } from "@worktable/ui/components/badge"
import { Callout } from "@worktable/ui/components/callout"
import { Button } from "@worktable/ui/components/button"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { Textarea } from "@worktable/ui/components/textarea"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { annotationQueryKeys } from "@/lib/annotations-queries"
import { HttpError } from "@/lib/http"
import { refreshLive } from "@/lib/live-refresh"
import { RelativeTime } from "@/lib/time"
import {
  applyVisitorCommentChange,
  visitorCommentsQueryKey,
} from "@/lib/visitor-comment-events"
import {
  finishVisitorComment,
  getVisitorComments,
  replyToVisitor,
  sendVisitorComments,
} from "@/lib/visitor-comments-api"
import { updateShareLink } from "@/lib/share-link-management-api"
import type { AnnotationPanelProps } from "./annotation-panel"
import { Quote } from "@/components/quote"
import {
  NO_RECIPIENT,
  useCommentRecipients,
  type CommentRecipients,
} from "@/lib/comment-recipients"

// Only loads where comments can be sent to someone (Preview agent tools).
const CommentRecipientSelect = lazy(() =>
  import("./comment-recipient").then((module) => ({
    default: module.CommentRecipientSelect,
  }))
)

type Context = NonNullable<AnnotationPanelProps["visitorComments"]>

/** Who comments go to, remembered per page and as the last pick anywhere. */
const LAST_PICK_KEY = "worktable-visitor-send"
function pageKey(context: Context): string {
  return `${LAST_PICK_KEY}:${context.spaceId}:${context.documentId}`
}

function readRemembered(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function remember(context: Context, value: string): void {
  try {
    localStorage.setItem(pageKey(context), value)
    if (value !== NO_RECIPIENT) localStorage.setItem(LAST_PICK_KEY, value)
  } catch {
    // Remembering is a convenience; the choice still applies now.
  }
}

/**
 * The recipient chosen here: the last one picked on this page, else the
 * agent that last changed the page, else the last one picked anywhere, else
 * the Space's only agent.
 */
function useRecipient(context: Context, recipients: CommentRecipients | null) {
  const [picked, setPicked] = useState<string | null>(() =>
    readRemembered(pageKey(context))
  )
  const [lastAnywhere] = useState(() => readRemembered(LAST_PICK_KEY))
  const offered = (id: string | null) =>
    id === NO_RECIPIENT ||
    Boolean(id && recipients?.options.some((option) => option.id === id))
  const agents = recipients?.options.filter((option) => option.kind === "agent")
  const value = !recipients
    ? NO_RECIPIENT
    : offered(picked)
      ? picked!
      : recipients.suggested !== NO_RECIPIENT
        ? recipients.suggested
        : offered(lastAnywhere)
          ? lastAnywhere!
          : agents?.length === 1
            ? agents[0]!.id
            : NO_RECIPIENT
  const choose = (next: string) => {
    setPicked(next)
    remember(context, next)
  }
  const name =
    recipients?.options.find((option) => option.id === value)?.name ?? null
  return { value, name, choose }
}

/** The send button's words: who it goes to, or that it stays a comment. */
function sendLabel(name: string | null): string {
  return name ? `Send to ${name}` : "Add to Comments"
}

function newRequestId(): string {
  return crypto.randomUUID().replaceAll("-", "")
}

export function VisitorCommentsPanel({
  context,
  annotations,
  onViewComment,
}: {
  context: Context
  annotations: Annotation[]
  onViewComment: (annotation: Annotation) => void
}) {
  const scrollRef = useScrollFade<HTMLDivElement>()
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null
  )
  const panelRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef(node)
      setPortalContainer(node?.closest<HTMLElement>("[role='dialog']") ?? null)
    },
    [scrollRef]
  )
  const queryClient = useQueryClient()
  const [resuming, setResuming] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [sending, setSending] = useState(false)
  const recipients = useCommentRecipients(
    context.spaceId,
    context.contributors,
    true
  )
  const recipient = useRecipient(context, recipients)
  // A send whose answer was lost is retried under the same id, so the
  // server asks the recipient once even if the first attempt went through.
  const unsettled = useRef<{ key: string; id: string } | null>(null)
  const list = useQuery({
    queryKey: visitorCommentsQueryKey(context.spaceId, context.documentId),
    queryFn: () => getVisitorComments(context.spaceId, context.documentId),
  })
  const byAnnotation = useMemo(
    () => new Map(annotations.map((annotation) => [annotation.id, annotation])),
    [annotations]
  )

  /** Send one or several comments in one go: one thread message to the recipient. */
  const send = async (
    comments: SendVisitorCommentsInput["comments"],
    to = recipient.value,
    includeName = false
  ): Promise<boolean> => {
    if (sending) return false
    setSending(true)
    const key = JSON.stringify([comments, to, includeName])
    const requestId =
      unsettled.current?.key === key ? unsettled.current.id : newRequestId()
    unsettled.current = { key, id: requestId }
    try {
      await sendVisitorComments(context.spaceId, {
        comments,
        to: to === NO_RECIPIENT ? null : to,
        includeName,
        requestId,
      })
      unsettled.current = null
      setSelected(new Set())
      const linkId = list.data?.comments.find(
        (comment) => comment.id === comments[0]?.id
      )?.linkId
      if (linkId)
        applyVisitorCommentChange(queryClient, context.spaceId, {
          documentId: context.documentId,
          linkId,
        })
      refreshLive(
        queryClient,
        [false, true].flatMap((includeResolved) => [
          {
            queryKey: annotationQueryKeys.doc(
              context.spaceId,
              context.path,
              includeResolved
            ),
            exact: true,
          },
          {
            queryKey: annotationQueryKeys.widget(
              context.spaceId,
              context.path,
              includeResolved
            ),
            exact: true,
          },
        ])
      )
      return true
    } catch (error) {
      // A refusal is settled; only an unanswered send keeps its id.
      if (error instanceof HttpError && error.status < 500)
        unsettled.current = null
      toast.error(
        error instanceof HttpError && error.status === 409
          ? error.message
          : "Couldn’t send. Try again."
      )
      return false
    } finally {
      setSending(false)
    }
  }

  // Render no cached visitor text after an authorization or availability failure.
  if (list.isError)
    return (
      <div className="space-y-3 p-4" role="alert">
        <p>Visitor comments aren’t available.</p>
        <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
          Try again
        </Button>
      </div>
    )
  if (list.isPending)
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Loading visitor comments…
      </p>
    )
  const { comments, pausedLinks } = list.data
  const fresh = comments.filter(
    (comment) => comment.status === "new" && comment.body
  )
  const earlier = comments.filter((comment) => !fresh.includes(comment))
  // Earlier comments that never reached anyone, or whose recipient isn't
  // answering, can still be sent, so the picker stays for them.
  const canSendEarlier = earlier.some((comment) => {
    if (!comment.body) return false
    if (!comment.passed) return true
    const sent = annotationSentTo(
      byAnnotation.get(comment.passed.annotationId) ?? {}
    )
    return !sent || sent.state === "failed"
  })
  const chosen = fresh.filter((comment) => selected.has(comment.id))
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const batches = activeBatches(
    earlier.flatMap((comment) => {
      const annotation = comment.passed
        ? byAnnotation.get(comment.passed.annotationId)
        : undefined
      const sent = annotation ? annotationSentTo(annotation) : null
      return sent ? [sent] : []
    })
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={panelRef}
        className="scroll-fade min-h-0 flex-1 overflow-auto px-4 pb-4"
      >
        {pausedLinks?.map((link) => (
          <Callout key={link.id} variant="warning" className="my-3">
            <div className="space-y-2">
              <p>
                Comments paused after a burst on {link.label || "Shared link"}.
              </p>
              {link.canResume && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resuming !== null}
                  onClick={async () => {
                    setResuming(link.id)
                    try {
                      await updateShareLink(link.id, {
                        comments: { acceptComments: true },
                      })
                      applyVisitorCommentChange(queryClient, context.spaceId, {
                        documentId: context.documentId,
                        linkId: link.id,
                      })
                    } catch {
                      toast.error("Couldn’t resume comments. Try again.")
                    } finally {
                      setResuming(null)
                    }
                  }}
                >
                  {resuming === link.id ? "Resuming…" : "Resume comments"}
                </Button>
              )}
            </div>
          </Callout>
        ))}
        {batches.map((batch) => (
          <div
            key={batch.name + batch.threadId}
            role="status"
            className="mt-3 flex items-center gap-2 rounded-lg bg-surface-inset px-3 py-2 text-sm"
          >
            <StateDot state={batch.state} />
            <span className="min-w-0 flex-1 truncate">
              {batch.state === "queued"
                ? `Sent ${count(batch.count)} to ${batch.name}`
                : `${batch.name} is working on ${count(batch.count)}`}
            </span>
            <Link
              to="/spaces/$spaceId/threads/$"
              params={{ spaceId: context.spaceId, _splat: batch.threadId }}
              className="shrink-0 font-medium text-primary-text hover:underline"
            >
              Open Thread
            </Link>
          </div>
        ))}
        {comments.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm font-medium">No visitor comments</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Comments from people with a link appear here. Agents can’t see
              them until you send them.
            </p>
          </div>
        ) : (
          <>
            {(fresh.length > 0 || canSendEarlier) && (
              <div className="flex items-center gap-2 pt-3">
                {recipients && (
                  <Suspense fallback={null}>
                    <CommentRecipientSelect
                      recipients={recipients}
                      value={recipient.value}
                      onChange={recipient.choose}
                    />
                  </Suspense>
                )}
                {fresh.length > 1 && (
                  <Button
                    variant="link"
                    size="sm"
                    className="ml-auto h-auto p-0"
                    onClick={() =>
                      setSelected(
                        chosen.length === fresh.length
                          ? new Set()
                          : new Set(fresh.map((comment) => comment.id))
                      )
                    }
                  >
                    {chosen.length === fresh.length ? "Clear" : "Select All"}
                  </Button>
                )}
              </div>
            )}
            <div className="divide-y divide-border">
              {fresh.map((comment) => (
                <VisitorRow
                  key={comment.id}
                  context={context}
                  comment={comment}
                  annotation={undefined}
                  recipients={recipients}
                  recipient={recipient}
                  selected={selected.has(comment.id)}
                  selecting={chosen.length > 0}
                  onSelect={(on) => toggle(comment.id, on)}
                  sending={sending}
                  onSend={send}
                  onViewComment={onViewComment}
                  portalContainer={portalContainer}
                />
              ))}
            </div>
            {earlier.length > 0 && (
              <>
                <h3 className="pt-5 pb-1 text-xs font-medium text-muted-foreground">
                  Earlier
                </h3>
                <div className="divide-y divide-border">
                  {earlier.map((comment) => (
                    <VisitorRow
                      key={comment.id}
                      context={context}
                      comment={comment}
                      annotation={
                        comment.passed
                          ? byAnnotation.get(comment.passed.annotationId)
                          : undefined
                      }
                      recipients={recipients}
                      recipient={recipient}
                      sending={sending}
                      onSend={send}
                      onViewComment={onViewComment}
                      portalContainer={portalContainer}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {chosen.length > 0 && (
        <div className="sticky bottom-0 z-10 flex shrink-0 items-center gap-2 border-t border-border bg-background px-4 py-3 xl:bg-card">
          <span className="min-w-0 flex-1 text-sm font-medium">
            {chosen.length} Selected
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={sending}
            onClick={async () => {
              setSending(true)
              try {
                for (const comment of chosen)
                  await finishVisitorComment(context.spaceId, comment.id, false)
                setSelected(new Set())
              } catch {
                toast.error("Couldn’t update these comments. Try again.")
              } finally {
                setSending(false)
                applyVisitorCommentChange(queryClient, context.spaceId, {
                  documentId: context.documentId,
                  linkId: chosen[0]!.linkId,
                })
              }
            }}
          >
            Mark Done
          </Button>
          <Button
            size="sm"
            disabled={sending}
            onClick={() =>
              void send(chosen.map((comment) => ({ id: comment.id })))
            }
          >
            {sending ? "Sending…" : sendLabel(recipient.name)}
          </Button>
        </div>
      )}
    </div>
  )
}

function count(n: number): string {
  return n === 1 ? "1 comment" : `${n} comments`
}

/**
 * Who still has comments to get to, one line each: how many, whether they
 * have started, and their latest thread.
 */
function activeBatches(sent: SentCommentRef[]) {
  const batches = new Map<
    string,
    { threadId: string; name: string; state: "queued" | "working"; count: number; at: string }
  >()
  for (const ref of sent) {
    const state = ref.state ?? "queued"
    if (state !== "queued" && state !== "working" && state !== "receiving")
      continue
    const batch = batches.get(ref.to.id)
    if (!batch) {
      batches.set(ref.to.id, {
        threadId: ref.threadId,
        name: ref.to.name,
        state: state === "queued" ? "queued" : "working",
        count: 1,
        at: ref.at,
      })
      continue
    }
    batch.count += 1
    if (state !== "queued") batch.state = "working"
    if (ref.at > batch.at) {
      batch.at = ref.at
      batch.threadId = ref.threadId
    }
  }
  return [...batches.values()].sort((a, b) => b.at.localeCompare(a.at))
}

function StateDot({ state }: { state: SentCommentRef["state"] | "done" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        state === "working" || state === "receiving"
          ? "bg-primary ring-3 ring-primary/20"
          : state === "replied" || state === "done"
            ? "bg-success"
            : state === "failed"
              ? "bg-warning"
              : "bg-muted-foreground"
      )}
    />
  )
}

/** Where a comment is now: sent, worked on, done, or stuck. */
function SentState({
  comment,
  annotation,
}: {
  comment: VisitorComment
  annotation: Annotation | undefined
}) {
  if (!comment.passed)
    return comment.status === "done" ? (
      <Badge variant="secondary">Done</Badge>
    ) : null
  const sent = annotation ? annotationSentTo(annotation) : null
  if (!sent)
    return (
      <p className="text-xs text-muted-foreground">
        Added to Comments by {comment.passed.by.name}
      </p>
    )
  const state = sent.state ?? "queued"
  const name = sent.to.name
  const text =
    state === "working" || state === "receiving"
      ? `${name} is working`
      : state === "replied"
        ? "Done"
        : state === "failed"
          ? `${name} isn’t answering`
          : `Sent to ${name}`
  return (
    <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
      <StateDot state={state} />
      {text}
    </p>
  )
}

/** The latest reply an agent left on the team's comment. */
function agentReply(annotation: Annotation | undefined) {
  return annotation?.thread
    .filter((message) => message.author.type === "agent")
    .at(-1)
}

function VisitorRow({
  context,
  comment,
  annotation,
  recipients,
  recipient,
  selected,
  selecting,
  onSelect,
  sending,
  onSend,
  onViewComment,
  portalContainer,
}: {
  context: Context
  comment: VisitorComment
  annotation: Annotation | undefined
  recipients: CommentRecipients | null
  recipient: ReturnType<typeof useRecipient>
  selected?: boolean
  /** Ticked comments are sent from the bar below, not from each row. */
  selecting?: boolean
  onSelect?: (on: boolean) => void
  sending: boolean
  onSend: (
    comments: SendVisitorCommentsInput["comments"],
    to?: string,
    includeName?: boolean
  ) => Promise<boolean>
  onViewComment: (annotation: Annotation) => void
  portalContainer: HTMLElement | null
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<"note" | "reply" | null>(null)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const refresh = () =>
    applyVisitorCommentChange(queryClient, context.spaceId, {
      documentId: context.documentId,
      linkId: comment.linkId,
    })
  const act = async (operation: () => Promise<unknown>) => {
    if (busy) return false
    setBusy(true)
    try {
      await operation()
      refresh()
      setForm(null)
      return true
    } catch {
      toast.error("Couldn’t update this comment. Try again.")
      return false
    } finally {
      setBusy(false)
    }
  }
  const isNew = comment.status === "new" && Boolean(comment.body)
  // Not sent to anyone yet, or its recipient isn't answering: it can still
  // go to someone, new, marked done, or already a team comment.
  const sent = annotation ? annotationSentTo(annotation) : null
  const sendable =
    Boolean(comment.body) &&
    (!comment.passed ||
      ((!sent || sent.state === "failed") && recipient.value !== NO_RECIPIENT))
  const reply = agentReply(annotation)
  const name = comment.body
    ? comment.visitorName || "Anonymous visitor"
    : "Visitor"
  return (
    <article
      className={cn(
        "flex gap-3 py-4",
        selected && "-mx-4 bg-surface-selected px-4"
      )}
    >
      {onSelect && (
        <Checkbox
          className="mt-0.5"
          checked={selected}
          aria-label={`Select comment from ${name}`}
          onCheckedChange={(checked) => onSelect(checked === true)}
        />
      )}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm break-words">
            <span className="font-medium">{name}</span>{" "}
            <span className="text-xs text-muted-foreground">
              <RelativeTime iso={comment.receivedAt} />
            </span>
          </p>
          {(comment.body || comment.canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-my-1.5"
                    aria-label="Visitor comment actions"
                    disabled={busy}
                  />
                }
              >
                <MoreVertical className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                container={portalContainer ?? undefined}
              >
                {sendable && !comment.passed && (
                  <DropdownMenuItem onClick={() => setForm("note")}>
                    Add Note
                  </DropdownMenuItem>
                )}
                {comment.body && (
                  <DropdownMenuItem onClick={() => setForm("reply")}>
                    Reply to Visitor
                  </DropdownMenuItem>
                )}
                {isNew && (
                  <DropdownMenuItem
                    onClick={() =>
                      void act(() =>
                        finishVisitorComment(context.spaceId, comment.id, false)
                      )
                    }
                  >
                    Mark Done
                  </DropdownMenuItem>
                )}
                {comment.canDelete && (
                  <>
                    {comment.body && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setRemoving(true)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {comment.body ? (
          <p
            className={cn(
              "text-sm break-words whitespace-pre-wrap",
              !isNew && "text-muted-foreground"
            )}
          >
            {comment.body}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Visitor text has been erased.
          </p>
        )}
        {comment.replies.map((visitorReply) => (
          <div key={visitorReply.id} className="border-l-2 border-border pl-3">
            <p className="text-xs font-medium">{visitorReply.author.name}</p>
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {visitorReply.body}
            </p>
          </div>
        ))}
        {reply && (
          <div className="border-l-2 border-border pl-3">
            <p className="line-clamp-3 text-sm break-words">
              <span className="font-medium">
                {reply.author.name ?? sent?.to.name ?? "Agent"}
              </span>{" "}
              {reply.body}
            </p>
          </div>
        )}
        {sendable && form !== "note" && !selecting && (
          <Button
            variant="outline"
            size="xs"
            disabled={sending}
            onClick={() => void onSend([{ id: comment.id }])}
          >
            {sendLabel(recipient.name)}
          </Button>
        )}
        {!isNew && (comment.passed || comment.status === "done") && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <SentState comment={comment} annotation={annotation} />
            {annotation && (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => onViewComment(annotation)}
              >
                View Comment
              </Button>
            )}
          </div>
        )}
        {form === "reply" && comment.body && (
          <ReplyForm
            busy={busy}
            onCancel={() => setForm(null)}
            onSubmit={(body) =>
              act(() => replyToVisitor(context.spaceId, comment.id, body))
            }
          />
        )}
        {form === "note" && sendable && !comment.passed && (
          <NoteForm
            comment={comment}
            recipients={recipients}
            initialRecipient={recipient.value}
            busy={sending}
            onCancel={() => setForm(null)}
            onSubmit={async (item, to, includeName) => {
              if (await onSend([item], to, includeName)) setForm(null)
            }}
          />
        )}
      </div>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Delete visitor comment?"
        description={
          comment.passed
            ? "This can’t be undone. The team’s comment remains."
            : "This can’t be undone."
        }
        variant="destructive"
        confirmLabel="Delete"
        loading={busy}
        loadingLabel="Deleting…"
        onConfirm={async () => {
          if (
            await act(() =>
              finishVisitorComment(context.spaceId, comment.id, true)
            )
          )
            setRemoving(false)
        }}
      />
    </article>
  )
}

function ReplyForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  onSubmit: (body: string) => Promise<boolean>
  onCancel: () => void
}) {
  const [body, setBody] = useState("")
  const id = useId()
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (body.trim()) void onSubmit(body.trim())
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Reply to visitor
      </label>
      <Textarea
        id={id}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={VISITOR_COMMENT_MAX_LENGTH}
        disabled={busy}
      />
      <p className="text-xs text-muted-foreground">
        Replies appear on this link with the visitor’s comment.
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !body.trim()}>
          {busy ? "Sending…" : "Reply"}
        </Button>
      </div>
    </form>
  )
}

/** A note for the team with the comment, a trimmed quote, and the visitor's name if wanted. */
function NoteForm({
  comment,
  recipients,
  initialRecipient,
  busy,
  onSubmit,
  onCancel,
}: {
  comment: VisitorComment
  recipients: CommentRecipients | null
  initialRecipient: string
  busy: boolean
  onSubmit: (
    item: SendVisitorCommentsInput["comments"][number],
    to: string,
    includeName: boolean
  ) => Promise<void>
  onCancel: () => void
}) {
  const [to, setTo] = useState(initialRecipient)
  const [note, setNote] = useState("")
  const [quote, setQuote] = useState(comment.body ?? "")
  const [editingQuote, setEditingQuote] = useState(false)
  const [includeName, setIncludeName] = useState(false)
  const id = useId()
  const name =
    recipients?.options.find((option) => option.id === to)?.name ?? null
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (quote.trim())
          void onSubmit(
            {
              id: comment.id,
              ...(note.trim() ? { note: note.trim() } : {}),
              ...(quote.trim() !== comment.body ? { quote: quote.trim() } : {}),
            },
            to,
            includeName
          )
      }}
    >
      <fieldset disabled={busy} className="space-y-3">
        <div className="space-y-2">
          <label htmlFor={`${id}-note`} className="text-sm font-medium">
            Note
          </label>
          <Textarea
            id={`${id}-note`}
            value={note}
            autoFocus
            onChange={(event) => setNote(event.target.value)}
            maxLength={10_000}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${id}-quote`} className="text-sm font-medium">
              Outside input, unverified
            </label>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setEditingQuote((value) => !value)}
            >
              {editingQuote ? "Keep Quote" : "Edit Quote"}
            </Button>
          </div>
          {editingQuote ? (
            <Textarea
              id={`${id}-quote`}
              value={quote}
              onChange={(event) => setQuote(event.target.value)}
              maxLength={VISITOR_COMMENT_MAX_LENGTH}
            />
          ) : (
            <Quote className="whitespace-pre-wrap">{quote}</Quote>
          )}
        </div>
        {comment.visitorName && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={includeName}
              onCheckedChange={(checked) => setIncludeName(checked === true)}
            />
            Include visitor’s name
          </label>
        )}
        {recipients && (
          <div className="-my-1 flex">
            <Suspense fallback={null}>
              <CommentRecipientSelect
                recipients={recipients}
                value={to}
                onChange={setTo}
              />
            </Suspense>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!quote.trim()}>
            {busy ? "Sending…" : sendLabel(name)}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
