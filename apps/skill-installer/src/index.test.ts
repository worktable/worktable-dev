import { afterEach, describe, expect, test } from "bun:test"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseInstallerArgs, runInstaller } from "./index.ts"

const roots: string[] = []

afterEach(() => {
  delete process.env["WORKTABLE_APP_DIR"]
  delete process.env["WORKTABLE_SKILL_HOME"]
  delete process.env["WORKTABLE_SKILL_INSTALLER_ROOT"]
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe("standalone skill installer", () => {
  test("keeps the public command surface target-based", () => {
    expect(parseInstallerArgs(["--target", "claude"])).toEqual({
      kind: "run",
      options: {
        operation: "install",
        targetId: "claude",
        preview: false,
        json: false,
      },
    })
    expect(
      parseInstallerArgs(["repair", "--target=agents", "--preview"])
    ).toEqual({
      kind: "run",
      options: {
        operation: "repair",
        targetId: "agents",
        preview: true,
        json: false,
      },
    })
    expect(() => parseInstallerArgs(["--target", "codex"])).toThrow(
      "claude or --target agents"
    )
  })

  test("installs and removes through the shared projection engine", () => {
    const root = mkdtempSync(join(tmpdir(), "worktable-skill-installer-"))
    roots.push(root)
    const home = join(root, "home")
    const app = join(root, "app")
    const release = join(root, "skills")
    const source = resolve(import.meta.dir, "../../../plugins/worktable/skills")
    cpSync(source, release, { recursive: true })
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({ type: "worktable.skill-installer", version: "9.9.9" })
    )
    process.env["WORKTABLE_APP_DIR"] = app
    process.env["WORKTABLE_SKILL_HOME"] = home
    process.env["WORKTABLE_SKILL_INSTALLER_ROOT"] = root

    runInstaller({
      operation: "install",
      targetId: "agents",
      preview: false,
      json: false,
    })
    const installed = join(
      home,
      ".agents",
      "skills",
      "worktable-create-or-update-docs",
      "SKILL.md"
    )
    expect(existsSync(installed)).toBe(true)
    expect(readFileSync(installed)).toEqual(
      readFileSync(join(source, "worktable-create-or-update-docs", "SKILL.md"))
    )

    runInstaller({
      operation: "remove",
      targetId: "agents",
      preview: false,
      json: false,
    })
    expect(existsSync(installed)).toBe(false)
  })
})
