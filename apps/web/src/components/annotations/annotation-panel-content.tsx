import { useMemo, useRef, useState, type ReactNode } from "react"
import {
  Check,
  ChevronLeft,
  MessageSquareText,
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
import { RelativeTime } from "@/lib/time"
import { authorName } from "./comment-author"
import { CommentAvatar, CommentMessage } from "./comment-message"
import { ThreadMarkdownProvider } from "@/components/threads/thread-markdown"
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
  /** Back from a comment to the list: lets go of the one chosen. */
  onDeselectAnnotation?: () => void
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
  onDeselectAnnotation,
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
  // The comment shown in full. Choosing a comment's passage in the Doc opens
  // it; Back returns to the list.
  const active = activeAnnotationId ?? null;
  const [openId, setOpenId] = useState<string | null>(active);
  const [seenActive, setSeenActive] = useState<string | null>(active);
  if (active !== seenActive) {
    setSeenActive(active);
    if (active) setOpenId(active);
  }
  const thread = openId
    ? annotations.find((annotation) => annotation.id === openId)
    : undefined;
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
      {thread ? (
        <CommentThread
          key={thread.id}
          annotation={thread}
          readOnly={readOnly}
          canReply={canReply}
          detached={detachedIds?.has(thread.id) ?? false}
          onBack={() => {
            setOpenId(null);
            onDeselectAnnotation?.();
          }}
          onSelect={() => onSelectAnnotation(thread)}
          onResolve={() => onResolve(thread.id)}
          onReopen={() => onReopen(thread.id)}
          onReply={(body) => onReply(thread.id, body)}
        />
      ) : (
        <>
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
              <ul className="space-y-0.5">
                {visible.map((annotation) => (
                  <li key={annotation.id}>
                    <ThreadRow
                      annotation={annotation}
                      detached={detachedIds?.has(annotation.id) ?? false}
                      onOpen={() => {
                        setOpenId(annotation.id);
                        onSelectAnnotation(annotation);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

interface ThreadMessageLike {
  id: string
  author: Annotation["author"]
  body: string
  createdAt: string
}

/** The comment and its replies, in order. */
function messagesOf(annotation: Annotation): ThreadMessageLike[] {
  return [
    {
      id: annotation.id,
      author: annotation.author,
      body: annotation.body,
      createdAt: annotation.createdAt,
    },
    ...annotation.thread,
  ];
}

/** A message as one line of plain text, for the list. */
function previewText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What an agent the comment went to is doing with it, while it is. */
function agentStatus(annotation: Annotation): string | null {
  if (annotation.status === "resolved") return null;
  const waiting = openRequests(annotation).filter(
    (request) => request.to.kind === "agent" && requestState(request) !== "replied"
  );
  const working = waiting.find((request) => requestState(request) === "read");
  if (working) return `${working.to.name} is working…`;
  const sent = waiting[0];
  return sent ? `Sent to ${sent.to.name}` : null;
}

/**
 * One comment in the list: its passage, the latest message and who is in
 * it. Opening it shows the whole conversation.
 */
function ThreadRow({
  annotation,
  detached,
  onOpen,
}: {
  annotation: Annotation
  detached: boolean
  onOpen: () => void
}) {
  const quote = "quote" in annotation.target ? annotation.target.quote : undefined;
  const messages = messagesOf(annotation);
  const latest = messages[messages.length - 1]!;
  const people = [
    ...new Map(messages.map((message) => [message.author.id, message.author])).values(),
  ].slice(0, 3);
  const replies = annotation.thread.length;
  const status = agentStatus(annotation);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "grid w-full gap-1.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring",
        annotation.status === "resolved" && "opacity-70"
      )}
    >
      {quote ? (
        <span
          className={cn(
            "quoted block truncate text-xs",
            detached && "line-through decoration-muted-foreground/50"
          )}
        >
          {quote}
        </span>
      ) : (
        annotation.title && (
          <span className="block truncate text-sm font-medium text-foreground">
            {annotation.title}
          </span>
        )
      )}
      <span className="flex items-start gap-2">
        <CommentAvatar author={latest.author} />
        <span className="line-clamp-2 min-w-0 pt-0.5 text-[0.84375rem] leading-5 text-foreground/85">
          <span className="font-medium text-foreground">{authorName(latest.author)}</span>{" "}
          <span>{previewText(latest.body)}</span>
        </span>
      </span>
      <span className="flex min-h-5 items-center gap-2 ps-8 text-xs text-muted-foreground">
        {status ? (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-accent-bronze" aria-hidden />
            {status}
          </>
        ) : (
          <>
            {people.length > 1 && (
              <span className="flex" aria-hidden>
                {people.map((author) => (
                  <CommentAvatar
                    key={author.id}
                    author={author}
                    className="-ms-1 size-[1.125rem] text-[0.5rem] outline-2 outline-card first:ms-0"
                  />
                ))}
              </span>
            )}
            {annotation.status === "resolved" && <span>Resolved ·</span>}
            {replies > 0 && <span>{replies === 1 ? "1 reply" : `${replies} replies`} ·</span>}
            <RelativeTime iso={latest.createdAt} />
          </>
        )}
      </span>
    </button>
  );
}

/** A comment in full, with every reply and the box to answer it. */
function CommentThread({
  annotation,
  readOnly,
  canReply,
  detached,
  onBack,
  onSelect,
  onResolve,
  onReopen,
  onReply,
}: {
  annotation: Annotation
  readOnly: boolean
  canReply: boolean
  detached: boolean
  onBack: () => void
  onSelect: () => void
  onResolve: () => void
  onReopen: () => void
  onReply: (body: string) => Promise<unknown>
}) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [allReplies, setAllReplies] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useScrollFade<HTMLDivElement>();
  const isResolved = annotation.status === "resolved";
  const selfId = useWorkspace().data?.person?.id;
  const recipients = recipientsLine(annotation, selfId);
  const notShown = isResolved ? [] : agentsNotShown(annotation);
  // Replying to a resolved comment opens it again, which needs the right to.
  const mayReply = canReply && (!isResolved || !readOnly);
  const quote = "quote" in annotation.target ? annotation.target.quote : undefined;
  const replies = annotation.thread;
  // Links in messages resolve in the comment's Space, as in a Thread there.
  const location = useMemo(
    () => ({ kind: "space" as const, spaceId: annotation.spaceId }),
    [annotation.spaceId]
  );
  // A long conversation opens on its latest replies.
  const hidden = allReplies || replies.length <= 6 ? 0 : replies.length - 3;

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
          if (isResolved) onReopen();
        },
        () => setFailed(true)
      )
      .finally(() => setSending(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
        <Button size="xs" variant="ghost" onClick={onBack}>
          <ChevronLeft className="size-4" />
          All Comments
        </Button>
        {!readOnly && (
          <span className="ms-auto">
            {isResolved ? (
              <IconAction label="Reopen" onClick={onReopen}>
                <RotateCcw />
              </IconAction>
            ) : (
              <IconAction label="Resolve" onClick={onResolve}>
                <Check />
              </IconAction>
            )}
          </span>
        )}
      </div>
      <ThreadMarkdownProvider location={location} mentionNames={NO_MENTIONS}>
      <article
        ref={scrollRef}
        aria-label={`Comment by ${authorName(annotation.author)}`}
        className="scroll-fade min-h-0 flex-1 space-y-4 overflow-auto px-4 pt-1 pb-4"
      >
        {quote && (
          <button
            type="button"
            onClick={onSelect}
            className="block w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Quote
              className={cn(
                "text-xs",
                detached && "line-through decoration-muted-foreground/50"
              )}
            >
              {quote}
            </Quote>
          </button>
        )}
        <CommentMessage
          id={annotation.id}
          author={annotation.author}
          body={annotation.body}
          createdAt={annotation.createdAt}
          title={annotation.title}
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
            {hidden === 1 ? "1 Earlier Reply" : `${hidden} Earlier Replies`}
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
      </article>
      </ThreadMarkdownProvider>
      {mayReply && (
        <div className="shrink-0 border-t border-border px-3 pt-2.5 pb-3">
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
      )}
    </div>
  );
}

const NO_MENTIONS: string[] = [];

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
