import type { AnnotationAuthor } from "@worktable/types"

/**
 * Who wrote a comment or reply, as the panel names them. A reply saved
 * without a name keeps its id, so different authors stay apart.
 */
export function authorName(author: AnnotationAuthor): string {
  return author.name ?? author.id
}
