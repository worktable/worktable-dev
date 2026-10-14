import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react"
import Markdown, { defaultUrlTransform, type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ThreadLocation } from "@worktable/types"

import { useScrollFadeX } from "@/hooks/use-scroll-fade-x"
import { externalLinkProps, worktableLinkOrigins } from "@/lib/external-links"
import { BASE_URL } from "@/lib/http"
import { renderThreadLinkHref } from "@/lib/thread-links"
import { threadMentionSegments } from "@/lib/thread-mentions"

interface ThreadMarkdownSettings {
  location: ThreadLocation
  mentionNames: string[]
  worktableOrigins: string[]
}

const ThreadMarkdownContext = createContext<ThreadMarkdownSettings>({
  location: { kind: "worktable" },
  mentionNames: [],
  worktableOrigins: [],
})

/**
 * What a message's Markdown depends on besides its text: links resolve
 * against the thread's location and mentions of these names are highlighted.
 * Parsed messages are cached without them, so a change here re-renders the
 * links and paragraphs without parsing again.
 */
export function ThreadMarkdownProvider({
  location,
  mentionNames,
  children,
}: {
  location: ThreadLocation
  mentionNames: string[]
  children: ReactNode
}) {
  const worktableOrigins = useMemo(() => {
    if (typeof window === "undefined") return []
    return worktableLinkOrigins(window.location.origin, BASE_URL)
  }, [])
  const settings = useMemo(
    () => ({ location, mentionNames, worktableOrigins }),
    [location, mentionNames, worktableOrigins]
  )
  return (
    <ThreadMarkdownContext.Provider value={settings}>
      {children}
    </ThreadMarkdownContext.Provider>
  )
}

const remarkPlugins = [remarkGfm]

const components: Components = {
  p: function ThreadParagraph({ node, children, ...props }) {
    void node
    const { mentionNames } = useContext(ThreadMarkdownContext)
    return (
      <p {...props}>{highlightThreadMentionChildren(children, mentionNames)}</p>
    )
  },
  li: function ThreadListItem({ node, children, ...props }) {
    void node
    const { mentionNames } = useContext(ThreadMarkdownContext)
    return (
      <li {...props}>
        {highlightThreadMentionChildren(children, mentionNames)}
      </li>
    )
  },
  a: function ThreadLink({ node, href = "", children, ...props }) {
    void node
    const { location, worktableOrigins } = useContext(ThreadMarkdownContext)
    const renderedHref = renderThreadLinkHref(location, href, worktableOrigins)
    return renderedHref ? (
      <a
        {...props}
        href={renderedHref}
        {...externalLinkProps(renderedHref, worktableOrigins)}
      >
        {children}
      </a>
    ) : (
      <span title="This Space-relative link has no Worktable location">
        {children}
      </span>
    )
  },
  pre: ({ children }) => <ThreadCodeBlock>{children}</ThreadCodeBlock>,
  table: ({ children }) => <ThreadTable>{children}</ThreadTable>,
}

/** Parsed messages, most recently used last. */
const parsedMessages = new Map<
  string,
  { body: string; element: ReactElement }
>()
const PARSED_MESSAGE_LIMIT = 500

/**
 * A message's Markdown as React elements, parsed once per message text:
 * reopening a thread, or rendering a row again, reuses the result.
 */
function parseThreadMarkdown(messageId: string, body: string): ReactElement {
  const cached = parsedMessages.get(messageId)
  if (cached) parsedMessages.delete(messageId)
  if (cached?.body === body) {
    parsedMessages.set(messageId, cached)
    return cached.element
  }
  // Markdown is react-markdown's synchronous renderer; it uses no hooks, so
  // calling it returns the elements it would render.
  const element = Markdown({
    children: body,
    remarkPlugins,
    urlTransform: defaultUrlTransform,
    components,
  })
  parsedMessages.set(messageId, { body, element })
  if (parsedMessages.size > PARSED_MESSAGE_LIMIT) {
    parsedMessages.delete(parsedMessages.keys().next().value!)
  }
  return element
}

export const ThreadMarkdown = memo(function ThreadMarkdown({
  messageId,
  body,
}: {
  messageId: string
  body: string
}) {
  return (
    <div className="typeset typeset-thread">
      {parseThreadMarkdown(messageId, body)}
    </div>
  )
})

function highlightThreadMentionChildren(
  children: ReactNode,
  names: string[]
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return threadMentionSegments(child, names).map((segment, index) => (
        <span
          key={`${index}:${segment.text}`}
          className={
            segment.mention
              ? "rounded-sm bg-primary/10 px-0.5 text-primary-text"
              : undefined
          }
        >
          {segment.text}
        </span>
      ))
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) return child
    if (
      typeof child.type === "string" &&
      (child.type === "a" || child.type === "code" || child.type === "pre")
    ) {
      return child
    }
    if (child.props.children === undefined) return child
    return cloneElement(
      child,
      undefined,
      highlightThreadMentionChildren(child.props.children, names)
    )
  })
}

function ThreadCodeBlock({ children }: { children: ReactNode }) {
  const fadeRef = useScrollFadeX<HTMLPreElement>()
  return (
    <pre ref={fadeRef} className="scroll-fade-x overflow-x-auto">
      {children}
    </pre>
  )
}

function ThreadTable({ children }: { children: ReactNode }) {
  const fadeRef = useScrollFadeX<HTMLDivElement>()
  return (
    <div ref={fadeRef} className="typeset-scroll scroll-fade-x overflow-x-auto">
      <table>{children}</table>
    </div>
  )
}
