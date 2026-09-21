import { describe, expect, it } from "bun:test"
import { desktopAgentConnectionDetails } from "./desktop-agent-connection"

const loopback = {
  endpoint: "http://127.0.0.1:7480/mcp",
  remoteMcpUrl: "http://127.0.0.1:7480/mcp",
  reachable: false,
  originConfigured: false,
  mcpTokenRequired: false,
}

describe("desktop agent connection posture", () => {
  it("uses a tokenless loopback endpoint for a fresh local install", () => {
    expect(desktopAgentConnectionDetails(loopback)).toEqual({
      endpoint: loopback.endpoint,
      needsToken: false,
      publicUrlUsed: false,
    })
  })

  it("requires a token when deployment policy protects the loopback endpoint", () => {
    expect(
      desktopAgentConnectionDetails({
        ...loopback,
        mcpTokenRequired: true,
      })
    ).toMatchObject({ endpoint: loopback.endpoint, needsToken: true })
  })

  it("uses the configured public origin and requires a token", () => {
    expect(
      desktopAgentConnectionDetails({
        ...loopback,
        originConfigured: true,
        remoteMcpUrl: "https://worktable.example.com/mcp",
      })
    ).toEqual({
      endpoint: "https://worktable.example.com/mcp",
      needsToken: true,
      publicUrlUsed: true,
    })
  })

  it("treats a network-reachable self-hosted install as authenticated", () => {
    expect(
      desktopAgentConnectionDetails({
        ...loopback,
        reachable: true,
        remoteMcpUrl: "http://worktable.lan:7480/mcp",
      })
    ).toMatchObject({
      endpoint: "http://worktable.lan:7480/mcp",
      needsToken: true,
    })
  })
})
