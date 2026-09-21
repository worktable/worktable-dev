import { useMemo, useState } from "react";
import { ArrowUp, CheckCircle2, Circle, MessageSquareText, Sparkles, X } from "lucide-react";
import type { Annotation, AnnotationCategory } from "@worktable/types";
import { Badge } from "@worktable/ui/components/badge";
import { Button } from "@worktable/ui/components/button";
import { Textarea } from "@worktable/ui/components/textarea";
import { cn } from "@worktable/ui/lib/utils";
import { useScrollFade } from "@/hooks/use-scroll-fade";

const categoryLabel: Record<AnnotationCategory, string> = {
  comment: "Comment",
  instruction: "Instruction",
};

function categoryVariant(category: AnnotationCategory): "default" | "secondary" | "outline" | "destructive" {
  if (category === "instruction") return "default";
  return "outline";
}

export interface AnnotationPanelProps {
  annotations: Annotation[];
  activeAnnotationId?: string | null;
  onSelectAnnotation: (annotation: Annotation) => void;
  onResolve: (annotationId: string) => void;
  onReopen: (annotationId: string) => void;
  onReply: (annotationId: string, body: string) => void;
  onClose?: () => void;
  /** When provided, renders a compose button under the header (used where there
   *  is no editor to attach annotations from — e.g. the HTML doc route). */
  onCompose?: () => void;
  composeLabel?: string;
  /** Overrides the empty-state hint for surfaces without a block editor. */
  emptyHint?: string;
  className?: string;
}

export function AnnotationPanel({
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
    <aside className={cn("flex h-full w-full flex-col bg-background", className)}>
      <div className="flex items-center justify-between gap-3 p-4 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquareText className="h-4 w-4 shrink-0 text-primary" />
          <h2 className="text-sm font-medium text-foreground">Annotations</h2>
          <Badge variant="secondary">{openCount} open</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setShowResolved((value) => !value)}>
            {showResolved ? "Hide resolved" : "Show resolved"}
          </Button>
          {onClose && (
            <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close annotations">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {onCompose && (
        <div className="px-4 pb-2">
          <Button size="sm" variant="outline" className="w-full gap-2" onClick={onCompose}>
            <MessageSquareText className="h-4 w-4" />
            {composeLabel ?? "Add comment"}
          </Button>
        </div>
      )}

      <div ref={scrollRef} className="scroll-fade min-h-0 flex-1 overflow-auto p-3">
        {visible.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border p-6 text-center">
            <MessageSquareText className="mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">No open annotations</p>
            <p className="mt-1 text-xs text-muted-foreground">{emptyHint ?? "Use /comment or /instruction in the editor to attach context to a block."}</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {visible.map((annotation) => (
              <AnnotationCard
                key={annotation.id}
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
  annotation,
  active,
  onSelect,
  onResolve,
  onReopen,
  onReply,
}: {
  annotation: Annotation;
  active: boolean;
  onSelect: () => void;
  onResolve: () => void;
  onReopen: () => void;
  onReply: (body: string) => void;
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
        "border-l-2 px-3 py-4 transition-colors",
        active ? "border-l-primary bg-muted/25" : "border-l-transparent hover:bg-muted/20"
      )}
    >
      <button type="button" onClick={onSelect} className="w-full text-left">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Badge variant={categoryVariant(annotation.category)}>
            {annotation.category === "instruction" && <Sparkles className="h-3 w-3" />}
            {categoryLabel[annotation.category]}
          </Badge>
          <Badge variant="outline">{annotation.status}</Badge>
          <span className="ml-auto text-[11px] text-muted-foreground">{blockLabel}</span>
        </div>
        {annotation.title && <h3 className="mb-1 text-sm font-medium text-foreground">{annotation.title}</h3>}
        {"quote" in annotation.target && annotation.target.quote && (
          <div className="mb-1.5 border-l-2 border-border pl-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Commenting on</span>
            <p className="line-clamp-3 text-xs italic text-muted-foreground">{annotation.target.quote}</p>
          </div>
        )}
        <p className="whitespace-pre-wrap text-sm text-foreground/90">{annotation.body}</p>
      </button>

      {annotation.thread.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {annotation.thread.map((message) => (
            <div key={message.id} className="border-l-2 border-border/70 py-1 pl-3">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">{message.author.name ?? message.author.id}</div>
              <p className="whitespace-pre-wrap text-xs text-foreground/80">{message.body}</p>
            </div>
          ))}
        </div>
      )}

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

      {!isResolved && (
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
