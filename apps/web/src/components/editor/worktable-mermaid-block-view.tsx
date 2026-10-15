import {
  ChevronRight,
  ChevronsDownUp,
  Code2,
  LayoutGrid,
  Lock,
  LockOpen,
} from "lucide-react"
import { lazy, Suspense, useCallback, useMemo, useState } from "react"
import { DEFAULT_MERMAID_TITLE } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { DocIconButton } from "@/components/document/doc-icon-button"
import { WorktableMermaidRenderer } from "./worktable-mermaid-renderer"
import { MERMAID_EXAMPLES } from "./worktable-mermaid-examples"
import type { MermaidExample } from "./worktable-mermaid-examples"
import { useTheme } from "@/components/theme-provider"

const loadSourceEditor = () => import("./worktable-mermaid-source-editor")
const MermaidSourceEditor = lazy(loadSourceEditor)
// A hint only: opening the editor loads it again and reports any failure.
const preloadSourceEditor = () => void loadSourceEditor().catch(() => {})

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
  // The default name is a placeholder, not something anyone wrote.
  const name = title && title !== DEFAULT_MERMAID_TITLE ? title : ""

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

  const [showEditor, setShowEditor] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  // Panels mount on first opening, then stay mounted so closing can unfold.
  const [opened, setOpened] = useState({ editor: false, templates: false })
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const templatesScrollRef = useScrollFade<HTMLDivElement>()
  const canEdit = !isReadOnly && !isLocked

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
      <button
        type="button"
        className="mermaid-block-shell worktable-diagram-collapsed"
        onClick={toggleCollapse}
        aria-expanded={false}
      >
        <ChevronRight />
        <span className="truncate">{name || "Diagram"}</span>
        {name && <span className="worktable-diagram-kind">· Diagram</span>}
      </button>
    )
  }

  const controls = isReadOnly ? null : (
    <>
      {canEdit && (
        <>
          <DocIconButton
            label="Edit source"
            aria-pressed={showEditor}
            onClick={() => {
              setOpened((current) => ({ ...current, editor: true }))
              setShowEditor((current) => !current)
            }}
            onPointerEnter={preloadSourceEditor}
            onFocus={preloadSourceEditor}
          >
            <Code2 />
          </DocIconButton>
          <DocIconButton
            label="Templates"
            aria-pressed={showTemplates}
            onClick={() => {
              setOpened((current) => ({ ...current, templates: true }))
              setShowTemplates((current) => !current)
            }}
          >
            <LayoutGrid />
          </DocIconButton>
        </>
      )}
      <DocIconButton
        label={isLocked ? "Unlock" : "Lock"}
        aria-pressed={isLocked}
        onClick={() => updateProps({ locked: isLocked ? "false" : "true" })}
      >
        {isLocked ? <Lock /> : <LockOpen />}
      </DocIconButton>
      <DocIconButton label="Collapse" onClick={toggleCollapse}>
        <ChevronsDownUp />
      </DocIconButton>
    </>
  )

  const footer = canEdit ? (
    <>
      <div className="worktable-unfold" data-open={showTemplates || undefined}>
        <div>
          {opened.templates && (
            <div className="mermaid-authoring-ui border-t border-border p-2.5">
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
                      "rounded-lg card-surface-interactive card-surface p-2.5 text-left"
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
        </div>
      </div>
      <div className="worktable-unfold" data-open={showEditor || undefined}>
        <div>
          {opened.editor && (
            <div className="mermaid-source-editor border-t border-border">
              <input
                type="text"
                value={name}
                onChange={(event) =>
                  updateProps({
                    title: event.target.value || DEFAULT_MERMAID_TITLE,
                  })
                }
                placeholder="Caption"
                aria-label="Caption"
                className="h-9 w-full border-b border-border bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              <Suspense fallback={<div className="h-[200px]" />}>
                <MermaidSourceEditor
                  value={data}
                  theme={resolvedTheme === "dark" ? "dark" : "light"}
                  onChange={(value) => updateProps({ data: value })}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </>
  ) : null

  return (
    <div className="mermaid-block-shell @container w-full">
      <WorktableMermaidRenderer
        name={block.id}
        chart={data.trim()}
        themeMode={resolvedTheme}
        title={name || undefined}
        caption={name || undefined}
        controls={controls}
        footer={footer}
        editing={canEdit && (showEditor || showTemplates)}
      />
    </div>
  )
}
