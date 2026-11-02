import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Check,
  MessageSquareText,
  Reply,
  RotateCcw,
  X,
} from "lucide-react"
import type { Annotation } from "@worktable/types"
import { Badge } from "@worktable/ui/components/badge"
import { Button } from "@worktable/ui/components/button"
import { InfoTip } from "@worktable/ui/components/info-tip"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { cn } from "@worktable/ui/lib/utils"
import { Composer } from "@/components/composer"
import { ContextPanelHeader } from "@/components/desktop-context-panel"
import { Quote } from "@/components/quote"
import { CommentMessage } from "./comment-message"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useWorkspace } from "@/lib/queries"

type CommentRequest = NonNullable<Annotation["requests"]>[number];

/** Where each recipient is with the comment, as far as Worktable knows. */
function requestState(request: CommentRequest): "sent" | "delivered" | "read" | "replied" {
  if (request.status === "replied") return "replied";
  if (request.readAt) return "read";
  return request.deliveredAt ? "delivered" : "sent";
}

const STATE_LABEL = {
  sent: (names: string) => `To ${names}`,
  delivered: (names: string) => `Delivered to ${names}`,
  read: (names: string) => `Read by ${names}`,
  replied: (names: string) => `Replied by ${names}`,
};

function openRequests(annotation: Annotation): CommentRequest[] {
  const latest = new Map<string, CommentRequest>();
  for (const request of annotation.requests ?? []) latest.set(request.to.id, request);
  return [...latest.values()].filter((request) => request.status !== "withdrawn");
}

/**
 * Agents that haven't been shown the comment yet. One that answers on its own
 * is shown it at once, so these see it when they next work in its Space.
 */
function agentsNotShown(annotation: Annotation): string[] {
  return openRequests(annotation)
    .filter((request) => request.to.kind === "agent" && requestState(request) === "sent")
    .map((request) => request.to.name);
}

/** Who the comment went to, and how far each of them has got with it. */
function recipientsLine(annotation: Annotation, selfId?: string): string | null {
  const requests = openRequests(annotation);
  if (requests.length === 0) return null;
  return (["sent", "delivered", "read", "replied"] as const)
    .map((state) => {
      const names = requests
        .filter((request) => requestState(request) === state)
        .map((request) => (request.to.id === selfId ? "you" : request.to.name));
      return names.length ? STATE_LABEL[state](names.join(", ")) : null;
    })
    .filter(Boolean)
    .join(" · ");
}

export interface AnnotationPanelContentProps {
  header?: ReactNode
  /** Can't resolve, reopen or add comments from the panel. */
  readOnly?: boolean
  /** May reply; with Teams a viewer may. Defaults to not readOnly. */
  canReply?: boolean
  annotations: Annotation[]
  activeAnnotationId?: string | null
  onSelectAnnotation: (annotation: Annotation) => void
  onResolve: (annotationId: string) => void
  onReopen: (annotationId: string) => void
  /** Sends a reply; the box keeps the text until it's saved. */
  onReply: (annotationId: string, body: string) => Promise<unknown>
  onClose?: () => void
  /** When provided, renders a compose button under the header (used where there
   *  is no editor to attach annotations from — e.g. the HTML doc route). */
  onCompose?: (trigger: HTMLElement) => void;
  composeLabel?: string;
  /** Overrides the empty-state hint for surfaces without a block editor. */
  emptyHint?: string;
  /** Comments whose passage is no longer in the Doc. */
  detachedIds?: ReadonlySet<string>;
  className?: string;
}

