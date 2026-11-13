// ============================================================
// Pictures agents can't take, converted to one they can
// ============================================================
//
// Agents take images as PNG, JPEG, GIF or WebP. An AVIF is decoded in the
// sandboxed preview browser, never in this process: a separate process with
// no network, no workers and a deadline, limited here by the bytes it is
// given, the size of the picture and the size of what comes back. When the
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

/** Whether converting is on; `WORKTABLE_AGENT_IMAGE_CONVERSION=off` turns it off. */
function conversionEnabled(): boolean {
  return process.env["WORKTABLE_AGENT_IMAGE_CONVERSION"]?.trim().toLowerCase() !== "off"
}

/**
 * An AVIF's picture as PNG bytes for an agent, or null when it can't be
 * converted within the limits above.
 */
export async function avifAsPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!conversionEnabled() || bytes.byteLength > CONVERSION_MAX_BYTES) return null
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
