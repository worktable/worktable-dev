import { useMemo, useState } from "react"
import {
  ArrowUp,
  CheckCircle2,
  Circle,
  MessageSquareText,
  Sparkles,
  X,
} from "lucide-react"
import type { Annotation, AnnotationCategory } from "@worktable/types"
import { Badge } from "@worktable/ui/components/badge"
import { Button } from "@worktable/ui/components/button"
import { Textarea } from "@worktable/ui/components/textarea"
import { cn } from "@worktable/ui/lib/utils"
import { ContextPanelHeader } from "@/components/desktop-context-panel"
import { useScrollFade } from "@/hooks/use-scroll-fade"

const categoryLabel: Record<AnnotationCategory, string> = {
  comment: "Comment",
  instruction: "Instruction",
};

function categoryVariant(category: AnnotationCategory): "default" | "secondary" | "outline" | "destructive" {
  if (category === "instruction") return "default";
  return "outline";
}

export interface AnnotationPanelProps {
  readOnly?: boolean
  annotations: Annotation[]
  activeAnnotationId?: string | null
  onSelectAnnotation: (annotation: Annotation) => void
  onResolve: (annotationId: string) => void
  onReopen: (annotationId: string) => void
  onReply: (annotationId: string, body: string) => void
  onClose?: () => void
  /** When provided, renders a compose button under the header (used where there
   *  is no editor to attach annotations from — e.g. the HTML doc route). */
  onCompose?: () => void;
  composeLabel?: string;
  /** Overrides the empty-state hint for surfaces without a block editor. */
  emptyHint?: string;
  className?: string;
}

export function AnnotationPanel({
  readOnly = false,
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
  className,
}: AnnotationPanelProps) {
  const [showResolved, setShowResolved] = useState(false);
  const scrollRef = useScrollFade<HTMLDivElement>();
  const visible = useMemo(
    () => annotations.filter((annotation) => showResolved || annotation.status !== "resolved"),
    [annotations, showResolved]
  );
  const openCount = annotations.filter((annotation) => annotation.status !== "resolved").length;

  return (
    <aside className={cn("flex h-full min-h-0 w-full flex-col bg-transparent", className)}>
      <ContextPanelHeader
        title="Annotations"
        icon={<MessageSquareText className="size-4 shrink-0 text-primary" />}
        meta={<Badge variant="secondary">{openCount} open</Badge>}
        actions={
          onClose && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onClose}
              aria-label="Close annotations"
            >
              <X className="size-4" />
            </Button>
          )
        }
      />
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
          <Button size="xs" variant="outline" onClick={onCompose}>
            <MessageSquareText className="size-3.5" />
            {composeLabel ?? "Add comment"}
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="scroll-fade min-h-0 flex-1 overflow-auto px-2 pb-3">
        {visible.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border p-6 text-center">
            <MessageSquareText className="mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No open annotations</p>
            <p className="mt-1 text-xs text-muted-foreground">{emptyHint ?? "Use /comment or /instruction in the editor to attach context to a block."}</p>
          </div>
        ) : (
          <div className="space-y-1">
            {visible.map((annotation) => (
              <AnnotationCard
                key={annotation.id}
                readOnly={readOnly}
                annotation={annotation}
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
  annotation,
  active,
  onSelect,
  onResolve,
  onReopen,
  onReply,
}: {
  readOnly?: boolean
  annotation: Annotation
  active: boolean
  onSelect: () => void
  onResolve: () => void
  onReopen: () => void
  onReply: (body: string) => void
}) {
  const [reply, setReply] = useState("");
  const isResolved = annotation.status === "resolved";
  const blockLabel =
    "blockId" in annotation.target && annotation.target.blockId
      ? annotation.target.blockId.slice(0, 8)
      : annotation.target.type === "widget"
        ? "html doc"
        : "doc";

  return (
    <article
      className={cn(
        "rounded-lg px-3 py-3 transition-colors",
        active ? "bg-surface-selected" : "hover:bg-surface-hover"
      )}
    >
      <button type="button" onClick={onSelect} className="w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Badge variant={categoryVariant(annotation.category)}>
            {annotation.category === "instruction" && (
              <Sparkles className="h-3 w-3" />
            )}
            {categoryLabel[annotation.category]}
          </Badge>
          <Badge variant="outline">{annotation.status}</Badge>
          <span className="ml-auto text-[11px] text-muted-foreground">{blockLabel}</span>
        </div>
        {annotation.title && (
          <h3 className="mb-1 text-sm font-medium text-foreground">
            {annotation.title}
          </h3>
        )}
        {"quote" in annotation.target && annotation.target.quote && (
          <div className="mb-1.5 border-l-2 border-border pl-2">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Commenting on
            </span>
            <p className="line-clamp-3 text-xs text-muted-foreground italic">
              {annotation.target.quote}
            </p>
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

      {!isResolved && !readOnly && (
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
