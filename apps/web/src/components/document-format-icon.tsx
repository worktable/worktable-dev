import { AppWindow, File, FileText, Pencil } from "lucide-react"

/** The icon the sidebar uses for a document format, for lists elsewhere. */
export function DocumentFormatIcon({
  formatId,
  className = "size-4",
}: {
  formatId?: string
  className?: string
}) {
  if (formatId === "worktable.html") return <AppWindow className={className} />
  if (formatId === "worktable.quickdraw") return <Pencil className={className} />
  if (formatId === "worktable.markdown") return <File className={className} />
  return <FileText className={className} />
}
