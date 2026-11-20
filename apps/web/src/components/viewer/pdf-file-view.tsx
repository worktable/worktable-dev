import { useCallback, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Skeleton } from "@worktable/ui/components/skeleton"
import { FileCard } from "@/components/file-card"
import {
  ViewerFrame,
  type ViewerFrameHandle,
} from "@/components/viewer/viewer-frame"
import { documentQueryKeys } from "@/lib/documents-queries"
import type { ViewerRefusal, ViewerState } from "@/lib/viewer-frame-protocol"

const REFUSALS: Record<ViewerRefusal, string> = {
  password: "Password protected",
  damaged: "Couldn’t load preview",
  failed: "Couldn’t load preview",
}

/**
 * A PDF on its own page: the file fills the pane, with its place and zoom
 * above it. The file is parsed in a viewer frame, never in this page.
 */
export default function PdfFileView({
  spaceId,
  path,
  name,
  fileUrl,
  byteLength,
  leading,
}: {
  spaceId: string
  path: string
  name: string
  fileUrl: string
  byteLength: number
  /** What the page says about the file, before the viewer's tools. */
  leading: ReactNode
}) {
  const queryClient = useQueryClient()
  const frame = useRef<ViewerFrameHandle>(null)
  const [shown, setShown] = useState<ViewerState | null>(null)
  const [refused, setRefused] = useState<ViewerRefusal | null>(null)
  // The page number as typed, until it is entered or the reader moves on.
  const [typed, setTyped] = useState<string | null>(null)

  const goToTyped = useCallback(() => {
    const page = Number(typed)
    if (Number.isInteger(page) && page >= 1) {
      frame.current?.command({ name: "page", page })
    }
    setTyped(null)
  }, [typed])
  const zoom = (to: "in" | "out" | "fit") =>
    frame.current?.command({ name: "zoom", to })
  // A file replaced while it was being read loads again from its page.
  const reload = useCallback(
    () =>
      void queryClient.invalidateQueries({
        queryKey: documentQueryKeys.page(spaceId, path),
        exact: true,
      }),
    [path, queryClient, spaceId]
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1">
        <div className="min-w-0 flex-1">{leading}</div>
        {shown ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              <span className="sr-only">Page</span>
              <input
                inputMode="numeric"
                aria-label="Page"
                className="h-7 w-10 rounded-md border border-input bg-transparent text-center text-xs text-foreground outline-none focus-visible:border-ring"
                value={typed ?? String(shown.page)}
                onChange={(event) => setTyped(event.target.value)}
                onBlur={goToTyped}
                onKeyDown={(event) => {
                  if (event.key === "Enter") goToTyped()
                  else if (event.key === "Escape") setTyped(null)
                }}
              />
              <span>of {shown.pages.toLocaleString()}</span>
            </label>
            <div className="mx-1 h-5 w-px bg-border" />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => zoom("out")}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut />
            </Button>
            <span
              className="min-w-12 text-center font-mono text-xs text-muted-foreground tabular-nums select-none max-sm:hidden"
              aria-live="polite"
            >
              {Math.round(shown.scale * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => zoom("in")}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomIn />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => zoom("fit")}
              title="Fit to width"
              aria-label="Fit to width"
            >
              <MoveHorizontal />
            </Button>
          </div>
        ) : null}
      </div>
      {refused ? (
        <div className="mx-auto w-full max-w-3xl px-6">
          <FileCard name={name} status={REFUSALS[refused]} />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {shown ? null : (
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden bg-background p-4">
              <Skeleton className="mx-auto aspect-[17/22] w-full max-w-3xl rounded-sm" />
            </div>
          )}
          <ViewerFrame
            ref={frame}
            viewer="pdf"
            title={name}
            fileUrl={fileUrl}
            byteLength={byteLength}
            className="block h-full w-full border-0 bg-background"
            onShown={setShown}
            onState={(state) => {
              setShown(state)
              setTyped(null)
            }}
            onRefused={setRefused}
            onChanged={reload}
          />
        </div>
      )}
    </div>
  )
}
