/**
 * Read-only markdown viewer for .md documents.
 * Uses react-markdown + remark-gfm for GFM support (tables, checkboxes, etc.)
 * Styled to match BlockNote editor layout (max-w-3xl, same padding).
 */

import {
  Component,
  Suspense,
  isValidElement,
  lazy,
  useMemo,
  type ErrorInfo,
  type ReactNode,
} from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { AlertTriangle } from "lucide-react"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useScrollFadeX } from "@/hooks/use-scroll-fade-x"
import { renderDocLinkHref } from "@/lib/doc-links"
import { externalLinkProps, worktableLinkOrigins } from "@/lib/external-links"
import { BASE_URL } from "@/lib/http"
import { useTheme } from "@/components/theme-provider"

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

// ── Markdown Viewer ──────────────────────────────────────

interface MarkdownViewerProps {
  content: string
  spaceId: string
  docPath: string
}

export function MarkdownViewer({
  content,
  spaceId,
  docPath,
}: MarkdownViewerProps) {
  const scrollRef = useScrollFade<HTMLDivElement>(8, { top: false })
  const { theme } = useTheme()
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

  return (
    <div className="flex h-full flex-col">
      {/* Scrollable content area with scroll fade (matches BlockNote editor) */}
      <div
        ref={scrollRef}
        className="scroll-fade h-full w-full flex-1 overflow-auto"
      >
        <article className="worktable-markdown mx-auto w-full max-w-3xl px-6 py-8 sm:px-8 md:px-12">
          <MarkdownErrorBoundary>
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node, href = "", ...props }) => {
                  void node
                  const renderedHref = renderDocLinkHref(spaceId, docPath, href)
                  return (
                    <a
                      {...props}
                      href={renderedHref}
                      {...externalLinkProps(renderedHref, worktableOrigins)}
                    />
                  )
                },
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
                    const source = String(childProps?.children ?? "").replace(
                      /\n$/,
                      ""
                    )
                    return (
                      <Suspense
                        fallback={
                          <div className="min-h-24 animate-pulse rounded-lg bg-muted/50" />
                        }
                      >
                        <MermaidRenderer
                          name={`${docPath}-markdown`}
                          chart={source}
                          themeMode={resolvedTheme}
                          showToolbar={false}
                          errorFallback={
                            <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
                              <div className="flex items-center gap-2 font-medium">
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                Diagram could not be rendered
                              </div>
                              <details className="mt-3 text-xs text-muted-foreground">
                                <summary className="cursor-pointer font-medium select-none">
                                  View diagram source
                                </summary>
                                <ScrollableMermaidSource source={source} />
                              </details>
                            </div>
                          }
                        />
                      </Suspense>
                    )
                  }
                  return <pre {...props}>{children}</pre>
                },
              }}
            >
              {content}
            </Markdown>
          </MarkdownErrorBoundary>
        </article>
      </div>
    </div>
  )
}
