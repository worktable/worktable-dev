import { BlockNoteEditor, BlockNoteSchema } from "@blocknote/core"
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
import type {
  DefaultReactSuggestionItem,
  FloatingUIOptions,
} from "@blocknote/react"
import {
  filterSuggestionItems,
  SideMenuExtension,
} from "@blocknote/core/extensions"
import { BlockNoteView } from "@blocknote/shadcn"
// Editor-only styles load with this chunk, not the app's root stylesheet.
import "@blocknote/shadcn/style.css"
import "@/styles/blocknote.css"
import "@/styles/document-controls.css"
import { syntaxHighlighter } from "@blocknote/code-block"
import type { Block } from "@blocknote/core"
import type * as Y from "yjs"
import { ySyncPluginKey } from "y-prosemirror"
import { TextSelection } from "@tiptap/pm/state"
import type { Awareness } from "y-protocols/awareness"
import type { Annotation } from "@worktable/types"
import { findPassageBlock } from "@worktable/types"
import { MessageSquarePlus } from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react"
import { createPortal } from "react-dom"
import { useTheme } from "@/components/theme-provider"
import { useServerSettings } from "@/hooks/use-server-settings"
import {
  rangeForPassage,
  readPassageText,
  setHighlight,
} from "@/components/annotations/passage-text"
import { initMermaidTouchHandler } from "./mermaid-touch-handler"
import {
  afterTitleKey,
  afterTitlePlugin,
  type TitleOptions,
} from "./after-title-widget"
import {
  getBlockNoteCreationContent,
  normalizeEditorInitialContent,
} from "./initial-content"
import { MobileFormattingToolbar } from "./mobile-formatting-toolbar"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useIsMobile } from "@/hooks/use-mobile"
import { sideMenuFirstLine } from "./side-menu-position"
import { usePaneWidth } from "@/hooks/use-pane-width"
import { DataTooltips } from "@/components/document/data-tooltip"
import { createRichCodeBlockSpec } from "./rich-code-block"
import { TableExpandControl } from "./table-expand"

import {
  WorktableMermaidBlock,
  insertWorktableMermaid,
} from "./worktable-mermaid-block"

const sideMenuFloatingOptions: Partial<FloatingUIOptions> = {
  useFloatingOptions: { middleware: [sideMenuFirstLine] },
}

// Upstream highlighting loads its parser on demand and supports both themes.
// Ordinary documents no longer start a highlighter during module evaluation.
let cachedSchema: ReturnType<typeof BlockNoteSchema.create> | null = null

