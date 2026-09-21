import {
  BlockNoteEditor,
  BlockNoteSchema,
  createCodeBlockSpec,
} from "@blocknote/core"
import { withCollaboration, yXmlFragmentToBlocks } from "@blocknote/core/yjs"
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  FormattingToolbarController,
  FormattingToolbar,
  getFormattingToolbarItems,
  SideMenuController,
  SideMenu,
  AddBlockButton,
  DragHandleButton,
  DragHandleMenu,
  RemoveBlockItem,
  BlockColorsItem,
  useBlockNoteEditor,
  useComponentsContext,
  useExtension,
} from "@blocknote/react"
import type { DefaultReactSuggestionItem } from "@blocknote/react"
import {
  filterSuggestionItems,
  SideMenuExtension,
} from "@blocknote/core/extensions"
import { BlockNoteView } from "@blocknote/shadcn"
import { codeBlockOptions, syntaxHighlighter } from "@blocknote/code-block"
import type { Block } from "@blocknote/core"
import type * as Y from "yjs"
import { ySyncPluginKey } from "y-prosemirror"
import type { Awareness } from "y-protocols/awareness"
import type { Annotation, AnnotationCategory } from "@worktable/types"
import { MessageSquarePlus, Sparkles } from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { useTheme } from "@/components/theme-provider"
import { useServerSettings } from "@/hooks/use-server-settings"
import { initMermaidTouchHandler } from "./mermaid-touch-handler"
import {
  getBlockNoteCreationContent,
  normalizeEditorInitialContent,
} from "./initial-content"
import { MobileFormattingToolbar } from "./mobile-formatting-toolbar"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useIsMobile } from "@/hooks/use-mobile"

import {
  WorktableMermaidBlock,
  insertWorktableMermaid,
} from "./worktable-mermaid-block"
import { EditorSkeleton } from "./editor-skeleton"

const worktableCodeBlockOptions = {
  ...codeBlockOptions,
  supportedLanguages: Object.fromEntries(
    Object.entries(codeBlockOptions.supportedLanguages ?? {}).filter(
      ([language]) => language !== "mermaid" && language !== "mmd"
    )
  ),
}

// Upstream highlighting loads its parser on demand and supports both themes.
// Ordinary documents no longer start a highlighter during module evaluation.
let cachedSchema: ReturnType<typeof BlockNoteSchema.create> | null = null

function getSchema() {
  if (cachedSchema) return cachedSchema

  const blockSpecs: Record<string, unknown> = {
    ...BlockNoteSchema.create().blockSpecs,
    codeBlock: createCodeBlockSpec(worktableCodeBlockOptions),
  }

  blockSpecs.mermaid = WorktableMermaidBlock()

  cachedSchema = BlockNoteSchema.create({
    blockSpecs,
  } as Parameters<typeof BlockNoteSchema.create>[0])

  return cachedSchema
}

export async function blocksFromCollaborationDoc(ydoc: Y.Doc) {
  const editor = BlockNoteEditor.create({ schema: getSchema() })
  return yXmlFragmentToBlocks(editor, ydoc.getXmlFragment("document-store"))
}

type EditorBlock = Block

// A doc-changing transaction is treated as a human edit only when a user
// gesture in the editor UI happened this recently. Long enough to cover a
// toolbar click or menu pick reaching ProseMirror; short enough that the
// editor's open-time normalization (no gesture at all in this tree — the
// navigation click lives outside it) can't be misattributed.
const GESTURE_INTENT_WINDOW_MS = 2000

interface PmTransactionLike {
  docChanged: boolean
  getMeta(key: unknown): unknown
}

interface TiptapLike {
  on(
    event: "transaction",
    handler: (props: { transaction: PmTransactionLike }) => void
  ): void
  off(
    event: "transaction",
    handler: (props: { transaction: PmTransactionLike }) => void
  ): void
}

