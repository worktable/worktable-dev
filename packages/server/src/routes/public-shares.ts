import { SOURCE_URL } from "../release-info.ts"
import { Hono, type Context } from "hono"
import { PublicShareProjection } from "@worktable/hosted-contract"
import {
  getHostedDocumentSharingConfig,
  SHARE_CAPABILITY_HEADER,
} from "../hosted.ts"
import {
  renderPublicDocProjection,
  renderPublicHtmlProjection,
} from "../public-share-renderer.ts"
import { withResolvedDocumentShare } from "../share-store.ts"
import { readSharedArtifact } from "../shared-artifact.ts"

export const publicSharesRouter = new Hono()

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

function unavailable(request: Request, content = false): Response {
  const config = getHostedDocumentSharingConfig()
  const headers =
    content && config
      ? contentHeaders(config.shareOrigin)
      : projectionHeaders()
  return htmlResponse(request, "", 404, headers)
}

function projectionResponse(
  request: Request,
  projection: PublicShareProjection
): Response {
  return htmlResponse(
    request,
    JSON.stringify(projection),
    200,
    projectionHeaders()
  )
}

async function resolveRequest(request: Request) {
  const token = request.headers.get(SHARE_CAPABILITY_HEADER) ?? ""
  return withResolvedDocumentShare(token, async (share) => {
    const artifact = await readSharedArtifact(share)
    return artifact ? { share, artifact } : null
  })
}

publicSharesRouter.onError((error, c) => {
  console.error(
    "[public-share] unavailable:",
    error instanceof Error ? error.name : "error"
  )
  return unavailable(c.req.raw, c.req.path.endsWith("/content"))
})

async function renderOuterShare(c: Context): Promise<Response> {
  const config = getHostedDocumentSharingConfig()
  if (!config) return unavailable(c.req.raw)
  const resolved = await resolveRequest(c.req.raw)
  if (!resolved) return unavailable(c.req.raw)

  if (resolved.artifact.kind === "doc") {
    const projection = await renderPublicDocProjection(
      resolved.artifact.content,
      resolved.artifact.format
    )
    return projectionResponse(
      c.req.raw,
      PublicShareProjection.parse({
        kind: "doc",
        sourceUrl: SOURCE_URL,
        format: resolved.artifact.format,
        title: resolved.artifact.title,
        projectionHtml: projection,
      })
    )
  }

  return projectionResponse(
    c.req.raw,
    PublicShareProjection.parse({
      kind: "html",
      sourceUrl: SOURCE_URL,
      title: resolved.artifact.title,
    })
  )
}

async function renderHtmlContent(c: Context): Promise<Response> {
  const config = getHostedDocumentSharingConfig()
  if (!config) return unavailable(c.req.raw, true)
  const resolved = await resolveRequest(c.req.raw)
  if (!resolved || resolved.artifact.kind !== "html") {
    return unavailable(c.req.raw, true)
  }
  return htmlResponse(
    c.req.raw,
    renderPublicHtmlProjection(resolved.artifact.html),
    200,
    contentHeaders(config.shareOrigin)
  )
}

publicSharesRouter.on(["GET", "HEAD"], "/", renderOuterShare)
publicSharesRouter.on(["GET", "HEAD"], "/content", renderHtmlContent)
publicSharesRouter.all("*", (c) =>
  unavailable(c.req.raw, c.req.path.endsWith("/content"))
)
