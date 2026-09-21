#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import skillInventory from "../plugins/worktable/skill-inventory.json" with { type: "json" }

const repositoryRoot = resolve(import.meta.dir, "..")
const pluginSource = join(repositoryRoot, "plugins/worktable")

function validatedSkillInventory(): Array<{ name: string; files: string[] }> {
  if (
    skillInventory.schemaVersion !== 1 ||
    !Array.isArray(skillInventory.skills)
  ) {
    throw new Error("Invalid Worktable skill inventory")
  }
  const names = new Set<string>()
  for (const skill of skillInventory.skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.name) || names.has(skill.name)) {
      throw new Error(
        `Invalid or duplicate Worktable skill name: ${skill.name}`
      )
    }
    names.add(skill.name)
    const files = new Set<string>()
    for (const path of skill.files) {
      const segments = path.split("/")
      if (
        segments.some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === ".." ||
            !/^[A-Za-z0-9._-]+$/.test(segment)
        ) ||
        files.has(path)
      ) {
        throw new Error(`Invalid or duplicate skill file path: ${path}`)
      }
      files.add(path)
    }
  }
  return skillInventory.skills
}

export const WORKTABLE_PLUGIN_SKILLS = validatedSkillInventory()

const WORKTABLE_PLUGIN_SKILL_FILES = WORKTABLE_PLUGIN_SKILLS.flatMap(
  ({ name, files }) => files.map((path) => `skills/${name}/${path}`)
)

export const WORKTABLE_PLUGIN_PUBLIC_FILES = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "assets/composer-icon.png",
  "assets/logo-dark.png",
  "assets/logo.png",
  "mcp.json",
  "plugin.json",
  "skill-inventory.json",
  ...WORKTABLE_PLUGIN_SKILL_FILES,
] as const

export const WORKTABLE_PLUGIN_PUBLIC_CATALOGS = {
  ".agents/plugins/marketplace.json": "distribution/codex-marketplace.json",
  ".claude-plugin/marketplace.json": "distribution/claude-marketplace.json",
} as const

