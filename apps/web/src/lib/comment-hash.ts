/** The address of one comment in its Doc: `#comment-<id>`. */
export const COMMENT_HASH = "comment-"

export function commentHash(annotationId: string): string {
  return `${COMMENT_HASH}${annotationId}`
}
