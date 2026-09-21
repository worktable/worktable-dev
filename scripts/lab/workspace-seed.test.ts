import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxSystem } from "./microsandbox.ts"
import {
  FIXTURE_SLUGS,
  fixturePath,
  stageHostWorkspace,
  stageWorkspace,
} from "./workspace-seed.ts"

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

describe("workspace fixture seeding", () => {
  test("uses the exact committed fixture inventory", () => {
    expect(FIXTURE_SLUGS).toEqual([
      "basic-docs",
      "engineer",
      "founder",
      "product-manager",
      "wiki-links",
    ])
    for (const slug of FIXTURE_SLUGS)
      expect(fixturePath(slug)).toEndWith(join("fixtures", "workspaces", slug))
    expect(() => fixturePath("../daily")).toThrow("Unknown fixture")
    expect(() => fixturePath("not-real")).toThrow("Unknown fixture")
  })

  test("named fixture copy gets a fresh identity without changing the source", () => {
    const sourceManifest = join(
      fixturePath("basic-docs"),
      "worktable.workspace.json"
    )
    const before = hash(sourceManifest)
    let copiedManifest: Record<string, any> | undefined
    const calls: string[][] = []
    const system: SandboxSystem = {
      owner: () => "tester",
      run(command, args) {
        calls.push([command, ...args])
        if (
          command === "msb" &&
          args[0] === "copy" &&
          args.at(-1)?.endsWith("worktable-seed-manifest.json")
        ) {
          copiedManifest = JSON.parse(readFileSync(args[2]!, "utf8"))
        }
        return ""
      },
    }
    stageWorkspace("fixture-test", "basic-docs", system)
    const source = JSON.parse(readFileSync(sourceManifest, "utf8"))
    expect(copiedManifest?.id).toMatch(/^ws_/)
    expect(copiedManifest?.id).not.toBe(source.id)
    expect(copiedManifest?.provenance).toMatchObject({
      mode: "fixture",
      fixtureName: "basic-docs",
      oneWay: true,
    })
    expect(hash(sourceManifest)).toBe(before)
    expect(
      calls.some((call) => call.includes("/home/tester/Worktable"))
    ).toBeTrue()
  })

  test("empty creates a target while absent fixture performs no operation", () => {
    const calls: string[][] = []
    const system: SandboxSystem = {
      owner: () => "tester",
      run(command, args) {
        calls.push([command, ...args])
        return ""
      },
    }
    stageWorkspace("empty-test", undefined, system)
    expect(calls).toHaveLength(0)
    stageWorkspace("empty-test", "empty", system)
    expect(calls[0]).toContain("/home/tester/Worktable")
  })

  test("host fixture staging copies one-way with a fresh identity", () => {
    const root = mkdtempSync(join(tmpdir(), "worktable-host-seed-test-"))
    const target = join(root, "workspace")
    const sourceManifest = join(
      fixturePath("basic-docs"),
      "worktable.workspace.json"
    )
    const before = hash(sourceManifest)
    try {
      expect(stageHostWorkspace(target, "basic-docs")).toBe("fixture")
      const source = JSON.parse(readFileSync(sourceManifest, "utf8"))
      const copied = JSON.parse(
        readFileSync(join(target, "worktable.workspace.json"), "utf8")
      )
      expect(copied.id).toMatch(/^ws_/)
      expect(copied.id).not.toBe(source.id)
      expect(copied.provenance).toMatchObject({
        mode: "fixture",
        fixtureName: "basic-docs",
        oneWay: true,
      })
      expect(hash(sourceManifest)).toBe(before)
      expect(() => stageHostWorkspace(target, "basic-docs")).toThrow(
        "Refusing to replace"
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
