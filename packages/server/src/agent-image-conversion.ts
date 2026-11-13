// ============================================================
// Pictures agents can't take, converted to one they can
// ============================================================
//
// Agents take images as PNG, JPEG, GIF or WebP. An AVIF is decoded in the
// sandboxed preview browser, never in this process: a separate process with
// no network, no workers and a deadline. It is given only a file within the
// byte limit whose container declares picture sizes within the pixel limits,
// read here from its box headers before anything decodes it, and what comes
// back is limited too. When the
// browser can't run, conversion is off, or any limit is passed, nothing is
// converted and the agent gets the file's bytes as before.

import { withPreviewPage } from "./document-preview-browser.ts"

/** The largest file converted, and the largest PNG returned. */
const CONVERSION_MAX_BYTES = 5 * 1024 * 1024
/** The widest or tallest picture converted, in pixels. */
const CONVERSION_MAX_SIDE = 8192
/** The most pixels a converted picture holds. */
const CONVERSION_MAX_PIXELS = 40_000_000
/** How long one conversion may take. */
const CONVERSION_DEADLINE_MS = 15_000

/**
 * The picture sizes an AVIF declares, from the image spatial extents
 * (`ispe`) in its `meta` box, read from the container's box headers without
 * decoding anything. Null when it declares none or its boxes don't parse:
 * such a file isn't converted, so the decoder never sees a size it wasn't
 * told first.
 */
export function avifDeclaredSizes(
  bytes: Uint8Array
): Array<{ width: number; height: number }> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sizes: Array<{ width: number; height: number }> = []
  const type = (at: number) =>
    String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
  // The boxes from `start` to `end`, each as [type, content start, end].
  const boxes = (start: number, end: number): Array<[string, number, number]> | null => {
    const found: Array<[string, number, number]> = []
    for (let at = start; at < end; ) {
      if (end - at < 8 || found.length > 4096) return null
      let size = view.getUint32(at)
      let header = 8
      if (size === 1) {
        if (end - at < 16) return null
        const large = view.getBigUint64(at + 8)
        if (large > BigInt(end - at)) return null
        size = Number(large)
        header = 16
      } else if (size === 0) {
        size = end - at
      }
      if (size < header || size > end - at) return null
      found.push([type(at + 4), at + header, at + size])
      at += size
    }
    return found
  }
  const child = (list: Array<[string, number, number]> | null, name: string) =>
    list?.find(([kind]) => kind === name)
  const meta = child(boxes(0, bytes.byteLength), "meta")
  // meta, like ispe, is a full box: a version and flags come first.
  if (!meta || meta[2] - meta[1] < 4) return null
  const iprp = child(boxes(meta[1] + 4, meta[2]), "iprp")
  const ipco = iprp && child(boxes(iprp[1], iprp[2]), "ipco")
  const properties = ipco && boxes(ipco[1], ipco[2])
  if (!properties) return null
  for (const [kind, start, end] of properties) {
    if (kind !== "ispe") continue
    if (end - start < 12) return null
    sizes.push({ width: view.getUint32(start + 4), height: view.getUint32(start + 8) })
  }
  return sizes.length > 0 ? sizes : null
}

/** Whether every size an AVIF declares is within what is converted. */
function withinConversionLimits(bytes: Uint8Array): boolean {
  const sizes = avifDeclaredSizes(bytes)
  return (
    sizes !== null &&
    sizes.every(
      ({ width, height }) =>
        width > 0 &&
        height > 0 &&
        width <= CONVERSION_MAX_SIDE &&
        height <= CONVERSION_MAX_SIDE &&
        width * height <= CONVERSION_MAX_PIXELS
    )
  )
}

/** Whether converting is on; `WORKTABLE_AGENT_IMAGE_CONVERSION=off` turns it off. */
function conversionEnabled(): boolean {
  return process.env["WORKTABLE_AGENT_IMAGE_CONVERSION"]?.trim().toLowerCase() !== "off"
}

/**
 * An AVIF's picture as PNG bytes for an agent, or null when it can't be
 * converted within the limits above.
 */
export async function avifAsPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (
    !conversionEnabled() ||
    bytes.byteLength > CONVERSION_MAX_BYTES ||
    // The decoder allocates for the size the file declares: one past the
    // limits never reaches it.
    !withinConversionLimits(bytes)
  ) {
    return null
  }
  // Held by a timer this call owns: Bun 1.3 can collect an unreferenced
  // AbortSignal.timeout before it fires.
  const deadline = new AbortController()
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Image conversion timed out", "TimeoutError")),
    CONVERSION_DEADLINE_MS
  )
  try {
    const png = await withPreviewPage(
      "image",
      async (page) => {
        await page.setContent("<!doctype html><title>Image</title>")
        return page.evaluate(
          async ({ data, maxSide, maxPixels, maxBytes }) => {
            const binary = atob(data)
            const input = new Uint8Array(binary.length)
            for (let index = 0; index < binary.length; index += 1) {
              input[index] = binary.charCodeAt(index)
            }
            let bitmap: ImageBitmap
            try {
              bitmap = await createImageBitmap(new Blob([input], { type: "image/avif" }))
            } catch {
              return null
            }
            const { width, height } = bitmap
            if (
              width === 0 ||
              height === 0 ||
              width > maxSide ||
              height > maxSide ||
              width * height > maxPixels
            ) {
              bitmap.close()
              return null
            }
            const canvas = new OffscreenCanvas(width, height)
            const context = canvas.getContext("2d")
            if (!context) return null
            context.drawImage(bitmap, 0, 0)
            bitmap.close()
            const blob = await canvas.convertToBlob({ type: "image/png" })
            if (blob.size > maxBytes) return null
            const output = new Uint8Array(await blob.arrayBuffer())
            let text = ""
            for (let index = 0; index < output.length; index += 0x8000) {
              text += String.fromCharCode(...output.subarray(index, index + 0x8000))
            }
            return btoa(text)
          },
          {
            data: Buffer.from(bytes).toString("base64"),
            maxSide: CONVERSION_MAX_SIDE,
            maxPixels: CONVERSION_MAX_PIXELS,
            maxBytes: CONVERSION_MAX_BYTES,
          }
        )
      },
      { signal: deadline.signal }
    )
    return png === null ? null : new Uint8Array(Buffer.from(png, "base64"))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
