import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  aggregatePublicFiles,
  assertCleanPublicCheckout,
  exportWorktablePlugin,
  WORKTABLE_PLUGIN_PUBLIC_CATALOGS,
  WORKTABLE_PLUGIN_PUBLIC_FILES,
} from "./export-worktable-plugin"

const temporaryDirectories: string[] = []
const REAL_IO_TIMEOUT_MS = 15_000
const pluginSource = resolve(import.meta.dir, "..", "plugins/worktable")

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function relativeFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await relativeFiles(root, path)))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporaryDirectories.push(path)
  return path
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

describe("Worktable plugin public exporter", () => {
  test(
    "exports only the allowlist with reproducible file hashes",
    async () => {
      const temporary = await temporaryDirectory("worktable-plugin-export-")
      const output = join(temporary, "plugins/worktable")
      const receipt = await exportWorktablePlugin({ outputDirectory: output })
      const expectedFiles = [
        ...WORKTABLE_PLUGIN_PUBLIC_FILES.map(
          (path) => `plugins/worktable/${path}`
        ),
        ...Object.keys(WORKTABLE_PLUGIN_PUBLIC_CATALOGS),
      ]

      expect(Object.keys(receipt.files)).toEqual(expectedFiles)
      expect(await relativeFiles(temporary)).toEqual(expectedFiles.sort())
      for (const [path, expected] of Object.entries(receipt.files)) {
        const contents = await readFile(join(temporary, path))
        expect(createHash("sha256").update(contents).digest("hex")).toBe(
          expected
        )
      }
      expect(receipt.aggregateSha256).toBe(aggregatePublicFiles(receipt.files))
      expect(receipt).toEqual(
        expect.objectContaining({
          name: "worktable",
          version: JSON.parse(
            await readFile(join(pluginSource, "plugin.json"), "utf8")
          ).version,
        })
      )
    },
    REAL_IO_TIMEOUT_MS
  )

  test(
    "refuses private or credential-shaped content",
    async () => {
      const temporary = await temporaryDirectory("worktable-plugin-secret-")
      const source = join(temporary, "source")
      await cp(pluginSource, source, { recursive: true })
      await writeFile(
        join(source, "README.md"),
        "Authorization: Bearer secret-example-value\n",
        "utf8"
      )

      await expect(
        exportWorktablePlugin({
          sourceDirectory: source,
          outputDirectory: join(temporary, "plugins/worktable"),
        })
      ).rejects.toThrow("bearer credential")

      await writeFile(
        join(source, "README.md"),
        "ANTHROPIC_API_KEY=sk-ant-api03-examplecredentialvalue\n",
        "utf8"
      )
      await expect(
        exportWorktablePlugin({
          sourceDirectory: source,
          outputDirectory: join(temporary, "plugins/worktable"),
        })
      ).rejects.toThrow("credential-shaped token")

      const policyPath = join(temporary, "publication-policy.json")
      await writeFile(
        policyPath,
        JSON.stringify({
          schemaVersion: 1,
          forbiddenLiterals: ["private.example.test"],
        })
      )
      await writeFile(
        join(source, "README.md"),
        "https://PRIVATE.example.test/internal"
      )
      const options = {
        sourceDirectory: source,
        outputDirectory: join(temporary, "plugins/worktable"),
        publicationPolicyPath: policyPath,
      }
      await expect(exportWorktablePlugin(options)).rejects.toThrow(
        "private publication policy"
      )
      await writeFile(policyPath, "{broken")
      await expect(exportWorktablePlugin(options)).rejects.toThrow(
        "Invalid private publication policy"
      )
      await rm(policyPath)
      await expect(exportWorktablePlugin(options)).rejects.toThrow()
    },
    REAL_IO_TIMEOUT_MS
  )

  test(
    "refuses symbolic links in source and output paths",
    async () => {
      const temporary = await temporaryDirectory("worktable-plugin-link-")
      const source = join(temporary, "source")
      await cp(pluginSource, source, { recursive: true })
      await rm(join(source, "README.md"))
      await symlink(join(pluginSource, "README.md"), join(source, "README.md"))
      await expect(
        exportWorktablePlugin({
          sourceDirectory: source,
          outputDirectory: join(temporary, "plugins/worktable"),
        })
      ).rejects.toThrow("regular file")

      const linkedParent = join(temporary, "linked")
      const realParent = join(temporary, "real")
      await mkdir(realParent)
      await symlink(realParent, linkedParent)
      await expect(
        exportWorktablePlugin({
          outputDirectory: join(linkedParent, "plugins/worktable"),
        })
      ).rejects.toThrow("symbolic-link path")
    },
    REAL_IO_TIMEOUT_MS
  )

  test(
    "refuses symbolic links in public catalog paths",
    async () => {
      const temporary = await temporaryDirectory(
        "worktable-plugin-catalog-link-"
      )
      const external = join(temporary, "external")
      await mkdir(external)
      await symlink(external, join(temporary, ".agents"))

      await expect(
        exportWorktablePlugin({
          outputDirectory: join(temporary, "plugins/worktable"),
        })
      ).rejects.toThrow("must not traverse a symbolic link")
      expect(await relativeFiles(external)).toEqual([])

      await rm(join(temporary, ".agents"))
      await mkdir(join(temporary, ".agents/plugins"), { recursive: true })
      const externalCatalog = join(external, "marketplace.json")
      await writeFile(externalCatalog, "outside\n", "utf8")
      await symlink(
        externalCatalog,
        join(temporary, ".agents/plugins/marketplace.json")
      )

      await expect(
        exportWorktablePlugin({
          outputDirectory: join(temporary, "plugins/worktable"),
        })
      ).rejects.toThrow("must be a regular file")
      expect(await readFile(externalCatalog, "utf8")).toBe("outside\n")
    },
    REAL_IO_TIMEOUT_MS
  )

  test(
    "refuses to replace dirty paths in a public checkout",
    async () => {
      const temporary = await temporaryDirectory(
        "worktable-plugin-dirty-public-"
      )
      const output = join(temporary, "plugins/worktable")
      const catalog = join(temporary, ".agents/plugins/marketplace.json")
      await mkdir(output, { recursive: true })
      await mkdir(join(temporary, ".agents/plugins"), { recursive: true })
      await writeFile(join(output, "README.md"), "published\n", "utf8")
      await writeFile(catalog, "{}\n", "utf8")
      git(temporary, ["init", "--quiet"])
      git(temporary, ["add", "."])
      git(temporary, [
        "-c",
        "user.name=Worktable Test",
        "-c",
        "user.email=test@worktable.dev",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ])

      expect(() => assertCleanPublicCheckout(output)).not.toThrow()
      await writeFile(catalog, '{"changed":true}\n', "utf8")
      expect(() => assertCleanPublicCheckout(output)).toThrow(
        "changes in the Worktable public export paths"
      )
    },
    REAL_IO_TIMEOUT_MS
  )

  test("refuses to replace a path outside plugins/worktable", async () => {
    const temporary = await temporaryDirectory("worktable-export-test-")
    await expect(
      exportWorktablePlugin({
        outputDirectory: resolve(temporary, "worktable"),
      })
    ).rejects.toThrow("unsafe output path")
  })
})
