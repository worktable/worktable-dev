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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@worktable/ui/components/select";

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

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add Annotation</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Attach an annotation to the current block.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Type</label>
            <Select value={category} onValueChange={(value) => setCategory(value as AnnotationCategory)}>
              <SelectTrigger>
                <SelectValue>{categoryLabel[category]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="comment">Comment</SelectItem>
                <SelectItem value="instruction">Instruction</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Note</label>
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={category === "instruction" ? "Write an instruction..." : "Write a comment..."}
              className="min-h-32"
            />
          </div>
          {draft && <p className="text-xs text-muted-foreground">Anchored to block <span className="font-mono">{draft.blockId.slice(0, 12)}</span></p>}
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
