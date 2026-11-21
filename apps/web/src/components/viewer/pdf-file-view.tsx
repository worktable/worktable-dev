import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"
import {
  ChevronDown,
  ChevronUp,
  MoveHorizontal,
  PanelLeft,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { Skeleton } from "@worktable/ui/components/skeleton"
import {
  ViewerFrame,
  type ViewerFrameHandle,
} from "@/components/viewer/viewer-frame"
import { documentQueryKeys } from "@/lib/documents-queries"
import {
  pdfPageFromHash,
  type ViewerKey,
  type ViewerRefusal,
  type ViewerState,
} from "@/lib/viewer-frame-protocol"

/** Where the reader's choice to show the page browser is kept. */
const RAIL_KEY = "worktable.pdf-pages"

/**
 * Whether the page browser starts open: as the reader last left it, else
 * open beside a file of more than one page when the pane has room.
 */
function railStartsOpen(pages: number): boolean {
  try {
    const kept = window.localStorage.getItem(RAIL_KEY)
    if (kept === "open" || kept === "closed") return kept === "open"
  } catch {
    // Storage can be off; fall through to the default.
  }
  return pages > 1 && window.innerWidth >= 1100
}

function keepRail(open: boolean): void {
  try {
    window.localStorage.setItem(RAIL_KEY, open ? "open" : "closed")
  } catch {
    // Not kept: the default applies next time.
  }
}

const REFUSALS: Record<ViewerRefusal, string> = {
  password: "Password protected",
  damaged: "Couldn’t load preview",
  failed: "Couldn’t load preview",
  "too-large": "Too large to preview",
}

/**
 * A PDF or Word file on its own page: the file fills the pane, with its
 * place and zoom above it, and for a PDF its pages and Find. The file is
 * parsed in a viewer frame, never in this page.
 */
export default function PdfFileView({
  viewer = "pdf",
  spaceId,
  path,
  name,
  fileUrl,
  byteLength,
  leading,
  onDismiss,
  onFileChanged,
  refusal,
}: {
  /** The viewer that shows the file. */
  viewer?: ViewerKey
  spaceId: string
  path: string
  name: string
  fileUrl: string
  /** The file's size when the page knows it. */
  byteLength?: number | undefined
  /** What the page says about the file, before the viewer's tools. */
  leading?: ReactNode
  /** Escape while reading, when nothing else in the viewer is open. */
  onDismiss?: () => void
  /**
   * The file changed while it was being read. By default its page is
   * checked again, which opens the new version.
   */
  onFileChanged?: () => void
  /**
   * What shows in place of a file the viewer can't show, given why; by
   * default the reason alone, centred.
   */
  refusal?: (status: string) => ReactNode
}) {
  const queryClient = useQueryClient()
  const frame = useRef<ViewerFrameHandle>(null)
  // Only the PDF viewer finds text and browses pages.
  const pdf = viewer === "pdf"
  const [startPage] = useState(() => pdfPageFromHash(window.location.hash))
  // A link to another page of the open file moves the viewer there.
  const hash = useRouterState({ select: (state) => state.location.hash })
  const lastHash = useRef(hash)
  useEffect(() => {
    if (hash === lastHash.current) return
    lastHash.current = hash
    const page = pdfPageFromHash(`#${hash}`)
    if (page) frame.current?.command({ name: "page", page })
  }, [hash])
  const [shown, setShown] = useState<ViewerState | null>(null)
  const [refused, setRefused] = useState<ViewerRefusal | null>(null)
  // The page number as typed, until it is entered or the reader moves on.
  const [typed, setTyped] = useState<string | null>(null)
  // Finding text: open with what is typed, and where it has got to.
  const [find, setFind] = useState<string | null>(null)
  const [found, setFound] = useState<{ current: number; total: number } | null>(
    null
  )
  const findInput = useRef<HTMLInputElement>(null)
  // The file asked for a password: whether the last one was wrong.
  const [asking, setAsking] = useState<{ retry: boolean } | null>(null)
  const [password, setPassword] = useState("")
  // The page browser beside the file; null until the file is shown.
  const [rail, setRail] = useState<boolean | null>(null)
  const showRail = (open: boolean) => {
    setRail(open)
    frame.current?.command({ name: "rail", open })
  }

  const goToTyped = useCallback(() => {
    const page = Number(typed)
    if (Number.isInteger(page) && page >= 1) {
      frame.current?.command({ name: "page", page })
    }
    setTyped(null)
  }, [typed])
  const zoom = (to: "in" | "out" | "fit") =>
    frame.current?.command({ name: "zoom", to })

  const openFind = useCallback(() => {
    setFind((open) => open ?? "")
    // Focus once the field is there; again if it already was.
    requestAnimationFrame(() => {
      findInput.current?.focus()
      findInput.current?.select()
    })
  }, [])
  const closeFind = useCallback(() => {
    setFind(null)
    setFound(null)
    frame.current?.command({ name: "find", query: "" })
  }, [])
  const findAgain = (direction: "next" | "previous") => {
    if (find) frame.current?.command({ name: "find", query: find, direction })
  }

  // Cmd or Ctrl+F finds in the PDF, not in the page around it.
  useEffect(() => {
    if (!shown || !pdf) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault()
        openFind()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [openFind, pdf, shown])

  // A file replaced while it was being read loads again from its page.
  const reload = useCallback(
    () =>
      void queryClient.invalidateQueries({
        queryKey: documentQueryKeys.page(spaceId, path),
        exact: true,
      }),
    [path, queryClient, spaceId]
  )

  const submitPassword = (event: FormEvent) => {
    event.preventDefault()
    if (!password) return
    frame.current?.password(password)
    setPassword("")
    setAsking(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-start gap-x-3 gap-y-1 border-b border-border px-4 py-1.5">
        {/* On a phone the byline takes the whole line, so its lists open at full
            width, and the tools sit on the line below. */}
        {leading ? (
          <div className="min-h-8 min-w-0 basis-full self-center text-sm text-muted-foreground sm:flex-1 sm:basis-0">
            {leading}
          </div>
        ) : (
          <div className="flex-1" />
        )}
        {shown ? (
          <div className="flex max-w-full shrink-0 items-center gap-0.5 overflow-x-auto">
            {pdf && shown.pages > 1 ? (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={rail === true}
                  className="aria-pressed:bg-surface-selected"
                  onClick={() => {
                    const open = !rail
                    showRail(open)
                    keepRail(open)
                  }}
                  title="Pages"
                  aria-label="Pages"
                >
                  <PanelLeft />
                </Button>
                <div className="mx-1 h-5 w-px bg-border" />
              </>
            ) : null}
            {find !== null ? (
              <div className="mr-1 flex items-center gap-0.5">
                <Input
                  ref={findInput}
                  aria-label="Find in PDF"
                  placeholder="Find"
                  className="h-7 w-36 text-xs sm:w-44"
                  value={find}
                  onChange={(event) => {
                    const query = event.target.value
                    setFind(query)
                    if (!query) setFound(null)
                    frame.current?.command({ name: "find", query })
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      findAgain(event.shiftKey ? "previous" : "next")
                    } else if (event.key === "Escape") {
                      event.preventDefault()
                      closeFind()
                    }
                  }}
                />
                <span
                  className="min-w-20 px-1 text-center text-xs whitespace-nowrap text-muted-foreground tabular-nums"
                  aria-live="polite"
                >
                  {find && found
                    ? found.total === 0
                      ? "No matches"
                      : `${found.current} of ${found.total}`
                    : ""}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!found?.total}
                  onClick={() => findAgain("previous")}
                  title="Previous match"
                  aria-label="Previous match"
                >
                  <ChevronUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!found?.total}
                  onClick={() => findAgain("next")}
                  title="Next match"
                  aria-label="Next match"
                >
                  <ChevronDown />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={closeFind}
                  title="Close Find"
                  aria-label="Close Find"
                >
                  <X />
                </Button>
                <div className="mx-1 h-5 w-px bg-border" />
              </div>
            ) : null}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
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
            {pdf && find === null ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={openFind}
                title="Find"
                aria-label="Find"
              >
                <Search />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {refused ? (
        refusal ? (
          <div className="mx-auto w-full max-w-3xl px-6">
            {refusal(REFUSALS[refused])}
          </div>
        ) : (
          <p className="m-auto p-6 text-sm text-muted-foreground">
            {REFUSALS[refused]}
          </p>
        )
      ) : (
        <div className="relative min-h-0 flex-1">
          {shown ? null : (
            <div className="absolute inset-0 z-10 overflow-hidden bg-background p-4">
              {asking ? (
                <form
                  onSubmit={submitPassword}
                  className="mx-auto mt-12 flex w-full max-w-sm flex-col gap-3 rounded-xl card-surface p-5"
                >
                  <h2 className="text-base font-semibold text-foreground">
                    Password Protected
                  </h2>
                  <Input
                    type="password"
                    autoComplete="off"
                    aria-label="Password"
                    placeholder="Password"
                    aria-invalid={asking.retry || undefined}
                    autoFocus
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  {asking.retry ? (
                    <p className="text-sm text-destructive">
                      That password didn’t work.
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        frame.current?.password(null)
                        setAsking(null)
                      }}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" size="sm" disabled={!password}>
                      Open
                    </Button>
                  </div>
                </form>
              ) : (
                <Skeleton className="pointer-events-none mx-auto aspect-[17/22] w-full max-w-3xl rounded-sm" />
              )}
            </div>
          )}
          <ViewerFrame
            ref={frame}
            viewer={viewer}
            title={name}
            fileUrl={fileUrl}
            byteLength={byteLength}
            {...(startPage ? { startPage } : {})}
            className="block h-full w-full border-0 bg-background"
            onShown={(state) => {
              setShown(state)
              if (pdf && state.pages > 1) showRail(railStartsOpen(state.pages))
            }}
            onState={(state) => {
              setShown(state)
              setTyped(null)
            }}
            onRefused={setRefused}
            onChanged={onFileChanged ?? reload}
            onFind={setFound}
            onPassword={(retry) => setAsking({ retry })}
            onRail={setRail}
            onKey={(key) => {
              if (key === "find") openFind()
              else if (key === "Escape") {
                if (find !== null) closeFind()
                else onDismiss?.()
              }
            }}
          />
        </div>
      )}
    </div>
  )
}
