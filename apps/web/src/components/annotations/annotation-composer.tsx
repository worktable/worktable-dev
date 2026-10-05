import { useState } from "react";
import type { AnnotationCategory } from "@worktable/types";
import { Button } from "@worktable/ui/components/button";
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
import { Toggle } from "@worktable/ui/components/toggle";
import { useIsMobile } from "@/hooks/use-mobile";

export interface AnnotationDraft {
  blockId: string;
  blockType?: string;
  quote?: string;
  category: AnnotationCategory;
}

const categoryLabel: Record<AnnotationCategory, string> = {
  comment: "Comment",
  instruction: "Instruction",
};

export function AnnotationComposer({
  draft,
  open,
  onOpenChange,
  onSubmit,
}: {
  draft: AnnotationDraft | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: AnnotationDraft, body: string) => void;
}) {
  const [category, setCategory] = useState<AnnotationCategory>(draft?.category ?? "comment");
  const [body, setBody] = useState("");
  const isMobile = useIsMobile();

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add Annotation</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {draft?.quote ? "Annotate the selected text." : "Annotate the current block."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4">
          {draft?.quote && (
            <blockquote className="line-clamp-3 border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
              {draft.quote}
            </blockquote>
          )}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">Type</legend>
            <div className="flex gap-2">
              {(["comment", "instruction"] as const).map((value) => (
                <Toggle
                  key={value}
                  variant="outline"
                  className="h-11 flex-1"
                  pressed={category === value}
                  onPressedChange={() => setCategory(value)}
                >
                  {categoryLabel[value]}
                </Toggle>
              ))}
            </div>
          </fieldset>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Note</label>
            <Textarea
              autoFocus={isMobile}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={category === "instruction" ? "Write an instruction..." : "Write a comment..."}
              className="min-h-32"
            />
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => {
              if (!draft || !body.trim()) return;
              onSubmit({ ...draft, category }, body.trim());
              onOpenChange(false);
            }}
            disabled={!draft || !body.trim()}
          >
            Add Annotation
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