interface CollaborationConfig {
  ydoc: Y.Doc
  provider: { awareness?: Awareness }
  fragmentName?: string
  /**
   * Called when the local user genuinely edits (typing, paste, drop, cut,
   * toolbar/menu actions, block drags) — never on the editor's automatic
   * normalization/initial-sync transactions. Lets the server attribute the
   * resulting persist to a human rather than treating it as machine drift.
   */
  onLocalEdit?: () => void
}

interface AnnotationCreateRequest {
  blockId: string
  blockType?: string
  quote?: string
  category: AnnotationCategory
}

interface AnnotationBlock {
  id: string
  type?: string
}

interface AnnotationCapableEditor {
  isEditable: boolean
  getTextCursorPosition: () => { block: AnnotationBlock }
  getSelectedText?: () => string
  getSelection?: () => { blocks: AnnotationBlock[] } | undefined
}

interface EditorProps {
  onReady?: () => void
  initialContent?: EditorBlock[]
  onChange?: (blocks: EditorBlock[]) => void
  editable?: boolean
  collaboration?: CollaborationConfig
  annotations?: Annotation[]
  activeAnnotationId?: string | null
  onCreateAnnotation?: (request: AnnotationCreateRequest) => void
  onSelectAnnotation?: (annotation: Annotation) => void
}

export function Editor({
  onReady,
  initialContent,
  onChange,
  editable = true,
  collaboration,
  annotations = [],
  activeAnnotationId,
  onCreateAnnotation,
  onSelectAnnotation,
}: EditorProps) {
  const [mounted, setMounted] = useState(false)
  const { theme } = useTheme()
  const isMobile = useIsMobile()
  // Server-backed editor preference; default false until the query resolves.
  // Applied to the live editor DOM (not baked at creation), so a flip never
  // recreates the editor. See EditorInner's spellcheck effect.
  const spellcheck = useServerSettings().data?.editor.spellcheck ?? false

  const resolvedTheme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme

  return (
    <EditorInner
      onReady={onReady}
      initialContent={initialContent}
      onChange={onChange}
      editable={editable}
      collaboration={collaboration}
      annotations={annotations}
      activeAnnotationId={activeAnnotationId}
      onCreateAnnotation={onCreateAnnotation}
      onSelectAnnotation={onSelectAnnotation}
      resolvedTheme={resolvedTheme}
      mounted={mounted}
      setMounted={setMounted}
      isMobile={isMobile}
      spellcheck={spellcheck}
    />
  )
}

