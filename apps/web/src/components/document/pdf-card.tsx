import { FileText } from "lucide-react"

/**
 * A PDF a Markdown Doc embeds: a card with its name that opens the file
 * full screen (PdfViewControl), and a link to its page without script.
 */
export function PdfCard({ target, href }: { target: string; href: string }) {
  const name = decodeURIComponent(target.slice(target.lastIndexOf("/") + 1))
  return (
    <a
      href={href}
      data-pdf-card={target}
      className="not-prose my-4 flex max-w-md items-center gap-3 rounded-xl card-surface-interactive card-surface p-3 no-underline"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-tint text-muted-foreground">
        <FileText className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {name}
        </span>
        <span className="block text-xs text-muted-foreground">PDF</span>
      </span>
    </a>
  )
}
