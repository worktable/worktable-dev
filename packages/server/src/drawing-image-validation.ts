import { imageSize } from "image-size"
import type { Page } from "playwright-core"
import type { QuickdrawDocument } from "@worktable/types"
import { withPreviewPage } from "./document-preview-browser.ts"

type DrawingAsset = Extract<
  QuickdrawDocument["snapshot"]["document"]["store"][string],
  { typeName: "asset" }
>
const MAX_IMAGE_DIMENSION = 8192
const MAX_IMAGE_PIXELS = 16_000_000

/** Inspect compressed headers before a browser can allocate decoded pixels. */
export function inspectDrawingImageAssets(assets: DrawingAsset[]): void {
  let pixels = 0
  for (const asset of assets) {
    const match =
      /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(
        asset.src
      )
    if (!match) throw new Error("Invalid drawing image asset")
    const bytes = Buffer.from(match[2]!, "base64")
    const dimensions = imageSize(bytes)
    if (dimensions.type !== (match[1] === "jpeg" ? "jpg" : match[1]))
      throw new Error("Drawing image bytes do not match their declared format")
    pixels += dimensions.width * dimensions.height
    if (
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width > MAX_IMAGE_DIMENSION ||
      dimensions.height > MAX_IMAGE_DIMENSION ||
      pixels > MAX_IMAGE_PIXELS
    )
      throw new Error("Drawing images exceed preview pixel budget")
  }
}

/** The same browser decoder and limits protect writes and native previews.
 * Header inspection alone cannot establish that compressed image data decodes. */
export async function decodeDrawingImageAssets(
  page: Page,
  assets: DrawingAsset[]
): Promise<void> {
  if (!assets.length) return
  await page.evaluate(
    async ({ assets, maxDimension, maxPixels }) => {
      let pixels = 0
      for (const asset of assets) {
        const image = new Image()
        try {
          image.src = asset.src
          await image.decode().catch(() => {
            throw new Error(`Could not decode drawing image ${asset.id}`)
          })
          pixels += image.naturalWidth * image.naturalHeight
          if (
            !image.naturalWidth ||
            !image.naturalHeight ||
            image.naturalWidth > maxDimension ||
            image.naturalHeight > maxDimension ||
            pixels > maxPixels
          )
            throw new Error("Drawing images exceed preview pixel budget")
        } finally {
          image.removeAttribute("src")
        }
      }
    },
    { assets, maxDimension: MAX_IMAGE_DIMENSION, maxPixels: MAX_IMAGE_PIXELS }
  )
}

export function drawingImageAssets(drawing: QuickdrawDocument): DrawingAsset[] {
  return Object.values(drawing.snapshot.document.store).filter(
    (record): record is DrawingAsset => record.typeName === "asset"
  )
}

/** Existing drawings remain editable without a renderer unless image bytes are
 * introduced or replaced. Validate the resulting complete asset budget before
 * publishing source, history or a mutation receipt, including unused imports. */
export async function validateDrawingImageMutation(
  after: QuickdrawDocument,
  before?: QuickdrawDocument
): Promise<void> {
  const assets = drawingImageAssets(after)
  if (
    !assets.some((asset) => {
      const previous = before?.snapshot.document.store[asset.id]
      return previous?.typeName !== "asset" || previous.src !== asset.src
    })
  )
    return
  inspectDrawingImageAssets(assets)
  await withPreviewPage("drawing", (page) =>
    decodeDrawingImageAssets(page, assets)
  )
}
