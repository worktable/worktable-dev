// What a viewer frame and the page that holds it say to each other.
//
// A viewer frame shows a file whose format has to be parsed, such as a PDF.
// It is a document Worktable serves with no origin of its own and no
// network: it can't read the session, the API or any other site. The page
// that holds it fetches the file and hands the bytes in; these messages are
// everything that crosses. A frame names nothing but offsets into the one
// file it was opened for, and plain names of its own public files.

/** The viewers Worktable builds; each is one frame document. */
export type ViewerKey = "pdf"

/** How opening a file ended, when it didn't end in the file being shown. */
export type ViewerRefusal =
  /** The file needs a password this viewer wasn't given. */
  | "password"
  /** The file can't be read as its type. */
  | "damaged"
  /** The viewer couldn't start or gave up. */
  | "failed"

/** Where the reader is in the file, as the viewer reports it. */
export interface ViewerState {
  /** The page in view, from 1. */
  page: number
  pages: number
  /** The scale pages are drawn at, where 1 is the file's own size. */
  scale: number
}

/** A public file a viewer needs, by kind and plain name. */
export interface ViewerAssetRequest {
  kind: string
  name: string
}

/** From the page to the frame. */
export type ViewerHostMessage =
  | {
      type: "viewer.open"
      /** The file's size, which the frame may read within. */
      byteLength: number
      /** The file's first bytes, or all of them when `whole`. */
      start: ArrayBuffer
      whole: boolean
      /** The page to start at, from 1. */
      page?: number
    }
  | { type: "viewer.bytes"; begin: number; data: ArrayBuffer | null }
  | { type: "viewer.asset"; id: string; data: ArrayBuffer | null }
  | { type: "viewer.command"; command: ViewerCommand }
  /** The password a reader typed, or null when they gave up. */
  | { type: "viewer.password"; password: string | null }

/** What the page asks of an open viewer. */
export type ViewerCommand =
  | { name: "page"; page: number }
  | { name: "zoom"; to: "in" | "out" | "fit" }
  /** Show or hide the page browser beside the file. */
  | { name: "rail"; open: boolean }
  /** Find text; an empty query ends finding and clears what was found. */
  | { name: "find"; query: string; direction?: "next" | "previous" }

/** From the frame to the page. Every message carries the frame's token. */
export type ViewerFrameMessage = { token: string } & (
  | { type: "viewer.handshake" }
  | { type: "viewer.read"; begin: number; end: number }
  | ({ type: "viewer.asset"; id: string } & ViewerAssetRequest)
  | ({ type: "viewer.shown" } & ViewerState)
  | ({ type: "viewer.state" } & ViewerState)
  | { type: "viewer.find"; current: number; total: number }
  /** The file needs a password; `retry` when the last one was wrong. */
  | { type: "viewer.password"; retry: boolean }
  | { type: "viewer.refused"; reason: ViewerRefusal }
  /** A link the reader followed; the page decides whether to open it. */
  | { type: "viewer.link"; url: string }
  /** The page browser closed itself, as it does after a choice on a phone. */
  | { type: "viewer.rail"; open: boolean }
  /** A key the reader pressed that the app owns, such as Escape. */
  | { type: "viewer.key"; key: string }
)

/**
 * The size of the pieces a large file is read in. Small on purpose: pdf.js
 * reads whole pieces around each object it needs, so larger ones pull in
 * far more of a file whose pages are listed flat.
 */
export const VIEWER_PIECE_BYTES = 64 * 1024

/** How much of a large file is fetched before its viewer asks for anything. */
export const VIEWER_FIRST_BYTES = 4 * VIEWER_PIECE_BYTES

/** Up to this size a file is handed to its viewer whole, in one request. */
export const VIEWER_WHOLE_FILE_BYTES = 4 * 1024 * 1024

const MESSAGE_TYPES = new Set([
  "viewer.handshake",
  "viewer.read",
  "viewer.asset",
  "viewer.shown",
  "viewer.state",
  "viewer.find",
  "viewer.password",
  "viewer.rail",
  "viewer.refused",
  "viewer.link",
  "viewer.key",
])

/** A frame's message, or null for anything else that reaches the page. */
export function viewerFrameMessage(data: unknown): ViewerFrameMessage | null {
  if (typeof data !== "object" || data === null) return null
  const message = data as { type?: unknown; token?: unknown }
  if (typeof message.type !== "string" || !MESSAGE_TYPES.has(message.type)) {
    return null
  }
  if (typeof message.token !== "string" || message.token.length === 0) {
    return null
  }
  return data as ViewerFrameMessage
}

/** The part of a file a frame may be given: only what is inside the file. */
export function clampViewerRead(
  begin: unknown,
  end: unknown,
  byteLength: number
): { begin: number; end: number } | null {
  if (typeof begin !== "number" || typeof end !== "number") return null
  if (!Number.isInteger(begin) || !Number.isInteger(end)) return null
  if (begin < 0 || end <= begin || begin >= byteLength) return null
  return { begin, end: Math.min(end, byteLength) }
}

/** A viewer's public file by a plain name: no folders, no dots first. */
export function viewerAssetPath(request: ViewerAssetRequest): string | null {
  const plain = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
  if (!/^[a-z][a-z_-]{0,31}$/.test(request.kind)) return null
  if (!plain.test(request.name) || request.name.includes("..")) return null
  return `${request.kind}/${request.name}`
}

/**
 * The page a link to a PDF names, as `#page=12`, the way links into PDFs
 * do everywhere; other parts of the address are left alone.
 */
export function pdfPageFromHash(hash: string): number | undefined {
  const match = /(?:^#|&)page=(\d{1,6})(?:&|$)/.exec(hash)
  const page = match ? Number(match[1]) : NaN
  return page >= 1 ? page : undefined
}
