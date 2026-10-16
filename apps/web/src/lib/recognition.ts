import type { CSSProperties } from "react"
import type { RecognitionColor } from "@worktable/types/recognition"

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
