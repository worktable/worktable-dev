import { createHash } from "node:crypto"
import type { Context } from "hono"
import {
  IDENTITY_IMAGE_MAX_BYTES,
  IDENTITY_IMAGE_MAX_SIDE,
  type IdentityImageType,
} from "@worktable/types"

/**
 * Worktable logos and people's photos. The browser crops and re-encodes them
 * before upload, which also drops metadata such as a photo's location; the
 * server still accepts only small raster images it can recognize, so nothing
 * it serves back can run as a document.
 */

export interface IdentityImage {
  bytes: Uint8Array
  type: IdentityImageType
  hash: string
}

export const IDENTITY_IMAGE_EXTENSIONS: Record<IdentityImageType, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

/** The type and size an image's own header declares. */
export function imageHeader(
  bytes: Uint8Array
): { type: IdentityImageType; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    ascii(bytes, 12, 4) === "IHDR"
  ) {
    return {
      type: "image/png",
      width: view.getUint32(16),
      height: view.getUint32(20),
    }
  }
  if (
    bytes.length >= 30 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    const chunk = ascii(bytes, 12, 4)
    if (chunk === "VP8 ") {
      return {
        type: "image/webp",
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      }
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!]
      return {
        type: "image/webp",
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      }
    }
    if (chunk === "VP8X") {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
      return { type: "image/webp", width, height }
    }
    return null
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]!
      // Padding bytes before a marker.
      if (marker === 0xff) {
        offset += 1
        continue
      }
      const length = view.getUint16(offset + 2)
      const frame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      if (frame) {
        return {
          type: "image/jpeg",
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        }
      }
      if (length < 2) return null
      offset += 2 + length
    }
  }
  return null
}

export class IdentityImageError extends Error {}

/** Accept an upload, or say why not. */
export function acceptIdentityImage(bytes: Uint8Array): IdentityImage {
  if (bytes.length === 0) throw new IdentityImageError("Choose an image")
  if (bytes.length > IDENTITY_IMAGE_MAX_BYTES) {
    throw new IdentityImageError("That image is too large")
  }
  const header = imageHeader(bytes)
  if (!header) {
    throw new IdentityImageError("Use a PNG, JPEG or WebP image")
  }
  if (
    header.width < 1 ||
    header.height < 1 ||
    header.width > IDENTITY_IMAGE_MAX_SIDE ||
    header.height > IDENTITY_IMAGE_MAX_SIDE
  ) {
    throw new IdentityImageError("That image is too large")
  }
  return {
    bytes,
    type: header.type,
    hash: createHash("sha256").update(bytes).digest("hex").slice(0, 32),
  }
}

/** An image response that the browser keeps: its URL names its content. */
export function identityImageResponse(
  bytes: Uint8Array,
  type: IdentityImageType
): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  })
}

/** Read at most `limit` bytes of a stream; more is refused, not buffered. */
export async function readBoundedStream(
  body: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** A request body, refused as soon as it is larger than an image may be. */
export async function readImageBody(c: Context): Promise<Uint8Array> {
  const declared = Number(c.req.header("Content-Length"))
  if (Number.isFinite(declared) && declared > IDENTITY_IMAGE_MAX_BYTES) {
    throw new IdentityImageError("That image is too large")
  }
  const bytes = await readBoundedStream(c.req.raw.body, IDENTITY_IMAGE_MAX_BYTES)
  if (!bytes) throw new IdentityImageError("That image is too large")
  return bytes
}
