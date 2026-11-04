import { lazy, useCallback, useEffect, useState, type RefObject } from "react"
import { Maximize2 } from "lucide-react"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import { DocIconButton } from "@/components/document/doc-icon-button"
import type { ViewerImage } from "./image-viewer"

/**
 * The images a page shows as content: a Markdown Doc's and a file page's
 * (marked data-viewable), and a rich text Doc's image blocks.
 */
const VIEWABLE_IMAGES =
  'img[data-viewable], [data-content-type="image"] img.bn-visual-media'
/** Shown smaller than this, an image is a mark, such as a badge, not a picture. */
const MIN_SHOWN = 40

// The viewer loads when an image is first pointed at, so it opens at once.
const loadViewer = () => import("./image-viewer")
const ImageViewer = lazy(() =>
  loadViewer().then((module) => ({ default: module.ImageViewer }))
)

function viewableImage(element: Element | null): HTMLImageElement | null {
  const image = element?.closest<HTMLImageElement>(VIEWABLE_IMAGES)
  if (!image || image.naturalWidth === 0) return null
  const box = image.getBoundingClientRect()
  return box.width >= MIN_SHOWN && box.height >= MIN_SHOWN ? image : null
}

function viewerImage(image: HTMLImageElement): ViewerImage {
  return {
    src: image.currentSrc || image.src,
    alt: image.alt,
    size: { width: image.naturalWidth, height: image.naturalHeight },
  }
}

type Target = { image: HTMLImageElement; top: number; right: number }

/**
 * Full screen for the images on a page. The control floats over the
 * pointed-at image's corner from outside the content, as table Expand does,
 * so neither Markdown's layout nor the editor's DOM changes. The viewer
 * moves through the page's images in order.
 */
export function ImageViewControl({
  frameRef,
  openOnClick,
  linksToFile,
}: {
  /** The positioned element the images are in. */
  frameRef: RefObject<HTMLElement | null>
  /** Clicking an image opens it too, where a click has nothing else to do. */
  openOnClick: boolean
  /** Offer Open for a Space's file; off on the file's own page. */
  linksToFile?: boolean
}) {
  const [target, setTarget] = useState<Target | null>(null)
  const [viewer, setViewer] = useState<{
    images: ViewerImage[]
    index: number
  } | null>(null)
  const [open, setOpen] = useState(false)

  const show = useCallback(
    (image: HTMLImageElement) => {
      const frame = frameRef.current
      const shown = frame
        ? [...frame.querySelectorAll<HTMLImageElement>(VIEWABLE_IMAGES)].filter(
            (each) => viewableImage(each) === each
          )
        : []
      const index = shown.indexOf(image)
      setViewer(
        index === -1
          ? { images: [viewerImage(image)], index: 0 }
          : { images: shown.map(viewerImage), index }
      )
      setOpen(true)
    },
    [frameRef]
  )

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let frameRequest = 0
    const select = (element: Element | null) => {
      if (frameRequest) return
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0
        if (element?.closest(".worktable-image-controls")) return
        const image = viewableImage(element)
        if (!image) {
          setTarget(null)
          return
        }
        void loadViewer()
        const box = image.getBoundingClientRect()
        const bounds = frame.getBoundingClientRect()
        setTarget({
          image,
          top: box.top - bounds.top,
          right: bounds.right - box.right,
        })
      })
    }
    // Pointer moves, taps and keyboard focus find the image under them.
    const point = (event: Event) => select(event.target as Element | null)
    // Touch pointers leave after every tap; keep the control until the next tap.
    const leave = (event: PointerEvent) => {
      if (event.pointerType === "mouse") setTarget(null)
    }
    const click = (event: MouseEvent) => {
      if (!openOnClick || event.button !== 0) return
      const image = viewableImage(event.target as Element | null)
      // An image inside a link keeps the link.
      if (!image || image.closest("a")) return
      event.preventDefault()
      show(image)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return
      const image = viewableImage(event.target as Element | null)
      if (!image || image !== event.target) return
      event.preventDefault()
      show(image)
    }
    frame.addEventListener("pointermove", point)
    frame.addEventListener("pointerdown", point)
    frame.addEventListener("pointerleave", leave)
    frame.addEventListener("focusin", point)
    frame.addEventListener("click", click)
    frame.addEventListener("keydown", key)
    return () => {
      frame.removeEventListener("pointermove", point)
      frame.removeEventListener("pointerdown", point)
      frame.removeEventListener("pointerleave", leave)
      frame.removeEventListener("focusin", point)
      frame.removeEventListener("click", click)
      frame.removeEventListener("keydown", key)
      cancelAnimationFrame(frameRequest)
    }
  }, [frameRef, openOnClick, show])

  return (
    <>
      {target && (
        <div
          className="worktable-image-controls"
          style={{ top: target.top + 5, right: target.right + 5, opacity: 1 }}
        >
          <DocIconButton label="Full screen" onClick={() => show(target.image)}>
            <Maximize2 />
          </DocIconButton>
        </div>
      )}
      <DeferredMount active={open}>
        {viewer && (
          <ImageViewer
            open={open}
            onOpenChange={setOpen}
            images={viewer.images}
            index={viewer.index}
            onIndexChange={(index) =>
              setViewer((current) => current && { ...current, index })
            }
            linksToFile={linksToFile ?? true}
          />
        )}
      </DeferredMount>
    </>
  )
}
