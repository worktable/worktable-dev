import { useEffect, useMemo, useRef, useState } from "react";
import type { AnnotationCategory } from "@worktable/types";
import { Button } from "@worktable/ui/components/button";
import { Popover, PopoverContent, PopoverTitle } from "@worktable/ui/components/popover";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog";
import { Textarea } from "@worktable/ui/components/textarea";
import { AnnotationCategoryChoice } from "./annotation-category-choice";
import { setHighlight } from "./passage-text";
import { useIsMobile } from "@/hooks/use-mobile";

export interface AnnotationDraft {
  blockId: string;
  blockType?: string;
  quote?: string;
  category: AnnotationCategory;
  /** What the comment box opens next to: the selection, or what was pressed. */
  anchor?: Range | Element;
}

const DRAFT_HIGHLIGHT = "worktable-comment-draft";

/** Floating UI's view of a range, which keeps up as the page scrolls. */
function anchorFor(anchor: Range | Element | undefined) {
  if (!anchor || anchor instanceof Element) return anchor ?? null;
  const context =
    anchor.startContainer instanceof Element
      ? anchor.startContainer
      : anchor.startContainer.parentElement;
  return {
    getBoundingClientRect: () => anchor.getBoundingClientRect(),
    getClientRects: () => anchor.getClientRects(),
    ...(context ? { contextElement: context } : {}),
  };
}

/**
 * Writes a comment or instruction. On a wide screen it opens beside what it's
 * about and leaves the Doc in view; on a phone it's a sheet from the bottom.
 */
export function AnnotationComposer({
  draft,
  open,
  onOpenChange,
  onSubmit,
  label = "Add Comment",
}: {
  draft: Pick<AnnotationDraft, "quote" | "category" | "anchor"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (category: AnnotationCategory, body: string) => void;
  /** Names the box for assistive technology, and on a phone, its sheet. */
  label?: string;
}) {
  const [category, setCategory] = useState<AnnotationCategory>(draft?.category ?? "comment");
  const [body, setBody] = useState("");
  const [wasOpen, setWasOpen] = useState(open);
  const isMobile = useIsMobile();
  const anchor = useMemo(() => anchorFor(draft?.anchor), [draft?.anchor]);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Reset each time the composer opens so a prior draft never lingers.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCategory(draft?.category ?? "comment");
      setBody("");
    }
  }

  // Writing moves focus away from the page, which hides the selection; keep
  // the text in view as the thing being commented on.
  const range = draft?.anchor instanceof Range ? draft.anchor : null;
  useEffect(() => {
    if (!open || !range) return;
    setHighlight(DRAFT_HIGHLIGHT, [range]);
    return () => setHighlight(DRAFT_HIGHLIGHT, []);
  }, [open, range]);

  const submit = () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    onSubmit(category, trimmed);
    onOpenChange(false);
  };
  const action = category === "instruction" ? "Add Instruction" : "Add Comment";
  const note = (
    <Textarea
      ref={noteRef}
      autoFocus
      aria-label={category === "instruction" ? "Instruction" : "Comment"}
      value={body}
      onChange={(event) => setBody(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }}
      placeholder={category === "instruction" ? "Write an instruction..." : "Write a comment..."}
      className={isMobile ? "min-h-32" : "min-h-24"}
    />
  );

  if (isMobile || !anchor) {
    return (
      <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader className="sr-only">
            <ResponsiveDialogTitle>{label}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {draft?.quote ? "About the selected text." : "About this part of the Doc."}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-4">
            {draft?.quote && (
              <blockquote className="line-clamp-3 border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
                {draft.quote}
              </blockquote>
            )}
            <AnnotationCategoryChoice value={category} onChange={setCategory} />
            {note}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!draft || !body.trim()}>
              {action}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // A stray click elsewhere mustn't throw away what's been written.
        if (
          !next &&
          (details.reason === "outside-press" || details.reason === "focus-out") &&
          body.trim()
        )
          return;
        onOpenChange(next);
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={8}
        initialFocus={noteRef}
        className="w-80 gap-3 p-3"
      >
        <PopoverTitle className="sr-only">{label}</PopoverTitle>
        <AnnotationCategoryChoice compact value={category} onChange={setCategory} />
        {note}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!draft || !body.trim()}>
            {action}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
