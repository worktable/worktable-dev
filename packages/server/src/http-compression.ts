import type { MiddlewareHandler } from "hono"
import { promisify } from "node:util"
import { brotliCompress, constants, gzip } from "node:zlib"
import { publicSurfaceAuthRequired } from "./auth.ts"
import { isLoopbackPeer } from "./request-source.ts"
import { timing } from "./request-timing.ts"

/** Compress off the request loop, on libuv's thread pool. */
export const gzipAsync = promisify(gzip)
const brotliAsync = promisify(brotliCompress)

export type ContentEncoding = "br" | "gzip"

function codingQualities(value: string): Map<string, number> {
  return new Map(
    value
      .toLowerCase()
      .split(",")
      .map((entry) => {
        const [name, ...params] = entry.trim().split(";")
        const quality = params.find((param) => param.trim().startsWith("q="))
        const q = quality ? Number(quality.trim().slice(2)) : 1
        return [name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0] as const
      })
  )
}

/**
 * The offered coding the client weights highest, or null for identity. Ties
 * go to the earlier offer, so list Brotli first.
 */
export function preferredEncoding(
  acceptEncoding: string,
  offered: readonly ContentEncoding[]
): ContentEncoding | null {
  const codings = codingQualities(acceptEncoding)
  let best: ContentEncoding | null = null
  let bestQuality = 0
  for (const coding of offered) {
    const quality = codings.get(coding) ?? codings.get("*") ?? 0
    if (quality > bestQuality) {
      best = coding
      bestQuality = quality
    }
  }
  return best
}

export function acceptsGzip(value: string): boolean {
  return preferredEncoding(value, ["gzip"]) === "gzip"
}

/**
 * A browser on this computer talking straight to an unexposed server, as with
 * a local install or Desktop. Compressing for it spends CPU to save no time.
 * Behind a tunnel, a proxy or the Cloud gateway, peers look local but are not.
 */
export function isLocalBrowserRequest(request: Request): boolean {
  return isLoopbackPeer(request) && !publicSurfaceAuthRequired()
}

// Buffered JSON and HTML API responses participate. SSE, MCP, downloads, static
// assets and upgraded sockets retain their own delivery/lifecycle semantics.
export const compressApiResponse: MiddlewareHandler = async (c, next) => {
  await next()
  const response = c.res
  if (
    c.req.method === "HEAD" ||
    response.status !== 200 ||
    !response.body ||
    !/^(?:application\/(?:[\w.-]+\+)?json|text\/html)(?:;|$)/i.test(
      response.headers.get("Content-Type") ?? ""
    ) ||
    response.headers.has("Content-Encoding") ||
    response.headers.has("Content-Range") ||
    response.headers.has("Content-Disposition") ||
    /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(
      response.headers.get("Cache-Control") ?? ""
    ) ||
    c.req.path === "/api/mcp" ||
    c.req.path.startsWith("/api/mcp/")
  )
    return

  const vary = response.headers.get("Vary") ?? ""
  if (
    !vary
      .split(",")
      .some((v) => ["*", "accept-encoding"].includes(v.trim().toLowerCase()))
  ) {
    c.header("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding")
  }
  const encoding = preferredEncoding(c.req.header("Accept-Encoding") ?? "", [
    "br",
    "gzip",
  ])
  if (!encoding || isLocalBrowserRequest(c.req.raw)) return

  // Hono may replace a response while updating its headers; consume the
  // current body after Vary has been applied, not the earlier response object.
  const body = new Uint8Array(await c.res.arrayBuffer())
  const compressed =
    body.byteLength < 1024
      ? null
      : await timing.span(encoding, () =>
          encoding === "br"
            ? brotliAsync(body, {
                params: {
                  // Fast enough for every response; smaller than gzip level 6.
                  [constants.BROTLI_PARAM_QUALITY]: 5,
                  [constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
                },
              })
            : gzipAsync(body, { level: 6 })
        )
  if (compressed && compressed.byteLength < body.byteLength) {
    c.res = new Response(compressed, c.res)
    c.header("Content-Encoding", encoding)
    c.header("Content-Length", String(compressed.byteLength))
    // A strong validator describes bytes. The weak form still validates the
    // same JSON representation across content encodings without false identity.
    const etag = response.headers.get("ETag")
    if (etag && !etag.startsWith("W/")) c.header("ETag", `W/${etag}`)
  } else {
    c.res = new Response(body, c.res)
    c.header("Content-Length", String(body.byteLength))
  }
}
