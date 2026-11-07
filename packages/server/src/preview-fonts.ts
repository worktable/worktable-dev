import { readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import fraunces from "../../../apps/desktop/ui/fonts/fraunces-variable-latin.woff2" with { type: "file" }
import jetbrainsMono from "../../../apps/desktop/ui/fonts/jetbrains-mono-variable-latin.woff2" with { type: "file" }
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
  type DrawingFontAsset,
} from "@worktable/ui/lib/drawing-fonts"

export { DRAWING_FONTS }

/** The display and code faces an HTML Doc's theme names, the Latin subsets the
 * app ships. Drawings never use them, so drawing font lists leave them out. */
const DOCUMENT_FONT_ASSETS: readonly DrawingFontAsset[] = [
  {
    id: "fraunces-variable-latin.woff2",
    family: "Fraunces",
    weight: "100 900",
    unicodeRange: "U+0-10FFFF",
    url: fraunces,
  },
  {
    id: "jetbrains-mono-variable-latin.woff2",
    family: "JetBrains Mono",
    weight: "400 800",
    unicodeRange: "U+0-10FFFF",
    url: jetbrainsMono,
  },
]
let documentFontVersion: string | undefined
function documentFontsVersion() {
  if (documentFontVersion) return documentFontVersion
  const hash = createHash("sha256")
  for (const asset of DOCUMENT_FONT_ASSETS)
    hash.update(readFileSync(new URL(asset.url, import.meta.url)))
  return (documentFontVersion = hash.digest("hex"))
}

export function previewFontVersion() {
  return createHash("sha256")
    .update(FALLBACK_FONT_VERSION)
    .update(productFontVersion())
    .update(documentFontsVersion())
    .digest("hex")
}
const byId = new Map(
  [...DRAWING_FONT_ASSETS, ...DOCUMENT_FONT_ASSETS].map((asset) => [
    asset.id,
    asset,
  ])
)
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
/** What in a page uses each document font, as the served theme sets them. */
const DOCUMENT_FONT_USES: Record<string, RegExp> = {
  Fraunces: /<h1[\s>]|--font-display\b/i,
  "JetBrains Mono": /<(?:code|pre|kbd|samp)[\s>]|--font-mono\b/i,
}

/**
 * Preload links for the document fonts a page uses, for the top of its head.
 * A font is otherwise fetched only once layout reaches text set in it, after
 * the page is parsed, and the frame's load event waits for it.
 */
export function documentFontPreloads(baseUrl: string, html: string): string {
  const version = previewFontVersion()
  return DOCUMENT_FONT_ASSETS.filter((asset) =>
    DOCUMENT_FONT_USES[asset.family]?.test(html)
  )
    .map(
      (asset) =>
        `<link rel="preload" as="font" type="font/woff2" crossorigin href=${JSON.stringify(`${baseUrl}/fonts/${asset.id}?v=${version}`)}>`
    )
    .join("")
}

export function previewFontCss(baseUrl: string): string {
  const version = previewFontVersion()
  return [...previewFontAssets(), ...DOCUMENT_FONT_ASSETS]
    .map(
      (asset) =>
        `@font-face{font-family:${JSON.stringify(asset.family)};font-style:normal;font-weight:${asset.weight};font-display:swap;src:url(${JSON.stringify(`${baseUrl}/fonts/${asset.id}?v=${version}`)}) format("${asset.id.endsWith(".woff") ? "woff" : "woff2"}");unicode-range:${asset.unicodeRange}}`
    )
    .join("\n")
}
