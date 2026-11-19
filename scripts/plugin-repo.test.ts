import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildPluginRepositoryTree } from "./plugin-repo"

const pluginSource = resolve(import.meta.dir, "..", "plugins/worktable")
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function sourceCopy(): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "worktable-plugin-repo-"))
  temporaryDirectories.push(temporary)
  const source = join(temporary, "worktable")
  await cp(pluginSource, source, { recursive: true })
  return source
}

const text = (contents: Uint8Array | string | undefined) =>
  typeof contents === "string" ? contents : new TextDecoder().decode(contents)

describe("plugin repository tree", () => {
  test("carries every plugin file, including new ones, and matching Gemini, Antigravity and Claude marketplace manifests", async () => {
    const source = await sourceCopy()
    await mkdir(join(source, ".example-host-plugin"))
    await writeFile(join(source, ".example-host-plugin/plugin.json"), "{}\n")

    const tree = await buildPluginRepositoryTree({ sourceDirectory: source })
    const paths = [...tree.files.keys()]

    expect(paths).toContain(".example-host-plugin/plugin.json")
    expect(paths).toContain(
      "skills/worktable-find-and-synthesize-context/SKILL.md"
    )
    expect(paths.some((path) => path.startsWith("distribution/"))).toBe(false)
    expect(paths.some((path) => path.endsWith(".test.ts"))).toBe(false)

    const plugin = JSON.parse(
      await readFile(join(source, "plugin.json"), "utf8")
    )
    const mcp = JSON.parse(await readFile(join(source, "mcp.json"), "utf8"))
    expect(JSON.parse(text(tree.files.get("gemini-extension.json")))).toEqual({
      name: "worktable",
      version: plugin.version,
      description: plugin.description,
      mcpServers: { worktable: { httpUrl: mcp.mcpServers.worktable.url } },
    })
    expect(tree.version).toBe(plugin.version)
    // Antigravity loads servers only from mcp_config.json, under its own manifest.
    expect(JSON.parse(text(tree.files.get("mcp_config.json")))).toEqual({
      mcpServers: { worktable: { serverUrl: mcp.mcpServers.worktable.url } },
    })
    expect(JSON.parse(text(tree.files.get(".antigravity-plugin/plugin.json")))).toMatchObject({
      name: "worktable",
      version: plugin.version,
      logo: "assets/logo.png",
    })
    expect(paths).toContain("assets/logo.png")
    // Claude's Add marketplace installs the repository itself, and the
    // connect command installs Worktable Skills from its folder.
    const marketplace = JSON.parse(text(tree.files.get(".claude-plugin/marketplace.json")))
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "worktable", source: "./", version: plugin.version }),
      expect.objectContaining({
        name: "worktable-skills",
        source: "./plugins/worktable-skills",
        version: plugin.version,
      }),
    ])
    const codex = JSON.parse(text(tree.files.get(".agents/plugins/marketplace.json")))
    expect(codex.plugins.map((entry: any) => [entry.name, entry.source.path])).toEqual([
      ["worktable", "./"],
      ["worktable-skills", "./plugins/worktable-skills"],
    ])
  })

  test("builds Worktable Skills from the same skills, shown as Worktable, with no MCP server", async () => {
    const tree = await buildPluginRepositoryTree({ sourceDirectory: await sourceCopy() })
    const skillsPlugin = "plugins/worktable-skills/"
    const inPlugin = [...tree.files.keys()]
      .filter((path) => path.startsWith(skillsPlugin))
      .map((path) => path.slice(skillsPlugin.length))
    // Every skill file, byte for byte.
    const skills = [...tree.files.keys()].filter((path) => path.startsWith("skills/"))
    expect(skills.length).toBeGreaterThan(0)
    for (const path of skills) {
      expect(text(tree.files.get(`${skillsPlugin}${path}`))).toBe(text(tree.files.get(path)))
    }
    expect(inPlugin.filter((path) => path.startsWith("skills/")).sort()).toEqual(skills.sort())
    expect(inPlugin.some((path) => /(^|\/)\.?mcp(_config)?\.json$/.test(path))).toBe(false)

    const claude = JSON.parse(text(tree.files.get(`${skillsPlugin}.claude-plugin/plugin.json`)))
    const codex = JSON.parse(text(tree.files.get(`${skillsPlugin}.codex-plugin/plugin.json`)))
    expect(claude).toMatchObject({ name: "worktable-skills", displayName: "Worktable", version: tree.version })
    expect(codex).toMatchObject({ name: "worktable-skills", version: tree.version, interface: { displayName: "Worktable" } })
    expect(claude.mcpServers).toBeUndefined()
    expect(codex.mcpServers).toBeUndefined()
  })

  test("refuses credential-shaped content in any carried file", async () => {
    const source = await sourceCopy()
    await mkdir(join(source, ".example-host-plugin"))
    await writeFile(
      join(source, ".example-host-plugin/plugin.json"),
      "ANTHROPIC_API_KEY=sk-ant-api03-examplecredentialvalue\n"
    )

    await expect(
      buildPluginRepositoryTree({ sourceDirectory: source })
    ).rejects.toThrow("credential-shaped token")
  })
})