export function AnnotationPanelContent({
  header,
  readOnly = false,
  canReply = !readOnly,
  annotations,
  activeAnnotationId,
  onSelectAnnotation,
  onResolve,
  onReopen,
  onReply,
  onClose,
  onCompose,
  composeLabel,
  emptyHint,
  detachedIds,
  className,
}: AnnotationPanelContentProps) {
  const [showResolved, setShowResolved] = useState(false);
  const scrollRef = useScrollFade<HTMLDivElement>();
  const visible = useMemo(
    () => annotations.filter((annotation) => showResolved || annotation.status !== "resolved"),
    [annotations, showResolved]
  );
  const openCount = annotations.filter((annotation) => annotation.status !== "resolved").length;

  return (
    <aside className={cn("flex h-full min-h-0 w-full flex-col bg-transparent", className)}>
      {header !== undefined ? header : <ContextPanelHeader
        title="Comments"
        icon={<MessageSquareText className="size-4 shrink-0 text-primary" />}
        meta={<Badge variant="secondary">{openCount} open</Badge>}
        actions={
          onClose && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onClose}
              aria-label="Close comments"
            >
              <X className="size-4" />
            </Button>
          )
        }
      />}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pb-2">
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={showResolved}
          onClick={() => setShowResolved((value) => !value)}
        >
          {showResolved ? "Hide Resolved" : "Show Resolved"}
        </Button>
        {onCompose && !readOnly && (
          <Button size="xs" variant="outline" onClick={(event) => onCompose(event.currentTarget)}>
            <MessageSquareText className="size-3.5" />
            {composeLabel ?? "Add Comment"}
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="scroll-fade min-h-0 flex-1 overflow-auto px-2 pb-3">
        {visible.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border p-6 text-center">
            <MessageSquareText className="mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No Open Comments</p>
            {emptyHint !== "" && <p className="mt-1 text-xs text-muted-foreground">{emptyHint ?? "Use /comment in the editor to attach context to a block."}</p>}
          </div>
        ) : (
          <div className="space-y-1">
            {visible.map((annotation) => (
              <AnnotationCard
                key={annotation.id}
                readOnly={readOnly}
                canReply={canReply}
                annotation={annotation}
                detached={detachedIds?.has(annotation.id) ?? false}
                active={annotation.id === activeAnnotationId}
                onSelect={() => onSelectAnnotation(annotation)}
                onResolve={() => onResolve(annotation.id)}
                onReopen={() => onReopen(annotation.id)}
                onReply={(body) => onReply(annotation.id, body)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function AnnotationCard({
  readOnly,
  canReply,
  annotation,
  detached,
  active,
  onSelect,
  onResolve,
  onReopen,
  onReply,
}: {
  readOnly?: boolean
  canReply: boolean
  annotation: Annotation
  detached: boolean
  active: boolean
  onSelect: () => void
  onResolve: () => void
  onReopen: () => void
  onReply: (body: string) => Promise<unknown>
}) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [replying, setReplying] = useState(false);
  const [allReplies, setAllReplies] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const isResolved = annotation.status === "resolved";
  const selfId = useWorkspace().data?.person?.id;
  const recipients = recipientsLine(annotation, selfId);
  const notShown = isResolved ? [] : agentsNotShown(annotation);
  // Replying to a resolved comment opens it again, which needs the right to.
  const mayReply = canReply && (!isResolved || !readOnly);
  // The box shows on the comment being looked at, or once Reply is pressed.
  const showReply = mayReply && (active || replying || reply.trim() !== "");
  const quote = "quote" in annotation.target ? annotation.target.quote : undefined;
  const replies = annotation.thread;
  const hidden = allReplies || replies.length <= 3 ? 0 : replies.length - 2;
  // A comment chosen from its passage comes into view in the panel.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  const send = () => {
    const trimmed = reply.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setFailed(false);
    onReply(trimmed)
      .then(
        () => {
          // Text written while it sent stays to send next.
          setReply((current) => (current.trim() === trimmed ? "" : current));
          setReplying(false);
          if (isResolved) onReopen();
        },
        () => setFailed(true)
      )
      .finally(() => setSending(false));
  };

  return (
    <article
      ref={ref}
      aria-label={`Comment by ${annotation.author.name ?? "someone"}`}
      onClick={(event) => {
        // Pressing the comment, not one of its controls, shows its passage.
        if (!(event.target as Element).closest("a, button, textarea")) onSelect();
      }}
      className={cn(
        "space-y-3 rounded-lg px-3 py-3 transition-colors",
        active ? "comment-selected" : "hover:bg-surface-hover",
        isResolved && !active && "opacity-75"
      )}
    >
      {quote && (
        <button
          type="button"
          onClick={onSelect}
          className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Quote className="line-clamp-2 text-xs">{quote}</Quote>
          {detached && (
            <span className="mt-1 block text-[11px] text-muted-foreground">
              This text has changed since.
            </span>
          )}
        </button>
      )}
      <CommentMessage
        id={annotation.id}
        author={annotation.author}
        body={annotation.body}
        createdAt={annotation.createdAt}
        title={annotation.title}
        actions={
          !readOnly &&
          (isResolved ? (
            <IconAction label="Reopen" onClick={onReopen}>
              <RotateCcw />
            </IconAction>
          ) : (
            <IconAction label="Resolve" onClick={onResolve}>
              <Check />
            </IconAction>
          ))
        }
      >
        {(recipients || isResolved) && (
          <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
            {[isResolved ? "Resolved" : null, recipients].filter(Boolean).join(" · ")}
            {notShown.length > 0 && (
              <InfoTip label="When they see it" className="size-6">
                <p>
                  {notShown.length === 1
                    ? `${notShown[0]} sees this when it next works in this Space.`
                    : `${notShown.join(", ")} see this when they next work in this Space.`}
                </p>
              </InfoTip>
            )}
          </p>
        )}
      </CommentMessage>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAllReplies(true)}
          className="ms-8 rounded-sm text-xs font-medium text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {hidden === 1 ? "1 More Reply" : `${hidden} More Replies`}
        </button>
      )}
      {replies.slice(hidden).map((message) => (
        <CommentMessage
          key={message.id}
          id={message.id}
          author={message.author}
          body={message.body}
          createdAt={message.createdAt}
        />
      ))}

      {showReply ? (
        <div className="ps-8">
          <Composer
            ref={replyRef}
            value={reply}
            onChange={setReply}
            onSubmit={send}
            pending={sending}
            error={failed ? "Couldn't send the reply." : undefined}
            placeholder={replyPlaceholder(annotation, selfId)}
            label="Reply"
            sendLabel="Send reply"
            size="inline"
            placement="inline"
          />
        </div>
      ) : (
        mayReply && (
          <button
            type="button"
            className="ms-8 -mt-1 flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setReplying(true);
              requestAnimationFrame(() => replyRef.current?.focus());
            }}
          >
            <Reply className="size-3.5" />
            Reply
          </button>
        )
      )}
    </article>
  );
}

/** Names who a reply goes to when it goes to an agent that answered. */
function replyPlaceholder(annotation: Annotation, selfId?: string): string {
  const agents = openRequests(annotation)
    .filter((request) => request.to.kind === "agent" && request.to.id !== selfId)
    .map((request) => request.to.name);
  return agents.length === 1 ? `Reply to ${agents[0]}…` : "Reply…";
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            onClick={onClick}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
