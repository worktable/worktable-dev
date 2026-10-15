const OKLCH = /^oklch\((\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)\)$/

/** Opaque `oklch(L C H)` to the nearest sRGB hex, for adapters that need hex. */
export function oklchToHex(color: string): string {
  const match = color.match(OKLCH)
  if (!match)
    throw new Error(`Expected an opaque OKLCH color, received ${color}`)

  const lightness = Number(match[1])
  const chroma = Number(match[2])
  const hue = (Number(match[3]) * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]

  return `#${linear
    .map((value) => {
      const clamped = Math.max(0, Math.min(1, value))
      const encoded =
        clamped <= 0.0031308
          ? 12.92 * clamped
          : 1.055 * clamped ** (1 / 2.4) - 0.055
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, "0")
    })
    .join("")}`
}
