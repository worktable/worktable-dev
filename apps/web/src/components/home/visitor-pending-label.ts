import type { PendingItem } from "@worktable/types"

/** Visitor-only wording needs no router, icons or formatting dependencies. */
export default function VisitorPendingLabel({
  item,
}: {
  item: Extract<PendingItem, { kind: "visitorComments" | "visitorCommentsPaused" }>
}) {
  return item.kind === "visitorCommentsPaused"
    ? `Comments paused on ${item.linkLabel || "Untitled link"}`
    : `${item.count} visitor comment${item.count === 1 ? "" : "s"} on ${item.docTitle ?? item.docPath}`
}
