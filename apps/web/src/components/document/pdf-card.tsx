import { FileText } from "lucide-react"

/**
 * A PDF a Markdown Doc embeds: a card with its name that opens the file
 * full screen (PdfViewControl), and a link to its page without script.
 */
export function PdfCard({
  target,
  href,
  inLink = false,
}: {
  target: string
  href: string
  /** Inside a link the author wrote: the card keeps that link's press. */
  inLink?: boolean
}) {
  const authored = target.slice(target.lastIndexOf("/") + 1)
  let name = authored
  try {
    name = decodeURIComponent(authored)
  } catch {
    // A name that isn't validly encoded shows as written.
  }
  const content = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-tint text-muted-foreground">
        <FileText className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {name}
        </span>
        <span className="block text-xs text-muted-foreground">PDF</span>
      </span>
    </>
  )
  const look =
    "not-prose my-4 flex max-w-md items-center gap-3 rounded-xl card-surface p-3 no-underline!"
  return inLink ? (
    <span className={look}>{content}</span>
  ) : (
    <a
      href={href}
      data-pdf-card={target}
      className={`${look} card-surface-interactive`}
    >
      {content}
    </a>
  )
}
