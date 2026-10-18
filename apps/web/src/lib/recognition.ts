import type { CSSProperties } from "react"
import { AGENT_PLATFORMS, type AgentPlatformId } from "@worktable/types"
import type { RecognitionColor } from "@worktable/types/recognition"

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
  const words = name.trim().split(/\s+/).filter(Boolean)
  const initials =
    words.length > 1 ? [words[0]!, words[words.length - 1]!] : words
  return initials.map((word) => word[0]?.toUpperCase() ?? "").join("")
}