function EditorInner({
  onReady,
  initialContent,
  onChange,
  editable,
  collaboration,
  annotations = [],
  activeAnnotationId,
  onCreateAnnotation,
  onSelectAnnotation,
  resolvedTheme,
  mounted,
  setMounted,
  isMobile,
  spellcheck,
}: EditorProps & {
  resolvedTheme: "light" | "dark"
  mounted: boolean
  setMounted: (value: boolean) => void
  isMobile: boolean
  spellcheck: boolean
}) {
  const schema = useMemo(() => getSchema(), [])
  const normalizedInitialContent = useMemo(
    () =>
      normalizeEditorInitialContent(initialContent) as
        | EditorBlock[]
        | undefined,
    [initialContent]
  )

  const baseOptions = {
    schema,
    extensions: [syntaxHighlighter],
    _tiptapOptions: {
      editorProps: {
        attributes: {
          // Seed with the current value; the effect below keeps it in sync when
          // the setting flips (without recreating the editor — no content loss).
          spellcheck: spellcheck ? "true" : "false",
        },
      },
    },
  }
  const editor = useCreateBlockNote(
    collaboration
      ? withCollaboration({
          ...baseOptions,
          collaboration: {
            provider: collaboration.provider,
            fragment: collaboration.ydoc.getXmlFragment(
              collaboration.fragmentName ?? "document-store"
            ),
            user: { name: "You", color: "#0d7377" },
          },
        })
      : {
          ...baseOptions,
          initialContent: getBlockNoteCreationContent(normalizedInitialContent),
        }
  )

  useEffect(() => {
    setMounted(true)
  }, [setMounted])

  useEffect(() => {
    if (mounted) onReady?.()
  }, [mounted, onReady])

  // Reactively apply the spellcheck preference to the live ProseMirror node
  // (`editor.domElement`, the same node editorProps.attributes seeds). Setting
  // the attribute in place never touches document content, so toggling the
  // preference — collab or non-collab — can't lose edits. `mounted` re-runs it
  // once the DOM node exists.
  useEffect(() => {
    editor.domElement?.setAttribute("spellcheck", spellcheck ? "true" : "false")
  }, [editor, spellcheck, mounted])

  useEffect(() => {
    if (!onChange || collaboration) return

    const handleChange = () => {
      onChange(editor.document as unknown as Block[])
    }

    editor.onEditorContentChange(handleChange)
  }, [editor, onChange, collaboration])

  // Signal genuine human edits to the server. A human edit is a ProseMirror
  // transaction that (a) changes the doc, (b) is NOT an applied remote update
  // (those carry the y-prosemirror sync plugin meta), and (c) closely follows a
  // user gesture inside the editor UI. The gesture correlation is what excludes
  // the editor's own open-time normalization transactions — they change the doc
  // and are local, but no one touched the editor — while still counting toolbar
  // buttons, slash-menu picks, and block drags that never fire input events on
  // the contentEditable. Gestures are recorded via React capture handlers on the
  // editor wrapper (see EditorRoot), which see portaled UI (the mobile toolbar
  // renders into document.body but stays in this React tree).
  const onLocalEdit = collaboration?.onLocalEdit
  const lastGestureAtRef = useRef(0)
  useEffect(() => {
    if (!onLocalEdit) return
    const tiptap = (editor as unknown as { _tiptapEditor?: TiptapLike })
      ._tiptapEditor
    if (!tiptap) return

    const handler = ({ transaction }: { transaction: PmTransactionLike }) => {
      if (!transaction.docChanged) return
      if (transaction.getMeta(ySyncPluginKey)) return
      if (Date.now() - lastGestureAtRef.current > GESTURE_INTENT_WINDOW_MS)
        return
      onLocalEdit()
    }
    tiptap.on("transaction", handler)
    return () => {
      tiptap.off("transaction", handler)
    }
  }, [editor, onLocalEdit])

  useEffect(() => {
    if (collaboration) return
    if (normalizedInitialContent !== undefined && mounted) {
      editor.replaceBlocks(editor.document, normalizedInitialContent)
    }
  }, [normalizedInitialContent, editor, mounted, collaboration])

  const getSlashMenuItems = useMemo(
    () =>
      async (query: string): Promise<DefaultReactSuggestionItem[]> => {
        const annotationItems: DefaultReactSuggestionItem[] = onCreateAnnotation
          ? [
              {
                title: "Comment",
                group: "Collaboration",
                aliases: ["note", "annotation"],
                subtext: "Attach a comment to this block",
                icon: <MessageSquarePlus className="h-4 w-4" />,
                onItemClick: () => {
                  const block = editor.getTextCursorPosition().block
                  const selectedText = editor.getSelectedText?.() ?? undefined
                  onCreateAnnotation({
                    blockId: block.id,
                    blockType: block.type,
                    quote: selectedText,
                    category: "comment",
                  })
                },
              },
              {
                title: "Instruction",
                group: "Collaboration",
                aliases: ["instruct", "agent", "todo"],
                subtext: "Attach an agent-visible instruction",
                icon: <Sparkles className="h-4 w-4" />,
                onItemClick: () => {
                  const block = editor.getTextCursorPosition().block
                  const selectedText = editor.getSelectedText?.() ?? undefined
                  onCreateAnnotation({
                    blockId: block.id,
                    blockType: block.type,
                    quote: selectedText,
                    category: "instruction",
                  })
                },
              },
            ]
          : []
        const items: DefaultReactSuggestionItem[] = [
          ...getDefaultReactSlashMenuItems(editor),
          ...annotationItems,
          insertWorktableMermaid() as DefaultReactSuggestionItem,
        ]
        return filterSuggestionItems(items, query)
      },
    [editor, onCreateAnnotation]
  )

  const scrollFadeRef = useScrollFade<HTMLDivElement>(8, { top: false })
  const editorScrollRef = useRef<HTMLDivElement>(null)
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const setEditorScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      editorScrollRef.current = node
      scrollFadeRef(node)
    },
    [scrollFadeRef]
  )

  // Record user gestures for the human-edit transaction correlation above.
  // React capture handlers see events from everything in this React tree,
  // including portaled UI (the mobile toolbar portals to document.body) —
  // but NOT the app chrome outside the editor, which is what keeps a sidebar
  // navigation click from counting as an editor gesture.
  const markGesture = useCallback(() => {
    lastGestureAtRef.current = Date.now()
  }, [])

  useEffect(() => {
    if (!mounted || !editorContainerRef.current) return
    return initMermaidTouchHandler(editorContainerRef.current)
  }, [mounted])

  if (!mounted) {
    return <EditorSkeleton />
  }

  return (
    <div
      ref={setEditorScrollRef}
      className="scroll-fade worktable-editor-scroll-root h-full w-full overflow-auto"
      onPointerDownCapture={markGesture}
      onPointerUpCapture={markGesture}
      onKeyDownCapture={markGesture}
      onBeforeInputCapture={markGesture}
      onPasteCapture={markGesture}
      onCutCapture={markGesture}
      onDropCapture={markGesture}
    >
      <div
        ref={editorContainerRef}
        className="worktable-editor-content relative mx-auto w-full max-w-3xl px-6 py-8 sm:px-8 md:px-12"
      >
        <AnnotationBadges
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          containerRef={editorContainerRef}
          editor={editor as unknown as { document: Block[] }}
          onSelectAnnotation={onSelectAnnotation}
        />
        <BlockNoteView
          editor={editor}
          editable={editable}
          theme={resolvedTheme}
          slashMenu={false}
          formattingToolbar={false}
          sideMenu={false}
        >
          {isMobile ? (
            <MobileEditorToolbarController scrollRootRef={editorScrollRef} />
          ) : (
            <FormattingToolbarController
              formattingToolbar={() => (
                <AnnotationFormattingToolbar onAnnotate={onCreateAnnotation} />
              )}
            />
          )}
          <SideMenuController
            sideMenu={() => (
              <AnnotationSideMenu onAnnotate={onCreateAnnotation} />
            )}
          />
          <SuggestionMenuController
            triggerCharacter="/"
            getItems={getSlashMenuItems}
          />
        </BlockNoteView>
      </div>
    </div>
  )
}

