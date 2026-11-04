import { authenticatedFetch, BASE_URL, HttpError } from "./http"
import type { WorkspaceInfo } from "./api"

/**
 * Saving logos and photos, which only Settings does; kept apart from the
 * addresses every page draws with.
 */

async function sendImage<T>(
  path: string,
  method: "PUT" | "DELETE",
  image?: Blob
): Promise<T> {
  const response = await authenticatedFetch(`${BASE_URL}${path}`, {
    method,
    ...(image ? { body: image, headers: { "Content-Type": image.type } } : {}),
  })
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null
  if (!response.ok || !body) {
    throw new HttpError(
      response.status,
      body,
      body?.error ?? `HTTP ${response.status}`
    )
  }
  return body
}

/** Upload a cropped logo image; answers with the Worktable's summary. */
export function uploadWorktableLogo(image: Blob): Promise<WorkspaceInfo> {
  return sendImage("/api/workspace/logo", "PUT", image)
}

/** Set or remove your photo. */
export function uploadPersonPhoto(
  image: Blob
): Promise<{ id: string; photo: string }> {
  return sendImage("/api/profile/photo", "PUT", image)
}

export function removePersonPhoto(): Promise<{ id: string; photo: null }> {
  return sendImage("/api/profile/photo", "DELETE")
}

/** The side of the stored square, enough for the largest tile on a sharp screen. */
export const IDENTITY_IMAGE_SIDE = 256

/**
 * Draw the chosen square of an image at the stored size. Re-encoding drops
 * metadata such as a photo's location. WebP where the browser can write it,
 * else JPEG, or PNG for an image with transparency.
 */
export async function encodeSquare(
  image: HTMLImageElement,
  square: { x: number; y: number; size: number }
): Promise<Blob> {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = IDENTITY_IMAGE_SIDE
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Couldn’t read that image.")
  context.imageSmoothingQuality = "high"
  context.drawImage(
    image,
    square.x,
    square.y,
    square.size,
    square.size,
    0,
    0,
    IDENTITY_IMAGE_SIDE,
    IDENTITY_IMAGE_SIDE
  )
  const encode = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  const webp = await encode("image/webp", 0.9)
  if (webp?.type === "image/webp") return webp
  // Safari can't write WebP. A photo as PNG would be too large for the
  // Worktable menu to carry, so an opaque image goes as JPEG and only one
  // with transparency as PNG.
  const opaque = context
    .getImageData(0, 0, IDENTITY_IMAGE_SIDE, IDENTITY_IMAGE_SIDE)
    .data.every((value, index) => index % 4 !== 3 || value === 255)
  const fallback = opaque
    ? await encode("image/jpeg", 0.88)
    : await encode("image/png")
  if (!fallback) throw new Error("Couldn’t read that image.")
  return fallback
}
