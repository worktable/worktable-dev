// ============================================================
// Built HTML Doc frames, kept by revision
// ============================================================
//
// A frame that carries Space images (html-space-images.ts) is megabytes, and
// building and compressing it takes most of a second: Brotli alone takes
// about 0.4 s for 4 MB of images. Its revision names its content, so the
// built page is kept by Doc, revision and theme, with each encoding it has
// been sent in, in a byte-bounded cache: the next request for it sends bytes
// already made. Frames without Space images are built per request, as they
// always were, and the compression middleware compresses them.

import {
  compressBody,
  isLocalBrowserRequest,
  preferredEncoding,
  type ContentEncoding,
} from "./http-compression.ts"

const MAX_BYTES = 64 * 1024 * 1024
const MAX_FRAMES = 64
/** A frame larger than this, its encodings included, isn't kept. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024
/** Smaller bodies go as they are, as the compression middleware sends them. */
const MIN_COMPRESSED_BYTES = 1024

interface Frame {
  body: Uint8Array<ArrayBuffer>
  encodings: Map<ContentEncoding, Promise<Uint8Array<ArrayBuffer>>>
  bytes: number
}

const frames = new Map<string, Frame>()
const building = new Map<string, Promise<Frame>>()
let total = 0

function forget(key: string): void {
  const frame = frames.get(key)
  if (!frame) return
  frames.delete(key)
  total -= frame.bytes
}

/** Oldest first out, until the cache fits; one too large never stays. */
function trim(): void {
  for (const [key, frame] of frames) {
    if (frame.bytes > MAX_FRAME_BYTES) forget(key)
  }
  for (const key of frames.keys()) {
    if (frames.size <= MAX_FRAMES && total <= MAX_BYTES) break
    forget(key)
  }
}

function remember(key: string, frame: Frame): void {
  forget(key)
  frames.set(key, frame)
  total += frame.bytes
  trim()
}

/** A built frame: its bytes, and each encoding of them, made once. */
export interface BuiltFrame {
  body: Uint8Array<ArrayBuffer>
  encoded(encoding: ContentEncoding): Promise<Uint8Array<ArrayBuffer>>
}

function built(key: string, frame: Frame): BuiltFrame {
  return {
    body: frame.body,
    encoded(encoding) {
      let encoded = frame.encodings.get(encoding)
      if (!encoded) {
        encoded = compressBody(frame.body, encoding)
        frame.encodings.set(encoding, encoded)
        void encoded.then(
          (bytes) => {
            if (frames.get(key) !== frame) return
            frame.bytes += bytes.byteLength
            total += bytes.byteLength
            trim()
          },
          () => frame.encodings.delete(encoding)
        )
      }
      return encoded
    },
  }
}

/**
 * The frame kept under `key`, else the one `build` makes, kept when it says
 * so. `key` must name the frame's content: its revision, theme and Doc.
 * Requests for one key that arrive together build it once.
 */
export async function builtFrame(
  key: string,
  build: () => Promise<{ html: string; keep: boolean }>
): Promise<BuiltFrame> {
  const kept = frames.get(key)
  if (kept) {
    // Most recently used last.
    frames.delete(key)
    frames.set(key, kept)
    return built(key, kept)
  }
  let pending = building.get(key)
  if (!pending) {
    pending = build().then(({ html, keep }) => {
      const body = Buffer.from(html, "utf8")
      const frame: Frame = { body, encodings: new Map(), bytes: body.byteLength }
      if (keep) remember(key, frame)
      return frame
    })
    building.set(key, pending)
    const settled = pending
    void settled
      .finally(() => {
        if (building.get(key) === settled) building.delete(key)
      })
      .catch(() => undefined)
  }
  return built(key, await pending)
}

/**
 * A frame's response, compressed as the compression middleware would
 * compress it, from the bytes kept for that encoding. Content-Encoding is
 * set here, so the middleware leaves it alone.
 */
export async function builtFrameResponse(
  request: Request,
  frame: BuiltFrame,
  headers: Record<string, string>
): Promise<Response> {
  const vary = headers["Vary"]
    ? `${headers["Vary"]}, Accept-Encoding`
    : "Accept-Encoding"
  const encoding =
    frame.body.byteLength < MIN_COMPRESSED_BYTES ||
    isLocalBrowserRequest(request)
      ? null
      : preferredEncoding(request.headers.get("Accept-Encoding") ?? "", [
          "br",
          "gzip",
        ])
  if (encoding) {
    const encoded = await frame.encoded(encoding).catch(() => null)
    if (encoded && encoded.byteLength < frame.body.byteLength) {
      return new Response(encoded, {
        headers: { ...headers, Vary: vary, "Content-Encoding": encoding },
      })
    }
  }
  return new Response(frame.body, { headers: { ...headers, Vary: vary } })
}
