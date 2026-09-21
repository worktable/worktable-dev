import { describe, expect, test } from "bun:test"

import { THEME_MODES, themeConfig } from "./theme-config"

const REQUIRED_MODE_ROLES = [
  "canvas",
  "panel",
  "raised",
  "overlay",
  "muted",
  "field",
  "fieldHover",
  "selected",
  "decorative",
  "border",
  "borderInput",
  "borderInputHover",
  "borderChrome",
  "overlayBorder",
  "foreground",
  "readingForeground",
  "mutedForeground",
  "resizeHandle",
  "sidebarDesktop",
  "sidebarHover",
  "sidebarControl",
  "sidebarControlBorder",
  "controlActive",
] as const

const OKLCH =
  /^oklch\(\d*\.?\d+\s+\d*\.?\d+\s+\d*\.?\d+(?:\s*\/\s*\d*\.?\d+%?)?\)$/
const HEX = /^#[0-9a-f]{6}$/i

function relativeLuminance(color: string): number {
  const match = color.match(/^oklch\((\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)/)
  if (!match) throw new Error(`Expected an OKLCH color, received ${color}`)

  const lightness = Number(match[1])
  const chroma = Number(match[2])
  const hue = (Number(match[3]) * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  const red = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
  const green = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
  const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  )
}

describe("canonical theme configuration", () => {
  test("both modes define the full semantic surface contract", () => {
    for (const mode of THEME_MODES) {
      expect(Object.keys(themeConfig.modes[mode])).toEqual(
        expect.arrayContaining(REQUIRED_MODE_ROLES)
      )
    }
  })

  test("structural CSS colors are valid OKLCH values", () => {
    for (const mode of THEME_MODES) {
      for (const role of REQUIRED_MODE_ROLES) {
        expect(themeConfig.modes[mode][role]).toMatch(OKLCH)
      }
      for (const rampColor of themeConfig.charts[mode]) {
        expect(rampColor).toMatch(OKLCH)
      }
      expect(themeConfig.backdrop[mode].lineColor).toMatch(OKLCH)
      expect(themeConfig.backdrop[mode].washColor).toMatch(OKLCH)
      expect(themeConfig.finishes[mode].primaryFaceTop).toMatch(OKLCH)
      expect(themeConfig.finishes[mode].primaryFaceBottom).toMatch(OKLCH)
      expect(themeConfig.finishes[mode].primaryHighlight).toMatch(OKLCH)
      expect(themeConfig.finishes[mode].primaryEdge).toMatch(OKLCH)
      expect(themeConfig.finishes[mode].primaryShadow).toMatch(OKLCH)
      expect(themeConfig.finishes[mode].primaryAmbientShadow).toMatch(OKLCH)
    }

    for (const accent of [
      "primary",
      "primaryText",
      "bronze",
      "bronzeInk",
      "technical",
      "technicalInk",
      "illustration",
      "focusRing",
    ] as const) {
      const values = themeConfig.accents[accent]
      for (const mode of THEME_MODES) {
        expect(values[mode]).toMatch(OKLCH)
      }
    }
    for (const values of Object.values(themeConfig.status)) {
      for (const mode of THEME_MODES) expect(values[mode]).toMatch(OKLCH)
    }
  })

  test("shell colors are six-digit browser-compatible hex values", () => {
    for (const mode of THEME_MODES) expect(themeConfig.shell[mode]).toMatch(HEX)
  })

  test("chart consumers receive five distinct colors in each mode", () => {
    for (const mode of THEME_MODES) {
      const ramp = themeConfig.charts[mode]
      expect(ramp).toHaveLength(5)
      expect(new Set(ramp).size).toBe(5)
    }
  })

  test("primary text accents meet normal-text contrast on panels", () => {
    for (const mode of THEME_MODES) {
      expect(
        contrast(
          themeConfig.accents.primaryText[mode],
          themeConfig.modes[mode].panel
        )
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  test("UI, reading, and muted text meet their canvas contrast targets", () => {
    for (const mode of THEME_MODES) {
      const colors = themeConfig.modes[mode]
      expect(contrast(colors.foreground, colors.canvas)).toBeGreaterThanOrEqual(
        7
      )
      const readingContrast = contrast(colors.readingForeground, colors.canvas)
      expect(readingContrast).toBeGreaterThanOrEqual(7)
      expect(readingContrast).toBeLessThan(
        contrast(colors.foreground, colors.canvas)
      )
      expect(
        contrast(colors.mutedForeground, colors.canvas)
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})
