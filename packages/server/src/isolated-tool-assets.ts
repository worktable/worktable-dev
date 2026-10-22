import { readFileSync } from "node:fs"
import manifest from "../../ui/src/tool-runtime/generated/manifest.json"
import scriptPath from "../../ui/src/tool-runtime/generated/tool.bundle.js" with { type: "file" }
import compressedPath from "../../ui/src/tool-runtime/generated/tool.bundle.js.gz" with { type: "file" }
import { acceptsGzip } from "./http-compression.ts"

export { manifest as isolatedToolManifest }

// Build-owned immutable bytes, read once at process initialization. Serving a
// tool never scans documents, reads workspace files, or compresses source.
const source = readFileSync(new URL(scriptPath, import.meta.url))
const gzip = readFileSync(new URL(compressedPath, import.meta.url))

export function isolatedToolAsset(request: Request): Response | null {
  if (new URL(request.url).pathname !== manifest.path) return null
  const headers = new Headers({
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    ETag: `W/"${manifest.hash}"`,
    Vary: "Accept-Encoding",
  })
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } })
  if (request.headers.get("If-None-Match") === headers.get("ETag"))
    return new Response(null, { status: 304, headers })
  const compressed = acceptsGzip(request.headers.get("Accept-Encoding") ?? "")
  if (compressed) headers.set("Content-Encoding", "gzip")
  return new Response(
    request.method === "HEAD" ? null : compressed ? gzip : source,
    { headers }
  )
}
