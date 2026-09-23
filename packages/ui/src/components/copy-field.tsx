import { Check, Copy } from "lucide-react"

import { cn } from "@worktable/ui/lib/utils"
import { useCopy } from "@worktable/ui/hooks/use-copy"

/**
 * Single-line value display with a copy button. The button swaps to a check for
 * ~1.5s on success. Clipboard access lives in the shared `useCopy` hook;
 * `onCopied` lets the app toast without leaking clipboard plumbing into props.
 */
function CopyField({
  value,
  label,
  mono = true,
  className,
  onCopied,
}: {
  value: string
  label?: string
  mono?: boolean
  className?: string
  onCopied?: () => void
}) {
  const { copied, copy } = useCopy(onCopied)

  return (
    <div
      data-slot="copy-field"
      className={cn("flex flex-col gap-1.5", className)}
    >
      {label ? (
        <span className="text-sm font-medium text-foreground">{label}</span>
      ) : null}
      <div className="well well-interactive flex h-9 items-center gap-2 rounded-lg border border-input pr-1 pl-3 transition-colors">
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            mono ? "font-mono text-xs" : "text-sm"
          )}
        >
          {value}
        </span>
        <button
          type="button"
          onClick={() => void copy(value)}
          aria-label={copied ? "Copied" : "Copy"}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {copied ? (
            <Check className="size-3.5 text-primary-text" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      </div>
    </div>
  )
}

export { CopyField }
