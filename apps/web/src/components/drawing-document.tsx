import { useEffect, useRef, useState } from "react"
import { useBlocker, useNavigate } from "@tanstack/react-router"
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { createQuickdraw, type Editor } from "@quickdrawjs/core"
import "@quickdrawjs/core/quickdraw.css"
import { Download, Image, RotateCw, Copy } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import {
  parseQuickdrawDocument,
  QUICKDRAW_FORMAT,
  type QuickdrawDocument,
} from "@worktable/types"
import { useTheme } from "@/components/theme-provider"
import { usePageMeta } from "@/hooks/use-page-meta"
import {
  readEditableDocument,
  writeDocumentSource,
  downloadDocumentSource,
} from "@/lib/documents-api"
import { workspaceQueryOptions } from "@/lib/queries"
import {
  drawingDraftKey,
  DrawingUnsavedError,
  registerDrawingSave,
} from "@/lib/drawing-drafts"
import { documentQueryKeys } from "@/lib/documents-queries"
import type { DocumentRendererProps } from "@/lib/document-renderers"
import { HttpError } from "@/lib/http"

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// A keyed editor owns one source and one revision for its entire lifetime.
export default function DrawingDocument(props: DocumentRendererProps) {
  const { data: workspace } = useSuspenseQuery(workspaceQueryOptions())
  return (
    <DrawingEditor
      key={`${workspace.id}/${props.spaceId}/${props.documentPath}`}
      workspaceId={workspace.id}
      {...props}
    />
  )
}