const BINARY_EXTENSIONS = new Set([".png"])
const FORBIDDEN_PUBLIC_PATTERNS: Array<{
  name: string
  pattern: RegExp
}> = [
  {
    name: "local worktree",
    pattern: /(?:\.t3code|\/(?:home|Users)\/[\w.-]+\/)/i,
  },
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: "credential-shaped token",
    pattern:
      /\b(?:ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/,
  },
  {
    name: "bearer credential",
    pattern:
      /(?:Authorization\s*:\s*(?:Bearer|Basic)|Cookie\s*:|(?:access|refresh)_token\s*=)\s*[A-Za-z0-9._~+/%=-]{12,}/i,
  },
  {
    name: "environment credential",
    pattern:
      /(?:^|\n)\s*[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*[^\s$<{][^\s]{7,}/,
  },
]

interface ExportOptions {
  outputDirectory: string
  sourceDirectory?: string
  publicationPolicyPath?: string
}

/** Optional private checkout policy; only generic checks travel with the source. */
async function readPrivatePublicationTerms(path?: string): Promise<string[]> {
  const policyPath = path ?? join(repositoryRoot, ".publication-policy.json")
  let contents: string
  try {
    const metadata = await lstat(policyPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Publication policy must be a regular file")
    }
    contents = await readFile(policyPath, "utf8")
  } catch (error) {
    if (
      path === undefined &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return []
    throw error
  }
  let policy: { schemaVersion?: unknown; forbiddenLiterals?: unknown }
  try {
    policy = JSON.parse(contents)
  } catch {
    throw new Error("Invalid private publication policy")
  }
  if (
    !policy ||
    policy.schemaVersion !== 1 ||
    !Array.isArray(policy.forbiddenLiterals) ||
    policy.forbiddenLiterals.some(
      (value) => typeof value !== "string" || !value.trim()
    )
  )
    throw new Error("Invalid private publication policy")
  return policy.forbiddenLiterals.map((value: string) => value.toLowerCase())
}

export interface PublicExportReceipt {
  name: "worktable"
  version: string
  files: Record<string, string>
  aggregateSha256: string
}

function sha256(contents: Uint8Array | string): string {
  return createHash("sha256").update(contents).digest("hex")
}

export function aggregatePublicFiles(files: Record<string, string>): string {
  const hash = createHash("sha256")
  for (const path of Object.keys(files).sort()) {
    hash.update(path)
    hash.update("\0")
    hash.update(files[path]!)
    hash.update("\n")
  }
  return hash.digest("hex")
}

function extension(path: string): string {
  const index = path.lastIndexOf(".")
  return index >= 0 ? path.slice(index) : ""
}

function assertPublicText(
  path: string,
  contents: Uint8Array,
  privateTerms: string[]
): void {
  if (BINARY_EXTENSIONS.has(extension(path))) return
  const text = new TextDecoder("utf-8", { fatal: true }).decode(contents)
  if (privateTerms.some((term) => text.toLowerCase().includes(term))) {
    throw new Error(
      `Public Worktable plugin violates private publication policy: ${path}`
    )
  }
  for (const forbidden of FORBIDDEN_PUBLIC_PATTERNS) {
    if (forbidden.pattern.test(text)) {
      throw new Error(
        `Public Worktable plugin contains ${forbidden.name}: ${path}`
      )
    }
  }
}

async function assertSafeOutputDirectory(
  outputDirectory: string
): Promise<string> {
  const resolved = resolve(outputDirectory)
  if (
    basename(resolved) !== "worktable" ||
    basename(dirname(resolved)) !== "plugins"
  ) {
    throw new Error(
      `Refusing to replace unsafe output path ${resolved}; expected .../plugins/worktable`
    )
  }
  if (resolved === pluginSource || resolved.startsWith(`${pluginSource}/`)) {
    throw new Error("Refusing to export over the private plugin source")
  }

  const parent = dirname(resolved)
  await mkdir(parent, { recursive: true })
  if ((await realpath(parent)) !== parent) {
    throw new Error(
      `Refusing to export through a symbolic-link path: ${resolved}`
    )
  }
  try {
    const metadata = await lstat(resolved)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        `Public plugin output must be a regular directory: ${resolved}`
      )
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error
  }
  return resolved
}

async function readRegularSourceFile(
  sourceDirectory: string,
  path: string
): Promise<Uint8Array> {
  let current = sourceDirectory
  const root = await lstat(current)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Public plugin source must be a regular directory")
  }

  const parts = path.split("/")
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const metadata = await lstat(current)
    const final = index === parts.length - 1
    if (
      metadata.isSymbolicLink() ||
      (final ? !metadata.isFile() : !metadata.isDirectory())
    ) {
      throw new Error(`Public plugin source must be a regular file: ${path}`)
    }
  }
  return readFile(current)
}

