import { describe, expect, it } from "bun:test"
import {
  AGENT_APPS,
  addressStep,
  appsFor,
  bringsSkills,
  connectCommand,
  placeOf,
  sharedAddressLandsHere,
  SKILL_CATALOG,
  waysFor,
  type AppId,
  type Place,
  type Way,
  type Where,
} from "./agent-app-steps"
import type { ConnectionInfo } from "./system-api"

const PLACES: Place[] = ["cloud", "computer", "server"]
const at = (place: Place, sharedHere = true): Where => ({ place, sharedHere })
const best = (app: AppId, where: Where): Way => waysFor(app, where)!.best

const LOCAL: ConnectionInfo = {
  mcpAuthMode: "local-token",
  endpoint: "http://127.0.0.1:7480/mcp",
  remoteMcpUrl: "http://127.0.0.1:7480/mcp",
  reachable: false,
  authRequired: false,
  mcpTokenRequired: false,
  origin: "http://127.0.0.1:7480",
  originSource: "fallback",
  originConfigured: false,
}

describe("agent app ways", () => {
  it("leads with the plugin or official app wherever it works", () => {
    expect(best("claude", at("cloud"))).toMatchObject({
      kind: "claude-plugin",
      link: false,
    })
    expect(best("chatgpt", at("cloud"))).toMatchObject({
      kind: "chatgpt-app",
      link: false,
    })
    expect(best("claude-code", at("cloud"))).toMatchObject({
      kind: "coding-plugin",
    })
    expect(best("codex", at("cloud"))).toMatchObject({ kind: "coding-plugin" })
    // Outside Cloud, Claude's and ChatGPT's plugins reach it through Link,
    // and Claude Desktop's extension stays one step away.
    expect(best("claude", at("computer"))).toMatchObject({
      kind: "claude-plugin",
      link: true,
    })
    expect(
      waysFor("claude", at("computer"))!.others.map((way) => way.kind)
    ).toEqual(["extension"])
    expect(best("chatgpt", at("server"))).toMatchObject({
      kind: "chatgpt-app",
      link: true,
    })
    // On Cloud, the connector for Claude's Free plan is the first other way.
    expect(waysFor("claude", at("cloud"))!.others[0]!.kind).toBe(
      "claude-connector"
    )
    for (const place of PLACES) {
      expect(best("openclaw", at(place)).kind).toBe("always-on")
      expect(best("hermes", at(place)).kind).toBe("always-on")
    }
  })

  it("leads with this Worktable's own address when the shared one lands elsewhere", () => {
    for (const app of ["claude-code", "codex"] as const) {
      const ways = waysFor(app, at("cloud", false))!
      expect(ways.best).toMatchObject({ kind: "cloud-command", client: app })
      expect(bringsSkills(ways.best)).toBe(true)
      expect(ways.others.map((way) => way.kind)).toEqual(["coding-plugin"])
    }
    const pinned = "https://app.worktable.cloud/api/mcp/w/wt_123"
    for (const app of [
      "gemini-cli",
      "antigravity",
      "vscode",
      "copilot",
      "perplexity",
    ] as const) {
      expect(best(app, at("cloud"))).toMatchObject({ kind: "app-plugin", app })
      const ways = waysFor(app, at("cloud", false))!
      expect(ways.best.kind).toBe("address")
      expect(ways.others).toEqual([
        { kind: "app-plugin", app, skills: { via: "plugin" } },
      ])
      expect(addressStep(app, pinned).value).toContain(pinned)
    }
  })

  it("connects coding agents directly outside Cloud, with skills only where they install", () => {
    for (const place of ["computer", "server"] as const) {
      // The connect command installs the skills plugin itself.
      for (const app of [
        "claude-code",
        "codex",
        "antigravity",
        "vscode",
        "copilot",
      ] as const) {
        const way = best(app, at(place))
        expect(way).toMatchObject({
          kind: "pairing",
          client: app,
          skills: { via: "connect-plugin" },
        })
        expect(bringsSkills(way)).toBe(true)
      }
      // OpenCode and Kilo get this Worktable's skills address from it.
      for (const app of ["opencode", "kilo"] as const) {
        const way = best(app, at(place))
        expect(way).toMatchObject({ kind: "pairing", client: app })
        expect(way.skills.via).toBe("catalog")
      }
      // Not claimed for an agent whose skills folder isn't one we install to.
      expect(bringsSkills(best("cursor", at(place)))).toBe(false)
    }
    // On Cloud they paste the server and the skills address together.
    const pinned = "https://app.worktable.cloud/api/mcp/w/wt_123"
    for (const app of ["opencode", "kilo"] as const) {
      expect(best(app, at("cloud"))).toMatchObject({
        kind: "address",
        skills: { via: "catalog" },
      })
      expect(JSON.parse(addressStep(app, pinned).value)).toEqual({
        mcp: { servers: { worktable: { type: "remote", url: pinned } } },
        skills: [SKILL_CATALOG],
      })
    }
    // An address alone is tools without skills; the Gemini app takes a file.
    expect(best("gemini", at("cloud")).skills.via).toBe("files")
    expect(bringsSkills(best("other", at("cloud")))).toBe(false)
  })

  it("runs one command that installs skills only after the connection works", () => {
    const pairing = best("claude-code", at("computer"))
    if (pairing.kind !== "pairing") throw new Error("expected a pairing")
    expect(
      connectCommand(pairing, {
        connectScript: "http://127.0.0.1:7480/connect.sh",
        code: "ABCDE-FGHJK",
      })
    ).toBe(
      "curl -fsSL http://127.0.0.1:7480/connect.sh | sh -s -- ABCDE-FGHJK --client claude-code"
    )
    const cloud = best("codex", at("cloud", false))
    if (cloud.kind !== "cloud-command") throw new Error("expected a command")
    const command = connectCommand(cloud, {
      mcpUrl: "https://app.worktable.cloud/api/mcp/w/wt_123",
    })
    expect(command).toContain(
      "--mcp-url 'https://app.worktable.cloud/api/mcp/w/wt_123'"
    )
    expect(command).toEndWith(
      " && curl -fsSL https://worktable.dev/install-skills | sh -s -- --target agents"
    )
    // Without skills, the command is the connection alone.
    const cursor = best("cursor", at("server"))
    if (cursor.kind !== "pairing") throw new Error("expected a pairing")
    expect(
      connectCommand(cursor, {
        connectScript: "https://w.example/connect.sh",
        code: "X",
      })
    ).not.toContain("&&")
  })

  it("shows every app at once, in order, where its setup works", () => {
    const ids = (place: Place): AppId[] => appsFor(place).map((app) => app.id)
    expect(ids("cloud")).toEqual(AGENT_APPS.map((app) => app.id))
    expect(ids("cloud").slice(0, 8)).toEqual([
      "claude",
      "chatgpt",
      "claude-code",
      "codex",
      "openclaw",
      "hermes",
      "grok-bot",
      "cursor",
    ])
    expect(ids("cloud").at(-1)).toBe("other")
    for (const place of ["computer", "server"] as const) {
      expect(ids(place)).not.toContain("perplexity")
      expect(ids(place)).not.toContain("gemini")
      expect(ids(place)).toContain("gemini-cli")
    }
  })

  it("says On this computer only when the page is", () => {
    const page = (hostname: string, desktop = false) => ({ hostname, desktop })
    expect(placeOf(LOCAL, page("127.0.0.1"))).toBe("computer")
    expect(placeOf(LOCAL, page("localhost"))).toBe("computer")
    // A password on a local install doesn't make it a server.
    const guarded = {
      ...LOCAL,
      reachable: true,
      authRequired: true,
      mcpTokenRequired: true,
    }
    expect(placeOf(guarded, page("127.0.0.1"))).toBe("computer")
    // A server opened from another machine is a server, whatever it binds to.
    expect(placeOf(LOCAL, page("192.168.1.20"))).toBe("server")
    expect(placeOf(guarded, page("worktable.example.com"))).toBe("server")
    // Desktop opens Worktables on this computer, unless one is public.
    expect(placeOf(LOCAL, page("tauri.localhost", true))).toBe("computer")
    expect(
      placeOf(
        { ...LOCAL, originConfigured: true },
        page("worktable.example.com", true)
      )
    ).toBe("server")
    expect(
      placeOf({ ...LOCAL, mcpAuthMode: "oauth" }, page("app.worktable.cloud"))
    ).toBe("cloud")
  })

  it("knows Cloud's shared address lands in the default Worktable only", () => {
    expect(sharedAddressLandsHere("https://app.worktable.cloud/api/mcp")).toBe(
      true
    )
    expect(
      sharedAddressLandsHere("https://app.worktable.cloud/api/mcp/w/wt_123")
    ).toBe(false)
  })
})
