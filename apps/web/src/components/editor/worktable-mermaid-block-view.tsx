import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Lock,
  LockOpen,
  Pencil,
  Workflow,
} from "lucide-react"
import CodeMirror from "@uiw/react-codemirror"
import { mermaid as mermaidLanguage } from "codemirror-lang-mermaid"
import { useCallback, useMemo, useState } from "react"
import { Button } from "@worktable/ui/components/button"
import { Badge } from "@worktable/ui/components/badge"
import { cn } from "@worktable/ui/lib/utils"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { WorktableMermaidRenderer } from "./worktable-mermaid-renderer"
import { MERMAID_EXAMPLES } from "./worktable-mermaid-examples"
import type { MermaidExample } from "./worktable-mermaid-examples"
import { useTheme } from "@/components/theme-provider"

/** Small identity tile shown in both collapsed and expanded headers. */
function MermaidIconTile() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      <Workflow className="size-4" />
    </span>
  )
}

export default function MermaidBlockComponent({
  block,
  editor,
}: {
  block: any
  editor: any
}) {
  const isReadOnly = useMemo(() => !editor.isEditable, [editor])
  const { data, locked, title, collapsed } = block.props
  const isLocked = locked === "true"
  const isCollapsed = collapsed === "true"

  const updateProps = useCallback(
    (patch: Record<string, string>) => {
      editor.updateBlock(block, { props: { ...block.props, ...patch } })
    },
    [block, editor]
  )

  const toggleCollapse = useCallback(
    () => updateProps({ collapsed: isCollapsed ? "false" : "true" }),
    [isCollapsed, updateProps]
  )

  const toggleLock = useCallback(
    () => updateProps({ locked: isLocked ? "false" : "true" }),
    [isLocked, updateProps]
  )

  const languageExtension = useMemo(() => mermaidLanguage(), [])
  const [showEditor, setShowEditor] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const templatesScrollRef = useScrollFade<HTMLDivElement>()

  const categories = useMemo(
    () => [...new Set(MERMAID_EXAMPLES.map((example) => example.category))],
    []
  )
  const visibleExamples = useMemo(
    () =>
      MERMAID_EXAMPLES.filter(
        (example) => !activeCategory || example.category === activeCategory
      ),
    [activeCategory]
  )

  const { theme } = useTheme()
  const resolvedTheme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme

  if (isCollapsed) {
    return (
      <div
        className={cn(
          "mermaid-block-shell @container w-full cursor-pointer select-none",
          "flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card/60 px-3.5 py-2.5",
          "transition-colors hover:border-primary/25 hover:bg-card"
        )}
        onClick={toggleCollapse}
        role="button"
        aria-expanded={false}
        title="Expand diagram"
      >
        <MermaidIconTile />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title || "Untitled Diagram"}
        </span>
        {isLocked && (
          <Badge variant="secondary" className="hidden @sm:inline-flex">
            Locked
          </Badge>
        )}
        <Badge
          variant="outline"
          className="hidden text-muted-foreground @sm:inline-flex"
        >
          Diagram
        </Badge>
        <ChevronsUpDown className="mermaid-collapse-hint size-4 shrink-0 text-muted-foreground" />
      </div>
    )
  }

  return (
    <div
      className={cn(
        "mermaid-block-shell @container flex w-full flex-col",
        !isReadOnly && "gap-2 rounded-xl border border-border bg-card/40 p-2.5"
      )}
    >
      {!isReadOnly && (
        <div className="mermaid-authoring-header flex min-w-0 items-center gap-2">
          <MermaidIconTile />

          {editingTitle && !isLocked ? (
            <input
              type="text"
              value={title}
              onChange={(event) => updateProps({ title: event.target.value })}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "Escape")
                  setEditingTitle(false)
              }}
              autoFocus
              placeholder="Diagram title…"
              className={cn(
                "h-8 min-w-0 flex-1 rounded-lg border border-primary/40 bg-background px-2.5",
                "text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              )}
            />
          ) : (
            <button
              type="button"
              className={cn(
                "group/title flex min-w-0 flex-1 items-center gap-1.5 text-left",
                isLocked ? "cursor-default" : "cursor-text"
              )}
              onClick={() => {
                if (!isLocked) setEditingTitle(true)
              }}
              title={isLocked ? undefined : "Rename diagram"}
            >
              <span className="truncate text-sm font-medium text-foreground">
                {title || "Untitled Diagram"}
              </span>
              {!isLocked && (
                <Pencil className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100" />
              )}
            </button>
          )}

          <div className="flex shrink-0 items-center gap-1">
            {isLocked && (
              <Badge variant="secondary" className="hidden @md:inline-flex">
                View only
              </Badge>
            )}
            {!isLocked && (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-pressed={showEditor}
                  className={cn(showEditor && "bg-muted text-foreground")}
                  onClick={() => setShowEditor((current) => !current)}
                  title={showEditor ? "Hide source" : "Edit source"}
                >
                  <Code2 className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-pressed={showTemplates}
                  className={cn(showTemplates && "bg-muted text-foreground")}
                  onClick={() => setShowTemplates((current) => !current)}
                  title="Templates"
                >
                  <ChevronDown
                    className={cn(
                      "size-3.5 transition-transform",
                      showTemplates && "rotate-180"
                    )}
                  />
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-pressed={isLocked}
              onClick={toggleLock}
              title={isLocked ? "Unlock to edit" : "Lock to prevent editing"}
            >
              {isLocked ? (
                <Lock className="size-3.5" />
              ) : (
                <LockOpen className="size-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={toggleCollapse}
              title="Collapse diagram"
            >
              <ChevronsDownUp className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {!isReadOnly && !isLocked && showTemplates && (
        <div className="mermaid-authoring-ui rounded-lg border border-border bg-background/40 p-2.5">
          <div className="mb-2 flex flex-wrap gap-1">
            {[null, ...categories].map((category) => (
              <Button
                key={category ?? "all"}
                variant="ghost"
                size="xs"
                aria-pressed={activeCategory === category}
                className={cn(
                  "h-6 rounded-full px-2.5 text-xs",
                  activeCategory === category &&
                    "bg-surface-tint text-primary-text"
                )}
                onClick={() => setActiveCategory(category)}
              >
                {category ?? "All"}
              </Button>
            ))}
          </div>
          <div
            ref={templatesScrollRef}
            className="scroll-fade grid max-h-44 grid-cols-2 gap-1.5 overflow-y-auto @md:grid-cols-3 @2xl:grid-cols-4"
            style={{ "--sf-size": "20px" } as React.CSSProperties}
          >
            {visibleExamples.map((example: MermaidExample) => (
              <button
                key={example.name}
                type="button"
                className={cn(
                  "rounded-lg border border-border bg-card/60 p-2.5 text-left transition-colors",
                  "hover:border-primary/30 hover:bg-card"
                )}
                onClick={() => {
                  updateProps({ data: example.code })
                  setShowTemplates(false)
                }}
              >
                <div className="truncate text-sm font-medium text-foreground">
                  {example.name}
                </div>
                <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                  {example.description}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {!isReadOnly && !isLocked && showEditor && (
        <div className="mermaid-source-editor overflow-hidden rounded-lg border border-border">
          <CodeMirror
            placeholder="Write your mermaid code here…"
            style={{ width: "100%" }}
            extensions={[languageExtension]}
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
              syntaxHighlighting: true,
            }}
            theme={resolvedTheme === "dark" ? "dark" : "light"}
            value={data}
            width="100%"
            height="200px"
            onChange={(value) => updateProps({ data: value })}
          />
        </div>
      )}

      <div
        className={cn(
          !isReadOnly &&
            "overflow-hidden rounded-lg border border-border/60 bg-background/30"
        )}
      >
        <WorktableMermaidRenderer
          name={block.id}
          chart={data.trim()}
          themeMode={resolvedTheme}
          showToolbar={!isReadOnly}
        />
      </div>
    </div>
  )
}
