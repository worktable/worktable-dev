import { describe, expect, it } from "bun:test"
import {
  assertMcpBridgeToolsOnly,
  classifyMcpBridgeError,
  McpBridgeError,
  optionalMcpUserConfigValue,
  parseMcpBridgeEndpoint,
  sameOriginMcpFetch,
} from "./bridge-policy.ts"
import { formatMcpBridgeError } from "./bridge.ts"

describe("MCP bridge policy", () => {
  it.each([
    "not a URL",
    "file:///tmp/worktable",
    "http://user:secret@localhost/mcp",
    "http://localhost/mcp#secret",
  ])("rejects credential-unsafe endpoint %s", (endpoint) => {
    expect(() => parseMcpBridgeEndpoint(endpoint)).toThrow(McpBridgeError)
    expect(() => parseMcpBridgeEndpoint(endpoint)).toThrow(
      expect.objectContaining({ code: "BAD_ENDPOINT" })
    )
  })

  it("accepts only the MCP tools capability", () => {
    expect(() => assertMcpBridgeToolsOnly({ tools: {} })).not.toThrow()
    expect(() => assertMcpBridgeToolsOnly(undefined)).toThrow(
      expect.objectContaining({ code: "PROTOCOL_MISMATCH" })
    )
    expect(() =>
      assertMcpBridgeToolsOnly({ tools: {}, resources: {} })
    ).toThrow(expect.objectContaining({ code: "PROTOCOL_MISMATCH" }))
  })

  it("treats unresolved optional MCPB values as absent", () => {
    expect(optionalMcpUserConfigValue(undefined)).toBeUndefined()
    expect(optionalMcpUserConfigValue("  ")).toBeUndefined()
    expect(
      optionalMcpUserConfigValue("${user_config.access_token}")
    ).toBeUndefined()
    expect(optionalMcpUserConfigValue(" wt_live ")).toBe("wt_live")
  })

  it.each([
    {
      error: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      code: "UNAVAILABLE",
    },
    {
      error: new Error("outer", {
        cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
      }),
      code: "TLS_OR_DNS",
    },
    { error: new Error("HTTP 401 unauthorized"), code: "UNAUTHORIZED" },
    { error: new DOMException("aborted", "AbortError"), code: "TIMEOUT" },
    { error: new Error("unexpected secret payload"), code: "UNKNOWN" },
  ])("classifies $code without exposing causes", ({ error, code }) => {
    expect(classifyMcpBridgeError(error).code).toBe(code)
    expect(formatMcpBridgeError(error)).not.toContain("secret payload")
  })

  it("refuses cross-origin requests and redirect responses before forwarding credentials", async () => {
    const crossOrigin = sameOriginMcpFetch(
      "https://worktable.example",
      async () => new Response(null, { status: 200 })
    )
    await expect(
      crossOrigin("https://foreign.example/mcp", {})
    ).rejects.toMatchObject({ code: "REDIRECT_REFUSED" })

    const redirected = sameOriginMcpFetch(
      "https://worktable.example",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://foreign.example/mcp" },
        })
    )
    await expect(
      redirected("https://worktable.example/mcp", {})
    ).rejects.toMatchObject({ code: "REDIRECT_REFUSED" })
  })
})
