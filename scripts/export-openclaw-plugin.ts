#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import skillInventory from "../plugins/worktable/skill-inventory.json" with { type: "json" }

const repositoryRoot = resolve(import.meta.dir, "..")
const pluginSource = join(repositoryRoot, "packages/openclaw-plugin")

export const OPENCLAW_PUBLIC_FILES = [
  ".gitignore",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "bun.lock",
  "index.ts",
  "openclaw.plugin.json",
  "package.json",
  "scripts/build.ts",
  "scripts/pack-dogfood.ts",
  "scripts/skill-package.ts",
  "scripts/verify-packed-artifact.ts",
  "scripts/verify-packed-discovery.ts",
  "scripts/verify-third-party-notices.ts",
  "setup-entry.ts",
  "src/agent-auth-config.ts",
  "src/agent-auth.test.ts",
  "src/agent-auth.ts",
  "src/channel.test.ts",
  "src/channel.ts",
  "src/connector.test.ts",
  "src/connector.ts",
  "src/delivery-identity.ts",
  "src/fake-worktable-client.ts",
  "src/openclaw-dispatcher.test.ts",
  "src/openclaw-dispatcher.ts",
  "src/package-contract.test.ts",
  "src/pairing.test.ts",
  "src/pairing.ts",
  "src/reply-outbox.ts",
  "src/runtime.ts",
  "src/types.ts",
  "src/worktable-client.test.ts",
  "src/worktable-client.ts",
  "src/worktable-contract.test.ts",
  "src/worktable-contract.ts",
  "tsconfig.json",
] as const

export const OPENCLAW_SKILL_FILES = skillInventory.skills.flatMap((skill) =>
  skill.files.map((file) => `skills/${skill.name}/${file}`)
)

interface ExportOptions {
  outputDirectory: string
  sourceDirectory?: string
  skillSourceDirectory?: string
}

interface SourceManifest {
  schemaVersion: 2
  sourcePath: "packages/openclaw-plugin"
  files: Record<string, string>
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex")
}

function assertSafeOutputDirectory(outputDirectory: string): string {
  const resolved = resolve(outputDirectory)
  if (
    basename(resolved) !== "openclaw" ||
    basename(dirname(resolved)) !== "plugins"
  ) {
    throw new Error(
      `Refusing to replace unsafe output path ${resolved}; expected .../plugins/openclaw`
    )
  }
  if (resolved === pluginSource || resolved.startsWith(`${pluginSource}/`)) {
    throw new Error("Refusing to export over the private plugin source")
  }
  return resolved
}

export async function exportOpenClawPlugin(
  options: ExportOptions
): Promise<SourceManifest> {
  const sourceDirectory = resolve(options.sourceDirectory ?? pluginSource)
  const skillSourceDirectory = resolve(
    options.skillSourceDirectory ??
      join(repositoryRoot, "plugins", "worktable", "skills")
  )
  const outputDirectory = assertSafeOutputDirectory(options.outputDirectory)
  const files: Record<string, string> = {}
  const rendered = new Map<string, Uint8Array>()

  for (const path of OPENCLAW_PUBLIC_FILES) {
    const sourcePath = join(sourceDirectory, path)
    const metadata = await lstat(sourcePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Public plugin source must be a regular file: ${path}`)
    }
    const contents = await readFile(sourcePath)
    rendered.set(path, contents)
    files[path] = sha256(contents)
  }
  for (const path of OPENCLAW_SKILL_FILES) {
    const sourcePath = join(skillSourceDirectory, path.slice("skills/".length))
    const metadata = await lstat(sourcePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Canonical skill source must be a regular file: ${path}`)
    }
    const contents = await readFile(sourcePath)
    rendered.set(path, contents)
    files[path] = sha256(contents)
  }

  const manifest: SourceManifest = {
    // Public receipts identify exported bytes, never private Git ancestry.
    schemaVersion: 2,
    sourcePath: "packages/openclaw-plugin",
    files,
  }

  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
  for (const [path, contents] of rendered) {
    const destination = join(outputDirectory, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents)
  }
  await writeFile(
    join(outputDirectory, "SOURCE.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  )
  return manifest
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim()
}

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf("--output")
  const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined
  if (!output) {
    throw new Error(
      "Usage: bun scripts/export-openclaw-plugin.ts --output /path/to/worktable-dev/plugins/openclaw"
    )
  }

  const dirty = git([
    "status",
    "--porcelain",
    "--",
    "packages/openclaw-plugin",
    "plugins/worktable/skill-inventory.json",
    "plugins/worktable/skills",
    relative(repositoryRoot, fileURLToPath(import.meta.url)),
  ])
  if (dirty) {
    throw new Error(
      "Commit the plugin and exporter before generating public source:\n" +
        dirty
    )
  }

  const sourceCommit = git(["rev-parse", "HEAD"])
  const manifest = await exportOpenClawPlugin({
    outputDirectory: output,
  })
  console.log(
    `Exported ${Object.keys(manifest.files).length} files from ${sourceCommit}`
  )
}

if (import.meta.main) {
  await main()
}
