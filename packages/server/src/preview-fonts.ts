import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import {
  productFontAssets,
  fulfillProductFont,
  productFontVersion,
} from "./product-fonts.ts"
import {
  DRAWING_FONT_ASSETS,
  DRAWING_FONT_VERSION as FALLBACK_FONT_VERSION,
} from "@worktable/ui/lib/drawing-font-assets.generated"
import {
  fontContainsCodepoints,
  textCodepoints,
  DRAWING_FONTS,
} from "@worktable/ui/lib/drawing-fonts"

export { DRAWING_FONTS }
export function previewFontVersion() {
  return createHash("sha256")
    .update(FALLBACK_FONT_VERSION)
    .update(productFontVersion())
    .digest("hex")
}
const byId = new Map(DRAWING_FONT_ASSETS.map((asset) => [asset.id, asset]))
export function previewFontAssets(text?: string) {
  const assets = [...productFontAssets(), ...DRAWING_FONT_ASSETS]
  if (text === undefined) return assets
  const points = textCodepoints(text)
  return assets.filter((asset) => fontContainsCodepoints(asset, points))
}
export async function fulfillPreviewFont(
  pathname: string
): Promise<Uint8Array | null> {
  const id = pathname.replace(/^\/fonts\//, "")
  const product = await fulfillProductFont(id)
  if (product) return product
  const asset = byId.get(id)
  return asset ? readFile(new URL(asset.url, import.meta.url)) : null
}
export function previewFontCss(baseUrl: string): string {
  const version = previewFontVersion()
  return previewFontAssets()
    .map(
      (asset) =>
        `@font-face{font-family:${JSON.stringify(asset.family)};font-style:normal;font-weight:${asset.weight};font-display:swap;src:url(${JSON.stringify(`${baseUrl}/fonts/${asset.id}?v=${version}`)}) format("${asset.id.endsWith(".woff") ? "woff" : "woff2"}");unicode-range:${asset.unicodeRange}}`
    )
    .join("\n")
}
