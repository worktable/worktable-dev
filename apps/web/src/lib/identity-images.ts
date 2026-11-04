import {
  listedWorktableLogo,
  type WorktableLogo,
} from "@worktable/types/recognition"
import { BASE_URL } from "./http"

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
