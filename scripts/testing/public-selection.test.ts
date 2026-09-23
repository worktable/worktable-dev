import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { publicTestSuites } from "./public-suites.ts"
import {
  needsPluginPackaging,
  productDocsOnly,
  publicChangePaths,
  selectPublicSuiteIds,
} from "./public-selection.ts"

const required = publicTestSuites
  .filter((s) => s.profiles.includes("required"))
  .map((s) => s.id)
const all = publicTestSuites.map((s) => s.id)

describe("public evidence ownership", () => {
  test("independent surfaces retain required evidence and their actual expensive owners", () => {
    for (const [path, extra] of [
      ["apps/cli/src/config.ts", []],
      ["packages/openclaw-plugin/src/connector.ts", []],
      ["apps/web/src/routes/index.tsx", ["web-browser"]],
      ["apps/desktop/ui/main.ts", ["desktop-contracts", "desktop-browser"]],
      ["packages/ui/src/button.tsx", ["web-browser", "desktop-browser"]],
    ] as const)
      expect(new Set(selectPublicSuiteIds([path]))).toEqual(
        new Set([...required, ...extra])
      )
    expect(
      selectPublicSuiteIds(["apps/web/a.ts", "apps/desktop/b.ts"])
    ).toEqual(all)
  })

  test("unknown and shared inputs fail closed, including either side of a rename", () => {
    for (const paths of [
      [],
      ["bun.lock"],
      ["packages/server/src/index.ts"],
      ["packages/types/src/index.ts"],
      ["scripts/testing/run.ts"],
      ["new-surface/a.ts"],
      ["apps/cli/a.ts", "packages/new/a.ts"],
    ]) {
      expect(selectPublicSuiteIds(paths)).toEqual(all)
    }
    expect(publicChangePaths("missing", "missing")).toEqual([])
    expect(
      productDocsOnly(["apps/docs/src/content/docs/start.md", "README.md"])
    ).toBe(true)
    expect(
      selectPublicSuiteIds(["apps/docs/src/content/docs/start.md"])
    ).toEqual(required)
    for (const input of [
      "mcp-tools.json",
      "scripts/generate-docs-content.ts",
      "apps/cli/src/index.ts",
      "packages/server/src/widget-authoring.ts",
    ])
      expect(
        productDocsOnly(["apps/docs/src/content/docs/start.md", input])
      ).toBe(false)
  })

  test("packaging follows plugin and build inputs while unrelated product work avoids repeat packs", () => {
    for (const paths of [
      [],
      ["bun.lock"],
      ["package.json"],
      [".github/workflows/openclaw-plugin.yml"],
      ["packages/openclaw-plugin/a.ts"],
      ["packages/hosted-contract/a.ts"],
      ["scripts/export-openclaw-plugin.ts"],
    ])
      expect(needsPluginPackaging(paths)).toBe(true)
    for (const path of [
      "apps/web/a.ts",
      "packages/server/src/index.ts",
      "README.md",
    ])
      expect(needsPluginPackaging([path])).toBe(false)
  })

  test("immutable Git diff includes both sides of renames and unavailable history is conservative", () => {
    const root = mkdtempSync(join(tmpdir(), "public-evidence-"))
    const previous = process.cwd()
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
    try {
      git("init", "--quiet")
      git("config", "user.name", "test")
      git("config", "user.email", "test@example.invalid")
      writeFileSync(join(root, "old.ts"), "export const value = 1\n")
      git("add", ".")
      git("commit", "--quiet", "-m", "base")
      const base = git("rev-parse", "HEAD")
      git("mv", "old.ts", "new.ts")
      git("commit", "--quiet", "-m", "rename")
      process.chdir(root)
      expect(publicChangePaths(base, git("rev-parse", "HEAD")).sort()).toEqual([
        "new.ts",
        "old.ts",
      ])
      expect(publicChangePaths("0".repeat(40), base)).toEqual([])
    } finally {
      process.chdir(previous)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
