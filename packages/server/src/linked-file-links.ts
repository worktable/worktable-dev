// File links through Worktable Link. The relay carries a request or an answer
// of at most LINKED_REQUEST_MAX_BYTES, each signed with its body's hash, so a
// file link's bytes cross it in pieces: the gateway sends an upload piece by
// piece, in order, and asks for a download the same way.

import {
  LINKED_FILE_LINK_MAX_BYTES,
  LINKED_FILE_SIZE_HEADER,
  LINKED_REQUEST_MAX_BYTES,
} from "@worktable/hosted-contract"
import { FileRevisionError } from "./file-revision.ts"
import { redeemFileTicket, type FileTicket } from "./file-tickets.ts"
import { filesEnabled } from "./files-enabled.ts"
import { fileLinksRouter, saveFileLinkUpload } from "./routes/file-links.ts"
import { discardStagedFile, StagingFile } from "./staged-file.ts"

/**
 * Each upload in progress is staged on disk, a piece at a time, until it is
 * saved; this bounds the disk they take at once.
 */
const UPLOADS_AT_ONCE = 2
/**
 * Each download piece is held whole while it crosses the relay, so pieces
 * take turns: at most this many are held at once.
 */
const DOWNLOAD_PIECES_AT_ONCE = 2
/** An upload whose next piece doesn't come in this long is dropped. */
const UPLOAD_IDLE_MS = 2 * 60_000

interface PendingUpload {
  ticket: Extract<FileTicket, { kind: "upload" }>
  file: StagingFile
  total: number
  /** Bytes taken, counted when a piece arrives, before it is written. */
  received: number
  /** The pieces taken so far, written in order. */
  written: Promise<void>
  touchedAt: number
}

const uploads = new Map<string, PendingUpload>()

/** End an upload in progress, leaving nothing of it on disk. */
async function dropUpload(token: string): Promise<void> {
  const upload = uploads.get(token)
  if (!upload) return
  uploads.delete(token)
  await upload.written.catch(() => undefined)
  await upload.file.discard()
}
let uploadsSaving = 0
let downloadPieces = 0
const waitingForPiece: Array<() => void> = []

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
    if (now - upload.touchedAt > UPLOAD_IDLE_MS) void dropUpload(key)
  if (total > LINKED_FILE_LINK_MAX_BYTES) {
    return answer(
      { error: "A file can be up to 64 MiB.", code: "PAYLOAD_TOO_LARGE" },
      413
    )
  }
  let upload = uploads.get(token)
  if (!upload && offset === 0) {
    if (uploads.size + uploadsSaving >= UPLOADS_AT_ONCE) {
      return answer(
        { error: "Another upload is under way. Try again shortly.", code: "BUSY" },
        429,
        { "Retry-After": "5" }
      )
    }
    const ticket = redeemFileTicket(token, "upload", now)
    if (!ticket || ticket.kind !== "upload") return answer(GONE, 410)
    // Held while the file is created, so the next piece finds the upload.
    uploadsSaving++
    let file: StagingFile
    try {
      file = await StagingFile.create()
    } finally {
      uploadsSaving--
    }
    upload = {
      ticket,
      file,
      total,
      received: 0,
      written: Promise.resolve(),
      touchedAt: now,
    }
    uploads.set(token, upload)
  }
  if (!upload) return answer(GONE, 410)
  if (
    offset !== upload.received ||
    total !== upload.total ||
    offset + piece.byteLength > total ||
    (piece.byteLength === 0 && total > 0)
  ) {
    await dropUpload(token)
    return answer(
      {
        error: "The upload arrived out of order. Ask for a new link.",
        code: "UPLOAD_BROKEN",
      },
      409
    )
  }
  const pending = upload
  pending.received += piece.byteLength
  pending.touchedAt = now
  // Whether this piece completes the file is fixed when it is taken: later
  // pieces may be counted before this one is written.
  const received = pending.received
  const last = received === total
  const written = pending.written.then(() => pending.file.append(piece))
  pending.written = written
  try {
    await written
  } catch (error) {
    await dropUpload(token)
    throw error
  }
  if (!last) return answer({ ok: true, received }, 202)
  // Only the last piece saves the file, once every piece queued before it is
  // written; one that failed has ended the upload.
  try {
    await pending.written
  } catch {
    return answer(GONE, 410)
  }
  if (uploads.get(token) !== pending) return answer(GONE, 410)
  uploads.delete(token)
  uploadsSaving++
  try {
    const staged = await pending.file.finish()
    try {
      const saved = await saveFileLinkUpload(pending.ticket, staged)
      return answer(saved.body, saved.status)
    } finally {
      await discardStagedFile(staged)
    }
  } catch (error) {
    await pending.file.discard()
    throw error
  } finally {
    uploadsSaving--
  }
}

/**
 * One piece of a download, from `offset`: the file's own headers, at most
 * one piece of its bytes, and its whole size. The link reads the revision
 * its first piece did, and only this piece's range of it: a later piece of
 * a file replaced partway is refused. Its ETag names the content too.
 */
export async function sendDownloadPiece(
  token: string,
  offset: number,
  method: "GET" | "HEAD"
): Promise<Response> {
  // A piece that finishes hands its turn to the next one waiting.
  if (downloadPieces >= DOWNLOAD_PIECES_AT_ONCE)
    await new Promise<void>((resolve) => waitingForPiece.push(resolve))
  else downloadPieces++
  try {
    return await readDownloadPiece(token, offset, method)
  } finally {
    const next = waitingForPiece.shift()
    if (next) next()
    else downloadPieces--
  }
}

function piece(from: Response, size: number, body: ArrayBuffer | null): Response {
  const headers = new Headers(from.headers)
  headers.set(LINKED_FILE_SIZE_HEADER, String(size))
  headers.set("Cache-Control", "no-store")
  headers.delete("Content-Length")
  headers.delete("Content-Range")
  return new Response(body, { status: 200, headers })
}

async function readDownloadPiece(
  token: string,
  offset: number,
  method: "GET" | "HEAD"
): Promise<Response> {
  // A HEAD, or a piece at the very end, carries the headers and no bytes.
  const whole = () => fileLinksRouter.request(`/${token}`, { method: "HEAD" })
  if (method === "HEAD") {
    const head = await whole()
    if (!head.ok) return head
    return piece(head, Number(head.headers.get("Content-Length") ?? "0"), null)
  }
  const ranged = await fileLinksRouter.request(`/${token}`, {
    headers: { Range: `bytes=${offset}-${offset + LINKED_REQUEST_MAX_BYTES - 1}` },
  })
  if (ranged.status === 206) {
    const size = Number(ranged.headers.get("Content-Range")?.split("/")[1])
    let body: ArrayBuffer
    try {
      body = await ranged.arrayBuffer()
    } catch (error) {
      // The file changed while this piece was read.
      if (!(error instanceof FileRevisionError)) throw error
      return answer(
        {
          error: "This file changed after the link was made. Read it again for a new link.",
          code: "FILE_CHANGED",
        },
        409
      )
    }
    return piece(ranged, size, body)
  }
  if (ranged.status === 416) {
    const size = Number(ranged.headers.get("Content-Range")?.split("/")[1])
    if (offset !== size) {
      return answer({ error: "Past the end of the file.", code: "RANGE" }, 416)
    }
    const head = await whole()
    if (!head.ok) return head
    return piece(head, size, new ArrayBuffer(0))
  }
  return ranged
}

/** Drop uploads in progress, as when the link is revoked. */
export function clearPendingUploads(): void {
  for (const token of [...uploads.keys()]) void dropUpload(token)
}
