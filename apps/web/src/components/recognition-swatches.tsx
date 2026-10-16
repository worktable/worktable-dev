import { useRef } from "react"
import { Check } from "lucide-react"
import { RECOGNITION_COLORS, type RecognitionColor } from "@worktable/types/recognition"
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
  const buttons = useRef(new Map<RecognitionColor, HTMLButtonElement>())
  // One tab stop; arrows move the choice, as in the Theme picker.
  function handleKeyDown(event: React.KeyboardEvent) {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown"
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp"
    if ((!forward && !back) || disabled) return
    event.preventDefault()
    const index = RECOGNITION_COLORS.indexOf(value)
    const count = RECOGNITION_COLORS.length
    const next = RECOGNITION_COLORS[(index + (forward ? 1 : -1) + count) % count]
    onChange(next)
    buttons.current.get(next)?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap gap-2"
      onKeyDown={handleKeyDown}
    >
      {RECOGNITION_COLORS.map((color) => (
        <button
          key={color}
          ref={(element) => {
            if (element) buttons.current.set(color, element)
            else buttons.current.delete(color)
          }}
          type="button"
          role="radio"
          aria-checked={value === color}
          tabIndex={value === color ? 0 : -1}
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
