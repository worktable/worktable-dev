import { createHash } from "node:crypto"
import { SOURCE_URL } from "../release-info.ts"
import { Hono, type Context } from "hono"
import { PublicShareProjection } from "@worktable/hosted-contract"
import {
  getHostedDocumentSharingConfig,
  SHARE_CAPABILITY_HEADER,
} from "../hosted.ts"
import { acceptsGzip, gzipAsync } from "../http-compression.ts"
import {
  renderPublicDocProjection,
  renderPublicHtmlProjection,
} from "../public-share-renderer.ts"
import { resolveDocumentShare } from "../share-store.ts"
import {
  readSharedArtifact,
  type ReadableSharedArtifact,
} from "../shared-artifact.ts"

const COMMON_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
} as const

function projectionHeaders(): Headers {
  return new Headers({
    ...COMMON_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cross-Origin-Resource-Policy": "same-origin",
  })
}

function contentHeaders(shareOrigin: string): Headers {
  return new Headers({
    ...COMMON_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Security-Policy": [
      "sandbox allow-popups allow-popups-to-escape-sandbox",
      "default-src 'none'",
      "script-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src data:",
      "font-src data:",
      "connect-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${shareOrigin}`,
    ].join("; "),
  })
}

function htmlResponse(
  request: Request,
  body: string,
  status: number,
  headers: Headers
): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers,
  })
}

function unavailable(
  request: Request,
  content = false,
  shareOrigin?: string
): Response {
  const headers =
    content && shareOrigin ? contentHeaders(shareOrigin) : projectionHeaders()
  return htmlResponse(request, "", 404, headers)
}

// ── Rendered pages ───────────────────────────────────────────
//
// Rendering (BlockNote and JSDOM) is most of a view's cost, so recent pages
// are kept by share and artifact revision. Every view resolves its share
// first, so a revoked share never reaches this cache, and a page is kept only
// if its share was still current after the artifact was read.

const MAX_RENDERED_PAGES = 64
const MAX_RENDERED_BYTES = 16 * 1024 * 1024

interface RenderedPage {
  revision: string
  body: string
  bytes: number
  gzip?: ReturnType<typeof gzipAsync>
}

const renderedPages = new Map<string, RenderedPage>()
const renderingPages = new Map<string, Promise<RenderedPage | null>>()
let renderedBytes = 0

function forgetPage(key: string): void {
  const page = renderedPages.get(key)
  if (!page) return
  renderedPages.delete(key)
  renderedBytes -= page.bytes
}

function rememberPage(
  key: string,
  revision: string,
  body: string
): RenderedPage {
  const page = { revision, body, bytes: Buffer.byteLength(body) }
  forgetPage(key)
  // One large page must not push every other share out of the cache.
  if (page.bytes > MAX_RENDERED_BYTES / 4) return page
  renderedPages.set(key, page)
  renderedBytes += page.bytes
  for (const [oldest, old] of renderedPages) {
    if (
      renderedPages.size <= MAX_RENDERED_PAGES &&
      renderedBytes <= MAX_RENDERED_BYTES
    ) {
      break
    }
    renderedPages.delete(oldest)
    renderedBytes -= old.bytes
  }
  return page
}

function pageKeys(token: string): string[] {
  return [`projection:${token}`, `content:${token}`]
}

interface ResolvedShare {
  token: string
  artifact: ReadableSharedArtifact
}

async function resolveRequest(request: Request): Promise<ResolvedShare | null> {
  const token = request.headers.get(SHARE_CAPABILITY_HEADER) ?? ""
  // The lifecycle lock covers only the lookup; see renderedPage.
  const share = await resolveDocumentShare(token)
  if (!share) {
    for (const key of pageKeys(token)) forgetPage(key)
    return null
  }
  const artifact = await readSharedArtifact(share)
  return artifact ? { token, artifact } : null
}

