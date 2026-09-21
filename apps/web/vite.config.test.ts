import { describe, expect, test } from "bun:test"

import { THEME_SHELL_COLORS } from "@worktable/ui/theme"

import {
  devServerProxy,
  navigateFallbackDenylist,
  webManifest,
} from "./vite.config"

describe("development server proxy", () => {
  test("forwards the authenticated app surface without changing HTTP origins", () => {
    expect(Object.keys(devServerProxy)).toEqual([
      "/api",
      "/auth",
      "/ws",
      "/yjs",
    ])
    for (const route of ["/api", "/auth"] as const) {
      expect(devServerProxy[route].changeOrigin).toBe(false)
    }
  })
})

describe("PWA manifest configuration", () => {
  test("installs and launches from the application root", () => {
    expect(webManifest.start_url).toBe("/")
    expect(webManifest.scope).toBe("/")
  })

  test("uses the canonical dark shell color", () => {
    expect(webManifest.theme_color).toBe(THEME_SHELL_COLORS.dark)
    expect(webManifest.background_color).toBe(THEME_SHELL_COLORS.dark)
  })

  test("leaves gateway-owned sign-out navigations on the network", () => {
    const denied = (path: string) =>
      navigateFallbackDenylist.some((pattern) => pattern.test(path))

    expect(denied("/logout")).toBe(true)
    expect(denied("/logout?from=settings")).toBe(true)
    expect(denied("/signed-out")).toBe(true)
    expect(denied("/signed-out?done=1")).toBe(true)
    expect(denied("/spaces/logout-notes")).toBe(false)
  })
})
