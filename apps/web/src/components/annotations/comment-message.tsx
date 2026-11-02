import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import type { AnnotationAuthor } from "@worktable/types"
import { cn } from "@worktable/ui/lib/utils"
import { ThreadParticipantAvatar } from "@/components/identity-icons"
import { ThreadMarkdown } from "@/components/threads/thread-markdown"
import { RelativeTime } from "@/lib/time"

/** A message taller than this is cut to {@link CLAMPED} until shown in full. */
const CLAMP_ABOVE = 200
const CLAMPED = 160

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
  actions,
  children,
}: {
  id: string
  author: AnnotationAuthor
  body: string
  createdAt: string
  title?: string
  /** Beside the author's name, such as Resolve. */
  actions?: ReactNode
  /** Under the message, such as who it was sent to. */
  children?: ReactNode
}) {
  const name = author.name ?? (author.type === "agent" ? "Agent" : "Someone")
  return (
    <div className="min-w-0">
      <div className="flex min-h-7 items-center gap-2">
        <ThreadParticipantAvatar
          participant={
            author.type === "system"
              ? undefined
              : {
                  id: author.id,
                  kind: author.type === "agent" ? "agent" : "human",
                  name,
                }
          }
          className="size-6 text-[0.625rem]"
        />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          <RelativeTime iso={createdAt} />
        </span>
        {actions && (
          <span className="ms-auto flex shrink-0 items-center">{actions}</span>
        )}
      </div>
      <div className="ps-8">
        {title && (
          <h3 className="mb-1 text-sm font-medium text-foreground">{title}</h3>
        )}
        <ClampedBody>
          <ThreadMarkdown messageId={id} body={body} />
        </ClampedBody>
        {children}
      </div>
    </div>
  )
}

/** Shows a long message cut short, with Show More to read it all. */
function ClampedBody({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    const node = content.current
    if (!node) return
    const measure = () => setLong(node.offsetHeight > CLAMP_ABOVE)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const clamped = long && !expanded
  return (
    <>
      <div
        className={cn(
          "overflow-hidden",
          clamped &&
            "[mask-image:linear-gradient(to_bottom,black_65%,transparent)]"
        )}
        style={clamped ? { maxHeight: CLAMPED } : undefined}
      >
        <div
          ref={content}
          // The panel's size, a step under a Thread's.
          className="[&_.typeset-thread]:[--typeset-leading:1.55] [&_.typeset-thread]:[--typeset-size:0.875rem]"
        >
          {children}
        </div>
      </div>
      {long && (
        <button
          type="button"
          className="mt-1 rounded-sm text-xs font-medium text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show Less" : "Show More"}
        </button>
      )}
    </>
  )
}
