import { resolve } from "node:path"
import { Hono } from "hono"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DocumentReadingPreview } from "@worktable/ui/document-reading-preview"
import { requireScope, trustedLocalIdentity } from "./auth.ts"
import { useResolvedDocumentHandle } from "./document-query.ts"
import { readDocumentSource } from "./document-source-reader.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { hasScope } from "./token-store.ts"
import type { DocumentPreloads } from "./document-preloads.ts"

export const OPENING_DATA_MARKER =
  '<script id="worktable-opening-data" type="application/json">null</script>'
export const OPENING_VIEW_MARKER = '<div id="worktable-opening-preview"></div>'

// A separate read-only surface uses exactly the REST identity and scope guards.
// Failure leaves the public shell untouched so its normal login/error flow runs.
// Gateway admission has already run on the outer navigation request.
const opening = new Hono()
opening.use("*", trustedLocalIdentity(), requireScope("documents:read"))
opening.get("/spaces/:spaceId/documents/*", async (c) => {
  const match = new URL(c.req.url).pathname.match(
    /^\/spaces\/([^/]+)\/documents\/(.+)$/
  )
  if (!match) return c.body(null, 204)
  const spaceId = decodeURIComponent(match[1])
  const path = decodeURIComponent(match[2])
  const result = await useResolvedDocumentHandle(
    { spaceId, path, includeArchived: true },
    async (handle) => {
      if (c.req.raw.signal.aborted) return null
      // Never project aliases, conflicts, unsupported formats or unvalidated paths.
      // The bounded source read stays inside the same document transaction.
      if (
        handle.document.path !== path ||
        handle.document.health !== "supported"
      )
        return null
      const format = handle.document.format.id
      const pathname = new URL(c.req.url).pathname
      if (
        format === BUILTIN_DOCUMENT_FORMATS.html &&
        handle.rendererKey === "html"
      ) {
        return hasScope(c.get("identity").scopes, "widgets:read")
          ? { pathname, html: "", preloadKey: "html" as const }
          : null
      }
      if (
        handle.rendererKey !== "doc" ||
        !hasScope(c.get("identity").scopes, "docs:read")
      )
        return null
      if (
        format !== BUILTIN_DOCUMENT_FORMATS.richText &&
        format !== BUILTIN_DOCUMENT_FORMATS.markdown
      )
        return null
      const bytes = await readDocumentSource({
        spaceRoot: resolve(getWorkspaceRoot(), "spaces", spaceId),
        documentId: handle.documentId,
        format: handle.document.format,
        source: handle.source,
        maxBytes: 2 * 1024 * 1024,
        signal: c.req.raw.signal,
      })
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      const content =
        format === BUILTIN_DOCUMENT_FORMATS.richText ? JSON.parse(text) : text
      if (typeof content !== "string" && !Array.isArray(content)) return null
      const html = renderToStaticMarkup(
        createElement(DocumentReadingPreview, { content })
      )
      // Bound the opening response even when one block contains enormous text.
      if (Buffer.byteLength(html) > 128 * 1024) return null
      return {
        pathname,
        html,
        preloadKey:
          format === BUILTIN_DOCUMENT_FORMATS.richText
            ? ("rich-text" as const)
            : ("markdown" as const),
      }
    }
  )
  return result && "html" in result ? c.json(result) : c.body(null, 204)
})
opening.onError(() => new Response(null, { status: 204 }))

export async function injectDocumentOpening(
  request: Request,
  shell: string,
  preloads?: DocumentPreloads
): Promise<string | null> {
  if (
    !shell.includes(OPENING_DATA_MARKER) ||
    !shell.includes(OPENING_VIEW_MARKER)
  )
    return null
  if (!/^\/spaces\/[^/]+\/documents\/.+/.test(new URL(request.url).pathname))
    return null
  // A projection is optional: slow catalog/auth/storage work must not hold up
  // the shell and all of its asset discovery. Aborted reads cannot publish a
  // late snapshot after the normal app has taken over.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(250)])
  if (signal.aborted) return null
  const response = await Promise.race([
    opening.fetch(new Request(request, { signal })),
    new Promise<null>((resolve) =>
      signal.addEventListener("abort", () => resolve(null), { once: true })
    ),
  ])
  if (!response || response.status !== 200 || signal.aborted) return null
  const data = (await response.json()) as {
    pathname: string
    html: string
    preloadKey: keyof DocumentPreloads
    preloads?: string[]
  }
  data.preloads = preloads?.[data.preloadKey] ?? []
  // JSON in a script raw-text element must never contain a literal '<'. React
  // escapes authored content in the separate preview markup above.
  const serialized = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  return shell
    .replace(
      OPENING_DATA_MARKER,
      () =>
        `<script id="worktable-opening-data" type="application/json">${serialized}</script>`
    )
    .replace(
      OPENING_VIEW_MARKER,
      () => `<div id="worktable-opening-preview">${data.html}</div>`
    )
}
