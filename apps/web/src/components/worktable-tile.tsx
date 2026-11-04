import { useState } from "react"
import type { RecognitionColor } from "@worktable/types/recognition"
import { cn } from "@worktable/ui/lib/utils"
import type { TileLogo } from "@/lib/identity-images"
import { NamedIcon } from "@/lib/icons"
import { recognitionSolid } from "@/lib/recognition"

/**
 * A Worktable's mark: its logo, else its initial on its color. Rounded
 * squares, since Worktables are places and only people are round.
 */
export function WorktableTile({
  name,
  color,
  logo,
  className,
}: {
  name: string
  color: RecognitionColor
  logo?: TileLogo | null
  /** Sizes other than the sidebar's 24 px. */
  className?: string
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const tile = cn(
    "flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-[25%] text-xs font-semibold",
    className
  )
  if (logo?.kind === "image" && failed !== logo.src) {
    return (
      <img
        src={logo.src}
        alt=""
        aria-hidden
        draggable={false}
        onError={() => setFailed(logo.src)}
        className={cn(
          tile,
          "object-cover outline-1 -outline-offset-1 outline-border"
        )}
      />
    )
  }
  return (
    <span aria-hidden className={tile} style={recognitionSolid(color)}>
      {logo?.kind === "icon" ? (
        <NamedIcon
          name={logo.icon}
          className="size-[60%]"
          fallback={name.trim().charAt(0).toUpperCase() || "W"}
        />
      ) : (
        name.trim().charAt(0).toUpperCase() || "W"
      )}
    </span>
  )
}
