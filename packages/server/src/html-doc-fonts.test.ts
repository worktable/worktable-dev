import { expect, test } from "bun:test"
import { SHARE_FONT_CSS } from "./widget-share-runtime.ts"
import { injectWidgetHostStyles } from "./widget-authoring.ts"

const page = (body: string, style = "") =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${style}</style></head><body>${body}</body></html>`
const preloads = (html: string) =>
  [...html.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map(
    ([, href]) => href!.split("/").pop()!.split("?")[0]
  )

test("starts loading the document fonts a page uses at the top of its head", () => {
  const titled = injectWidgetHostStyles(page("<h1>Plan</h1><p>Text</p>"))
  expect(preloads(titled)).toEqual(["fraunces-variable-latin.woff2"])
  // Before the page's own head content, so the fetch begins with the page.
  expect(titled.indexOf('rel="preload"')).toBeLessThan(titled.indexOf('name="viewport"'))

  expect(preloads(injectWidgetHostStyles(page("<p>Run <code>bun test</code></p>")))).toEqual([
    "jetbrains-mono-variable-latin.woff2",
  ])
  // A page that names the theme's variables uses the fonts too.
  expect(
    preloads(injectWidgetHostStyles(page("<p class=t>Plan</p>", ".t{font-family:var(--font-display)}")))
  ).toEqual(["fraunces-variable-latin.woff2"])

  // A page that uses neither fetches neither, and share links bring their own fonts.
  expect(preloads(injectWidgetHostStyles(page("<p>Text</p>")))).toEqual([])
  expect(
    preloads(injectWidgetHostStyles(page("<h1>Plan</h1>"), { fontStyles: SHARE_FONT_CSS }))
  ).toEqual([])
})
