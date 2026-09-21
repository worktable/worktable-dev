import { useState } from "react"
import { Check, Copy, Eye, EyeOff } from "lucide-react"

import { cn } from "@worktable/ui/lib/utils"
import { useCopy } from "@worktable/ui/hooks/use-copy"

// Masked form: fixed dots + the last 4 chars, so the value is recognizable
// without exposing it.
function mask(secret: string): string {
  return `••••${secret.slice(-4)}`
}

/**
 * A `.well`-styled mono block for a one-time secret. Masked by default with an
 * eye toggle to reveal; the copy button copies the real secret regardless of
 * mask state. Shares the check-swap behavior with CopyField/Snippet.
 */
function SecretReveal({
  secret,
  onCopied,
  className,
}: {
  secret: string
  onCopied?: () => void
  className?: string
}) {
  const [revealed, setRevealed] = useState(false)
  const { copied, copy } = useCopy(onCopied)

  return (
    <div
      data-slot="secret-reveal"
      className={cn(
        "well well-interactive flex items-center gap-1 rounded-lg border border-input py-1 pr-1 pl-3 transition-colors",
        className
      )}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        {revealed ? secret : mask(secret)}
      </span>
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        aria-label={revealed ? "Hide" : "Reveal"}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {revealed ? (
          <EyeOff className="size-3.5" />
        ) : (
          <Eye className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={() => void copy(secret)}
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
  )
}

export { SecretReveal }
