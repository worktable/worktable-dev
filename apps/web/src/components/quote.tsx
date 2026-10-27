import type { ComponentProps } from "react"
import { cn } from "@worktable/ui/lib/utils"

/** Quoted text outside a Doc, in the look of a Markdown quote. */
export function Quote({ className, ...props }: ComponentProps<"blockquote">) {
  return (
    <blockquote
      className={cn("quoted text-sm break-words", className)}
      {...props}
    />
  )
}
