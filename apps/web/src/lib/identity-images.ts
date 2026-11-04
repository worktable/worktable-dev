import {
  listedWorktableLogo,
  type WorktableLogo,
} from "@worktable/types/recognition"
import { authenticatedFetch, BASE_URL, HttpError } from "./http"
import type { WorkspaceInfo } from "./api"

/**
 * A logo as a tile draws it: an icon on the Worktable's color, or an image.
 * Images in the Worktable menu come from Desktop or Cloud as small data URLs.
 */
export type TileLogo =
  | { kind: "icon"; icon: string }
  | { kind: "image"; src: string }

/** Where the current Worktable's logo image loads from; its hash names it. */
export function worktableLogoUrl(hash: string): string {
  return `${BASE_URL}/api/workspace/logo/${hash}`
}

/** Where a person's photo loads from. */
export function personPhotoUrl(participantId: string, hash: string): string {
  return `${BASE_URL}/api/profile/photos/${encodeURIComponent(participantId)}/${hash}`
}

/** This Worktable's saved logo, as its tiles draw it. */
export function tileLogo(
  logo: WorktableLogo | null | undefined
): TileLogo | null {
  if (!logo) return null
  return logo.kind === "icon"
    ? logo
    : { kind: "image", src: worktableLogoUrl(logo.hash) }
}

/**
 * A logo another Worktable's listing carries, from Desktop or Cloud. Only an
 * icon name or an inline raster image is drawn; anything else draws the
 * initial.
 */
export function listedLogo(value: unknown): TileLogo | null {
  const logo = listedWorktableLogo(value)
  if (!logo) return null
  return logo.kind === "icon" ? logo : { kind: "image", src: logo.data }
}

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
 * else PNG.
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
  const png = await encode("image/png")
  if (!png) throw new Error("Couldn’t read that image.")
  return png
}
