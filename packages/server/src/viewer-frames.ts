// Viewer frames: the documents the app shows files in when a file's format
// has to be parsed, such as a PDF.
//
// A viewer frame is a document with no origin and no network. The web build
// makes each one self-contained (apps/web/viewer-frames.ts) and writes the
// policy it must be served under beside it; this module sends both. The
// frame never fetches anything: the app's page hands it the file's bytes
// and, by name, the viewer's own public files, which are served here too.

import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { preferredEncoding, type ContentEncoding } from "./http-compression.ts"
import { getStaticAssetsInfo, readBuildId } from "./static-assets.ts"

/** The viewers a build may carry. */
export const VIEWER_KEYS = ["pdf", "word"] as const
export type ViewerKey = (typeof VIEWER_KEYS)[number]

export function isViewerKey(value: string): value is ViewerKey {
  return (VIEWER_KEYS as readonly string[]).includes(value)
}

/**
 * Whether a viewer is on. Each can be turned off without a release, as
 * `WORKTABLE_VIEWER_PDF=off`, when its parser has a problem; its files then
 * show as a card with Download, as they did before the viewer.
 */
export function viewerEnabled(key: ViewerKey): boolean {
  const value = process.env[`WORKTABLE_VIEWER_${key.toUpperCase()}`]
    ?.trim()
    .toLowerCase()
  return value !== "off" && value !== "0" && value !== "false"
}

type Viewers = { dir: string; buildId: string | null }
let viewers: Promise<Viewers | null> | undefined

/**
 * Where the viewer frames are: in the web build, or, in a source checkout
 * with no web build, built once into a temporary folder.
 */
function viewersFolder(): Promise<Viewers | null> {
  viewers ??= (async () => {
    const override = process.env["WORKTABLE_VIEWERS_DIR"]?.trim()
    if (override) return { dir: override, buildId: null }
    const staticDir = getStaticAssetsInfo().staticDir
    if (staticDir && existsSync(join(staticDir, "viewers"))) {
      return {
        dir: join(staticDir, "viewers"),
        buildId: readBuildId(staticDir),
      }
    }
    const entry = join(
      import.meta.dir,
      "../../../apps/web/build-viewer-frames.ts"
    )
    if (!existsSync(entry)) return null
    const dir = mkdtempSync(join(tmpdir(), "worktable-viewers-"))
    const child = Bun.spawn([process.execPath, entry, dir], {
      stdout: "ignore",
      stderr: "ignore",
      cwd: dirname(entry),
    })
    return (await child.exited) === 0 ? { dir, buildId: null } : null
  })()
  return viewers
}

/** Test seam: where the frames are is kept for the process's lifetime. */
export function resetViewerFramesForTests(): void {
  viewers = undefined
}

const notFound = () => new Response("Not found", { status: 404 })

function cacheControl(request: Request, buildId: string | null): string {
  // The app names the build it runs. A frame or file of that build never
  // changes, so the browser may keep it for good.
  const version = new URL(request.url).searchParams.get("v")
  return buildId !== null && version === buildId
    ? "private, max-age=31536000, immutable"
    : "private, no-cache"
}

function respond(
  request: Request,
  path: string,
  headers: Record<string, string>,
  encoding: ContentEncoding | null
): Response {
  let size: number
  let etag: string
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return notFound()
    size = stats.size
    etag = `"${stats.ino.toString(36)}-${stats.size.toString(36)}-${Math.floor(stats.mtimeMs).toString(36)}"`
  } catch {
    return notFound()
  }
  const all = {
    ...headers,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(encoding ? { "Content-Encoding": encoding } : {}),
  }
  const known = request.headers.get("if-none-match")
  if (
    known?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)
  ) {
    return new Response(null, { status: 304, headers: all })
  }
  return new Response(request.method === "HEAD" ? null : Bun.file(path), {
    headers: { ...all, "Content-Length": String(size) },
  })
}

/** A viewer's frame document, under the policy its build wrote for it. */
export async function viewerFrameResponse(
  key: string,
  request: Request
): Promise<Response> {
  if (!isViewerKey(key) || !viewerEnabled(key)) return notFound()
  const found = await viewersFolder()
  if (!found) return notFound()
  const frame = join(found.dir, key, "frame.html")
  let csp: unknown
  try {
    csp = (
      JSON.parse(readFileSync(join(found.dir, key, "policy.json"), "utf8")) as {
        csp?: unknown
      }
    ).csp
  } catch {
    return notFound()
  }
  // Without its policy a frame would run with the app's origin: never send it.
  if (typeof csp !== "string" || !csp.startsWith("sandbox allow-scripts;"))
    return notFound()
  const encoding = preferredEncoding(
    request.headers.get("accept-encoding") ?? "",
    compressedCopies(frame)
  )
  return respond(
    request,
    encoding ? `${frame}.${encoding === "br" ? "br" : "gz"}` : frame,
    {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "Cache-Control": cacheControl(request, found.buildId),
      Vary: "Accept-Encoding",
    },
    encoding
  )
}

/** The copies of a file the build compressed, best first. */
function compressedCopies(path: string): ContentEncoding[] {
  return (["br", "gzip"] as const).filter((coding) =>
    existsSync(`${path}.${coding === "br" ? "br" : "gz"}`)
  )
}

/** One of a viewer's public files, such as a font, by kind and plain name. */
export async function viewerFileResponse(
  key: string,
  kind: string,
  name: string,
  request: Request
): Promise<Response> {
  if (!isViewerKey(key) || !viewerEnabled(key)) return notFound()
  if (!/^[a-z][a-z_-]{0,31}$/.test(kind)) return notFound()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.includes(".."))
    return notFound()
  const found = await viewersFolder()
  if (!found) return notFound()
  const root = resolve(found.dir, key, "files")
  const path = resolve(root, kind, name)
  if (!path.startsWith(root + sep)) return notFound()
  // A Word viewer's engine is sent compressed when the build made copies.
  const offered = compressedCopies(path)
  const encoding = preferredEncoding(
    request.headers.get("accept-encoding") ?? "",
    offered
  )
  return respond(
    request,
    encoding ? `${path}.${encoding === "br" ? "br" : "gz"}` : path,
    {
      "Content-Type": "application/octet-stream",
      "Cache-Control": cacheControl(request, found.buildId),
      ...(offered.length ? { Vary: "Accept-Encoding" } : {}),
    },
    encoding
  )
}
