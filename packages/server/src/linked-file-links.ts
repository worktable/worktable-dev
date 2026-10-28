// File links through Worktable Link. The relay carries a request or an answer
// of at most LINKED_REQUEST_MAX_BYTES, each signed with its body's hash, so a
// file link's bytes cross it in pieces: the gateway sends an upload piece by
// piece, in order, and asks for a download the same way.

import {
  LINKED_FILE_LINK_MAX_BYTES,
  LINKED_FILE_SIZE_HEADER,
  LINKED_REQUEST_MAX_BYTES,
} from "@worktable/hosted-contract"
import { redeemFileTicket, type FileTicket } from "./file-tickets.ts"
import { filesEnabled } from "./files-enabled.ts"
import { fileLinksRouter, saveFileLinkUpload } from "./routes/file-links.ts"

/** Each upload in progress holds its file in memory until its last piece. */
const UPLOADS_AT_ONCE = 2
/** An upload whose next piece doesn't come in this long is dropped. */
const UPLOAD_IDLE_MS = 2 * 60_000

interface PendingUpload {
  ticket: Extract<FileTicket, { kind: "upload" }>
  bytes: Uint8Array
  received: number
  touchedAt: number
}

const uploads = new Map<string, PendingUpload>()

function answer(body: unknown, status: number, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  })
}

const GONE = {
  error: "This link has expired or was used. Ask for a new one.",
  code: "LINK_EXPIRED",
}

/**
 * One piece of an upload. The first takes the link, so it works once; the
 * file is saved, as whoever made the link, when the last arrives. A piece
 * out of order ends the upload.
 */
export async function receiveUploadPiece(
  token: string,
  offset: number,
  total: number,
  piece: Uint8Array,
  now = Date.now()
): Promise<Response> {
  if (!filesEnabled()) return answer({ error: "Not found", code: "NOT_FOUND" }, 404)
  for (const [key, upload] of uploads)
    if (now - upload.touchedAt > UPLOAD_IDLE_MS) uploads.delete(key)
  if (total > LINKED_FILE_LINK_MAX_BYTES) {
    return answer(
      { error: "A file can be up to 64 MiB.", code: "PAYLOAD_TOO_LARGE" },
      413
    )
  }
  let upload = uploads.get(token)
  if (!upload && offset === 0) {
    if (uploads.size >= UPLOADS_AT_ONCE) {
      return answer(
        { error: "Another upload is under way. Try again shortly.", code: "BUSY" },
        429,
        { "Retry-After": "5" }
      )
    }
    const ticket = redeemFileTicket(token, "upload", now)
    if (!ticket || ticket.kind !== "upload") return answer(GONE, 410)
    upload = { ticket, bytes: new Uint8Array(total), received: 0, touchedAt: now }
    uploads.set(token, upload)
  }
  if (!upload) return answer(GONE, 410)
  if (
    offset !== upload.received ||
    total !== upload.bytes.byteLength ||
    offset + piece.byteLength > total ||
    (piece.byteLength === 0 && total > 0)
  ) {
    uploads.delete(token)
    return answer(
      {
        error: "The upload arrived out of order. Ask for a new link.",
        code: "UPLOAD_BROKEN",
      },
      409
    )
  }
  upload.bytes.set(piece, offset)
  upload.received += piece.byteLength
  upload.touchedAt = now
  if (upload.received < total) {
    return answer({ ok: true, received: upload.received }, 202)
  }
  uploads.delete(token)
  const saved = await saveFileLinkUpload(upload.ticket, upload.bytes)
  return answer(saved.body, saved.status)
}

/**
 * One piece of a download, from `offset`: the file's own headers, at most
 * one piece of its bytes, and its whole size.
 */
export async function sendDownloadPiece(
  token: string,
  offset: number,
  method: "GET" | "HEAD"
): Promise<Response> {
  const whole = await fileLinksRouter.request(`/${token}`)
  if (!whole.ok) return whole
  const bytes = new Uint8Array(await whole.arrayBuffer())
  if (offset > bytes.byteLength) {
    return answer({ error: "Past the end of the file.", code: "RANGE" }, 416)
  }
  const headers = new Headers(whole.headers)
  headers.set(LINKED_FILE_SIZE_HEADER, String(bytes.byteLength))
  headers.set("Cache-Control", "no-store")
  headers.delete("ETag")
  headers.delete("Content-Length")
  const piece = bytes.slice(offset, offset + LINKED_REQUEST_MAX_BYTES)
  return new Response(method === "HEAD" ? null : piece, { status: 200, headers })
}

/** Drop uploads in progress, as when the link is revoked. */
export function clearPendingUploads(): void {
  uploads.clear()
}
