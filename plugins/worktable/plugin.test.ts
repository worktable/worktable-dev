import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import sharp from "sharp"
import { WORKTABLE_PLUGIN_SKILLS } from "../../scripts/export-worktable-plugin.ts"

const pluginRoot = import.meta.dir
const agentPluginSchema =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
const agentPluginMcpSchema =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
const worktableMcpEndpoint = "https://app.worktable.cloud/api/mcp"

type JsonObject = Record<string, unknown>

async function jsonFile(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject
}

function expectOnlyKeys(value: JsonObject, allowed: string[]): void {
  expect(Object.keys(value).every((key) => allowed.includes(key))).toBe(true)
}

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

function yamlRecord(raw: string): JsonObject {
  const value = Bun.YAML.parse(raw)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a YAML mapping")
  }
  return value as JsonObject
}

function skillDocument(raw: string): {
  frontmatter: JsonObject
  body: string
} {
  if (!raw.startsWith("---\n")) throw new Error("Missing skill frontmatter")
  const end = raw.indexOf("\n---\n", 4)
  if (end < 0) throw new Error("Unterminated skill frontmatter")
  return {
    frontmatter: yamlRecord(raw.slice(4, end)),
    body: raw.slice(end + 5),
  }
}

describe("Worktable plugin bundle", () => {
  test("ships one portable plugin core with aligned provider adapters", async () => {
    const portableManifest = await jsonFile(join(pluginRoot, "plugin.json"))
    expectOnlyKeys(portableManifest, [
      "$schema",
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "extensions",
    ])
    expect(portableManifest).toEqual(
      expect.objectContaining({
        $schema: agentPluginSchema,
        name: "worktable",
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        description: expect.any(String),
        author: expect.objectContaining({ name: "Reva Labs" }),
        license: "MIT",
      })
    )
    expect(String(portableManifest.description).trim()).not.toBe("")

    const portableMcp = await jsonFile(join(pluginRoot, "mcp.json"))
    expectOnlyKeys(portableMcp, ["$schema", "mcpServers"])
    expect(portableMcp).toEqual({
      $schema: agentPluginMcpSchema,
      mcpServers: {
        worktable: {
          type: "streamable-http",
          url: worktableMcpEndpoint,
        },
      },
    })

    const codexManifest = await jsonFile(
      join(pluginRoot, ".codex-plugin", "plugin.json")
    )
    expect(codexManifest).toEqual(
      expect.objectContaining({
        name: portableManifest.name,
        version: portableManifest.version,
        mcpServers: "./.mcp.json",
        interface: expect.any(Object),
      })
    )

    const claudeManifest = await jsonFile(
      join(pluginRoot, ".claude-plugin", "plugin.json")
    )
    expect(claudeManifest).toEqual(
      expect.objectContaining({
        name: portableManifest.name,
        version: portableManifest.version,
        mcpServers: "./.mcp.json",
      })
    )
    const claudeMcp = await jsonFile(join(pluginRoot, ".mcp.json"))
    expect(claudeMcp).toEqual({
      mcpServers: {
        worktable: {
          type: "http",
          url: worktableMcpEndpoint,
        },
      },
    })

    const claudeMarketplace = (await jsonFile(
      join(pluginRoot, "distribution", "claude-marketplace.json")
    )) as { plugins?: Array<JsonObject> }
    expect(claudeMarketplace.plugins).toEqual([
      expect.objectContaining({
        name: portableManifest.name,
        version: portableManifest.version,
        source: "./plugins/worktable",
      }),
    ])
    const codexMarketplace = (await jsonFile(
      join(pluginRoot, "distribution", "codex-marketplace.json")
    )) as { plugins?: Array<JsonObject> }
    expect(codexMarketplace.plugins).toEqual([
      expect.objectContaining({
        name: portableManifest.name,
        source: { source: "local", path: "./plugins/worktable" },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
      }),
    ])

    const license = await readFile(join(pluginRoot, "LICENSE"), "utf8")
    expect(license).toStartWith("MIT License\n")
  })

  test("ships the six canonical skills and their OpenAI overlays", async () => {
    const actual = (await readdir(join(pluginRoot, "skills"))).sort()
    expect(actual).toEqual(
      WORKTABLE_PLUGIN_SKILLS.map(({ name }) => name).sort()
    )

    for (const { name, files } of WORKTABLE_PLUGIN_SKILLS) {
      expect(files).toContain("SKILL.md")
      expect(files).toContain("agents/openai.yaml")
      expect(await relativeFiles(join(pluginRoot, "skills", name))).toEqual(
        [...files].sort()
      )
      const skill = skillDocument(
        await readFile(join(pluginRoot, "skills", name, "SKILL.md"), "utf8")
      )
      expect(skill.frontmatter.name).toBe(name)
      expect(skill.frontmatter.description).toEqual(expect.any(String))
      expect(String(skill.frontmatter.description).trim()).not.toBe("")
      expect(skill.body.trim()).not.toBe("")

      const overlay = yamlRecord(
        await readFile(
          join(pluginRoot, "skills", name, "agents", "openai.yaml"),
          "utf8"
        )
      )
      expect(overlay.interface).toEqual(expect.any(Object))
      const interfaceMetadata = overlay.interface as JsonObject
      expect(interfaceMetadata.default_prompt).toEqual(
        expect.stringContaining(`$${name}`)
      )
    }
  })

  test("ships provider-sized PNG brand assets", async () => {
    for (const [name, size] of [
      ["composer-icon.png", 128],
      ["logo.png", 512],
      ["logo-dark.png", 512],
    ] as const) {
      const path = join(pluginRoot, "assets", name)
      expect(existsSync(path)).toBe(true)
      const metadata = await sharp(path).metadata()
      expect(metadata.format).toBe("png")
      expect(metadata.width).toBe(size)
      expect(metadata.height).toBe(size)
    }
  })
})
