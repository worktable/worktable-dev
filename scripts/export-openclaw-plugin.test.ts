import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  exportOpenClawPlugin,
  OPENCLAW_PUBLIC_FILES,
  OPENCLAW_SKILL_FILES,
} from "./export-openclaw-plugin"

const temporaryDirectories: string[] = []
const REAL_IO_TIMEOUT_MS = 15_000

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("OpenClaw public source exporter", () => {
  test(
    "exports only the allowlist with reproducible file hashes",
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), "worktable-export-test-"))
      temporaryDirectories.push(temporary)
      const output = join(temporary, "plugins/openclaw")
      const manifest = await exportOpenClawPlugin({
        outputDirectory: output,
      })

      expect(Object.keys(manifest.files)).toEqual([
        ...OPENCLAW_PUBLIC_FILES,
        ...OPENCLAW_SKILL_FILES,
      ])
      for (const [path, expected] of Object.entries(manifest.files)) {
        const contents = await readFile(join(output, path))
        expect(createHash("sha256").update(contents).digest("hex")).toBe(
          expected
        )
      }

      const publicReceipt = JSON.parse(
        await readFile(join(output, "SOURCE.json"), "utf8")
      )
      // The public artifact must not disclose a private repository or Git SHA.
      expect(publicReceipt).toEqual({
        schemaVersion: 2,
        sourcePath: "packages/openclaw-plugin",
        files: manifest.files,
      })

      const pkg = JSON.parse(
        await readFile(join(output, "package.json"), "utf8")
      ) as {
        scripts?: { test?: string }
        devDependencies?: Record<string, string>
      }
      expect(pkg.scripts?.test).toBe("bun test")
      expect(JSON.stringify(pkg)).not.toContain("workspace:*")
      expect(pkg.devDependencies).not.toHaveProperty(
        "@worktable/hosted-contract"
      )
    },
    REAL_IO_TIMEOUT_MS
  )

  test("refuses to replace a path outside plugins/openclaw", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "worktable-export-test-"))
    temporaryDirectories.push(temporary)
    await expect(
      exportOpenClawPlugin({
        outputDirectory: resolve(temporary, "openclaw"),
      })
    ).rejects.toThrow("unsafe output path")
  })

  test("preserves an exported skill tree while preparing a package", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "worktable-export-test-"))
    temporaryDirectories.push(temporary)
    const output = join(temporary, "plugins/openclaw")
    await exportOpenClawPlugin({
      outputDirectory: output,
    })

    const publicWorktableRoot = join(temporary, "plugins/worktable")
    await mkdir(publicWorktableRoot, { recursive: true })
    await cp(
      join(
        resolve(import.meta.dir, ".."),
        "plugins/worktable/skill-inventory.json"
      ),
      join(publicWorktableRoot, "skill-inventory.json")
    )

    const editedSkill = join(output, OPENCLAW_SKILL_FILES[0]!)
    const editedContents = `${await readFile(editedSkill, "utf8")}\nLocal edit\n`
    await writeFile(editedSkill, editedContents)

    const skillPackage = await import(
      `${pathToFileURL(join(output, "scripts/skill-package.ts")).href}?test=${Date.now()}`
    )
    const prepared = await skillPackage.prepareSkillPackage()
    expect(prepared.generated).toBe(false)
    await skillPackage.cleanPreparedSkillPackage(prepared)
    expect(await readFile(editedSkill, "utf8")).toBe(editedContents)
  })
})
