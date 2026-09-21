import { ExternalLink } from "lucide-react"

import { cn } from "@worktable/ui/lib/utils"

interface SourceChipProps {
  url: string
  label?: string
  favicon?: string
  domain?: string
  className?: string
}

function SourceChip({
  url,
  label,
  favicon,
  domain,
  className,
}: SourceChipProps) {
  // Extract domain from URL if not provided
  const displayDomain =
    domain ??
    (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, "")
      } catch {
        return url
      }
    })()

  const displayLabel = label ?? displayDomain

  // Build favicon URL if not provided
  const faviconSrc =
    favicon ??
    (() => {
      try {
        const origin = new URL(url).origin
        return `${origin}/favicon.ico`
      } catch {
        return undefined
      }
    })()

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:bg-surface-tint hover:text-foreground",
        className
      )}
    >
      {faviconSrc && (
        <img
          src={faviconSrc}
          alt=""
          className="size-3 rounded-sm object-contain"
          onError={(e) => {
            ;(e.currentTarget as HTMLImageElement).style.display = "none"
          }}
        />
      )}
      <span className="max-w-[160px] truncate">{displayLabel}</span>
      <ExternalLink className="size-3 shrink-0 opacity-60" />
    </a>
  )
}

export { SourceChip }
export type { SourceChipProps }
