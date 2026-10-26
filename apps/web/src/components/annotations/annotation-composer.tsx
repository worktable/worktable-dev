import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityActor } from "@worktable/types";
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
import { CommentRecipientSelect } from "./comment-recipient";
import { NO_RECIPIENT, useCommentRecipients } from "@/lib/comment-recipients";
import { setHighlight } from "./passage-text";
import { useIsMobile } from "@/hooks/use-mobile";

export interface AnnotationDraft {
  blockId: string;
  blockType?: string;
  quote?: string;
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

/** Where a comment is written, so it can be sent to whoever changed the Doc. */
export interface CommentContext {
  spaceId: string;
  contributors?: readonly ActivityActor[];
}

/**
 * Writes a comment, sent to the agent that last changed the Doc unless the
 * writer picks someone else. On a wide screen it opens beside what it's about
 * and leaves the Doc in view; on a phone it's a sheet from the bottom.
 */
export function AnnotationComposer({
  draft,
  open,
  onOpenChange,
  onSubmit,
  context,
  label = "Add Comment",
}: {
  draft: Pick<AnnotationDraft, "quote" | "anchor"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `to` holds the participant it is sent to, or is empty. */
  onSubmit: (body: string, to: string[]) => void;
  context?: CommentContext;
  /** Names the box for assistive technology, and on a phone, its sheet. */
  label?: string;
}) {
  const [body, setBody] = useState("");
  const recipients = useCommentRecipients(context?.spaceId, context?.contributors, open);
  // Until the writer picks, the comment goes to whoever is suggested.
  const [picked, setPicked] = useState<string | null>(null);
  const recipient = picked ?? recipients?.suggested ?? NO_RECIPIENT;
  const [wasOpen, setWasOpen] = useState(open);
  const isMobile = useIsMobile();
  const anchor = useMemo(() => anchorFor(draft?.anchor), [draft?.anchor]);
  // Opened from a drawer, the box goes inside it: the drawer keeps focus
  // within itself and would take it back from a box outside.
  // Undefined, not null, otherwise: a null container renders nothing.
  const container =
    (draft?.anchor instanceof Element
      ? draft.anchor.closest<HTMLElement>("[data-vaul-drawer]")
      : null) ?? undefined;
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Reset each time the composer opens so a prior draft never lingers.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setBody("");
      setPicked(null);
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
    onSubmit(trimmed, recipients && recipient !== NO_RECIPIENT ? [recipient] : []);
    onOpenChange(false);
  };
  const action = "Add Comment";
  const recipientSelect = recipients && (
    <CommentRecipientSelect recipients={recipients} value={recipient} onChange={setPicked} />
  );
  const note = (
    <Textarea
      ref={noteRef}
      autoFocus
      aria-label="Comment"
      value={body}
      onChange={(event) => setBody(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }}
      placeholder="Write a comment..."
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
            {note}
            {recipientSelect}
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
        container={container}
        side="bottom"
        align="start"
        sideOffset={8}
        initialFocus={noteRef}
        className="w-80 gap-3 p-3"
      >
        <PopoverTitle className="sr-only">{label}</PopoverTitle>
        {note}
        {recipientSelect && <div className="-my-1 flex">{recipientSelect}</div>}
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
