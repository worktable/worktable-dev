import type { ComponentProps, ReactNode } from "react"
import { Button } from "@worktable/ui/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { cn } from "@worktable/ui/lib/utils"

/** A quiet icon control inside a Doc, named by its tooltip. */
export function DocIconButton({
  label,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label"> & {
  label: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className={cn(
              "size-7 text-muted-foreground hover:text-foreground aria-pressed:text-primary",
              className
            )}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
