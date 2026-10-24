import type { ReactElement } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"

/**
 * A header action's name with a line on what it changes. Loaded only for
 * actions that have that line, so every page doesn't carry the tooltip.
 */
export default function HeaderActionTooltip({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: ReactElement
}) {
  return (
    <TooltipProvider delay={500}>
      <Tooltip>
        <TooltipTrigger render={children} />
        <TooltipContent>
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{label}</span>
            <span className="opacity-70">{description}</span>
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
