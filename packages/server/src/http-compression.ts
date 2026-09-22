import type { MiddlewareHandler } from "hono"
import { promisify } from "node:util"
import { gzip } from "node:zlib"

const gzipAsync = promisify(gzip)

export function acceptsGzip(value: string): boolean {
  const codings = new Map(
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
  return (codings.get("gzip") ?? codings.get("*") ?? 0) > 0
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
  if (!acceptsGzip(c.req.header("Accept-Encoding") ?? "")) {
    return
  }

  // Hono may replace a response while updating its headers; consume the
  // current body after Vary has been applied, not the earlier response object.
  const body = new Uint8Array(await c.res.arrayBuffer())
  const compressed =
    body.byteLength >= 1024 ? await gzipAsync(body, { level: 6 }) : null
  if (compressed && compressed.byteLength < body.byteLength) {
    c.res = new Response(compressed, c.res)
    c.header("Content-Encoding", "gzip")
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
