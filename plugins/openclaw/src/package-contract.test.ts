import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { worktableMcpEndpoint } from "./worktable-client"

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")
) as {
  description: string
  version: string
  icon?: string
  activation?: { onCommands?: string[] }
  commandAliases?: Array<{ name?: string; kind?: string }>
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as {
  version: string
  description: string
  license?: string
  files?: string[]
  peerDependencies?: { openclaw?: string }
  devDependencies?: { openclaw?: string }
  repository?: { type?: string; url?: string; directory?: string }
  openclaw?: {
    channel?: { blurb?: string }
    compat?: { pluginApi?: string; minGatewayVersion?: string }
    build?: { openclawVersion?: string; pluginSdkVersion?: string }
    install?: {
      clawhubSpec?: string
      defaultChoice?: string
      minHostVersion?: string
    }
  }
}

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

describe("packed OpenClaw contract", () => {
  test("keeps the ClawHub listing metadata aligned", () => {
    expect(manifest.description).toBe(packageJson.description)
    expect(packageJson.openclaw?.channel?.blurb).toBe(packageJson.description)
    expect(manifest.icon).toBe("https://www.worktable.dev/favicon.svg")
  })

  test("declares the command ownership needed for lazy plugin CLI loading", () => {
    expect(manifest.activation?.onCommands).toContain("worktable")
    expect(manifest.commandAliases).toContainEqual({
      name: "worktable",
      kind: "cli",
    })
  })

  test("keeps package, manifest, and OpenClaw compatibility aligned", () => {
    expect(manifest.version).toBe(packageJson.version)
    const verifiedVersion = packageJson.devDependencies?.openclaw
    expect(verifiedVersion).toMatch(/^\d+\.\d+\.\d+(?:-\d+)?$/)
    expect(packageJson.peerDependencies?.openclaw).toBe(`>=${verifiedVersion}`)
    expect(packageJson.openclaw?.compat).toEqual({
      pluginApi: `>=${verifiedVersion}`,
      minGatewayVersion: verifiedVersion,
    })
    expect(packageJson.openclaw?.build).toEqual({
      openclawVersion: verifiedVersion,
      pluginSdkVersion: verifiedVersion,
    })
    expect(packageJson.openclaw?.install).toEqual({
      clawhubSpec: "clawhub:@worktable/openclaw",
      defaultChoice: "clawhub",
      minHostVersion: `>=${verifiedVersion}`,
    })
  })

  test("normalizes root and nested Worktable origins to one MCP path", () => {
    expect(worktableMcpEndpoint("http://127.0.0.1:7480").href).toBe(
      "http://127.0.0.1:7480/mcp"
    )
    expect(worktableMcpEndpoint("https://example.test/base/").href).toBe(
      "https://example.test/base/mcp"
    )
    expect(worktableMcpEndpoint("https://example.test/mcp").href).toBe(
      "https://example.test/mcp"
    )
  })

  test("declares the public source and ClawHub install path", () => {
    expect(packageJson.license).toBe("MIT")
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/worktable/worktable-dev.git",
      directory: "plugins/openclaw",
    })
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "README.md",
        "CHANGELOG.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
      ])
    )
    expect(readme).toContain(
      "openclaw plugins install clawhub:@worktable/openclaw"
    )
    expect(readme).not.toContain("releases/latest/download/worktable-openclaw")
  })
})
