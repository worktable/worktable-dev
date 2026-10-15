import type { ComponentProps, ReactNode } from "react"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"

/**
 * A quiet icon control inside a Doc, named by its tooltip. The tooltip comes
 * from DataTooltips around the Doc, which keeps the opening Doc from loading
 * a tooltip library. Icons are 14px wherever the control sits: inside the
 * editor, BlockNote's stylesheet would otherwise reset them to 24px.
 */
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
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      data-tooltip={label}
      className={cn(
        "size-7 text-muted-foreground hover:text-foreground aria-pressed:text-primary [&_svg]:size-3.5!",
        className
      )}
      {...props}
    >
      {children}
    </Button>
  )
}
