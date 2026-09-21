import { ExternalLink } from "lucide-react"

import { cn } from "@worktable/ui/lib/utils"

interface LinkCardProps {
  url: string
  title: string
  description?: string
  favicon?: string
  domain?: string
  image?: string
  className?: string
}

function LinkCard({
  url,
  title,
  description,
  favicon,
  domain,
  image,
  className,
}: LinkCardProps) {
  const displayDomain =
    domain ??
    (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, "")
      } catch {
        return url
      }
    })()

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
        "group/link-card flex flex-col overflow-hidden rounded-xl bg-card ring-1 ring-border text-sm text-card-foreground transition-all duration-180 hover:ring-primary/25",
        className
      )}
    >
      {/* Optional preview image */}
      {image && (
        <div className="aspect-[2/1] overflow-hidden bg-muted">
          <img
            src={image}
            alt=""
            className="h-full w-full object-cover transition-transform duration-200 group-hover/link-card:scale-[1.02]"
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5 p-3">
        {/* Domain + external link icon */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {faviconSrc && (
            <img
              src={faviconSrc}
              alt=""
              className="size-3.5 rounded-sm object-contain"
              onError={(e) => {
                ;(e.currentTarget as HTMLImageElement).style.display = "none"
              }}
            />
          )}
          <span className="truncate">{displayDomain}</span>
          <ExternalLink className="size-3 shrink-0 ml-auto opacity-50 transition-opacity group-hover/link-card:opacity-100" />
        </div>

        {/* Title */}
        <span className="font-medium leading-snug line-clamp-2 text-foreground group-hover/link-card:text-primary transition-colors">
          {title}
        </span>

        {/* Description */}
        {description && (
          <p className="text-xs text-muted-foreground leading-snug line-clamp-3">
            {description}
          </p>
        )}
      </div>
    </a>
  )
}

export { LinkCard }
export type { LinkCardProps }
