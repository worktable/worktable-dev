import type { ReactNode } from "react"
import { Check, ChevronRight } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { cn } from "@worktable/ui/lib/utils"

function StepMark({
  number,
  complete,
}: {
  number: number
  complete?: boolean
}) {
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full bg-surface-tint text-xs",
        complete && "bg-success/10 text-success"
      )}
    >
      {complete ? <Check className="size-3.5" aria-hidden /> : number}
    </span>
  )
}

/**
 * One numbered step of a setup, shown with a check once complete. With
 * `onOpenChange` it opens to show its content; without, it is a plain step.
 * Render inside an `<ol className="space-y-1">`.
 */
export function SetupStep({
  number,
  title,
  complete,
  open = false,
  disabled,
  onOpenChange,
  children,
}: {
  number: number
  title: ReactNode
  complete?: boolean
  open?: boolean
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
}) {
  if (!onOpenChange)
    return (
      <li className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <StepMark number={number} complete={complete} />
        <span className="flex-1">{title}</span>
      </li>
    )
  return (
    <li>
      <Collapsible open={open && !disabled} onOpenChange={onOpenChange}>
        <CollapsibleTrigger
          disabled={disabled}
          className="flex min-h-11 w-full items-center gap-3 text-left text-sm font-medium disabled:cursor-default disabled:text-muted-foreground"
        >
          <StepMark number={number} complete={complete} />
          <span className="flex-1">{title}</span>
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && !disabled && "rotate-90"
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <div className="flex min-w-0 flex-col gap-3 pt-2 pb-4 pl-9">
            {children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
