/** Font families shared by native drawing measurement, the editor and previews. */
export const DRAWING_FONT_FAMILIES = [
  "Noto Color Emoji",
  "Noto Sans",
  "Noto Sans Arabic",
  "Noto Sans Hebrew",
  "Noto Sans Bengali",
  "Noto Sans Tamil",
  "Noto Sans Telugu",
  "Noto Sans Kannada",
  "Noto Sans Malayalam",
  "Noto Sans Gujarati",
  "Noto Sans Gurmukhi",
  "Noto Sans Oriya",
  "Noto Sans Sinhala",
  "Noto Sans Thai",
  "Noto Sans Khmer",
  "Noto Sans Lao",
  "Noto Sans Myanmar",
  "Noto Sans JP",
  "Noto Sans KR",
  "Noto Sans SC",
  "Noto Sans Symbols 2",
] as const
const fallback = DRAWING_FONT_FAMILIES.map((family) =>
  JSON.stringify(family)
).join(",")
export const DRAWING_FONTS = {
  sans: `"General Sans",${fallback},system-ui,sans-serif`,
  serif: `"Noto Serif",${fallback},serif`,
  mono: `"Noto Sans Mono",${fallback},monospace`,
  draw: `"Caveat",${fallback},cursive`,
}

export type DrawingFontAsset = {
  id: string
  family: string
  weight: string
  unicodeRange: string
  url: string
}

export function textCodepoints(text: string): number[] {
  const points = new Set<number>()
  for (const char of text) points.add(char.codePointAt(0)!)
  return [...points].sort((a, b) => a - b)
}

/** Points are sorted once per job; each unicode interval uses binary search. */
export function fontContainsCodepoints(
  asset: DrawingFontAsset,
  points: readonly number[]
): boolean {
  return asset.unicodeRange.split(",").some((part) => {
    const range = part.trim().replace(/^U\+/i, "")
    const [a, b = a] = range.includes("?")
      ? [range.replaceAll("?", "0"), range.replaceAll("?", "F")]
      : range.split("-")
    const min = parseInt(a, 16),
      max = parseInt(b, 16)
    let low = 0,
      high = points.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (points[mid]! < min) low = mid + 1
      else high = mid
    }
    return low < points.length && points[low]! <= max
  })
}

export type DrawingFontRun = { font: keyof typeof DRAWING_FONTS; text: string }

/** Preview-only readiness. Register faces without fetching them, then let the
 * browser select the faces needed by the actual text and font choices. Calling
 * FontFace.load() or fonts.load() on the entire fallback stack fetches unused
 * families, even when the first family already covers every character. */
export async function loadDrawingFonts(
  assets: readonly DrawingFontAsset[],
  runs: readonly DrawingFontRun[]
): Promise<void> {
  const faces = assets.map((asset) => {
    const face = new FontFace(
      asset.family,
      `url(${JSON.stringify(asset.url)})`,
      {
        weight: asset.weight,
        style: "normal",
        unicodeRange: asset.unicodeRange,
        display: "swap",
      }
    )
    document.fonts.add(face)
    return face
  })
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")!
  // A loaded face can reveal that another fallback is needed. Repaint until
  // matching is settled. The surrounding preview job owns the hard deadline.
  for (let attempt = 0; attempt <= faces.length; attempt++) {
    for (const run of runs) {
      context.font = `500 20px ${DRAWING_FONTS[run.font]}`
      context.fillText(run.text, 0, 20)
    }
    if (document.fonts.status === "loaded") break
    await document.fonts.ready
  }
  const failed = faces.filter((face) => face.status === "error")
  if (failed.length)
    throw new Error(
      `Could not load drawing font: ${failed.map((face) => face.family).join(", ")}`
    )
}
