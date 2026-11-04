import type { ReactNode } from "react"
import { Pencil } from "lucide-react"
import { cn } from "@worktable/ui/lib/utils"

/** A logo or photo in Settings, which opens its picker. */
export function EditMarkButton({
  label,
  round,
  disabled,
  onClick,
  children,
}: {
  label: string
  round?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group relative shrink-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default",
        round ? "rounded-full" : "rounded-[25%]"
      )}
    >
      <span className="block transition-[filter] duration-150 group-hover:brightness-95 group-disabled:brightness-100">
        {children}
      </span>
      {disabled ? null : (
        <span
          aria-hidden
          className="absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-xs"
        >
          <Pencil className="size-2.5" />
        </span>
      )}
    </button>
  )
}
