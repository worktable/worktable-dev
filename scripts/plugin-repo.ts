#!/usr/bin/env bun

// Builds worktable/worktable-plugin: a repository whose root is the Worktable
// agent plugin, for directories that read a plugin only from a repository
// root (Gemini CLI extensions, Kiro Powers, Grok Build). The tree carries
// every file in plugins/worktable except tests and distribution catalogs, plus
// a generated Gemini CLI manifest, a note on where the source lives, and the
// workflow that releases each new plugin version.

import { lstat, mkdir, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { readPublicPluginFiles } from "./export-worktable-plugin.ts"

const repositoryRoot = resolve(import.meta.dir, "..")
const pluginSource = join(repositoryRoot, "plugins/worktable")

export const PLUGIN_REPOSITORY = "worktable/worktable-plugin"
const SOURCE_URL =
  "https://github.com/worktable/worktable-dev/tree/main/plugins/worktable"
const ISSUES_URL = "https://github.com/worktable/worktable-dev/issues"

/** Source paths that stay in worktable-dev. */
function excluded(path: string): boolean {
  return (
    path === "distribution" ||
    path.startsWith("distribution/") ||
    path.endsWith(".test.ts") ||
    path.split("/").at(-1) === ".DS_Store"
  )
}

async function listSourceFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (excluded(path)) continue
    // Symbolic links and other entries fail in readPublicPluginFiles.
    if (entry.isDirectory()) files.push(...(await listSourceFiles(root, path)))
    else files.push(path)
  }
  return files.sort()
}

function json(contents: Uint8Array | undefined, path: string): any {
  if (!contents) throw new Error(`Worktable plugin is missing ${path}`)
  return JSON.parse(new TextDecoder().decode(contents))
}

/** Gemini CLI reads skills/ by convention; the manifest names the server. */
function geminiExtension(files: Map<string, Uint8Array>): string {
  const plugin = json(files.get("plugin.json"), "plugin.json")
  const mcp = json(files.get("mcp.json"), "mcp.json")
  const server = mcp.mcpServers?.worktable
  if (
    plugin.name !== "worktable" ||
    typeof plugin.version !== "string" ||
    typeof plugin.description !== "string" ||
    server?.type !== "streamable-http" ||
    typeof server.url !== "string"
  ) {
    throw new Error(
      "plugin.json and mcp.json must name a versioned Worktable plugin with a Streamable HTTP server"
    )
  }
  const manifest = {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    mcpServers: { worktable: { httpUrl: server.url } },
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function readme(files: Map<string, Uint8Array>): string {
  const source = new TextDecoder().decode(files.get("README.md")).trimEnd()
  return `${source}

## About this repository

This repository is generated from [\`plugins/worktable\`](${SOURCE_URL})
in worktable-dev and updated on every change there. Report issues and propose
changes in [worktable-dev](${ISSUES_URL}).
`
}

// Runs in the plugin repository. A push that carries a new plugin version
// tags it and publishes a release, which the Gemini CLI gallery indexes and
// release-based installs update from.
const RELEASE_WORKFLOW = `name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Check out
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Release a new version
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          version="$(jq -r .version gemini-extension.json)"
          tag="v$version"
          if gh release view "$tag" >/dev/null 2>&1; then
            echo "$tag is already released"
            exit 0
          fi
          awk -v heading="## [$version]" '
            index($0, heading) == 1 { found = 1; next }
            found && /^## \\[/ { exit }
            found { print }
          ' CHANGELOG.md > notes.md
          if ! grep -q '[^[:space:]]' notes.md; then
            echo "CHANGELOG.md has no entry for $version" >&2
            exit 1
          fi
          gh release create "$tag" --target "$GITHUB_SHA" --title "$tag" --notes-file notes.md
`

export interface PluginRepositoryTree {
  version: string
  files: Map<string, Uint8Array | string>
}

export async function buildPluginRepositoryTree(
  options: { sourceDirectory?: string; publicationPolicyPath?: string } = {}
): Promise<PluginRepositoryTree> {
  const sourceDirectory = resolve(options.sourceDirectory ?? pluginSource)
  const paths = await listSourceFiles(sourceDirectory)
  const source = await readPublicPluginFiles(paths, {
    sourceDirectory,
    publicationPolicyPath: options.publicationPolicyPath,
  })
  const files = new Map<string, Uint8Array | string>(source)
  const gemini = geminiExtension(source)
  const version: string = JSON.parse(gemini).version
  // The plugin repository's release workflow publishes this section.
  const changelog = new TextDecoder().decode(source.get("CHANGELOG.md"))
  if (!changelog.split("\n").some((line) => line.startsWith(`## [${version}]`)))
    throw new Error(`CHANGELOG.md needs a section for ${version}`)
  files.set("gemini-extension.json", gemini)
  files.set("README.md", readme(source))
  files.set(".github/workflows/release.yml", RELEASE_WORKFLOW)
  return { version, files }
}

/** Writes the tree into a new directory; the caller syncs it into a checkout. */
export async function writePluginRepositoryTree(
  outputDirectory: string,
  tree: PluginRepositoryTree
): Promise<void> {
  const output = resolve(outputDirectory)
  try {
    await lstat(output)
    throw new Error(`Output directory already exists: ${output}`)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error
  }
  for (const [path, contents] of tree.files) {
    const destination = join(output, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents)
  }
}

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf("--output")
  const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined
  if (!output) {
    throw new Error(
      "Usage: bun scripts/plugin-repo.ts --output <new directory>"
    )
  }
  const tree = await buildPluginRepositoryTree()
  await writePluginRepositoryTree(output, tree)
  console.log(
    `Built ${tree.files.size} files for ${PLUGIN_REPOSITORY} ${tree.version}`
  )
}

if (import.meta.main) {
  await main()
}
