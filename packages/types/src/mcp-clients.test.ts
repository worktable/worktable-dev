import { describe, expect, it } from "bun:test"
import {
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  DESKTOP_EXTENSION_MCP_CLIENT_IDS,
  MANUAL_MCP_CLIENT_IDS,
  MCP_CLIENTS,
  MCP_SNIPPET_CLIENT_IDS,
  SUPPORTED_MCP_CLIENT_IDS,
} from "./mcp-clients.ts"

describe("MCP client registry", () => {
  it("separates support maturity from setup method", () => {
    expect(SUPPORTED_MCP_CLIENT_IDS).toContain("claude-desktop")
    expect(DESKTOP_EXTENSION_MCP_CLIENT_IDS).toEqual(["claude-desktop"])
    expect(CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS).not.toContain("claude-desktop")
    expect(MCP_SNIPPET_CLIENT_IDS).not.toContain("claude-desktop")
    expect(MCP_CLIENTS["claude-desktop"]).toMatchObject({
      maturity: "supported",
      setupKind: "desktop-extension",
    })
  })

  it("keeps manual and connector-installable surfaces distinct", () => {
    expect(MANUAL_MCP_CLIENT_IDS).toEqual(["goose"])
    expect(CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS).not.toContain("goose")
    expect(MCP_CLIENTS.goose.setupKind).toBe("manual")
    for (const id of CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS) {
      expect(MCP_CLIENTS[id].setupKind).toBe("connector")
    }
  })
})
