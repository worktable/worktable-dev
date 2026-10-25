/**
 * Read-only markdown viewer for .md documents.
 * Uses react-markdown + remark-gfm for GFM support (tables, checkboxes, etc.)
 * Content styles are shared with rich text Docs:
 * @worktable/ui/document-content.css.
 */

import {
  Component,
  Suspense,
  createContext,
  isValidElement,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ErrorInfo,
  type ReactNode,
} from "react"
import { useRouter } from "@tanstack/react-router"
import Markdown, {
  type Components,
  type Options as MarkdownOptions,
} from "react-markdown"
import remarkGfm from "remark-gfm"
import { AlertTriangle } from "lucide-react"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useScrollFadeX } from "@/hooks/use-scroll-fade-x"
import { mergeRefs, usePaneWidth } from "@/hooks/use-pane-width"
import { containsHtml } from "@/lib/markdown-html-detect"
import { CodeBlock } from "@/components/document/code-block"
import { DocTable } from "@/components/document/doc-table"
import { DocDetails, DocSummary } from "@/components/document/doc-details"
import { DataTooltips } from "@/components/document/data-tooltip"
import { NumberedList } from "@worktable/ui/lib/numbered-list"
import { markdownTitleLine } from "@worktable/ui/document-reading-preview"
import "@/styles/document-controls.css"
import { renderDocLinkHref } from "@/lib/doc-links"
import {
  embedSourceUrl,
  knownImageSize,
  rememberImageSize,
} from "@/lib/file-embeds"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { externalLinkProps, worktableLinkOrigins } from "@/lib/external-links"
import { BASE_URL } from "@/lib/http"
import { useTheme } from "@/components/theme-provider"
import { resolveDocLink } from "@worktable/types"

const MermaidRenderer = lazy(() =>
  import("./worktable-mermaid-renderer").then((module) => ({
    default: module.WorktableMermaidRenderer,
  }))
)

// ── Error Boundary ───────────────────────────────────────

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

function ScrollableMermaidSource({ source }: { source: string }) {
  const fade = useScrollFadeX<HTMLPreElement>()
  return (
    <pre
      ref={fade}
      className="scroll-fade-x mt-2 overflow-auto rounded-md bg-muted p-3 text-foreground"
    >
      <code>{source}</code>
    </pre>
  )
}

type HtmlPlugins = NonNullable<MarkdownOptions["rehypePlugins"]>
let htmlPlugins: HtmlPlugins | undefined

/**
 * Sanitized HTML support, loaded only for Docs that contain HTML. Until it
 * arrives, HTML is left out rather than shown as tag text.
 */
function useHtmlPlugins(content: string) {
  const needed = useMemo(() => containsHtml(content), [content])
  const [plugins, setPlugins] = useState(htmlPlugins)
  useEffect(() => {
    if (!needed || plugins) return
    let active = true
    void import("./markdown-html").then((module) => {
      htmlPlugins = module.markdownHtmlPlugins
      if (active) setPlugins(htmlPlugins)
    })
    return () => {
      active = false
    }
  }, [needed, plugins])
  return {
    rehypePlugins: needed ? plugins : undefined,
    skipHtml: needed && !plugins,
  }
}

class MarkdownErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[MarkdownViewer] Render error:", error, info)
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Failed to render markdown</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {this.state.error.message}
              </p>
            </div>
          </div>
        )
      )
    }
    return this.props.children
  }
}

// ── Title ────────────────────────────────────────────────

/** What shows under the title, and the source line of that title. */
const AfterTitleContext = createContext<{
  line: number | null
  node: ReactNode
}>({ line: null, node: null })

/**
 * Level-one headings. The title, the Doc's opening heading, carries what
 * shows under it. One component for every render keeps that content's state.
 */
function TitleHeading({
  node,
  ...props
}: ComponentProps<"h1"> & {
  node?: { position?: { start: { line: number } } }
}) {
  const after = useContext(AfterTitleContext)
  if (node?.position?.start.line !== after.line) return <h1 {...props} />
  return (
    <>
      <h1 {...props} />
      {after.node}
    </>
  )
}

// ── Markdown Viewer ──────────────────────────────────────

interface MarkdownViewerProps {
  content: string
  spaceId: string
  docPath: string
  /** Shown under the title (the opening level-one heading), or first when there is none. */
  afterTitle?: ReactNode
  /** The versions of the Doc's files, from its page. */
  fileVersions?: Readonly<Record<string, string>>
  /** The versions are on their way: the Space's images wait for them. */
  fileVersionsPending?: boolean
  /** For an old version: show its files as they were at this time. */
  filesAt?: string
}

