import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultBundlePath,
  resolveDesktopBundlePath,
  resolveDesktopDmgPath,
  resolveDesktopUpdaterBundlePath,
  resolveDesktopUpdaterSignaturePath,
} from "./release-paths"

const roots: string[] = []

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "worktable-desktop-release-paths-"))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

describe("Desktop release artifact paths", () => {
  test("uses the normal bundle unless an extracted DMG bundle is supplied", () => {
    expect(resolveDesktopBundlePath({})).toBe(defaultBundlePath)
    expect(
      resolveDesktopBundlePath({
        WORKTABLE_DESKTOP_BUNDLE_PATH: "/tmp/Installed Worktable.app",
      })
    ).toBe("/tmp/Installed Worktable.app")
  })

  test("resolves the only built DMG from a real directory", () => {
    const root = temporaryDirectory()
    writeFileSync(join(root, "notes.txt"), "ignored")
    writeFileSync(join(root, "Worktable_1.2.3_aarch64.dmg"), "dmg")

    expect(resolveDesktopDmgPath(undefined, {}, root)).toBe(
      join(root, "Worktable_1.2.3_aarch64.dmg")
    )
  })

  test("refuses missing or ambiguous release DMGs", () => {
    const missing = join(temporaryDirectory(), "missing")
    expect(() => resolveDesktopDmgPath(undefined, {}, missing)).toThrow(
      "Desktop DMG directory is missing"
    )

    const ambiguous = temporaryDirectory()
    mkdirSync(ambiguous, { recursive: true })
    writeFileSync(join(ambiguous, "Worktable_1.dmg"), "one")
    writeFileSync(join(ambiguous, "Worktable_2.dmg"), "two")
    expect(() => resolveDesktopDmgPath(undefined, {}, ambiguous)).toThrow(
      "Expected exactly one Desktop DMG"
    )
  })

  test("an explicit or environment DMG path bypasses discovery", () => {
    expect(resolveDesktopDmgPath("/tmp/explicit.dmg", {}, "/missing")).toBe(
      "/tmp/explicit.dmg"
    )
    expect(
      resolveDesktopDmgPath(
        undefined,
        { WORKTABLE_DESKTOP_DMG_PATH: "/tmp/environment.dmg" },
        "/missing"
      )
    ).toBe("/tmp/environment.dmg")
  })

  test("resolves the updater archive and its detached signature", () => {
    const root = temporaryDirectory()
    const updaterBundle = join(root, "Worktable.app.tar.gz")
    writeFileSync(updaterBundle, "archive")
    writeFileSync(`${updaterBundle}.sig`, "signature")

    expect(resolveDesktopUpdaterBundlePath(undefined, {}, root)).toBe(
      updaterBundle
    )
    expect(
      resolveDesktopUpdaterSignaturePath(updaterBundle, undefined, {})
    ).toBe(`${updaterBundle}.sig`)
  })

  test("refuses missing or ambiguous updater archives", () => {
    const missing = join(temporaryDirectory(), "missing")
    expect(() =>
      resolveDesktopUpdaterBundlePath(undefined, {}, missing)
    ).toThrow("Desktop updater bundle directory is missing")

    const ambiguous = temporaryDirectory()
    writeFileSync(join(ambiguous, "Worktable.app.tar.gz"), "one")
    writeFileSync(join(ambiguous, "Other.app.tar.gz"), "two")
    expect(() =>
      resolveDesktopUpdaterBundlePath(undefined, {}, ambiguous)
    ).toThrow("Expected exactly one Desktop updater bundle")
  })

  test("supports explicit updater archive and signature paths", () => {
    expect(
      resolveDesktopUpdaterBundlePath(
        undefined,
        {
          WORKTABLE_DESKTOP_UPDATER_BUNDLE_PATH: "/tmp/environment.app.tar.gz",
        },
        "/missing"
      )
    ).toBe("/tmp/environment.app.tar.gz")
    expect(
      resolveDesktopUpdaterSignaturePath(
        "/tmp/environment.app.tar.gz",
        undefined,
        {
          WORKTABLE_DESKTOP_UPDATER_SIGNATURE_PATH:
            "/tmp/environment.app.tar.gz.sig",
        }
      )
    ).toBe("/tmp/environment.app.tar.gz.sig")
  })
})
