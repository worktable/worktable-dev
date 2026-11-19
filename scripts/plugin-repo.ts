#!/usr/bin/env bun

// Builds worktable/worktable-plugin: a repository whose root is the Worktable
// agent plugin, for directories that read a plugin only from a repository
// root (Gemini CLI extensions, Kiro Powers, Grok Build). The tree carries
// every file in plugins/worktable except tests and distribution catalogs, plus
// a generated Gemini CLI manifest, a note on where the source lives, and the
// workflow that pulls each change and releases each new plugin version.
//
// The repository is also the Claude Code, Codex and Copilot marketplace that
// Worktable's connect command installs from, and Antigravity installs from its
// folders. Beside the full plugin it lists Worktable Skills
// (`plugins/worktable-skills`), built here from the same skills with no MCP
// server: the connect command adds the connection to a Worktable on a
// computer or server itself, so a bundled Cloud server would only duplicate it.

import { lstat, mkdir, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { readPublicPluginFiles } from "./export-worktable-plugin.ts"

const repositoryRoot = resolve(import.meta.dir, "..")
const pluginSource = join(repositoryRoot, "plugins/worktable")

export const PLUGIN_REPOSITORY = "worktable/worktable-plugin"
/** The skills-only plugin's id; clients show it as Worktable. */
export const SKILLS_PLUGIN = "worktable-skills"
export const SKILLS_PLUGIN_PATH = `plugins/${SKILLS_PLUGIN}`
const SKILLS_PLUGIN_DESCRIPTION =
  "Worktable's skills for Docs, HTML Docs, Records, annotations and threads, for an agent connected to Worktable with its connect command."
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

/**
 * Antigravity reads `.antigravity-plugin/plugin.json` ahead of the root
 * manifest, whose Agent Plugins `$schema` its native schema rejects, and its
 * MCP servers only from `mcp_config.json`.
 */
function antigravity(files: Map<string, Uint8Array>): { manifest: string; mcp: string } {
  const plugin = json(files.get("plugin.json"), "plugin.json")
  const claude = json(files.get(".claude-plugin/plugin.json"), ".claude-plugin/plugin.json")
  const server = json(files.get("mcp.json"), "mcp.json").mcpServers?.worktable
  const prompts = plugin.extensions?.["com.openai"]?.interface?.defaultPrompt
  if (typeof claude.displayName !== "string" || !Array.isArray(prompts) || typeof server?.url !== "string") {
    throw new Error("The plugin manifests must give a display name, prompts and the Worktable server")
  }
  const manifest = {
    name: plugin.name,
    displayName: claude.displayName,
    description: plugin.description,
    version: plugin.version,
    logo: "assets/logo.png",
    author: plugin.author,
    homepage: plugin.homepage,
    repository: `https://github.com/${PLUGIN_REPOSITORY}`,
    license: plugin.license,
    keywords: plugin.keywords,
    suggestedPrompts: prompts.slice(0, 3),
  }
  const mcp = { mcpServers: { worktable: { serverUrl: server.url } } }
  return {
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    mcp: `${JSON.stringify(mcp, null, 2)}\n`,
  }
}

/**
 * Worktable Skills: the full plugin's skills, assets and license under Claude,
 * Codex and Antigravity manifests that name no MCP server. Copilot reads the
 * Claude one. Nothing is copied in worktable-dev; the tree is built from
 * plugins/worktable each sync.
 */
function skillsPlugin(
  files: Map<string, Uint8Array>,
  antigravityManifest: string
): Map<string, string | Uint8Array> {
  const claude = json(files.get(".claude-plugin/plugin.json"), ".claude-plugin/plugin.json")
  const codex = json(files.get(".codex-plugin/plugin.json"), ".codex-plugin/plugin.json")
  const { mcpServers: _claudeServers, ...claudeRest } = claude
  const { mcpServers: _codexServers, ...codexRest } = codex
  const out = new Map<string, string | Uint8Array>()
  const manifest = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  out.set(
    ".claude-plugin/plugin.json",
    manifest({
      ...claudeRest,
      name: SKILLS_PLUGIN,
      displayName: claude.displayName,
      description: SKILLS_PLUGIN_DESCRIPTION,
      repository: `https://github.com/${PLUGIN_REPOSITORY}`,
    })
  )
  out.set(
    ".codex-plugin/plugin.json",
    manifest({
      ...codexRest,
      name: SKILLS_PLUGIN,
      description: SKILLS_PLUGIN_DESCRIPTION,
      interface: {
        ...codex.interface,
        shortDescription: "Skills for your Worktable",
        longDescription: SKILLS_PLUGIN_DESCRIPTION,
      },
    })
  )
  // Without its own manifest Antigravity converts the Claude one and shows
  // the plugin by its id.
  out.set(
    ".antigravity-plugin/plugin.json",
    manifest({
      ...JSON.parse(antigravityManifest),
      name: SKILLS_PLUGIN,
      description: SKILLS_PLUGIN_DESCRIPTION,
    })
  )
  for (const [path, contents] of files) {
    if (path.startsWith("skills/") || path.startsWith("assets/") || path === "LICENSE")
      out.set(path, contents)
  }
  out.set(
    "README.md",
    `# Worktable Skills

Worktable's skills, without a connection: find and cite context, write Docs,
build HTML Docs, organize Records, review with annotations, and work in
threads. Worktable's connect command installs this plugin in Claude Code,
Codex, Copilot CLI, VS Code and Antigravity when it connects them to a
Worktable on your computer or server, and adds the connection itself.

To install it yourself:

\`\`\`text
claude plugin install ${SKILLS_PLUGIN} --marketplace ${PLUGIN_REPOSITORY}
\`\`\`

\`\`\`text
codex plugin marketplace add ${PLUGIN_REPOSITORY}
codex plugin add ${SKILLS_PLUGIN}@worktable
\`\`\`

\`\`\`text
copilot plugin marketplace add ${PLUGIN_REPOSITORY}
copilot plugin install ${SKILLS_PLUGIN}@worktable
\`\`\`

\`\`\`text
agy plugin install https://github.com/${PLUGIN_REPOSITORY}/tree/main/${SKILLS_PLUGIN_PATH}
\`\`\`

For Worktable Cloud, install the full Worktable plugin at the root of this
repository instead. See [Skills](https://docs.worktable.dev/agents/skills/).
`
  )
  return out
}

/**
 * Claude's Add marketplace takes a repository whose root has a marketplace
 * manifest; here the full plugin is the repository itself, and Worktable
 * Skills sits in its own folder.
 */
function claudeMarketplace(marketplace: any): string {
  const repository = `https://github.com/${PLUGIN_REPOSITORY}`
  const full = marketplace.plugins.map((plugin: Record<string, unknown>) => ({
    ...plugin,
    source: "./",
    repository,
  }))
  const skills = full
    .filter((plugin: Record<string, unknown>) => plugin.name === "worktable")
    .map((plugin: Record<string, unknown>) => ({
      ...plugin,
      name: SKILLS_PLUGIN,
      source: `./${SKILLS_PLUGIN_PATH}`,
      description: SKILLS_PLUGIN_DESCRIPTION,
    }))
  return `${JSON.stringify({ ...marketplace, plugins: [...full, ...skills] }, null, 2)}\n`
}

/** Codex's `plugin marketplace add` reads `.agents/plugins/marketplace.json`. */
function codexMarketplace(marketplace: any): string {
  const full = marketplace.plugins.map((plugin: Record<string, unknown>) => ({
    ...plugin,
    source: { source: "local", path: "./" },
  }))
  const skills = full
    .filter((plugin: Record<string, unknown>) => plugin.name === "worktable")
    .map((plugin: Record<string, unknown>) => ({
      ...plugin,
      name: SKILLS_PLUGIN,
      source: { source: "local", path: `./${SKILLS_PLUGIN_PATH}` },
    }))
  return `${JSON.stringify({ ...marketplace, plugins: [...full, ...skills] }, null, 2)}\n`
}

function readme(files: Map<string, Uint8Array>): string {
  const source = new TextDecoder().decode(files.get("README.md")).trimEnd()
  return `${source}

## About this repository

This repository is generated from [\`plugins/worktable\`](${SOURCE_URL})
in worktable-dev and updated on every change there. Report issues and propose
changes in [worktable-dev](${ISSUES_URL}).

[\`${SKILLS_PLUGIN_PATH}\`](${SKILLS_PLUGIN_PATH}) holds Worktable Skills, the
same skills without the Cloud connection, which Worktable's connect command
installs in Claude Code, Codex, Copilot CLI, VS Code and Antigravity for a
Worktable on a computer or server.
`
}

// Runs in the plugin repository, which pulls instead of being pushed to, so
// no credential for it lives anywhere. Each hour (or on demand) it rebuilds
// the tree from worktable-dev's main, commits any change with its own token,
// and releases a new plugin version, which the Gemini CLI gallery indexes.
// A workflow token can't change workflow files, so the sync leaves .github/
// alone; when this workflow changes, push it to the plugin repository by hand.
const SYNC_WORKFLOW = `name: Sync

on:
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: sync
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Check out this repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          path: plugin

      - name: Check out worktable-dev
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: worktable/worktable-dev
          ref: main
          path: source
          persist-credentials: false

      - name: Set up Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: "1.3.14"

      - name: Sync and release
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          source_sha="$(git -C source rev-parse HEAD)"
          bun source/scripts/plugin-repo.ts --output "$RUNNER_TEMP/tree"
          rsync -a --delete --exclude=.git --exclude=.github "$RUNNER_TEMP/tree/" plugin/
          cd plugin
          git add -A
          if git diff --cached --quiet; then
            echo "Up to date with worktable-dev \${source_sha::12}"
          else
            git -c user.name="github-actions[bot]" \\
              -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \\
              commit --quiet \\
              -m "Sync from worktable-dev \${source_sha::12}" \\
              -m "https://github.com/worktable/worktable-dev/commit/$source_sha"
            git push --quiet origin HEAD:main
          fi
          version="$(jq -r .version gemini-extension.json)"
          tag="v$version"
          if gh release view "$tag" >/dev/null 2>&1; then
            exit 0
          fi
          awk -v heading="## [$version]" '
            index($0, heading) == 1 { found = 1; next }
            found && /^## \\[/ { exit }
            found { print }
          ' CHANGELOG.md > "$RUNNER_TEMP/notes.md"
          if ! grep -q '[^[:space:]]' "$RUNNER_TEMP/notes.md"; then
            echo "CHANGELOG.md has no entry for $version" >&2
            exit 1
          fi
          gh release create "$tag" --target "$(git rev-parse HEAD)" --title "$tag" --notes-file "$RUNNER_TEMP/notes.md"
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
  // The plugin repository's sync workflow publishes this section.
  const changelog = new TextDecoder().decode(source.get("CHANGELOG.md"))
  if (!changelog.split("\n").some((line) => line.startsWith(`## [${version}]`)))
    throw new Error(`CHANGELOG.md needs a section for ${version}`)
  files.set("gemini-extension.json", gemini)
  const google = antigravity(source)
  files.set(".antigravity-plugin/plugin.json", google.manifest)
  files.set("mcp_config.json", google.mcp)
  // The catalogs stay in worktable-dev but pass the same publication checks.
  const claudeCatalog = "distribution/claude-marketplace.json"
  const codexCatalog = "distribution/codex-marketplace.json"
  const catalogs = await readPublicPluginFiles([claudeCatalog, codexCatalog], {
    sourceDirectory,
    publicationPolicyPath: options.publicationPolicyPath,
  })
  files.set(".claude-plugin/marketplace.json", claudeMarketplace(json(catalogs.get(claudeCatalog), claudeCatalog)))
  files.set(".agents/plugins/marketplace.json", codexMarketplace(json(catalogs.get(codexCatalog), codexCatalog)))
  for (const [path, contents] of skillsPlugin(source, google.manifest))
    files.set(`${SKILLS_PLUGIN_PATH}/${path}`, contents)
  files.set("README.md", readme(source))
  files.set(".github/workflows/sync.yml", SYNC_WORKFLOW)
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
