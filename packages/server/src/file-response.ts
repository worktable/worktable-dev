// A file's bytes as an HTTP response, for the app's file route and the
// short-lived links agents download from.

import type { Context } from "hono"
import { documentSourceDisposition } from "./content-disposition.ts"
import { fileMediaType, fileShownInline } from "./file-media.ts"
import { fileContentHash } from "./file-uploads.ts"

/**
 * A file's bytes, shown inline only when an image. Every response is
 * sandboxed and unsniffed. A request naming the current content, by its
 * hash or by the version a Doc's page gave for it, may keep it for good, as
 * may bytes from a moment past: a file's bytes at any of these never change.
 * Others revalidate by ETag.
 */
export function serveFileBytes(
  c: Context,
  bytes: Uint8Array,
  fileName: string,
  options: { cacheForGood: boolean; version?: string }
): Response {
  const hash = fileContentHash(bytes)
  const etag = `"${hash}"`
  const v = c.req.query("v")
  const cacheControl =
    options.cacheForGood ||
    v === hash ||
    (options.version !== undefined && v === options.version)
      ? "private, max-age=31536000, immutable"
      : "private, no-cache"
  const headers: Record<string, string> = {
    "Cache-Control": cacheControl,
    ETag: etag,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  }
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers })
  }
  const inline = fileShownInline(fileName) && c.req.query("download") !== "1"
  return new Response(new Uint8Array(bytes).buffer, {
    headers: {
      ...headers,
      "Content-Type": fileMediaType(fileName),
      "Content-Disposition": documentSourceDisposition(
        fileName,
        inline ? "inline" : "attachment"
      ),
    },
  })
}
