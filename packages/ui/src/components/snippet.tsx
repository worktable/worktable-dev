import { Check, Copy } from "lucide-react"

import { cn } from "@worktable/ui/lib/utils"
import { useCopy } from "@worktable/ui/hooks/use-copy"

/**
 * Multi-line code block with a top-right copy button. Overflows horizontally by
 * scrolling (the app can wrap it in scroll-fade-x if desired). Shares the
 * check-swap copy behavior with CopyField and SecretReveal via `useCopy`.
 */
function Snippet({
  code,
  label,
  onCopied,
  className,
}: {
  code: string
  label?: string
  onCopied?: () => void
  className?: string
}) {
  const { copied, copy } = useCopy(onCopied)

  return (
    <div data-slot="snippet" className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <span className="text-xs font-medium tracking-wide text-foreground/70">
          {label}
        </span>
      ) : null}
      <div className="relative">
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 pr-11 font-mono text-xs whitespace-pre">
          {code}
        </pre>
        <button
          type="button"
          onClick={() => void copy(code)}
          aria-label={copied ? "Copied" : "Copy"}
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-md bg-muted/80 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
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

export { Snippet }