function getSchema() {
  if (cachedSchema) return cachedSchema

  const blockSpecs: Record<string, unknown> = {
    ...BlockNoteSchema.create().blockSpecs,
    codeBlock: createRichCodeBlockSpec(),
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
  /** What the comment box opens next to: the selection, or the block. */
  anchor?: Range | Element
}

interface AnnotationBlock {
  id: string
  type?: string
}

interface AnnotationCapableEditor {
  isEditable: boolean
  domElement?: HTMLElement
  getTextCursorPosition: () => { block: AnnotationBlock }
  getSelectedText?: () => string
  getSelection?: () => { blocks: AnnotationBlock[] } | undefined
}

/** What a Doc's page can ask of its editor once the editor is shown. */
export interface EditorHandle {
  /** Put the caret at the start of what this element shows, without scrolling. */
  placeCaret(element: Element): void
}

interface EditorProps {
  onReady?: (handle: EditorHandle) => void
  initialContent?: EditorBlock[]
  onChange?: (blocks: EditorBlock[]) => void
  editable?: boolean
  collaboration?: CollaborationConfig
  annotations?: Annotation[]
  activeAnnotationId?: string | null
  onCreateAnnotation?: (request: AnnotationCreateRequest) => void
  onSelectAnnotation?: (annotation: Annotation) => void
  /**
   * Marks the text open comments are about, as a Markdown Doc does, and says
   * which comments' text is gone. Only for the editor on screen.
   */
  passages?: EditorPassages
  /** Shown under the title (the opening level-one heading), outside the content. */
  afterTitle?: ReactNode
  /** How the editor shows the Doc's name, its title. */
  title?: EditorTitle
  /**
   * The Doc's files: where an embed loads from, and, while editing, how a
   * pasted or dropped file is saved. Without it, media blocks take URLs only.
   */
  files?: EditorFiles
}

export interface EditorPassages {
  /** Text a comment is about was pressed. */
  onClick: (annotation: Annotation) => void
  /** The open comments whose text is no longer in the Doc. */
  onDetached: (annotationIds: ReadonlySet<string>) => void
}

export interface EditorFiles {
  /** The URL an embed's stored path loads from. */
  resolve: (url: string) => string
  /** Save a file into the Doc's folder; returns the path to embed. */
  upload?: (file: File) => Promise<string>
}

/** The file handlers an editor made once reads, always the latest given. */
class LatestFiles {
  private files: EditorFiles | undefined
  constructor(files: EditorFiles | undefined) {
    this.files = files
  }
  set(files: EditorFiles | undefined): void {
    this.files = files
  }
  resolve(url: string): string {
    return this.files ? this.files.resolve(url) : url
  }
  upload(file: File): Promise<string> {
    const upload = this.files?.upload
    if (!upload) return Promise.reject(new Error("Files can't be added to this Doc now"))
    return upload(file)
  }
}

export interface EditorTitle {
  /** Grey text for an empty title, and for a Doc that has none yet. */
  placeholder: string
  /** Start with the caret in the title, for a Doc just created. */
  focus?: boolean
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
  passages,
  afterTitle,
  title,
  files,
}: EditorProps) {
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
      passages={passages}
      afterTitle={afterTitle}
      title={title}
      files={files}
      resolvedTheme={resolvedTheme}
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
  passages,
  afterTitle,
  title,
  files,
  resolvedTheme,
  isMobile,
  spellcheck,
}: EditorProps & {
  resolvedTheme: "light" | "dark"
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

  // The editor is made once; its file handlers read the latest ones, so
  // versions that arrive with the Doc's page still reach its images.
  const [currentFiles] = useState(() => new LatestFiles(files))
  useEffect(() => currentFiles.set(files), [currentFiles, files])
  const baseOptions = {
    schema,
    extensions: [syntaxHighlighter],
    ...(files
      ? {
          resolveFileUrl: async (url: string) => currentFiles.resolve(url),
          ...(files.upload
            ? { uploadFile: (file: File) => currentFiles.upload(file) }
            : {}),
        }
      : {}),
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

  // This editor is only rendered by client-side document routes. BlockNote
  // mounts its DOM in a ref callback, before this passive readiness effect;
  // a separate mount-state skeleton would add another unnecessary commit.
  useEffect(() => {
    onReady?.({
      placeCaret: (element) => {
        const view = editor.prosemirrorView
        if (!view || !editor.isEditable || !view.dom.contains(element)) return
        const pos = view.posAtDOM(element, 0)
        editor.transact((tr) =>
          tr.setSelection(TextSelection.near(tr.doc.resolve(pos)))
        )
        editor.focus()
      },
    })
  }, [editor, onReady])

  // Reactively apply the spellcheck preference to the live ProseMirror node
  // (`editor.domElement`, the same node editorProps.attributes seeds). Setting
  // the attribute in place never touches document content, so toggling the
  // preference — collab or non-collab — can't lose edits. The DOM ref is
  // attached before effects run.
  useEffect(() => {
    editor.domElement?.setAttribute("spellcheck", spellcheck ? "true" : "false")
  }, [editor, spellcheck])

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

  // What goes under the title lives in a widget ProseMirror places between
  // blocks; React renders into it through a portal.
  const [afterTitleHost] = useState(() => {
    const host = document.createElement("div")
    host.className = "worktable-after-title"
    host.contentEditable = "false"
    return host
  })
  const showsAfterTitle = afterTitle != null
  const showsTitle = title != null
  // The plugin reads the title options on each update, so new ones need no
  // new plugin, only a transaction to show them.
  const titleOptions = useRef<TitleOptions | null>(null)
  const titlePlaceholder = title?.placeholder
  useEffect(() => {
    titleOptions.current =
      titlePlaceholder === undefined
        ? null
        : {
            placeholder: titlePlaceholder,
            onCreate: editable
              ? () => {
                  const first = editor.document[0]
                  if (!first) return
                  const [added] = editor.insertBlocks(
                    [{ type: "heading", props: { level: 1 } }],
                    first,
                    "before"
                  )
                  if (added) editor.setTextCursorPosition(added, "start")
                  editor.focus()
                }
              : undefined,
          }
    const view = (
      editor as unknown as {
        _tiptapEditor?: {
          view?: { state: { tr: unknown }; dispatch(tr: unknown): void }
        }
      }
    )._tiptapEditor?.view
    view?.dispatch(view.state.tr)
  }, [editor, editable, titlePlaceholder])
  useEffect(() => {
    if (!showsAfterTitle && !showsTitle) return
    const tiptap = (
      editor as unknown as {
        _tiptapEditor?: {
          registerPlugin(plugin: ReturnType<typeof afterTitlePlugin>): void
          unregisterPlugin(key: typeof afterTitleKey): void
        }
      }
    )._tiptapEditor
    if (!tiptap) return
    tiptap.registerPlugin(
      afterTitlePlugin(showsAfterTitle ? afterTitleHost : null, titleOptions)
    )
    return () => tiptap.unregisterPlugin(afterTitleKey)
  }, [editor, showsAfterTitle, showsTitle, afterTitleHost])

  // A Doc just created starts with the caret in its empty title. Its content
  // arrives with the first sync, so look again as the editor changes, for a
  // moment only: a title that is still empty later is not for this.
  const focusTitle = editable && title?.focus === true
  useEffect(() => {
    if (!focusTitle) return
    const tiptap = (editor as unknown as { _tiptapEditor?: TiptapLike })
      ._tiptapEditor
    if (!tiptap) return
    const until = Date.now() + 5_000
    const tryFocus = () => {
      if (Date.now() > until) return stop()
      const first = editor.document[0] as
        | { type?: string; props?: { level?: number }; content?: unknown[] }
        | undefined
      if (
        first?.type !== "heading" ||
        (first.props?.level ?? 1) !== 1 ||
        (first.content?.length ?? 0) > 0
      ) {
        return
      }
      // Placing the caret is itself a transaction; stop listening first.
      stop()
      editor.setTextCursorPosition(editor.document[0]!, "start")
      editor.focus()
    }
    const stop = () => tiptap.off("transaction", tryFocus)
    tiptap.on("transaction", tryFocus)
    tryFocus()
    return stop
  }, [editor, focusTitle])

  useEffect(() => {
    if (collaboration) return
    if (normalizedInitialContent !== undefined) {
      editor.replaceBlocks(editor.document, normalizedInitialContent)
    }
  }, [normalizedInitialContent, editor, collaboration])

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
                icon: <MessageSquarePlus className="size-4.5" />,
                onItemClick: () => {
                  const block = editor.getTextCursorPosition().block
                  const selectedText = editor.getSelectedText?.() ?? undefined
                  onCreateAnnotation({
                    blockId: block.id,
                    blockType: block.type,
                    quote: selectedText,
                    anchor: annotationAnchor(editor, block.id, false),
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
  const paneWidthRef = usePaneWidth<HTMLDivElement>()
  const setEditorScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      editorScrollRef.current = node
      scrollFadeRef(node)
      paneWidthRef(node)
    },
    [scrollFadeRef, paneWidthRef]
  )

  // Record user gestures for the human-edit transaction correlation above.
  // React capture handlers see events from everything in this React tree,
  // including portaled UI (the mobile toolbar portals to document.body) —
  // but NOT the app chrome outside the editor, which is what keeps a sidebar
  // navigation click from counting as an editor gesture. The diagram viewer is
  // portaled the same way but never edits, so its pans and zooms don't count.
  const markGesture = useCallback((event: SyntheticEvent) => {
    if ((event.target as Element).closest?.("[data-diagram-viewer]")) return
    lastGestureAtRef.current = Date.now()
  }, [])

  useEffect(() => {
    if (!editorContainerRef.current) return
    return initMermaidTouchHandler(editorContainerRef.current)
  }, [])

  return (
    <div
      ref={setEditorScrollRef}
      className="scroll-fade worktable-editor-scroll-root h-full w-full overflow-auto"
      onPointerDownCapture={markGesture}
      onPointerUpCapture={markGesture}
      onKeyDownCapture={(event) => {
        markGesture(event)
        // Mod+Alt+M comments, as on a Markdown Doc.
        if (
          onCreateAnnotation &&
          editable &&
          (event.metaKey || event.ctrlKey) &&
          event.altKey &&
          event.code === "KeyM"
        ) {
          event.preventDefault()
          createAnnotationFromEditor(
            editor as unknown as AnnotationCapableEditor,
            onCreateAnnotation
          )
        }
      }}
      onBeforeInputCapture={markGesture}
      onPasteCapture={markGesture}
      onCutCapture={markGesture}
      onDropCapture={markGesture}
    >
      <div
        ref={editorContainerRef}
        className="worktable-editor-content worktable-document-content"
      >
        {!isMobile && <TableExpandControl frameRef={editorContainerRef} />}
        <DataTooltips rootRef={editorContainerRef} />
        <AnnotationBadges
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          containerRef={editorContainerRef}
          editor={editor as unknown as { document: Block[] }}
          onSelectAnnotation={onSelectAnnotation}
          passages={passages}
        />
        {showsAfterTitle && createPortal(afterTitle, afterTitleHost)}
        <BlockNoteView
          editor={editor}
          editable={editable}
          theme={resolvedTheme}
          slashMenu={false}
          formattingToolbar={false}
          sideMenu={false}
        >
          {isMobile ? (
            <MobileEditorToolbarController
              scrollRootRef={editorScrollRef}
              onAnnotate={onCreateAnnotation}
            />
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
            floatingUIOptions={sideMenuFloatingOptions}
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
  onAnnotate,
}: {
  scrollRootRef: RefObject<HTMLDivElement | null>
  onAnnotate?: (request: AnnotationCreateRequest) => void
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
      <MobileFormattingToolbar>
        <AnnotationToolbarButton onAnnotate={onAnnotate} />
      </MobileFormattingToolbar>
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
  passages,
}: {
  annotations: Annotation[]
  activeAnnotationId?: string | null
  containerRef: RefObject<HTMLDivElement | null>
  editor: { document: Block[] }
  onSelectAnnotation?: (annotation: Annotation) => void
  passages?: EditorPassages
}) {
  const [positions, setPositions] = useState<
    Array<{ blockId: string; top: number; annotations: Annotation[] }>
  >([])
  // The text each open comment is about, where it is now.
  const marked = useRef(new Map<string, Range>())
  const latestPassages = useRef(passages)
  useEffect(() => {
    latestPassages.current = passages
  }, [passages])
  const markPassages = Boolean(passages)
  const reportedDetached = useRef<ReadonlySet<string>>(new Set())

  useEffect(() => {
    const report = (ids: Set<string>) => {
      const previous = reportedDetached.current
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return
      reportedDetached.current = ids
      latestPassages.current?.onDetached(ids)
    }
    const clearMarks = () => {
      marked.current = new Map()
      if (!markPassages) return
      setHighlight(PASSAGE_HIGHLIGHT, [])
      setHighlight(ACTIVE_PASSAGE_HIGHLIGHT, [])
    }
    // No badges means no model traversal, forced layout, timer, or resize work.
    // A passage comment (no block id, as made on Markdown) sits on the
    // block that holds its passage, found as the server finds it.
    const blockIdOf = (annotation: Annotation, blocks: Block[]) => {
      const target = annotation.target
      if ("blockId" in target) return target.blockId || undefined
      if (target.type !== "doc" || !target.quote) return undefined
      const found = findPassageBlock(
        blocks.map((block) =>
          blockToPlainText((block as { content?: unknown }).content)
        ),
        { quote: target.quote, prefix: target.prefix, suffix: target.suffix }
      )
      return found ? blocks[found.index]!.id : undefined
    }
    const anchored = (annotation: Annotation) =>
      annotation.status !== "resolved" &&
      ("blockId" in annotation.target
        ? Boolean(annotation.target.blockId)
        : annotation.target.type === "doc" && Boolean(annotation.target.quote))
    if (!annotations.some(anchored)) {
      setPositions((previous) => (previous.length ? [] : previous))
      clearMarks()
      if (markPassages) report(new Set())
      return
    }
    const update = () => {
      const container = containerRef.current
      if (!container) return
      const containerRect = container.getBoundingClientRect()
      const grouped = new Map<string, Annotation[]>()
      const blocks = flattenEditorBlocks(editor.document)
      const gone = new Set<string>()
      for (const annotation of annotations) {
        if (!anchored(annotation)) continue
        const blockId = blockIdOf(annotation, blocks)
        if (!blockId) {
          gone.add(annotation.id)
          continue
        }
        const list = grouped.get(blockId) ?? []
        list.push(annotation)
        grouped.set(blockId, list)
      }
      // Block IDs actually present in the document. Used to tell genuine ID drift
      // apart from a block whose DOM node is only transiently missing mid-render.
      const liveBlockIds = new Set(blocks.map((block) => block.id))
      const next: Array<{
        blockId: string
        top: number
        annotations: Annotation[]
      }> = []
      const ranges = new Map<string, Range>()
      for (const [blockId, blockAnnotations] of grouped) {
        let node = container.querySelector(
          `[data-id="${CSS.escape(blockId)}"]`
        ) as HTMLElement | null
        // Re-anchor by quote only when the block is genuinely gone from the
        // document — not when the stored ID still exists but its node is missing
        // from the DOM this tick, since a transient miss could otherwise relocate
        // the badge to a different block whose text happens to match the quote.
        const blockGone = !node && !liveBlockIds.has(blockId)
        if (blockGone) {
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
        if (!node) {
          if (blockGone)
            for (const annotation of blockAnnotations) gone.add(annotation.id)
          continue
        }
        const rect = node.getBoundingClientRect()
        next.push({
          blockId,
          top: rect.top - containerRect.top + container.scrollTop + 2,
          annotations: blockAnnotations,
        })
        if (!markPassages) continue
        // The quoted words, looked for in this block only.
        const content =
          node.querySelector(".bn-block-content") ?? (node as Element)
        const model = readPassageText(content)
        for (const annotation of blockAnnotations) {
          const target = annotation.target
          const quote = "quote" in target ? target.quote : undefined
          if (!quote) continue
          const range = rangeForPassage(model, { quote })
          if (range) ranges.set(annotation.id, range)
          else gone.add(annotation.id)
        }
      }
      setPositions(next)
      if (!markPassages) return
      marked.current = ranges
      setHighlight(
        PASSAGE_HIGHLIGHT,
        [...ranges].flatMap(([id, range]) =>
          id === activeAnnotationId ? [] : [range]
        )
      )
      const active = activeAnnotationId && ranges.get(activeAnnotationId)
      setHighlight(ACTIVE_PASSAGE_HIGHLIGHT, active ? [active] : [])
      report(gone)
    }
    update()
    window.addEventListener("resize", update)
    const timer = window.setInterval(update, 1000)
    return () => {
      window.removeEventListener("resize", update)
      window.clearInterval(timer)
    }
  }, [annotations, activeAnnotationId, containerRef, editor, markPassages])

  useEffect(
    () => () => {
      if (!markPassages) return
      setHighlight(PASSAGE_HIGHLIGHT, [])
      setHighlight(ACTIVE_PASSAGE_HIGHLIGHT, [])
    },
    [markPassages]
  )

  // Pressing marked text, without selecting any, shows its comment.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !markPassages) return
    const click = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return
      const caret = caretPointAt(event.clientX, event.clientY)
      if (!caret) return
      let hit: [string, Range] | null = null
      for (const entry of marked.current) {
        if (!entry[1].isPointInRange(caret.node, caret.offset)) continue
        // The innermost passage wins where comments overlap.
        if (!hit || entry[1].toString().length < hit[1].toString().length)
          hit = entry
      }
      const annotation =
        hit && annotations.find((candidate) => candidate.id === hit[0])
      if (annotation) latestPassages.current?.onClick(annotation)
    }
    container.addEventListener("click", click)
    return () => container.removeEventListener("click", click)
  }, [annotations, containerRef, markPassages])

  if (!positions.length) return null

  return (
    <div className="pointer-events-none absolute inset-y-0 right-1 z-20 sm:right-3 print:hidden">
      {positions.map(({ blockId, top, annotations: blockAnnotations }) => {
        const active = blockAnnotations.some(
          (annotation) => annotation.id === activeAnnotationId
        )
        const primary = blockAnnotations[0]!
        return (
          <button
            key={blockId}
            type="button"
            aria-label={`${blockAnnotations.length} comments on this block`}
            onClick={() => onSelectAnnotation?.(primary)}
            className={`pointer-events-auto absolute right-0 flex h-7 min-w-7 items-center justify-center rounded-full border px-2 text-xs font-medium transition-colors ${
              active
                ? "border-primary bg-surface-selected text-primary"
                : "border-border bg-popover text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            style={{ top }}
          >
            <MessageSquarePlus className="mr-1 h-3 w-3" />
            {blockAnnotations.length}
          </button>
        )
      })}
    </div>
  )
}

const PASSAGE_HIGHLIGHT = "worktable-comment"
const ACTIVE_PASSAGE_HIGHLIGHT = "worktable-comment-active"

function caretPointAt(
  x: number,
  y: number
): { node: Node; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y)
    return position
      ? { node: position.offsetNode, offset: position.offset }
      : null
  }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

function createAnnotationFromEditor(
  editor: AnnotationCapableEditor,
  onAnnotate: ((request: AnnotationCreateRequest) => void) | undefined,
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
  onAnnotate({
    blockId: target.id,
    blockType: target.type,
    quote,
    anchor: annotationAnchor(editor, target.id, Boolean(quote && !block)),
  })
}

/** The selection when the comment is about it, else the block's element. */
function annotationAnchor(
  editor: AnnotationCapableEditor,
  blockId: string,
  aboutSelection: boolean
): Range | Element | undefined {
  const selection = window.getSelection()
  if (aboutSelection && selection?.rangeCount && !selection.isCollapsed)
    return selection.getRangeAt(0).cloneRange()
  return (
    editor.domElement?.querySelector(`[data-id="${CSS.escape(blockId)}"]`) ??
    undefined
  )
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
      label="Comment"
      mainTooltip="Comment"
      icon={<MessageSquarePlus className="size-3.5" />}
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
            createAnnotationFromEditor(editor, onAnnotate, block)
          }}
        >
          Comment
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
