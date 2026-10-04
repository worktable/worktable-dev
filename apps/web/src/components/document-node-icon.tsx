import {
  AlertTriangle,
  AppWindow,
  File,
  FileText,
  Folder,
  Pencil,
} from "lucide-react"
import { specializedDocumentView } from "@/lib/document-views"
import type { TreeNode } from "@/lib/tree"

/** The icon the sidebar shows for a folder or document of this format. */
export function DocumentNodeIcon({
  node,
  className,
}: {
  node: Pick<TreeNode, "kind" | "isFolder" | "format" | "health">
  className?: string
}) {
  if (node.kind === "conflict") return <AlertTriangle className={className} />
  if (node.isFolder) return <Folder className={className} />
  const view = specializedDocumentView(node)
  if (view === "html") return <AppWindow className={className} />
  if (view === "doc" && node.format?.id !== "worktable.markdown") {
    return <FileText className={className} />
  }
  if (
    node.format?.id === "worktable.quickdraw" &&
    node.health === "supported"
  ) {
    return <Pencil className={className} />
  }
  return <File className={className} />
}
