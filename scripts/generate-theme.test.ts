import { describe, expect, test } from "bun:test"

import {
  renderAuthKitCss,
  renderBlockNoteCss,
  renderMermaidTs,
} from "./generate-theme"
import { themeConfig } from "../packages/ui/src/theme/theme-config"

describe("theme artifact generation", () => {
  test("BlockNote and Mermaid adapters are derived from canonical values", () => {
    const blockNote = renderBlockNoteCss()
    expect(blockNote).toContain(themeConfig.blockNote.light.editorText)
    expect(blockNote).toContain(themeConfig.blockNote.dark.editorText)
    expect(blockNote).toContain(themeConfig.blockNote.light.menu)
    expect(blockNote).toContain(themeConfig.blockNote.dark.selected)

    const mermaid = renderMermaidTs()
    expect(mermaid).toContain(themeConfig.mermaid.light.canvas)
    expect(mermaid).toContain(themeConfig.mermaid.dark.canvas)
    expect(mermaid).toContain('"useGradient": false')
  })

  test("AuthKit output targets the supported WorkOS states", () => {
    const css = renderAuthKitCss()

    expect(css).toContain(".light-theme & {")
    expect(css).toContain(".dark-theme & {")
    expect(css).toContain(".ak-Card {")
    expect(css).toContain(".ak-TextField:focus-within {")
    expect(css).toContain(".ak-PrimaryButton:focus-visible {")
    expect(css).toContain(".ak-Callout {")
    expect(css).toContain(".ak-OtpInput:focus-within {")
    expect(css).toContain(".ak-SelectionCardButton:focus-visible {")
    expect(css).toContain("@media (max-width: 520px)")
  })
})
