// A file's bytes as an HTTP response, for the app's file route and the
// short-lived links agents download from.

import type { Context } from "hono"
import { documentSourceDisposition } from "./content-disposition.ts"
import { fileMediaType, fileShownInline } from "./file-media.ts"
import type { CurrentFile } from "./document-page-service.ts"
import {
  contentHashOf,
  pinnedFileStream,
  verifyPinnedFile,
  type PinnedFile,
} from "./file-revision.ts"

/** A file at one revision, as a response serves it. */
export interface ServedFile {
  fileName: string
  /** Where its bytes are, at the revision they are served from. */
  pinned: PinnedFile
  /** The content's hash, which its ETag names. */
  contentHash: string
  /** A revision a Doc's page may give as `v` to keep it for good. */
  version?: string
  /** Checks the whole file's bytes as they are sent. */
  verify?: () => { update(chunk: Uint8Array): void; ok(): boolean }
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
} as const

function etagOf(contentHash: string): string {
  return `"${contentHash}"`
}

function matchesNoneOf(c: Context, etag: string): boolean {
  const header = c.req.header("if-none-match")
  if (header === undefined) return false
  return header
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === "*" || tag === etag)
}

type ByteRange = { start: number; end: number } | "unsatisfiable" | null

/**
 * The one range a request asks for, inclusive, or null for the whole file:
 * when it asks for none, for several, in a form this doesn't read, or under
 * an If-Range that no longer holds.
 */
function requestedRange(c: Context, size: number, etag: string): ByteRange {
  const header = c.req.header("range")
  if (header === undefined) return null
  const ifRange = c.req.header("if-range")
  // Only a strong ETag can hold; dates and weak tags fall back to the whole.
  if (ifRange !== undefined && ifRange.trim() !== etag) return null
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!match) return null
  const [, first = "", last = ""] = match
  if (first === "" && last === "") return null
  if (first === "") {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1)
  if (last !== "" && Number(last) < start) return null
  if (start >= size) return "unsatisfiable"
  return { start, end }
}

/**
 * A file's bytes, shown inline only when an image. Every response is
 * sandboxed and unsniffed, a range of them too. A request naming the
 * current content, by its hash or by the revision a Doc's page gave for it,
 * may keep it for good, as may bytes from a moment past: a file's bytes at
 * any of these never change. Others revalidate by ETag.
 */
export async function serveFile(
  c: Context,
  served: ServedFile,
  options: { cacheForGood: boolean }
): Promise<Response> {
  const size = served.pinned.size
  const etag = etagOf(served.contentHash)
  const v = c.req.query("v")
  const cacheControl =
    options.cacheForGood ||
    v === served.contentHash ||
    (served.version !== undefined && v === served.version)
      ? "private, max-age=31536000, immutable"
      : "private, no-cache"
  const inline = fileShownInline(served.fileName) && c.req.query("download") !== "1"
  const headers: Record<string, string> = {
    "Cache-Control": cacheControl,
    ETag: etag,
    "Accept-Ranges": "bytes",
    ...SECURITY_HEADERS,
    "Content-Type": fileMediaType(served.fileName),
    "Content-Disposition": documentSourceDisposition(
      served.fileName,
      inline ? "inline" : "attachment"
    ),
  }
  // The client's copy is current: nothing is opened.
  if (matchesNoneOf(c, etag)) return new Response(null, { status: 304, headers })
  if (c.req.method === "HEAD") {
    return new Response(null, {
      headers: { ...headers, "Content-Length": String(size) },
    })
  }
  const range = requestedRange(c, size, etag)
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    })
  }
  if (range) {
    // A range can't be checked against the whole file's recorded hash as it
    // goes, so a file with one is checked whole first, once per revision.
    if (served.verify) {
      const sound = await verifyPinnedFile(served.pinned, served.verify()).catch(() => false)
      if (!sound) {
        return Response.json(
          { error: "This file can't be read safely.", code: "SOURCE_UNAVAILABLE" },
          { status: 409, headers: SECURITY_HEADERS }
        )
      }
    }
    return new Response(pinnedFileStream(served.pinned, range.start, range.end + 1), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    })
  }
  return new Response(pinnedFileStream(served.pinned, 0, size, served.verify?.()), {
    headers: { ...headers, "Content-Length": String(size) },
  })
}

/**
 * A current file as served: its content hash is the one kept for its
 * revision, or read once and kept from then on.
 */
export async function servedCurrentFile(current: CurrentFile): Promise<ServedFile> {
  return {
    fileName: current.fileName,
    pinned: current.pinned,
    contentHash: await contentHashOf(current.pinned),
    version: current.pinned.revision,
  }
}
