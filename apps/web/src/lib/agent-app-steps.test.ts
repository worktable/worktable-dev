import { describe, expect, it } from "bun:test"
import {
  appsFor,
  bringsSkills,
  sharedAddressLandsHere,
  waysFor,
  type AppId,
  type Place,
} from "./agent-app-steps"

const PLACES: Place[] = ["cloud", "computer", "server"]

describe("agent app ways", () => {
  it("leads with the plugin or official app wherever it works", () => {
    expect(waysFor("claude", "cloud").best).toEqual({ kind: "claude-plugin", link: false })
    expect(waysFor("chatgpt", "cloud").best).toEqual({ kind: "chatgpt-app", link: false })
    expect(waysFor("claude-code", "cloud").best).toEqual({ kind: "coding-plugin", client: "claude-code" })
    expect(waysFor("codex", "cloud").best).toEqual({ kind: "coding-plugin", client: "codex" })
    // Outside Cloud, Claude's and ChatGPT's plugins reach it through Link,
    // and Claude Desktop's extension stays one step away.
    expect(waysFor("claude", "computer").best).toEqual({ kind: "claude-plugin", link: true })
    expect(waysFor("claude", "computer").others).toEqual([{ kind: "extension" }])
    expect(waysFor("chatgpt", "server").best).toEqual({ kind: "chatgpt-app", link: true })
    for (const place of PLACES) {
      expect(waysFor("openclaw", place).best.kind).toBe("always-on")
      expect(waysFor("hermes", place).best.kind).toBe("always-on")
    }
  })

  it("connects coding agents directly outside Cloud, with skills only where they install", () => {
    for (const place of ["computer", "server"] as const) {
      const claudeCode = waysFor("claude-code", place).best
      expect(claudeCode).toEqual({ kind: "pairing", client: "claude-code", skills: "claude" })
      expect(bringsSkills(claudeCode)).toBe(true)
      expect(waysFor("codex", place).best).toMatchObject({ skills: "agents" })
      // Not claimed for an agent whose skills folder isn't one we install to.
      expect(bringsSkills(waysFor("cursor", place).best)).toBe(false)
    }
    // An address alone is tools without skills, and says so.
    expect(bringsSkills(waysFor("gemini", "cloud").best)).toBe(false)
  })

  it("offers apps that connect from their own servers only on Cloud", () => {
    const ids = (place: Place): AppId[] => appsFor(place).map((app) => app.id)
    expect(ids("cloud")).toContain("perplexity")
    expect(ids("cloud")).toContain("gemini")
    for (const place of ["computer", "server"] as const) {
      expect(ids(place)).not.toContain("perplexity")
      expect(ids(place)).not.toContain("gemini")
      expect(ids(place)).toContain("gemini-cli")
    }
  })

  it("knows Cloud's shared address lands in the default Worktable only", () => {
    expect(sharedAddressLandsHere("https://app.worktable.cloud/api/mcp")).toBe(true)
    expect(sharedAddressLandsHere("https://app.worktable.cloud/api/mcp/w/wt_123")).toBe(false)
  })
})
