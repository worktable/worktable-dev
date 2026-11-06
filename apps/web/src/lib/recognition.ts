import type { CSSProperties } from "react"
import { AGENT_PLATFORMS, type AgentPlatformId } from "@worktable/types"
import type {
  RecognitionColor,
  WorktableLogo,
} from "@worktable/types/recognition"
import { BASE_URL } from "./http"

export function agentLogoUrl(
  platform: AgentPlatformId | undefined
): string | null {
  const logo = platform ? AGENT_PLATFORMS[platform]?.logo : null
  return logo ? `/agent-logos/${logo}` : null
}

/** A solid tile or avatar carrying white initials. */
export function recognitionSolid(color: RecognitionColor): CSSProperties {
  return { backgroundColor: `var(--recognition-${color})`, color: "white" }
}

/** An icon drawn in its color on a soft fill of the same hue. */
export function recognitionChip(color: RecognitionColor): CSSProperties {
  return {
    backgroundColor: `var(--recognition-${color}-soft)`,
    color: `var(--recognition-${color}-ink)`,
  }
}

/** Initials used by person and agent avatars without loading Thread schemas. */
export function participantInitials(name: string): string {
  // "Sage (Claude)" is Sage: what's in brackets and stray marks aren't the name.
  const words = name
    .replace(/\([^()]*\)/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
  if (words.length === 0) return name.trim().charAt(0).toUpperCase()
  return (
    words[0]![0]! + (words.length > 1 ? words.at(-1)![0]! : "")
  ).toUpperCase()
}

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
