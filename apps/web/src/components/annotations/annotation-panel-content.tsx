import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowUp,
  CheckCircle2,
  Circle,
  MessageSquareText,
  X,
} from "lucide-react"
import type { Annotation } from "@worktable/types"
import { Badge } from "@worktable/ui/components/badge"
import { Button } from "@worktable/ui/components/button"
import { Textarea } from "@worktable/ui/components/textarea"
import { cn } from "@worktable/ui/lib/utils"
import { ContextPanelHeader } from "@/components/desktop-context-panel"
import { Quote } from "@/components/quote"
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

/** Who the comment went to, and how far each of them has got with it. */
function recipientsLine(annotation: Annotation, selfId?: string): string | null {
  const latest = new Map<string, CommentRequest>();
  for (const request of annotation.requests ?? []) latest.set(request.to.id, request);
  const requests = [...latest.values()].filter((request) => request.status !== "withdrawn");
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
  onReply: (annotationId: string, body: string) => void
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
          {showResolved ? "Hide resolved" : "Show resolved"}
        </Button>
        {onCompose && !readOnly && (
          <Button size="xs" variant="outline" onClick={(event) => onCompose(event.currentTarget)}>
            <MessageSquareText className="size-3.5" />
            {composeLabel ?? "Add comment"}
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="scroll-fade min-h-0 flex-1 overflow-auto px-2 pb-3">
        {visible.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border p-6 text-center">
            <MessageSquareText className="mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No open comments</p>
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
  onReply: (body: string) => void
}) {
  const [reply, setReply] = useState("");
  const isResolved = annotation.status === "resolved";
  const selfId = useWorkspace().data?.person?.id;
  const recipients = recipientsLine(annotation, selfId);
  const meta = [isResolved ? "Resolved" : null, recipients].filter(Boolean).join(" · ");
  // A comment chosen from its passage comes into view in the panel.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  return (
    <article
      ref={ref}
      className={cn(
        "rounded-lg px-3 py-3 transition-colors",
        active ? "comment-selected" : "hover:bg-surface-hover"
      )}
    >
      <button type="button" onClick={onSelect} className="w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {meta && <p className="mb-2 text-xs text-muted-foreground">{meta}</p>}
        {annotation.title && (
          <h3 className="mb-1 text-sm font-medium text-foreground">
            {annotation.title}
          </h3>
        )}
        {"quote" in annotation.target && annotation.target.quote && (
          <div className="mb-1.5">
            <Quote className="line-clamp-3 text-xs">{annotation.target.quote}</Quote>
            {detached && (
              <p className="mt-1 text-[11px] text-muted-foreground">This text has changed since.</p>
            )}
          </div>
        )}
        <p className="text-sm whitespace-pre-wrap text-foreground/90">
          {annotation.body}
        </p>
      </button>

      {annotation.thread.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {annotation.thread.map((message) => (
            <div
              key={message.id}
              className="border-l-2 border-border/70 py-1 pl-3"
            >
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                {message.author.name ?? message.author.id}
              </div>
              <p className="text-xs whitespace-pre-wrap text-foreground/80">
                {message.body}
              </p>
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="mt-3 flex items-center gap-2">
          {isResolved ? (
            <Button size="sm" variant="outline" onClick={onReopen}>
              <Circle className="mr-1.5 h-3.5 w-3.5" />
              Reopen
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onResolve}>
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              Resolve
            </Button>
          )}
        </div>
      )}

      {!isResolved && canReply && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = reply.trim();
            if (!trimmed) return;
            onReply(trimmed);
            setReply("");
          }}
        >
          <Textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            placeholder="Reply..."
            className="min-h-9 flex-1 resize-none text-xs"
          />
          <Button size="icon" type="submit" className="shrink-0 rounded-full" aria-label="Send reply">
            <ArrowUp className="h-4 w-4" />
          </Button>
        </form>
      )}
    </article>
  );
}
