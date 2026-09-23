import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mcpClientSnippet } from "@worktable/types"
import { createDefaultConfig } from "./config.ts"
import { adapters } from "./mcp.ts"

const endpoint = "http://127.0.0.1:7480/mcp"
const token = "wt_test_token"

// Parse what each client consumes: formatting and explanatory prose can change.
describe("MCP client configuration", () => {
  it("emits usable JSON for each client with optional bearer authentication", () => {
    const clients = ["cursor", "opencode", "vscode", "goose"] as const
    for (const id of clients) {
      for (const bearer of [undefined, token, 'wt_quote"and\\slash']) {
        const url = `${endpoint}?label=quoted\"value`
        const parsed = JSON.parse(
          mcpClientSnippet(id, { endpoint: url, token: bearer }).body
        )
        const server =
          id === "cursor"
            ? parsed.mcpServers.worktable
            : id === "opencode"
              ? parsed.mcp.worktable
              : id === "vscode"
                ? parsed.servers.worktable
                : parsed
        expect(server.url).toBe(url)
        expect(server.headers).toEqual(
          bearer ? { Authorization: `Bearer ${bearer}` } : undefined
        )
        if (id === "vscode") expect(server.type).toBe("http")
        if (id === "opencode" || id === "goose") {
          expect(server.type).toBe("remote")
          expect(server.enabled).toBe(true)
        }
        if (id === "goose") expect(server.name).toBe("worktable")
      }
    }
  })

  it("emits Codex TOML with the endpoint and optional bearer header", () => {
    for (const bearer of [undefined, token]) {
      const parsed = Bun.TOML.parse(
        mcpClientSnippet("codex", { endpoint, token: bearer }).body
      ) as {
        mcp_servers: {
          worktable: { url: string; http_headers?: Record<string, string> }
        }
      }
      expect(parsed.mcp_servers.worktable).toEqual({
        url: endpoint,
        ...(bearer
          ? { http_headers: { Authorization: `Bearer ${bearer}` } }
          : {}),
      })
    }
  })

  it("passes the endpoint and bearer as distinct Claude command arguments", () => {
    for (const bearer of [undefined, token]) {
      const body = mcpClientSnippet("claude-code", {
        endpoint,
        token: bearer,
      }).body
      const result = spawnSync(
        "sh",
        ["-c", `claude() { printf '%s\\0' "$@"; }; ${body}`],
        { encoding: "utf8" }
      )
      expect(result.status).toBe(0)
      expect(result.stdout.split("\0").slice(0, -1)).toEqual([
        "mcp",
        "add",
        "--transport",
        "http",
        "worktable",
        endpoint,
        "--scope",
        "user",
        ...(bearer ? ["--header", `Authorization: Bearer ${bearer}`] : []),
      ])
    }
  })

  it("requires a token for Goose on reachable installs", () => {
    expect(
      mcpClientSnippet("goose", { endpoint, reachable: true }).needsToken
    ).toBe(true)
    expect(
      mcpClientSnippet("goose", { endpoint, reachable: true, token }).needsToken
    ).toBeUndefined()
  })

  it("uses the configured service endpoint and supplied bearer in CLI output", () => {
    const config = createDefaultConfig({
      workspace: "/tmp/wt-snippet-workspace",
      service: { host: "127.0.0.1", port: 9876, startAtLogin: true },
    })
    const parsed = JSON.parse(adapters.cursor.printConfig(config, token))
    expect(parsed.mcpServers.worktable).toEqual({
      url: "http://127.0.0.1:9876/mcp",
      headers: { Authorization: `Bearer ${token}` },
    })
  })
})
