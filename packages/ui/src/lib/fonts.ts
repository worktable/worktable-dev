// Worktable serves its own fonts; no page loads one from a third party.
// Fraunces and JetBrains Mono are hashed build assets (apps/web styles).
// General Sans is provisioned for builds and served by the Worktable server
// (apps/desktop/ui/fonts/README.md). The server versions and preloads this
// URL when it serves the page, and drops it when the font is not installed.
export const PRODUCT_FONT_PATH =
  "/worktable-preview/fonts/general-sans-variable.woff2"
export const PRODUCT_FONT_STYLE_ID = "worktable-product-font"

export function productFontFaceCss(url: string): string {
  return `@font-face{font-family:"General Sans";src:url(${JSON.stringify(url)}) format("woff2");font-style:normal;font-weight:200 700;font-display:swap}`
}
