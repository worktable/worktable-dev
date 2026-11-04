import { useEffect, useMemo, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight, Download } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { documentRoute } from "@/lib/document-views"
import { fileSourceUrl, sourceFileOf } from "@/lib/file-embeds"
import { IMAGE_PLACEMENT, type ViewSize } from "@/lib/zoom-view"
import { ViewerDialog } from "./viewer-dialog"
import { ZoomCanvas, type ZoomContent } from "./zoom-canvas"

/** An image a page shows, as the viewer opens it. */
export interface ViewerImage {
  /** The URL the page loaded it from. */
  src: string
  /** What the page says it shows. */
  alt: string
  /** Its own size, from the page that loaded it. */
  size: ViewSize
}

/**
 * Images from a page in the full-window viewer, one at a time: zoom and pan,
 * move through the page's images in order, and, for a Space's file,
 * Download and Open its page.
 */
export function ImageViewer({
  open,
  onOpenChange,
  images,
  index,
  onIndexChange,
  linksToFile = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  images: readonly ViewerImage[]
  index: number
  onIndexChange: (index: number) => void
  /** Offer Open for a Space's file; off on the file's own page. */
  linksToFile?: boolean
}) {
  const image = images[index]
  const previous = index > 0 ? () => onIndexChange(index - 1) : undefined
  const next =
    index < images.length - 1 ? () => onIndexChange(index + 1) : undefined

  // The dialog keeps arrow keys from leaving it, as composite widgets need,
  // so they're heard on their way in.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const move =
        event.key === "ArrowLeft"
          ? previous
          : event.key === "ArrowRight"
            ? next
            : undefined
      if (!move) return
      event.preventDefault()
      move()
    }
    document.addEventListener("keydown", handleKeyDown, true)
    return () => document.removeEventListener("keydown", handleKeyDown, true)
  }, [next, open, previous])

  return (
    <ViewerDialog open={open} onOpenChange={onOpenChange}>
      {image ? (
        <ImageBody
          // A new image starts at its own placement.
          key={`${index}:${image.src}`}
          image={image}
          linksToFile={linksToFile}
          onOpenFile={() => onOpenChange(false)}
          navigation={
            images.length > 1 ? (
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={previous}
                  disabled={!previous}
                  title="Previous image"
                  aria-label="Previous image"
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={next}
                  disabled={!next}
                  title="Next image"
                  aria-label="Next image"
                >
                  <ChevronRight />
                </Button>
                <span className="ml-1 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
                  {index + 1} of {images.length}
                </span>
              </div>
            ) : undefined
          }
        />
      ) : null}
    </ViewerDialog>
  )
}

function ImageBody({
  image,
  linksToFile,
  onOpenFile,
  navigation,
}: {
  image: ViewerImage
  linksToFile: boolean
  onOpenFile: () => void
  navigation: ReactNode
}) {
  const file = useMemo(() => sourceFileOf(image.src), [image.src])
  const name = file
    ? file.path.slice(file.path.lastIndexOf("/") + 1)
    : image.alt.trim() || undefined
  const content = useMemo<ZoomContent>(
    () => ({ type: "image", src: image.src, alt: image.alt }),
    [image.alt, image.src]
  )

  return (
    <ZoomCanvas
      title={name}
      fallbackTitle="Image"
      leading={navigation}
      content={content}
      size={image.size}
      placement={IMAGE_PLACEMENT}
      tools={
        file ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                window.location.href = fileSourceUrl(
                  file.spaceId,
                  file.path,
                  file.version,
                  { download: true, ...(file.at ? { at: file.at } : {}) }
                )
              }}
              title="Download"
              aria-label="Download"
            >
              <Download />
            </Button>
            {linksToFile ? (
              <Button
                nativeButton={false}
                variant="ghost"
                size="sm"
                render={
                  <Link
                    {...documentRoute(file.spaceId, file.path)}
                    onClick={onOpenFile}
                  />
                }
                aria-label="Open file page"
              >
                Open
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    />
  )
}