function getSelectionRect() {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0).cloneRange()
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0
  )
  return rects.at(-1) ?? range.getBoundingClientRect()
}

function MobileEditorToolbarController({
  scrollRootRef,
}: {
  scrollRootRef: RefObject<HTMLDivElement | null>
}) {
  const editor = useBlockNoteEditor()
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)

  const isEditorInteractionActive = useCallback(() => {
    const editorElement = editor.domElement
    const activeElement = document.activeElement
    const selection = window.getSelection()

    return Boolean(
      editorElement &&
      ((activeElement && editorElement.contains(activeElement)) ||
        (selection?.anchorNode && editorElement.contains(selection.anchorNode)))
    )
  }, [editor])

  const keepSelectionVisible = useCallback(() => {
    if (!isEditorInteractionActive()) return

    const scrollRoot = scrollRootRef.current
    const selectionRect = getSelectionRect()
    if (!scrollRoot || !selectionRect) return

    const visualViewport = window.visualViewport
    const visualTop = visualViewport?.offsetTop ?? 0
    const visualBottom =
      visualTop + (visualViewport?.height ?? window.innerHeight)
    const toolbarRect = toolbarRef.current?.getBoundingClientRect()
    const rootRect = scrollRoot.getBoundingClientRect()
    const topGuard = Math.max(rootRect.top, visualTop) + 16
    const obstructionTop = toolbarRect?.height ? toolbarRect.top : visualBottom
    const bottomGuard =
      Math.min(rootRect.bottom, visualBottom, obstructionTop) - 28

    if (selectionRect.bottom > bottomGuard) {
      scrollRoot.scrollBy({
        top: selectionRect.bottom - bottomGuard,
        behavior: "smooth",
      })
      return
    }

    if (selectionRect.top < topGuard) {
      scrollRoot.scrollBy({
        top: selectionRect.top - topGuard,
        behavior: "smooth",
      })
    }
  }, [isEditorInteractionActive, scrollRootRef])

  useEffect(() => {
    setPortalTarget(document.body)
  }, [])

  useEffect(() => {
    let frame = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const schedule = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const nextActive = isEditorInteractionActive()
        setActive(nextActive)
        if (nextActive) keepSelectionVisible()
      })
    }

    const scheduleSettledChecks = () => {
      schedule()
      for (const delay of [120, 280, 520]) {
        const timer = setTimeout(schedule, delay)
        timers.add(timer)
      }
    }

    schedule()
    document.addEventListener("focusin", scheduleSettledChecks)
    document.addEventListener("focusout", scheduleSettledChecks)
    document.addEventListener("selectionchange", schedule)
    document.addEventListener("input", scheduleSettledChecks)
    window.visualViewport?.addEventListener("resize", scheduleSettledChecks, {
      passive: true,
    })
    window.visualViewport?.addEventListener("scroll", schedule, {
      passive: true,
    })
    window.visualViewport?.addEventListener(
      "scrollend",
      scheduleSettledChecks,
      { passive: true }
    )

    return () => {
      window.cancelAnimationFrame(frame)
      for (const timer of timers) clearTimeout(timer)
      document.removeEventListener("focusin", scheduleSettledChecks)
      document.removeEventListener("focusout", scheduleSettledChecks)
      document.removeEventListener("selectionchange", schedule)
      document.removeEventListener("input", scheduleSettledChecks)
      window.visualViewport?.removeEventListener(
        "resize",
        scheduleSettledChecks
      )
      window.visualViewport?.removeEventListener("scroll", schedule)
      window.visualViewport?.removeEventListener(
        "scrollend",
        scheduleSettledChecks
      )
    }
  }, [isEditorInteractionActive, keepSelectionVisible])

  useEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return

    const updateHeight = () => {
      document.documentElement.style.setProperty(
        "--app-mobile-toolbar-height",
        `${Math.ceil(toolbar.getBoundingClientRect().height || 56)}px`
      )
    }

    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [])

  const toolbar = (
    <div
      ref={toolbarRef}
      className="bn-mobile-formatting-toolbar worktable-mobile-formatting-toolbar-shell"
      data-active={active ? "true" : "false"}
      aria-hidden={!active}
    >
      <MobileFormattingToolbar />
    </div>
  )

  return portalTarget ? createPortal(toolbar, portalTarget) : toolbar
}

