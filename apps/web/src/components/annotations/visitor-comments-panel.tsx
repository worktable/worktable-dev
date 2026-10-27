import { Suspense, lazy, useCallback, useId, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { MoreVertical } from "lucide-react"
import type {
  Annotation,
  PassVisitorCommentInput,
  VisitorComment,
} from "@worktable/types"
import { VISITOR_COMMENT_MAX_LENGTH } from "@worktable/types"
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
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { annotationQueryKeys } from "@/lib/annotations-queries"
import { refreshLive } from "@/lib/live-refresh"
import {
  applyVisitorCommentChange,
  visitorCommentsQueryKey,
} from "@/lib/visitor-comment-events"
import {
  finishVisitorComment,
  getVisitorComments,
  passVisitorToTeam,
  replyToVisitor,
} from "@/lib/visitor-comments-api"
import { updateShareLink } from "@/lib/share-link-management-api"
import type { AnnotationPanelProps } from "./annotation-panel"
import { Quote } from "@/components/quote"
import { NO_RECIPIENT, useCommentRecipients } from "@/lib/comment-recipients"

// Only loads where comments can be sent to someone (Preview agent tools).
const CommentRecipientSelect = lazy(() =>
  import("./comment-recipient").then((module) => ({
    default: module.CommentRecipientSelect,
  }))
)

type Context = NonNullable<AnnotationPanelProps["visitorComments"]>

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
  const list = useQuery({
    queryKey: visitorCommentsQueryKey(context.spaceId, context.documentId),
    queryFn: () => getVisitorComments(context.spaceId, context.documentId),
  })
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
  return (
    <div
      ref={panelRef}
      className="scroll-fade h-full min-h-0 overflow-auto px-4 pb-4"
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
      {comments.length ? (
        <div className="divide-y divide-border">
          {comments.map((comment) => (
            <VisitorRow
              key={comment.id}
              context={context}
              comment={comment}
              annotations={annotations}
              onViewComment={onViewComment}
              portalContainer={portalContainer}
            />
          ))}
        </div>
      ) : (
        <div className="py-8 text-center">
          <p className="text-sm font-medium">No visitor comments</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Comments from people with a link appear here. Agents can’t see them
            until you pass one to the team.
          </p>
        </div>
      )}
    </div>
  )
}

function VisitorRow({
  context,
  comment,
  annotations,
  onViewComment,
  portalContainer,
}: {
  context: Context
  comment: VisitorComment
  annotations: Annotation[]
  onViewComment: (annotation: Annotation) => void
  portalContainer: HTMLElement | null
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<"pass" | "reply" | null>(null)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [passed, setPassed] = useState<Annotation | null>(null)
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
  const annotation =
    passed ??
    annotations.find(
      (annotation) => annotation.id === comment.passed?.annotationId
    )
  return (
    <article className="space-y-3 py-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words">
            {comment.body
              ? (comment.visitorName ?? "Anonymous visitor")
              : "Visitor"}
          </p>
          <p className="text-xs break-words text-muted-foreground">
            via {comment.linkLabel || "Shared link"}
          </p>
        </div>
        <Badge variant="outline">Unverified</Badge>
        {(comment.body || comment.canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
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
              {comment.body && (
                <DropdownMenuItem onClick={() => setForm("reply")}>
                  Reply
                </DropdownMenuItem>
              )}
              {comment.body && comment.status === "new" && (
                <DropdownMenuItem
                  onClick={() =>
                    void act(() =>
                      finishVisitorComment(context.spaceId, comment.id, false)
                    )
                  }
                >
                  Mark done
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
      <time
        className="block text-xs text-muted-foreground"
        dateTime={comment.receivedAt}
      >
        {new Date(comment.receivedAt).toLocaleString()}
      </time>
      {comment.body ? (
        <p className="text-sm break-words whitespace-pre-wrap">
          {comment.body}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Visitor text has been erased.
        </p>
      )}
      {comment.replies.map((reply) => (
        <div key={reply.id} className="border-l-2 border-border pl-3">
          <p className="text-xs font-medium">{reply.author.name}</p>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap">
            {reply.body}
          </p>
        </div>
      ))}
      {comment.passed ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Passed by {comment.passed.by.name}</p>
          {annotation && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => onViewComment(annotation)}
            >
              View comment
            </Button>
          )}
        </div>
      ) : (
        comment.body && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setForm(form === "pass" ? null : "pass")}
            >
              Pass to Team
            </Button>
            {comment.status === "done" && (
              <Badge variant="secondary">Done</Badge>
            )}
          </div>
        )
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
      {form === "pass" && comment.body && (
        <PassForm
          spaceId={context.spaceId}
          comment={comment}
          busy={busy}
          onCancel={() => setForm(null)}
          onSubmit={(input) =>
            act(async () => {
              const result = await passVisitorToTeam(
                context.spaceId,
                comment.id,
                input
              )
              setPassed(result.annotation)
              const target = result.annotation.target
              const key =
                target.type === "widget"
                  ? annotationQueryKeys.widget
                  : annotationQueryKeys.doc
              refreshLive(
                queryClient,
                [false, true].map((includeResolved) => ({
                  queryKey: key(context.spaceId, context.path, includeResolved),
                  exact: true,
                }))
              )
            })
          }
        />
      )}
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

function PassForm({
  spaceId,
  comment,
  busy,
  onSubmit,
  onCancel,
}: {
  spaceId: string
  comment: VisitorComment
  busy: boolean
  onSubmit: (input: PassVisitorCommentInput) => Promise<boolean>
  onCancel: () => void
}) {
  const recipients = useCommentRecipients(spaceId, undefined, true)
  const [recipient, setRecipient] = useState(NO_RECIPIENT)
  const [note, setNote] = useState("")
  const [quote, setQuote] = useState(comment.body ?? "")
  const [editingQuote, setEditingQuote] = useState(false)
  const [includeName, setIncludeName] = useState(false)
  const id = useId()
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (note.trim() && quote.trim())
          void onSubmit({
            ...(recipients && recipient !== NO_RECIPIENT
              ? { to: [recipient] }
              : {}),
            note: note.trim(),
            quote: quote.trim(),
            includeName,
          })
      }}
    >
      <fieldset disabled={busy} className="space-y-3">
        <div className="space-y-2">
          <label htmlFor={`${id}-note`} className="text-sm font-medium">
            What should happen?
          </label>
          <Textarea
            id={`${id}-note`}
            value={note}
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
              {editingQuote ? "Keep quote" : "Edit quote"}
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
                value={recipient}
                onChange={setRecipient}
              />
            </Suspense>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!note.trim() || !quote.trim()}
          >
            {busy ? "Passing…" : "Pass to Team"}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