export function MarkdownViewer({
  content,
  spaceId,
  docPath,
  afterTitle,
  fileVersions,
  fileVersionsPending = false,
  filesAt,
}: MarkdownViewerProps) {
  const router = useRouter()
  const fade = useScrollFade<HTMLDivElement>(8, { top: false })
  const paneWidth = usePaneWidth<HTMLDivElement>()
  const scrollRoot = useRef<HTMLDivElement | null>(null)
  const setScrollRoot = useCallback((node: HTMLDivElement | null) => {
    scrollRoot.current = node
  }, [])
  const scrollRef = useMemo(
    () => mergeRefs(fade, paneWidth, setScrollRoot),
    [fade, paneWidth, setScrollRoot]
  )
  const html = useHtmlPlugins(content)
  // What goes under the title renders inside the title's heading component,
  // which keeps one identity across renders so its state survives them.
  const titleLine = afterTitle != null ? markdownTitleLine(content) : null
  const afterTitleValue = useMemo(
    () => ({ line: titleLine, node: afterTitle }),
    [titleLine, afterTitle]
  )
  const { theme } = useTheme()
  // With files on, an image's relative path names a file in this Space.
  const filesOn = useDeploymentInfo().data?.capabilities.filesPreview ?? false
  const worktableOrigins = useMemo(
    () =>
      typeof window === "undefined"
        ? []
        : worktableLinkOrigins(window.location.origin, BASE_URL),
    []
  )
  const resolvedTheme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme

  // One identity per input, so a re-render of the Doc keeps its images,
  // diagrams and opened sections instead of mounting new ones: a new
  // component function is a new element type to React. The versions key on
  // their content, since each page read brings a new object.
  const versionsKey = JSON.stringify(fileVersions ?? null)
  const components = useMemo<Components>(
    () => ({
      h1: TitleHeading,
      a: ({ node, href = "", ...props }) => {
        void node
        const renderedHref = renderDocLinkHref(spaceId, docPath, href)
        return (
          <a
            {...props}
            href={renderedHref}
            onClick={(event) => {
              props.onClick?.(event)
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return
              if (renderedHref.startsWith("#")) return
              const anchor = event.currentTarget
              if (
                anchor.hasAttribute("download") ||
                (anchor.target && anchor.target !== "_self")
              )
                return
              const url = new URL(anchor.href)
              // Only app document routes belong to the client router.
              // Attachments, fragments and external URLs retain browser behavior.
              if (
                url.origin !== window.location.origin ||
                !/^\/spaces\/[^/]+\/(?:documents|docs|widgets)\//.test(
                  url.pathname
                )
              )
                return
              event.preventDefault()
              void router.navigate({
                href: url.pathname + url.search + url.hash,
              })
            }}
            {...externalLinkProps(renderedHref, worktableOrigins)}
          />
        )
      },
      table: ({ node, children }) => {
        void node
        return <DocTable>{children}</DocTable>
      },
      ol: ({ node, ...props }) => {
        void node
        return <NumberedList {...props} />
      },
      img: ({ node, title, src, ...props }) => {
        void node
        // A Space's image waits for its version, so it loads once.
        if (
          filesOn &&
          fileVersionsPending &&
          !filesAt &&
          typeof src === "string" &&
          resolveDocLink(docPath, src) !== null
        ) {
          return <span aria-hidden className="worktable-image-pending" />
        }
        const source =
          filesOn && typeof src === "string"
            ? embedSourceUrl(spaceId, docPath, src, {
                versions: fileVersions,
                at: filesAt,
              })
            : src
        // A size known from before holds the image's space, unless
        // the Doc gives one itself.
        const known =
          typeof source === "string" &&
          props.width === undefined &&
          props.height === undefined
            ? knownImageSize(source)
            : undefined
        const image = (
          <img
            {...known}
            {...props}
            src={source}
            title={title}
            onLoad={(event) => {
              if (typeof source === "string") {
                rememberImageSize(source, event.currentTarget)
              }
            }}
          />
        )
        return title ? (
          <span className="worktable-figure">
            {image}
            <span className="worktable-caption">{title}</span>
          </span>
        ) : (
          image
        )
      },
      details: ({ node, open, children }) => {
        void node
        return <DocDetails open={open}>{children}</DocDetails>
      },
      // Mapped directly, so DocDetails can find it among its children.
      summary: DocSummary,
      pre: ({ node, children, ...props }) => {
        void node
        const child = Array.isArray(children) ? children[0] : children
        const childProps = isValidElement<{
          className?: string
          children?: ReactNode
        }>(child)
          ? child.props
          : undefined
        const language = childProps?.className?.match(
          /(?:^|\s)language-(mermaid|mmd)(?:\s|$)/i
        )
        if (language) {
          const source = String(childProps?.children ?? "").replace(/\n$/, "")
          return (
            <Suspense
              fallback={
                <div className="min-h-24 animate-pulse rounded-lg bg-muted" />
              }
            >
              <MermaidRenderer
                name={`${docPath}-markdown`}
                chart={source}
                themeMode={resolvedTheme}
                errorFallback={
                  <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
                    <div className="flex items-center gap-2 font-medium">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      Diagram could not be rendered
                    </div>
                    <div className="mt-3 text-xs">
                      <DocDetails>
                        <DocSummary>View diagram source</DocSummary>
                        <ScrollableMermaidSource source={source} />
                      </DocDetails>
                    </div>
                  </div>
                }
              />
            </Suspense>
          )
        }
        void props
        const code = childProps?.className?.match(
          /(?:^|\s)language-([\w+#.-]+)/
        )
        return <CodeBlock language={code?.[1]}>{children}</CodeBlock>
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fileVersions by versionsKey
    [
      docPath,
      filesAt,
      filesOn,
      fileVersionsPending,
      resolvedTheme,
      router,
      spaceId,
      versionsKey,
      worktableOrigins,
    ]
  )

  return (
    <div className="flex h-full flex-col">
      {/* Scrollable content area with scroll fade (matches BlockNote editor) */}
      <div
        ref={scrollRef}
        data-document-scroll-root
        className="scroll-fade h-full w-full flex-1 overflow-auto"
      >
        <DataTooltips rootRef={scrollRoot} />
        <article className="worktable-markdown worktable-document-content">
          {afterTitle != null && titleLine === null && afterTitle}
          <MarkdownErrorBoundary>
            <AfterTitleContext value={afterTitleValue}>
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={html.rehypePlugins}
                skipHtml={html.skipHtml}
                components={components}
              >
                {content}
              </Markdown>
            </AfterTitleContext>
          </MarkdownErrorBoundary>
        </article>
      </div>
    </div>
  )
}