// Mirror of the server's textFromInline / re-anchoring in
// packages/server/src/annotation-store.ts — keep the normalization and
// first-match rule identical so badge placement and agent context agree.
function blockToPlainText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return ""
      const record = item as Record<string, unknown>
      if (typeof record.text === "string") return record.text
      return blockToPlainText(record.content)
    })
    .join("")
}

function normalizeQuote(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

// Depth-first, document-order flatten so the first quote match is deterministic.
function flattenEditorBlocks(blocks: Block[], out: Block[] = []): Block[] {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue
    out.push(block)
    const children = (block as { children?: unknown }).children
    if (Array.isArray(children)) flattenEditorBlocks(children as Block[], out)
  }
  return out
}

// When a stored blockId no longer exists in the current document (e.g. a doc was
// rewritten as markdown and block ids changed), relocate by the stored quote.
function resolveBlockIdByQuote(
  blocks: Block[],
  quote: string | undefined
): string | undefined {
  const needle = quote ? normalizeQuote(quote) : ""
  if (!needle) return undefined
  const match = flattenEditorBlocks(blocks).find((block) =>
    normalizeQuote(
      blockToPlainText((block as { content?: unknown }).content)
    ).includes(needle)
  )
  return match?.id
}

function AnnotationBadges({
  annotations,
  activeAnnotationId,
  containerRef,
  editor,
  onSelectAnnotation,
}: {
  annotations: Annotation[]
  activeAnnotationId?: string | null
  containerRef: RefObject<HTMLDivElement | null>
  editor: { document: Block[] }
  onSelectAnnotation?: (annotation: Annotation) => void
}) {
  const [positions, setPositions] = useState<
    Array<{ blockId: string; top: number; annotations: Annotation[] }>
  >([])

  useEffect(() => {
    // No badges means no model traversal, forced layout, timer, or resize work.
    if (
      !annotations.some(
        (annotation) =>
          annotation.status !== "resolved" &&
          "blockId" in annotation.target &&
          annotation.target.blockId
      )
    ) {
      setPositions((previous) => (previous.length ? [] : previous))
      return
    }
    const update = () => {
      const container = containerRef.current
      if (!container) return
      const containerRect = container.getBoundingClientRect()
      const grouped = new Map<string, Annotation[]>()
      for (const annotation of annotations) {
        if (annotation.status === "resolved") continue
        if (!("blockId" in annotation.target) || !annotation.target.blockId)
          continue
        const blockId = annotation.target.blockId
        const list = grouped.get(blockId) ?? []
        list.push(annotation)
        grouped.set(blockId, list)
      }
      // Block IDs actually present in the document. Used to tell genuine ID drift
      // apart from a block whose DOM node is only transiently missing mid-render.
      const liveBlockIds = new Set(
        flattenEditorBlocks(editor.document).map((block) => block.id)
      )
      const next: Array<{
        blockId: string
        top: number
        annotations: Annotation[]
      }> = []
      for (const [blockId, blockAnnotations] of grouped) {
        let node = container.querySelector(
          `[data-id="${CSS.escape(blockId)}"]`
        ) as HTMLElement | null
        // Re-anchor by quote only when the block is genuinely gone from the
        // document — not when the stored ID still exists but its node is missing
        // from the DOM this tick, since a transient miss could otherwise relocate
        // the badge to a different block whose text happens to match the quote.
        if (!node && !liveBlockIds.has(blockId)) {
          const quote = blockAnnotations
            .map((annotation) =>
              "quote" in annotation.target ? annotation.target.quote : undefined
            )
            .find(Boolean)
          const resolvedId = resolveBlockIdByQuote(editor.document, quote)
          if (resolvedId) {
            node = container.querySelector(
              `[data-id="${CSS.escape(resolvedId)}"]`
            ) as HTMLElement | null
          }
        }
        if (!node) continue
        const rect = node.getBoundingClientRect()
        next.push({
          blockId,
          top: rect.top - containerRect.top + container.scrollTop + 2,
          annotations: blockAnnotations,
        })
      }
      setPositions(next)
    }
    update()
    window.addEventListener("resize", update)
    const timer = window.setInterval(update, 1000)
    return () => {
      window.removeEventListener("resize", update)
      window.clearInterval(timer)
    }
  }, [annotations, containerRef, editor])

  if (!positions.length) return null

  return (
    <div className="pointer-events-none absolute inset-y-0 right-1 z-20 sm:right-3 print:hidden">
      {positions.map(({ blockId, top, annotations: blockAnnotations }) => {
        const active = blockAnnotations.some(
          (annotation) => annotation.id === activeAnnotationId
        )
        const primary = blockAnnotations[0]!
        const hasInstruction = blockAnnotations.some(
          (annotation) => annotation.category === "instruction"
        )
        return (
          <button
            key={blockId}
            type="button"
            aria-label={`${blockAnnotations.length} annotations for this block`}
            onClick={() => onSelectAnnotation?.(primary)}
            className={`pointer-events-auto absolute right-0 flex h-7 min-w-7 items-center justify-center rounded-full border px-2 text-xs font-medium shadow-sm transition-colors ${
              active
                ? "border-primary bg-surface-selected text-primary"
                : hasInstruction
                  ? "border-primary/30 bg-surface-tint text-primary hover:bg-surface-selected"
                  : "border-border bg-popover text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            style={{ top }}
          >
            {hasInstruction ? (
              <Sparkles className="mr-1 h-3 w-3" />
            ) : (
              <MessageSquarePlus className="mr-1 h-3 w-3" />
            )}
            {blockAnnotations.length}
          </button>
        )
      })}
    </div>
  )
}

function createAnnotationFromEditor(
  editor: AnnotationCapableEditor,
  onAnnotate: ((request: AnnotationCreateRequest) => void) | undefined,
  category: AnnotationCategory = "comment",
  block?: AnnotationBlock
) {
  if (!onAnnotate) return
  // Each trigger anchors to the block it's actually about:
  // - drag handle passes the hovered block explicitly,
  // - the formatting toolbar (text selected) anchors to the selection's start block,
  // - everything else falls back to the caret's block.
  const target =
    block ??
    editor.getSelection?.()?.blocks[0] ??
    editor.getTextCursorPosition().block
  const quote = editor.getSelectedText?.() || undefined
  onAnnotate({ blockId: target.id, blockType: target.type, quote, category })
}

function AnnotationToolbarButton({
  onAnnotate,
}: {
  onAnnotate?: (request: AnnotationCreateRequest) => void
}) {
  const editor = useBlockNoteEditor() as AnnotationCapableEditor
  const Components = useComponentsContext()!

  if (!onAnnotate || !editor.isEditable) return null

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      data-test="annotate"
      onClick={() => createAnnotationFromEditor(editor, onAnnotate)}
      label="Annotate"
      mainTooltip="Annotate"
      icon={<MessageSquarePlus className="h-4 w-4" />}
    />
  )
}

function AnnotationFormattingToolbar({
  onAnnotate,
}: {
  onAnnotate?: (request: AnnotationCreateRequest) => void
}) {
  const items = getFormattingToolbarItems()
  return (
    <FormattingToolbar>
      {items.flatMap((item) => {
        if (
          item.key === "addCommentButton" ||
          item.key === "addTiptapCommentButton"
        ) {
          return []
        }
        if (item.key === "blockTypeSelect") {
          return [
            item,
            <AnnotationToolbarButton
              key="annotateButton"
              onAnnotate={onAnnotate}
            />,
          ]
        }
        return [item]
      })}
    </FormattingToolbar>
  )
}

function AnnotationDragHandleMenu({
  onAnnotate,
}: {
  onAnnotate?: (request: AnnotationCreateRequest) => void
}) {
  const editor = useBlockNoteEditor() as AnnotationCapableEditor
  const sideMenu = useExtension(SideMenuExtension)
  const Components = useComponentsContext()!

  return (
    <DragHandleMenu>
      {onAnnotate && (
        <Components.Generic.Menu.Item
          className="bn-menu-item"
          onClick={() => {
            const block = sideMenu.store?.state?.block
            sideMenu.unfreezeMenu()
            createAnnotationFromEditor(editor, onAnnotate, "comment", block)
          }}
        >
          Annotate
        </Components.Generic.Menu.Item>
      )}
      <RemoveBlockItem>Delete</RemoveBlockItem>
      <BlockColorsItem>Colors</BlockColorsItem>
    </DragHandleMenu>
  )
}

function AnnotationSideMenu({
  onAnnotate,
}: {
  onAnnotate?: (request: AnnotationCreateRequest) => void
}) {
  return (
    <SideMenu>
      <AddBlockButton />
      <DragHandleButton
        dragHandleMenu={() => (
          <AnnotationDragHandleMenu onAnnotate={onAnnotate} />
        )}
      />
    </SideMenu>
  )
}
