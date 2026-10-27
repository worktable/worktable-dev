import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityActor } from "@worktable/types";
import { Popover, PopoverContent, PopoverTitle } from "@worktable/ui/components/popover";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog";
import { NO_RECIPIENT, useCommentRecipients } from "@/lib/comment-recipients";
import { setHighlight } from "./passage-text";
import { Quote } from "@/components/quote";
import { useIsMobile } from "@/hooks/use-mobile";

const Composer = lazy(() =>
  import("@/components/composer").then((module) => ({ default: module.Composer }))
);

// Only loads where comments can be sent to someone (Preview agent tools).
const CommentRecipientSelect = lazy(() =>
  import("./comment-recipient").then((module) => ({
    default: module.CommentRecipientSelect,
  }))
);

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
  /** The Doc, for finding who wrote selected text. */
  docPath?: string;
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
  draft:
    | (Pick<AnnotationDraft, "quote" | "anchor"> & {
        prefix?: string;
        suffix?: string;
      })
    | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `to` holds the participant it is sent to, or is empty. */
  onSubmit: (body: string, to: string[]) => void;
  context?: CommentContext;
  /** Names the box for assistive technology, and on a phone, its sheet. */
  label?: string;
}) {
  const [body, setBody] = useState("");
  const recipients = useCommentRecipients(
    context?.spaceId,
    context?.contributors,
    open,
    context?.docPath && draft?.quote
      ? { docPath: context.docPath, quote: draft.quote, prefix: draft.prefix, suffix: draft.suffix }
      : undefined
  );
  // Until the writer picks, the comment goes to whoever is suggested.
  const [picked, setPicked] = useState<string | null>(null);
  const recipient = picked ?? recipients?.suggested ?? NO_RECIPIENT;
  // A suggestion waits for who wrote the selection; a choice doesn't.
  const awaitingRecipient = picked === null && Boolean(recipients?.settling);
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
    if (!trimmed || awaitingRecipient) return;
    onSubmit(trimmed, recipients && recipient !== NO_RECIPIENT ? [recipient] : []);
    onOpenChange(false);
  };
  // The box loads when it first opens; it takes focus as it arrives.
  const focusOnArrival = useCallback((node: HTMLTextAreaElement | null) => {
    noteRef.current = node;
    node?.focus();
  }, []);
  const composer = (
    <Suspense fallback={<div className="well min-h-24 rounded-2xl" />}>
      <Composer
        ref={focusOnArrival}
        value={body}
        onChange={setBody}
        onSubmit={submit}
        pending={false}
        disabled={!draft}
        canSubmit={!awaitingRecipient}
        placeholder="Write a comment…"
        label={label}
        sendLabel="Send comment"
        size={isMobile ? "regular" : "compact"}
        placement="inline"
        toolbarActions={
          recipients && (
            <Suspense fallback={null}>
              <CommentRecipientSelect recipients={recipients} value={recipient} onChange={setPicked} />
            </Suspense>
          )
        }
      />
    </Suspense>
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
          <ResponsiveDialogBody className="space-y-4 pb-4">
            {draft?.quote && <Quote className="line-clamp-3">{draft.quote}</Quote>}
            {composer}
          </ResponsiveDialogBody>
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
        className="w-80 p-2"
      >
        <PopoverTitle className="sr-only">{label}</PopoverTitle>
        {composer}
      </PopoverContent>
    </Popover>
  );
}
