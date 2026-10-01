import { readFileSync } from "node:fs"
import { parse, type Font } from "opentype.js"
import sans_latin from "@fontsource/noto-sans/files/noto-sans-latin-500-normal.woff" with { type: "file" }
import sans_latin_ext from "@fontsource/noto-sans/files/noto-sans-latin-ext-500-normal.woff" with { type: "file" }
import sans_greek from "@fontsource/noto-sans/files/noto-sans-greek-500-normal.woff" with { type: "file" }
import sans_greek_ext from "@fontsource/noto-sans/files/noto-sans-greek-ext-500-normal.woff" with { type: "file" }
import sans_cyrillic from "@fontsource/noto-sans/files/noto-sans-cyrillic-500-normal.woff" with { type: "file" }
import sans_cyrillic_ext from "@fontsource/noto-sans/files/noto-sans-cyrillic-ext-500-normal.woff" with { type: "file" }
import sans_vietnamese from "@fontsource/noto-sans/files/noto-sans-vietnamese-500-normal.woff" with { type: "file" }
import serif_latin from "@fontsource/noto-serif/files/noto-serif-latin-500-normal.woff" with { type: "file" }
import serif_latin_ext from "@fontsource/noto-serif/files/noto-serif-latin-ext-500-normal.woff" with { type: "file" }
import serif_greek from "@fontsource/noto-serif/files/noto-serif-greek-500-normal.woff" with { type: "file" }
import serif_greek_ext from "@fontsource/noto-serif/files/noto-serif-greek-ext-500-normal.woff" with { type: "file" }
import serif_cyrillic from "@fontsource/noto-serif/files/noto-serif-cyrillic-500-normal.woff" with { type: "file" }
import serif_cyrillic_ext from "@fontsource/noto-serif/files/noto-serif-cyrillic-ext-500-normal.woff" with { type: "file" }
import serif_vietnamese from "@fontsource/noto-serif/files/noto-serif-vietnamese-500-normal.woff" with { type: "file" }
import mono_latin from "@fontsource/noto-sans-mono/files/noto-sans-mono-latin-500-normal.woff" with { type: "file" }
import mono_latin_ext from "@fontsource/noto-sans-mono/files/noto-sans-mono-latin-ext-500-normal.woff" with { type: "file" }
import mono_greek from "@fontsource/noto-sans-mono/files/noto-sans-mono-greek-500-normal.woff" with { type: "file" }
import mono_greek_ext from "@fontsource/noto-sans-mono/files/noto-sans-mono-greek-ext-500-normal.woff" with { type: "file" }
import mono_cyrillic from "@fontsource/noto-sans-mono/files/noto-sans-mono-cyrillic-500-normal.woff" with { type: "file" }
import mono_cyrillic_ext from "@fontsource/noto-sans-mono/files/noto-sans-mono-cyrillic-ext-500-normal.woff" with { type: "file" }
import mono_vietnamese from "@fontsource/noto-sans-mono/files/noto-sans-mono-vietnamese-500-normal.woff" with { type: "file" }
import draw_latin from "@fontsource/caveat/files/caveat-latin-500-normal.woff" with { type: "file" }
import draw_latin_ext from "@fontsource/caveat/files/caveat-latin-ext-500-normal.woff" with { type: "file" }
import draw_cyrillic from "@fontsource/caveat/files/caveat-cyrillic-500-normal.woff" with { type: "file" }
import draw_cyrillic_ext from "@fontsource/caveat/files/caveat-cyrillic-ext-500-normal.woff" with { type: "file" }

import symbols from "@fontsource/noto-sans-symbols-2/files/noto-sans-symbols-2-symbols-400-normal.woff" with { type: "file" }

import math from "@fontsource/noto-sans-symbols-2/files/noto-sans-symbols-2-math-400-normal.woff" with { type: "file" }

