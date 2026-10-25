import type { AnnotationCategory } from "@worktable/types"
import { Toggle } from "@worktable/ui/components/toggle"

export function AnnotationCategoryChoice({ value, onChange, compact = false }: {
  value: AnnotationCategory
  onChange: (value: AnnotationCategory) => void
  /** Without the label, sized for a popover. */
  compact?: boolean
}) {
  return <fieldset className="space-y-2">
    <legend className={compact ? "sr-only" : "text-sm font-medium text-foreground"}>Type</legend>
    <div className="flex gap-2">
      {(["comment", "instruction"] as const).map(category => <Toggle key={category} variant="outline" className={compact ? "flex-1" : "h-11 flex-1"} pressed={category === value} onPressedChange={() => onChange(category)}>
        {category === "comment" ? "Comment" : "Instruction"}
      </Toggle>)}
    </div>
  </fieldset>
}
