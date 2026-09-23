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
  it("offers each supported client through its declared setup method", () => {
    const groups = [
      ["connector", CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS],
      ["manual", MANUAL_MCP_CLIENT_IDS],
      ["desktop-extension", DESKTOP_EXTENSION_MCP_CLIENT_IDS],
    ] as const
    const offered = groups.flatMap(([, ids]) => [...ids])
    expect(new Set(offered).size).toBe(offered.length)
    expect([...offered].sort()).toEqual([...SUPPORTED_MCP_CLIENT_IDS].sort())
    for (const [setupKind, ids] of groups) {
      for (const id of ids) {
        expect(MCP_CLIENTS[id]).toMatchObject({
          maturity: "supported",
          setupKind,
        })
        expect(
          MCP_SNIPPET_CLIENT_IDS.includes(
            id as (typeof MCP_SNIPPET_CLIENT_IDS)[number],
          ),
        ).toBe(setupKind !== "desktop-extension")
      }
    }
  })
})