async function assertSafePublicDestination(
  publicRepositoryRoot: string,
  publicPath: string
): Promise<string> {
  const parts = publicPath.split("/")
  if (
    parts.length < 2 ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid public export path: ${publicPath}`)
  }

  let current = publicRepositoryRoot
  const root = await lstat(current)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Public export root must be a regular directory")
  }

  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    try {
      const metadata = await lstat(current)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(
          `Public export destination must not traverse a symbolic link: ${publicPath}`
        )
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error
      await mkdir(current)
    }
  }

  if ((await realpath(current)) !== current) {
    throw new Error(
      `Public export destination must not traverse a symbolic link: ${publicPath}`
    )
  }

  const destination = join(current, parts.at(-1)!)
  try {
    const metadata = await lstat(destination)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `Public export destination must be a regular file: ${publicPath}`
      )
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error
  }
  return destination
}

export async function exportWorktablePlugin(
  options: ExportOptions
): Promise<PublicExportReceipt> {
  const privateTerms = await readPrivatePublicationTerms(
    options.publicationPolicyPath
  )
  const sourceDirectory = resolve(options.sourceDirectory ?? pluginSource)
  const outputDirectory = await assertSafeOutputDirectory(
    options.outputDirectory
  )
  const publicRepositoryRoot = dirname(dirname(outputDirectory))
  const files: Record<string, string> = {}
  const rendered = new Map<string, Uint8Array>()

  for (const path of WORKTABLE_PLUGIN_PUBLIC_FILES) {
    const contents = await readRegularSourceFile(sourceDirectory, path)
    assertPublicText(path, contents, privateTerms)
    const publicPath = `plugins/worktable/${path}`
    rendered.set(publicPath, contents)
    files[publicPath] = sha256(contents)
  }
  for (const [publicPath, sourcePath] of Object.entries(
    WORKTABLE_PLUGIN_PUBLIC_CATALOGS
  )) {
    const contents = await readRegularSourceFile(sourceDirectory, sourcePath)
    assertPublicText(sourcePath, contents, privateTerms)
    rendered.set(publicPath, contents)
    files[publicPath] = sha256(contents)
  }

  const pluginManifest = JSON.parse(
    new TextDecoder().decode(rendered.get("plugins/worktable/plugin.json"))
  ) as { $schema?: unknown; name?: unknown; version?: unknown }
  if (
    pluginManifest.$schema !==
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" ||
    pluginManifest.name !== "worktable" ||
    typeof pluginManifest.version !== "string" ||
    !pluginManifest.version
  ) {
    throw new Error("plugin.json must identify a versioned Worktable package")
  }

  const receipt: PublicExportReceipt = {
    name: "worktable",
    version: pluginManifest.version,
    files,
    aggregateSha256: aggregatePublicFiles(files),
  }

  const catalogDestinations = new Map<string, string>()
  for (const publicPath of Object.keys(WORKTABLE_PLUGIN_PUBLIC_CATALOGS)) {
    catalogDestinations.set(
      publicPath,
      await assertSafePublicDestination(publicRepositoryRoot, publicPath)
    )
  }

  await rm(outputDirectory, { recursive: true, force: true })
  for (const [path, contents] of rendered) {
    const destination =
      catalogDestinations.get(path) ?? join(publicRepositoryRoot, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents)
  }
  return receipt
}

function git(args: string[], cwd = repositoryRoot): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

export function assertCleanPublicCheckout(outputDirectory: string): void {
  const publicRepositoryRoot = dirname(dirname(resolve(outputDirectory)))
  let gitRoot: string
  try {
    gitRoot = resolve(
      git(["rev-parse", "--show-toplevel"], publicRepositoryRoot)
    )
  } catch {
    throw new Error(
      `Public export target must be a Git checkout root: ${publicRepositoryRoot}`
    )
  }
  if (gitRoot !== publicRepositoryRoot) {
    throw new Error(
      `Public export target must be a Git checkout root: ${publicRepositoryRoot}`
    )
  }

  const ownedPaths = [
    "plugins/worktable",
    ...Object.keys(WORKTABLE_PLUGIN_PUBLIC_CATALOGS),
  ]
  const dirty = git(
    ["status", "--porcelain", "--", ...ownedPaths],
    publicRepositoryRoot
  )
  if (dirty) {
    throw new Error(
      "Commit or discard changes in the Worktable public export paths before replacing them:\n" +
        dirty
    )
  }
}

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf("--output")
  const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined
  if (!output) {
    throw new Error(
      "Usage: bun scripts/export-worktable-plugin.ts --output /path/to/worktable-dev/plugins/worktable"
    )
  }

  const dirty = git([
    "status",
    "--porcelain",
    "--",
    "plugins/worktable",
    relative(repositoryRoot, fileURLToPath(import.meta.url)),
    "scripts/export-worktable-plugin.test.ts",
    ".publication-policy.json",
  ])
  if (dirty) {
    throw new Error(
      "Commit the Worktable plugin and exporter before generating public source:\n" +
        dirty
    )
  }

  assertCleanPublicCheckout(output)

  const receipt = await exportWorktablePlugin({ outputDirectory: output })
  console.log(
    `Exported ${Object.keys(receipt.files).length} files for Worktable ${receipt.version}; aggregate ${receipt.aggregateSha256}`
  )
}

if (import.meta.main) {
  await main()
}
