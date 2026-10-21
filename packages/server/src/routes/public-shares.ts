import { createHash } from "node:crypto"
import { SOURCE_URL } from "../release-info.ts"
import { Hono, type Context } from "hono"
import {
  PUBLIC_SHARE_STATUS,
  PublicShareProjection,
} from "@worktable/hosted-contract"
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
import { legacyShareHeldBack } from "../share-policy.ts"
import {
  readShareLinkDocument,
  resolveShareLinkView,
  shareLinkStillOpens,
  type ShareLinkView,
} from "../share-link-views.ts"
import {
  getShareLink,
  noteShareLinkUsed,
  onShareLinksChanged,
  ShareLinksStoreError,
  sharingV2Active,
} from "../share-links-store.ts"
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

/** Too many pages are rendering; the gateway shows its waiting page. */
function busy(
  request: Request,
  content: boolean,
  shareOrigin: string
): Response {
  const headers = content ? contentHeaders(shareOrigin) : projectionHeaders()
  headers.set("Retry-After", "5")
  return htmlResponse(
    request,
    content ? "" : JSON.stringify({ error: "Busy", code: "BUSY" }),
    PUBLIC_SHARE_STATUS.BUSY,
    headers
  )
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

// Pages of links (v2) are kept by link, surface, path and content revision,
// so a hit needs neither the content nor a second lookup: the link was live
// when this request resolved it, and the revision names the content. A
// revoked or edited link's pages are dropped at once.

function linkPageKey(
  linkId: string,
  surface: "projection" | "content",
  path: string,
  revision: string,
  title: string
): string {
  // The outer page shows the title, which an HTML Doc keeps apart from its
  // content.
  const key = `${linkId}\0${surface}\0${path}\0${revision}`
  return surface === "projection" ? `${key}\0${title}` : key
}

function forgetLinkPages(linkId: string): void {
  const prefix = `${linkId}\0`
  for (const key of [...renderedPages.keys()]) {
    if (key.startsWith(prefix)) forgetPage(key)
  }
}

onShareLinksChanged((ids) => {
  for (const id of ids) forgetLinkPages(id)
})

// Rendering a missed page is the expensive part of a view. A few run at
// once, a few more wait, and the rest are told to come back.
const RENDER_CONCURRENCY = 2
const RENDER_QUEUE = 16
let rendersRunning = 0
const renderWaiting: Array<() => void> = []
const renderingLinkPages = new Map<
  string,
  Promise<RenderedPage | null | "busy">
>()

async function withRenderSlot<T>(
  render: () => Promise<T>
): Promise<T | "busy"> {
  if (rendersRunning < RENDER_CONCURRENCY) rendersRunning++
  else if (renderWaiting.length >= RENDER_QUEUE) return "busy"
  else await new Promise<void>((resolve) => renderWaiting.push(resolve))
  try {
    return await render()
  } finally {
    // The slot passes straight to the next waiter.
    const next = renderWaiting.shift()
    if (next) next()
    else rendersRunning--
  }
}

function linkStillOpens(id: string): boolean {
  const link = getShareLink(id)
  return Boolean(
    link &&
    link.servable &&
    link.revokedAt === null &&
    (link.expiresAt === null || link.expiresAt > Date.now())
  )
}

async function renderLinkBody(
  view: ShareLinkView,
  surface: "projection" | "content"
): Promise<RenderedPage | null> {
  const document = await readShareLinkDocument(view, surface)
  if (!document) return null
  let body: string
  let revision: string | null
  if (document.kind === "html-title") {
    body = JSON.stringify(
      PublicShareProjection.parse({
        kind: "html",
        sourceUrl: SOURCE_URL,
        title: document.title,
      })
    )
    revision = view.revision
  } else if (document.kind === "html") {
    body = renderPublicHtmlProjection(document.html)
    revision = document.revision
  } else {
    body = JSON.stringify(
      PublicShareProjection.parse({
        kind: "doc",
        sourceUrl: SOURCE_URL,
        format: document.format,
        title: document.title,
        projectionHtml: await renderPublicDocProjection(
          document.content,
          document.format
        ),
      })
    )
    revision = document.revision
  }
  // Rendering takes a while: a link revoked or held back meanwhile gets
  // neither this page nor a cached one. One statement, on a miss only.
  if (!shareLinkStillOpens(view.link)) return null
  // Kept under the revision that was read, which may be newer than the one
  // the request looked up.
  if (revision === null) {
    return { revision: "", body, bytes: Buffer.byteLength(body) }
  }
  return rememberPage(
    linkPageKey(view.link.id, surface, view.path, revision, view.title),
    revision,
    body
  )
}

/** The link's page at its current revision, rendering it at most once. */
async function renderLinkPage(
  view: ShareLinkView,
  surface: "projection" | "content"
): Promise<RenderedPage | null | "busy"> {
  if (view.revision === null) {
    return withRenderSlot(() => renderLinkBody(view, surface))
  }
  const key = linkPageKey(
    view.link.id,
    surface,
    view.path,
    view.revision,
    view.title
  )
  const cached = renderedPages.get(key)
  if (cached) {
    renderedPages.delete(key)
    renderedPages.set(key, cached)
    return cached
  }
  // Requests for the same page wait for one render.
  let rendering = renderingLinkPages.get(key)
  if (!rendering) {
    rendering = withRenderSlot(() => renderLinkBody(view, surface))
    renderingLinkPages.set(key, rendering)
    void rendering
      .finally(() => renderingLinkPages.delete(key))
      .catch(() => undefined)
  }
  return rendering
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
  // With links v2 on, the owner policy holds back today's links too.
  if (!share || (sharingV2Active() && legacyShareHeldBack(share))) {
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

  /**
   * Serve a link from the links store, or null when the token is not one of
   * its links and the older share store answers instead.
   */
  async function serveLink(
    c: Context,
    surface: "projection" | "content",
    shareOrigin: string
  ): Promise<Response | null> {
    if (!sharingV2Active()) return null
    const content = surface === "content"
    let view: Awaited<ReturnType<typeof resolveShareLinkView>>
    try {
      view = await resolveShareLinkView(
        c.req.raw.headers.get(SHARE_CAPABILITY_HEADER) ?? ""
      )
    } catch (error) {
      // A store this binary cannot open serves none of its links, and its
      // policy, which can't be checked, holds older links back too.
      if (error instanceof ShareLinksStoreError) return null
      throw error
    }
    if (view === null) return null
    if (view === "unavailable" || (content && view.link.kind !== "html")) {
      return unavailable(c.req.raw, content, shareOrigin)
    }
    const page = await renderLinkPage(view, surface)
    if (page === "busy") return busy(c.req.raw, content, shareOrigin)
    if (!page) return unavailable(c.req.raw, content, shareOrigin)
    noteShareLinkUsed(view.link)
    return pageResponse(
      c.req.raw,
      page,
      content ? contentHeaders(shareOrigin) : projectionHeaders()
    )
  }

  async function renderOuterShare(c: Context): Promise<Response> {
    const shareOrigin = getShareOrigin()
    if (!shareOrigin) return unavailable(c.req.raw)
    const link = await serveLink(c, "projection", shareOrigin)
    if (link) return link
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
    const link = await serveLink(c, "content", shareOrigin)
    if (link) return link
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
