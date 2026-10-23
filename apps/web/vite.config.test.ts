import { describe, expect, test } from "bun:test"

import { THEME_SHELL_COLORS } from "@worktable/ui/theme"

import { devServerProxy, webManifest } from "./vite.config"

describe("development server proxy", () => {
  test("forwards the authenticated app surface without changing HTTP origins", () => {
    expect(Object.keys(devServerProxy)).toEqual([
      "/api",
      "/worktable-preview/fonts",
      "/auth",
      "/ws",
      "/yjs",
    ])
    for (const route of [
      "/api",
      "/auth",
      "/worktable-preview/fonts",
    ] as const) {
      expect(devServerProxy[route].changeOrigin).toBe(false)
    }
  })
})

describe("web app manifest", () => {
  test("installs and launches from the application root", () => {
    expect(webManifest.start_url).toBe("/")
    expect(webManifest.scope).toBe("/")
  })

  test("uses the canonical dark shell color", () => {
    expect(webManifest.theme_color).toBe(THEME_SHELL_COLORS.dark)
    expect(webManifest.background_color).toBe(THEME_SHELL_COLORS.dark)
  })
})
