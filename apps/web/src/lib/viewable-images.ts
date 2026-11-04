// Which images on a page open in the image viewer.

/**
 * The images a page shows as content: a Markdown Doc's and a file page's
 * (marked data-viewable), and a rich text Doc's image blocks.
 */
export const VIEWABLE_IMAGES =
  'img[data-viewable], [data-content-type="image"] img.bn-visual-media'
/** Shown smaller than this, an image is a mark, such as a badge, not a picture. */
const MIN_SHOWN = 40

/**
 * The content image at or around `element` that opens in the viewer: one
 * that loaded, and is shown large enough to be a picture.
 */
export function viewableImage(
  element: Element | null
): HTMLImageElement | null {
  const image = element?.closest<HTMLImageElement>(VIEWABLE_IMAGES)
  if (!image || image.naturalWidth === 0) return null
  const box = image.getBoundingClientRect()
  return box.width >= MIN_SHOWN && box.height >= MIN_SHOWN ? image : null
}
