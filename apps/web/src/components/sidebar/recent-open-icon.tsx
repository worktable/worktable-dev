import { Database, Library as LibraryIcon, MessageCircle } from "lucide-react"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import type { RecentOpen } from "@/lib/recent-opens"

/** The icon of a page someone opened: its format, or what kind of page it is. */
export function RecentOpenIcon({
  open,
  className,
}: {
  open: RecentOpen
  className?: string
}) {
  if (open.role === "document") {
    return (
      <DocumentFormatIcon
        formatId={open.formatId}
        name={open.path.split("/").pop()}
        className={className}
      />
    )
  }
  if (open.role === "thread") return <MessageCircle className={className} />
  if (open.role === "skill") return <LibraryIcon className={className} />
  return <Database className={className} />
}
