import type { ReactNode } from "react"
import type { AnnotationAuthor } from "@worktable/types"
import { cn } from "@worktable/ui/lib/utils"
import { ThreadParticipantAvatar } from "@/components/identity-icons"
import { ThreadMarkdown } from "@/components/threads/thread-markdown"
import { RelativeTime } from "@/lib/time"
import { authorName } from "./comment-author"

/** The person's or agent's avatar, as in a Thread. */
export function CommentAvatar({
  author,
  className,
}: {
  author: AnnotationAuthor
  className?: string
}) {
  return (
    <ThreadParticipantAvatar
      participant={
        author.type === "system"
          ? undefined
          : {
              id: author.id,
              kind: author.type === "agent" ? "agent" : "human",
              name: authorName(author),
            }
      }
      className={cn("size-6 text-[0.625rem]", className)}
    />
  )
}

/**
 * One message on a comment: the comment itself or a reply. People and agents
 * read the same, as in a Thread, and Markdown agents write shows as Markdown.
 */
export function CommentMessage({
  id,
  author,
  body,
  createdAt,
  title,
  children,
}: {
  id: string
  author: AnnotationAuthor
  body: string
  createdAt: string
  title?: string
  /** Under the message, such as who it was sent to. */
  children?: ReactNode
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-h-7 items-center gap-2">
        <CommentAvatar author={author} />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {authorName(author)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          <RelativeTime iso={createdAt} />
        </span>
      </div>
      <div className="ps-8">
        {title && (
          <h3 className="mb-1 text-sm font-medium text-foreground">{title}</h3>
        )}
        <div
          // The panel's size, a step under a Thread's.
          className="[&_.typeset-thread]:[--typeset-leading:1.55] [&_.typeset-thread]:[--typeset-size:0.875rem]"
        >
          <ThreadMarkdown messageId={id} body={body} />
        </div>
        {children}
      </div>
    </div>
  )
}
