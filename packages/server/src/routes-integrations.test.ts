import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { resetClaudeDesktopExtensionCacheForTests } from "./claude-extension-assets.ts"
import { integrationsRouter } from "./routes/integrations.ts"

let tempDir: string
let savedBundle: string | undefined
let savedHosted: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "worktable-integrations-"))
  savedBundle = process.env["WORKTABLE_CLAUDE_MCPB_BUNDLE"]
  savedHosted = process.env["WORKTABLE_HOSTED"]
  delete process.env["WORKTABLE_HOSTED"]
  resetClaudeDesktopExtensionCacheForTests()
})

afterEach(() => {
  if (savedBundle === undefined)
    delete process.env["WORKTABLE_CLAUDE_MCPB_BUNDLE"]
  else process.env["WORKTABLE_CLAUDE_MCPB_BUNDLE"] = savedBundle
  if (savedHosted === undefined) delete process.env["WORKTABLE_HOSTED"]
  else process.env["WORKTABLE_HOSTED"] = savedHosted
  resetClaudeDesktopExtensionCacheForTests()
  rmSync(tempDir, { recursive: true, force: true })
})

function app(): Hono {
  return new Hono().route("/", integrationsRouter)
}

describe("GET /integrations/claude-desktop.mcpb", () => {
  it("serves the resolved extension as an uncached attachment", async () => {
    const bundlePath = join(tempDir, "worktable.mcpb")
    const expected = Buffer.from("PK\u0003\u0004test-mcpb-binary", "binary")
    writeFileSync(bundlePath, expected)
    process.env["WORKTABLE_CLAUDE_MCPB_BUNDLE"] = bundlePath

    const response = await app().fetch(
      new Request("http://localhost/integrations/claude-desktop.mcpb")
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream"
    )
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="worktable-claude-desktop.mcpb"'
    )
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      readFileSync(bundlePath)
    )
  })

  it("returns a stable unavailable response when the selected artifact is absent", async () => {
    process.env["WORKTABLE_CLAUDE_MCPB_BUNDLE"] = join(tempDir, "missing.mcpb")
    const response = await app().fetch(
      new Request("http://localhost/integrations/claude-desktop.mcpb")
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      code: "EXTENSION_UNAVAILABLE",
    })
  })

  it("uses the standard hosted-disabled contract on Worktable Cloud", async () => {
    process.env["WORKTABLE_HOSTED"] = "1"
    const response = await app().fetch(
      new Request("http://localhost/integrations/claude-desktop.mcpb")
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "HOSTED_DISABLED" })
  })
})
