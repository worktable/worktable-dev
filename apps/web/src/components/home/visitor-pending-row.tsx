import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Reply } from "lucide-react"
import type { PendingItem } from "@worktable/types"

/** Loaded only when a person actually has private visitor work to review. */
export function VisitorPendingRow({item, className, where, when}: {
  item: Extract<PendingItem, {kind: "visitorComments" | "visitorCommentsPaused"}>
  className: string
  where: ReactNode
  when: string
}) {
  return <Link to="/spaces/$spaceId/documents/$" params={{spaceId: item.spaceId, _splat: item.docPath}} hash="visitors" className={className}>
    <Reply className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium text-foreground">{item.kind === "visitorCommentsPaused" ? `Comments paused on ${item.linkLabel || "Untitled link"}` : `${item.count} visitor comment${item.count === 1 ? "" : "s"} on ${item.docTitle ?? item.docPath}`}</span>
      {item.kind === "visitorComments" ? <span className="block truncate text-xs text-muted-foreground">{item.linkLabel || "Untitled link"}</span> : null}
    </span>
    {where}
    <span className="shrink-0 text-xs text-muted-foreground">{when}</span>
  </Link>
}