/** The page for this share and artifact revision, rendering it at most once. */
async function renderedPage(
  key: string,
  resolved: ResolvedShare,
  render: () => Promise<string> | string
): Promise<RenderedPage | null> {
  const revision = createHash("sha256")
    .update(JSON.stringify(resolved.artifact))
    .digest("base64url")
  const cached = renderedPages.get(key)
  if (cached?.revision === revision) {
    renderedPages.delete(key)
    renderedPages.set(key, cached)
    return cached
  }

  const renderKey = `${key}\0${revision}`
  let rendering = renderingPages.get(renderKey)
  if (!rendering) {
    rendering = (async () => {
      const body = await render()
      // The artifact was read after the lookup released the lifecycle lock.
      // Shares are revoked before their path changes owner, so a share that
      // is still current proves the read was this share's artifact.
      if (!(await resolveDocumentShare(resolved.token))) return null
      return rememberPage(key, revision, body)
    })()
    renderingPages.set(renderKey, rendering)
    void rendering
      .finally(() => renderingPages.delete(renderKey))
      .catch(() => undefined)
  }
  return rendering
}

async function pageResponse(
  request: Request,
  page: RenderedPage,
  headers: Headers
): Promise<Response> {
  headers.set("Vary", "Accept-Encoding")
  const gzip =
    page.bytes >= 1024 &&
    acceptsGzip(request.headers.get("Accept-Encoding") ?? "")
  if (gzip) headers.set("Content-Encoding", "gzip")
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers })
  }
  return new Response(
    gzip ? await (page.gzip ??= gzipAsync(page.body)) : page.body,
    { status: 200, headers }
  )
}

/** The caller must admit requests before mounting this capability-only router. */
export function createPublicSharesRouter(
  getShareOrigin: () => string | null = () =>
    getHostedDocumentSharingConfig()?.shareOrigin ?? null
): Hono {
  const router = new Hono()
  router.onError((error, c) => {
    console.error(
      "[public-share] unavailable:",
      error instanceof Error ? error.name : "error"
    )
    return unavailable(
      c.req.raw,
      c.req.path.endsWith("/content"),
      getShareOrigin() ?? undefined
    )
  })

  async function renderOuterShare(c: Context): Promise<Response> {
    const shareOrigin = getShareOrigin()
    if (!shareOrigin) return unavailable(c.req.raw)
    const resolved = await resolveRequest(c.req.raw)
    if (!resolved) return unavailable(c.req.raw)

    const { artifact } = resolved
    const page = await renderedPage(
      `projection:${resolved.token}`,
      resolved,
      async () =>
        JSON.stringify(
          artifact.kind === "doc"
            ? PublicShareProjection.parse({
                kind: "doc",
                sourceUrl: SOURCE_URL,
                format: artifact.format,
                title: artifact.title,
                projectionHtml: await renderPublicDocProjection(
                  artifact.content,
                  artifact.format
                ),
              })
            : PublicShareProjection.parse({
                kind: "html",
                sourceUrl: SOURCE_URL,
                title: artifact.title,
              })
        )
    )
    if (!page) return unavailable(c.req.raw)
    return pageResponse(c.req.raw, page, projectionHeaders())
  }

  async function renderHtmlContent(c: Context): Promise<Response> {
    const shareOrigin = getShareOrigin()
    if (!shareOrigin) return unavailable(c.req.raw, true)
    const resolved = await resolveRequest(c.req.raw)
    const artifact = resolved?.artifact
    if (!resolved || artifact?.kind !== "html") {
      return unavailable(c.req.raw, true, shareOrigin)
    }
    const page = await renderedPage(`content:${resolved.token}`, resolved, () =>
      renderPublicHtmlProjection(artifact.html)
    )
    if (!page) return unavailable(c.req.raw, true, shareOrigin)
    return pageResponse(c.req.raw, page, contentHeaders(shareOrigin))
  }

  router.on(["GET", "HEAD"], "/", renderOuterShare)
  router.on(["GET", "HEAD"], "/content", renderHtmlContent)
  router.all("*", (c) =>
    unavailable(
      c.req.raw,
      c.req.path.endsWith("/content"),
      getShareOrigin() ?? undefined
    )
  )
  return router
}

export const publicSharesRouter = createPublicSharesRouter()
