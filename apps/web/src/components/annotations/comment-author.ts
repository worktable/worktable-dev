import type { AnnotationAuthor } from "@worktable/types"

/** Who wrote a comment or reply, as the panel names them. */
export function authorName(author: AnnotationAuthor): string {
  return author.name ?? (author.type === "agent" ? "Agent" : "Someone")
}