function DrawingEditor({
  workspaceId,
  spaceId,
  documentPath,
}: DocumentRendererProps & { workspaceId: string }) {
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null)
  const dirty = useRef(false)
  const actions = useRef<{
    save: () => Promise<void>
    reload: () => void
    copy: () => void
    source: () => void
  }>(null)
  const [title, setTitle] = useState("")
  const [status, setStatus] = useState("Opening drawing…")
  const [error, setError] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState(false)
  const { resolvedTheme } = useTheme()
  const initialTheme = useRef(resolvedTheme)
  const { setPageMeta } = usePageMeta()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  useBlocker({
    shouldBlockFn: () =>
      dirty.current &&
      !window.confirm("This drawing has unsaved changes. Leave anyway?"),
    enableBeforeUnload: () => dirty.current,
  })

  useEffect(() => {
    const node = container.current
    if (!node) return
    let disposed = false
    let revision = ""
    let drawing: QuickdrawDocument | null = null
    let change = 0
    let saving = false
    let loading = false
    let conflict = false
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const activePointers = new Set<number>()
    let draftKey = ""
    let pendingSave: Promise<void> | null = null
    let ownDraft = ""
    const instance = createQuickdraw({
      container: node,
      theme: initialTheme.current,
      readonly: true,
      grid: "dots",
      themeToggle: false,
    })
    editor.current = instance.editor

    const currentSource = () =>
      JSON.stringify({
        ...drawing,
        snapshot: instance.editor.store.getSnapshot(),
      })
    const keepDraft = (source?: string) => {
      if (!dirty.current || !drawing) return
      try {
        ownDraft = JSON.stringify({
          revision,
          source: source ?? currentSource(),
        })
        localStorage.setItem(draftKey, ownDraft)
      } catch {
        // A full browser store must never turn a failed network save into success.
      }
    }
    const clearDraft = () => {
      try {
        if (localStorage.getItem(draftKey) === ownDraft)
          localStorage.removeItem(draftKey)
      } catch {
        /* Storage may be unavailable. */
      }
    }
    const scheduleSave = (delay = 800) => {
      clearTimeout(timer)
      if (loading) return
      timer = setTimeout(() => void save(), delay)
    }
    const save = (): Promise<void> => {
      if (pendingSave) return pendingSave
      pendingSave = persist().finally(() => {
        pendingSave = null
      })
      return pendingSave
    }
    const persist = async () => {
      clearTimeout(timer)
      if (
        disposed ||
        saving ||
        loading ||
        conflict ||
        !dirty.current ||
        !drawing
      )
        return
      // A stationary pen is still writing. Resume on pointerup, not on a timer
      // that can serialize the whole board in the middle of the gesture.
      if (activePointers.size > 0) return
      const savedChange = change
      const source = currentSource()
      keepDraft(source)
      saving = true
      setStatus("Saving…")
      try {
        // The document writer validates the source. Re-parsing and validating
        // the same board here blocks input without adding a persistence boundary.
        const result = await writeDocumentSource(spaceId, {
          path: documentPath,
          source,
          expectedRevision: revision,
        })
        revision = result.sourceRevision
        retries = 0
        if (change === savedChange) {
          dirty.current = false
          clearDraft()
          if (!disposed) setStatus("Saved")
        } else {
          scheduleSave()
        }
        if (!disposed) setError(null)
        void queryClient.invalidateQueries({
          queryKey: documentQueryKeys.list(spaceId),
        })
      } catch (cause) {
        conflict = cause instanceof HttpError && cause.status === 409
        const retryable =
          cause instanceof TypeError ||
          (cause instanceof HttpError &&
            (cause.status >= 500 ||
              cause.status === 408 ||
              cause.status === 429))
        if (retryable && !disposed) {
          scheduleSave(Math.min(30_000, 1000 * 2 ** Math.min(retries++, 5)))
        }
        if (!disposed) {
          setConflictError(conflict)
          setStatus("Not saved")
          setError(
            conflict
              ? "This drawing changed elsewhere. Save a copy to keep your changes, then reload."
              : retryable
                ? "Changes haven’t synced. Retrying…"
                : "Couldn’t save your changes. Download a copy to keep them."
          )
        }
        console.error("Drawing save failed", cause)
      } finally {
        saving = false
      }
    }
    const load = async (recoverDraft: boolean) => {
      if (
        loading ||
        (saving && !pendingSave) ||
        (dirty.current &&
          !window.confirm(
            "Discard unsaved changes and reload the saved drawing?"
          ))
      )
        return
      // Once discard is confirmed, no queued autosave may publish that ink.
      // A request already sent must settle before we read its saved revision.
      loading = true
      clearTimeout(timer)
      instance.editor.setReadonly(true)
      try {
        await pendingSave
        if (disposed) return
        const result = await readEditableDocument(spaceId, documentPath)
        const bytes = Uint8Array.from(atob(result.source), (char) =>
          char.charCodeAt(0)
        )
        const saved = parseQuickdrawDocument(bytes)
        if (disposed) return
        draftKey = drawingDraftKey(workspaceId, result.documentId)
        revision = result.sourceRevision
        drawing = saved
        dirty.current = false
        conflict = false
        retries = 0
        setError(null)
        setConflictError(false)
        setStatus("Saved")
        if (recoverDraft) {
          try {
            const raw = localStorage.getItem(draftKey)
            if (raw) {
              ownDraft = raw
              const draft = JSON.parse(raw) as {
                revision: string
                source: string
              }
              const recovered = parseQuickdrawDocument(
                new TextEncoder().encode(draft.source)
              )
              if (JSON.stringify(recovered) !== JSON.stringify(saved)) {
                drawing = recovered
                dirty.current = true
                conflict = draft.revision !== revision
                setConflictError(conflict)
                setStatus("Recovered unsaved changes")
                if (conflict)
                  setError(
                    "The saved drawing changed while you were away. Save a copy to keep your recovered changes."
                  )
              } else clearDraft()
            }
          } catch {
            /* Invalid drafts never replace a valid server source. */
          }
        } else clearDraft()
        instance.editor.store.loadSnapshot(drawing.snapshot)
        instance.ui.setHidden(false)
        instance.editor.setTool("draw")
        instance.editor.fitContent()
        setTitle(drawing.title)
      } catch (cause) {
        if (!disposed) {
          setStatus("Couldn’t open drawing")
          setError("Reload to try again. Your saved drawing has not changed.")
        }
        console.error("Drawing load failed", cause)
      } finally {
        loading = false
        if (!disposed && drawing) instance.editor.setReadonly(false)
      }
      if (recoverDraft && dirty.current && !conflict) scheduleSave()
    }
    actions.current = {
      save,
      reload: () => {
        void load(false)
      },
      source: () => {
        if (drawing)
          download(
            new Blob([currentSource()], { type: "application/json" }),
            `${drawing.title}.quickdraw`
          )
        else
          void downloadDocumentSource(spaceId, documentPath).catch(() =>
            toast.error("Couldn’t download the drawing. Try again.")
          )
      },
      copy: () => {
        if (!drawing || saving || loading) return
        clearTimeout(timer)
        saving = true
        instance.editor.setReadonly(true)
        node.inert = true
        const copiedChange = change
        void (async () => {
          try {
            const result = await writeDocumentSource(spaceId, {
              path: `${documentPath}-copy-${crypto.randomUUID().slice(0, 8)}`,
              source: currentSource(),
              format: { id: QUICKDRAW_FORMAT, sourceVersion: 1 },
            })
            if (change !== copiedChange) {
              toast.info("Copy saved. New edits are still on this drawing.")
              return
            }
            dirty.current = false
            clearDraft()
            void queryClient.invalidateQueries({
              queryKey: documentQueryKeys.list(spaceId),
            })
            await navigate({
              to: "/spaces/$spaceId/documents/$",
              params: { spaceId, _splat: result.path },
            })
          } catch {
            toast.error(
              "Couldn’t save a copy. Download your drawing to keep your changes."
            )
          } finally {
            saving = false
            if (!disposed) {
              instance.editor.setReadonly(false)
              node.inert = false
            }
          }
        })()
      },
    }
    const unregisterSave = registerDrawingSave(
      spaceId,
      documentPath,
      async () => {
        await pendingSave
        await save()
        if (dirty.current) throw new DrawingUnsavedError()
      }
    )
    const unsubscribe = instance.editor.store.listen(
      () => {
        dirty.current = true
        change += 1
        setStatus("Unsaved changes")
        scheduleSave()
      },
      { source: "user" }
    )
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target !== node &&
        event.target !== instance.editor.canvas &&
        event.target !== instance.editor.overlay
      )
        return
      if (event.pointerType === "pen") activePointers.clear()
      if (event.pointerType !== "touch" || !instance.editor.penMode)
        activePointers.add(event.pointerId)
      clearTimeout(timer)
    }
    const onPointerEnd = (event: PointerEvent) => {
      activePointers.delete(event.pointerId)
      if (activePointers.size === 0 && dirty.current) scheduleSave()
    }
    const onOnline = () => {
      retries = 0
      if (dirty.current) scheduleSave()
    }
    const onPageHide = () => keepDraft()
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        activePointers.clear()
        keepDraft()
      }
    }
    node.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("pointerup", onPointerEnd)
    window.addEventListener("pointercancel", onPointerEnd)
    node.addEventListener("lostpointercapture", onPointerEnd)
    window.addEventListener("online", onOnline)
    document.addEventListener("visibilitychange", onHide)
    window.addEventListener("pagehide", onPageHide)
    window.addEventListener("beforeunload", onPageHide)
    // Quickdraw owns keyboard shortcuts while its canvas has focus.
    const stopKeys = (event: KeyboardEvent) => event.stopPropagation()
    node.addEventListener("keydown", stopKeys)
    void load(true)
    return () => {
      keepDraft()
      disposed = true
      clearTimeout(timer)
      unsubscribe()
      unregisterSave()
      node.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("pointerup", onPointerEnd)
      window.removeEventListener("pointercancel", onPointerEnd)
      node.removeEventListener("lostpointercapture", onPointerEnd)
      window.removeEventListener("online", onOnline)
      document.removeEventListener("visibilitychange", onHide)
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("beforeunload", onPageHide)
      actions.current = null
      editor.current = null
      node.removeEventListener("keydown", stopKeys)
      instance.destroy()
    }
  }, [workspaceId, spaceId, documentPath, queryClient, navigate])

  useEffect(() => {
    editor.current?.setTheme(resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    setPageMeta({
      titleOverride: title || "Drawing",
      overflowActions: [
        {
          id: "drawing-image",
          label: "Download PNG",
          icon: Image,
          onSelect: () => {
            void editor.current
              ?.exportImage()
              .then((blob) => {
                if (blob) download(blob, `${title || "drawing"}.png`)
                else toast.info("Add something to your drawing first.")
              })
              .catch(() => toast.error("Couldn’t export this drawing."))
          },
        },
        {
          id: "drawing-source",
          label: "Download drawing",
          icon: Download,
          onSelect: () => actions.current?.source(),
        },
        {
          id: "drawing-copy",
          label: "Save a copy",
          icon: Copy,
          onSelect: () => actions.current?.copy(),
        },
        {
          id: "drawing-reload",
          label: "Reload drawing",
          icon: RotateCw,
          onSelect: () => actions.current?.reload(),
        },
      ],
    })
    return () => setPageMeta(null)
  }, [title, setPageMeta])

  return (
    <section
      className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      aria-label="Drawing"
    >
      <span role="status" className="sr-only">
        {status}
      </span>
      {error && (
        <div className="overlay-floating absolute inset-x-3 top-3 z-50 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-popover p-3 text-sm text-popover-foreground">
          <span role="alert" className="min-w-0 flex-1">
            {error}
          </span>
          <Button
            size="sm"
            onClick={() =>
              dirty.current
                ? conflictError
                  ? actions.current?.copy()
                  : void actions.current?.save()
                : actions.current?.reload()
            }
          >
            {dirty.current
              ? conflictError
                ? "Save a copy"
                : "Retry save"
              : "Try again"}
          </Button>
        </div>
      )}
      <div
        ref={container}
        className="relative min-h-96 flex-1"
        aria-label="Drawing canvas"
      />
    </section>
  )
}