export type DrawingFontStyle = "sans" | "serif" | "mono" | "draw"
type FontFace = { style: DrawingFontStyle; family: string; path: string }
const faces: FontFace[] = [
  { style: "sans", family: "Worktable Noto Sans latin", path: sans_latin },
  {
    style: "sans",
    family: "Worktable Noto Sans latin-ext",
    path: sans_latin_ext,
  },
  { style: "sans", family: "Worktable Noto Sans greek", path: sans_greek },
  {
    style: "sans",
    family: "Worktable Noto Sans greek-ext",
    path: sans_greek_ext,
  },
  {
    style: "sans",
    family: "Worktable Noto Sans cyrillic",
    path: sans_cyrillic,
  },
  {
    style: "sans",
    family: "Worktable Noto Sans cyrillic-ext",
    path: sans_cyrillic_ext,
  },
  {
    style: "sans",
    family: "Worktable Noto Sans vietnamese",
    path: sans_vietnamese,
  },
  { style: "serif", family: "Worktable Noto Serif latin", path: serif_latin },
  {
    style: "serif",
    family: "Worktable Noto Serif latin-ext",
    path: serif_latin_ext,
  },
  { style: "serif", family: "Worktable Noto Serif greek", path: serif_greek },
  {
    style: "serif",
    family: "Worktable Noto Serif greek-ext",
    path: serif_greek_ext,
  },
  {
    style: "serif",
    family: "Worktable Noto Serif cyrillic",
    path: serif_cyrillic,
  },
  {
    style: "serif",
    family: "Worktable Noto Serif cyrillic-ext",
    path: serif_cyrillic_ext,
  },
  {
    style: "serif",
    family: "Worktable Noto Serif vietnamese",
    path: serif_vietnamese,
  },
  { style: "mono", family: "Worktable Noto Sans Mono latin", path: mono_latin },
  {
    style: "mono",
    family: "Worktable Noto Sans Mono latin-ext",
    path: mono_latin_ext,
  },
  { style: "mono", family: "Worktable Noto Sans Mono greek", path: mono_greek },
  {
    style: "mono",
    family: "Worktable Noto Sans Mono greek-ext",
    path: mono_greek_ext,
  },
  {
    style: "mono",
    family: "Worktable Noto Sans Mono cyrillic",
    path: mono_cyrillic,
  },
  {
    style: "mono",
    family: "Worktable Noto Sans Mono cyrillic-ext",
    path: mono_cyrillic_ext,
  },
  {
    style: "mono",
    family: "Worktable Noto Sans Mono vietnamese",
    path: mono_vietnamese,
  },
  { style: "draw", family: "Worktable Caveat latin", path: draw_latin },
  { style: "draw", family: "Worktable Caveat latin-ext", path: draw_latin_ext },
  { style: "draw", family: "Worktable Caveat cyrillic", path: draw_cyrillic },
  {
    style: "draw",
    family: "Worktable Caveat cyrillic-ext",
    path: draw_cyrillic_ext,
  },
]
faces.push(
  { style: "sans", family: "Worktable Noto Sans Symbols", path: symbols },
  { style: "sans", family: "Worktable Noto Sans Math", path: math }
)
const loaded = new Map<FontFace, { font: Font; bytes: Buffer }>()
function load(face: FontFace) {
  let result = loaded.get(face)
  if (!result) {
    const bytes = readFileSync(new URL(face.path, import.meta.url))
    const font = parse(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer
    )
    result = { font, bytes }
    loaded.set(face, result)
  }
  return result
}
export const drawingDefaultFont = faces[0]
export function drawingPrimaryFont(style: DrawingFontStyle) {
  return faces.find((face) => face.style === style)!
}
export function drawingFontMetrics(style: DrawingFontStyle) {
  return load(drawingPrimaryFont(style)).font
}
export type DrawingTextRun = {
  text: string
  face: FontFace
  w: number
  missing: boolean
}
export function drawingTextRuns(
  text: string,
  size: number,
  style: DrawingFontStyle
): DrawingTextRun[] {
  const candidates = [
    ...faces.filter((face) => face.style === style),
    ...faces.filter((face) => face.style === "sans" && style !== "sans"),
  ]
  const runs: DrawingTextRun[] = []
  for (const char of text) {
    const available = candidates.find(
      (face) => load(face).font.charToGlyphIndex(char) !== 0
    )
    const face = available ?? candidates[0]
    const previous = runs.at(-1)
    if (previous?.face === face) {
      previous.text += char
      previous.missing ||= !available && !/\s/u.test(char)
    } else
      runs.push({
        text: char,
        face,
        w: 0,
        missing: !available && !/\s/u.test(char),
      })
  }
  for (const run of runs)
    run.w = load(run.face).font.getAdvanceWidth(run.text, size, {
      kerning: false,
    })
  return runs
}
export function drawingFontEmbedding(face: FontFace) {
  return `@font-face{font-family:'${face.family}';font-weight:500;src:url(data:font/woff;base64,${load(face).bytes.toString("base64")})}`
}
export type { FontFace as DrawingFontFace }
