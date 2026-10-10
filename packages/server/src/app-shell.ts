import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import {
  PRODUCT_FONT_PATH,
  PRODUCT_FONT_STYLE_ID,
  productFontFaceCss,
} from "@worktable/ui/lib/fonts"
import {
  readDocumentPreloads,
  readRoutePreloads,
  shellWithRoutePreloads,
  type DocumentPreloads,
  type RoutePreloads,
} from "./document-preloads.ts"
import { preferredEncoding, type ContentEncoding } from "./http-compression.ts"

type Page = { html: string; etag: string } & Partial<
  Record<ContentEncoding, Uint8Array<ArrayBuffer>>
>
const bytes = (buffer: Buffer) =>
  new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.length)

const productFontStyle = new RegExp(
  `<style id="${PRODUCT_FONT_STYLE_ID}">[^<]*</style>`
)

/**
 * Point the shell's General Sans face at this installation's font, and preload
 * it as the body face. Without an installed font, fallbacks render instead of
 * requesting a file that is not there. The style element itself stays, so the
 * app hydrates the same head it rendered.
 */
export function shellWithProductFont(
  shell: string,
  fontVersion: string | null
): string {
  const style = (css: string) =>
    `<style id="${PRODUCT_FONT_STYLE_ID}">${css}</style>`
  if (!fontVersion) return shell.replace(productFontStyle, () => style(""))
  const url = `${PRODUCT_FONT_PATH}?v=${fontVersion}`
  return shell.replace(
    productFontStyle,
    () =>
      `<link rel="preload" href="${url}" as="font" type="font/woff2" crossorigin=""/>${style(productFontFaceCss(url))}`
  )
}

/**
 * The single-page shell, as each route should start: only that route's module
 * preloads and the installed product font. Pages are rendered once per route
 * and compressed once, and the build is re-read when the shell file changes.
 */
export function createAppShell(
  staticDir: string,
  shellPath: string,
  fontVersion: () => string | null
) {
  let build:
    | {
        identity: string
        shell: string
        documentPreloads: DocumentPreloads
        routes: RoutePreloads | null
        pages: Map<string, Page>
      }
    | undefined
  const current = () => {
    const stats = statSync(shellPath)
    const identity = `${stats.ino}:${stats.size}:${stats.mtimeMs}`
    if (build?.identity !== identity)
      build = {
        identity,
        shell: readFileSync(shellPath, "utf8"),
        documentPreloads: readDocumentPreloads(staticDir),
        routes: readRoutePreloads(staticDir),
        pages: new Map(),
      }
    return build
  }
  const page = (pathname: string): Page => {
    const { shell, routes, pages } = current()
    const route = routes?.forPath(pathname)
    const font = fontVersion()
    const key = `${route?.route}:${font}`
    let rendered = pages.get(key)
    if (!rendered) {
      const html = shellWithProductFont(
        route
          ? shellWithRoutePreloads(shell, routes!.entry, route.files)
          : shell,
        font
      )
      rendered = {
        html,
        etag: `"${createHash("sha256").update(html).digest("hex").slice(0, 32)}"`,
      }
      pages.set(key, rendered)
    }
    return rendered
  }
  return {
    html: (pathname: string) => page(pathname).html,
    documentPreloads: () => current().documentPreloads,
    response(pathname: string, request: Request): Response {
      const rendered = page(pathname)
      const encoding = preferredEncoding(
        request.headers.get("accept-encoding") ?? "",
        ["br", "gzip"]
      )
      if (encoding && !rendered[encoding])
        rendered[encoding] = bytes(
          encoding === "br"
            ? brotliCompressSync(rendered.html, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
              })
            : gzipSync(rendered.html, { level: 9 })
        )
      const etag = encoding
        ? `${rendered.etag.slice(0, -1)}-${encoding}"`
        : rendered.etag
      const headers = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        Vary: "Accept-Encoding",
        ETag: etag,
      })
      if (
        request.headers
          .get("if-none-match")
          ?.split(",")
          .some((tag) => tag.trim().replace(/^W\//, "") === etag)
      )
        return new Response(null, { status: 304, headers })
      const body = encoding ? rendered[encoding]! : rendered.html
      if (encoding) headers.set("Content-Encoding", encoding)
      headers.set(
        "Content-Length",
        String(typeof body === "string" ? Buffer.byteLength(body) : body.length)
      )
      return new Response(request.method === "HEAD" ? null : body, { headers })
    },
  }
}
