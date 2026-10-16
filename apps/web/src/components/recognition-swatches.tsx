import { Check } from "lucide-react"
import { RECOGNITION_COLORS, type RecognitionColor } from "@worktable/types"
import { recognitionSolid } from "@/lib/recognition"

const NAMES: Record<RecognitionColor, string> = {
  teal: "Teal",
  sky: "Sky",
  violet: "Violet",
  rose: "Rose",
  orange: "Orange",
  amber: "Amber",
  green: "Green",
  slate: "Slate",
}

/** Chooses one of the recognition colors. */
export function RecognitionSwatches({
  value,
  onChange,
  label,
  disabled,
}: {
  value: RecognitionColor
  onChange: (color: RecognitionColor) => void
  label: string
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {RECOGNITION_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={NAMES[color]}
          title={NAMES[color]}
          disabled={disabled}
          onClick={() => onChange(color)}
          className="flex size-7 items-center justify-center rounded-md outline-offset-2 transition-shadow aria-checked:ring-2 aria-checked:ring-ring aria-checked:ring-offset-2 aria-checked:ring-offset-background disabled:opacity-50"
          style={recognitionSolid(color)}
        >
          {value === color && <Check className="size-3.5" />}
        </button>
      ))}
    </div>
  )
}
