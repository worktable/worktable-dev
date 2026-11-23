// The images an HTML Doc's page asks to open in the image viewer.
import type { ViewerImage } from "@/components/viewer/image-viewer"

/** A page asks for no more images than this at once. */
const MAX_FRAME_IMAGES = 200

/**
 * The images and the one to show first, from a page's request, or null when
 * it isn't one. A page shows images only as data URLs, so only those open:
 * the app never loads an address a page names.
 */
export function frameImages(
  data: unknown
): { images: ViewerImage[]; index: number } | null {
  const request = data as { images?: unknown; index?: unknown } | null
  if (!Array.isArray(request?.images)) return null
  const listed: unknown[] = request.images
  if (listed.length === 0 || listed.length > MAX_FRAME_IMAGES) return null
  const images: ViewerImage[] = []
  for (const item of listed) {
    const image = item as {
      src?: unknown
      alt?: unknown
      width?: unknown
      height?: unknown
    } | null
    if (
      typeof image?.src !== "string" ||
      !image.src.toLowerCase().startsWith("data:image/") ||
      !isSize(image.width) ||
      !isSize(image.height)
    )
      return null
    images.push({
      src: image.src,
      alt: typeof image.alt === "string" ? image.alt.slice(0, 300) : "",
      size: { width: image.width, height: image.height },
    })
  }
  const index = request.index
  if (typeof index !== "number" || !Number.isInteger(index)) return null
  if (index < 0 || index >= images.length) return null
  return { images, index }
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}
