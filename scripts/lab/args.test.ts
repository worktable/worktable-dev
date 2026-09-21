import { describe, expect, test } from "bun:test"
import { parseArgs, validateOrigin, validatePublicHost } from "./args.ts"

describe("manual lab arguments", () => {
  test("cloud requires an explicit origin and defaults to a two-hour lifetime", () => {
    expect(() => parseArgs(["cloud"])).toThrow("requires --origin")
    expect(
      parseArgs(["cloud", "--origin", "https://staging.example.test"])
    ).toEqual({
      command: "cloud",
      dryRun: false,
      ttl: "2h",
      origin: "https://staging.example.test",
      authMode: "ready",
    })
  })

  test("client target is optional and normalized", () => {
    expect(
      parseArgs([
        "client",
        "--target",
        "http://192.168.1.50:17432",
        "--ttl",
        "30m",
      ])
    ).toEqual({
      command: "client",
      dryRun: false,
      ttl: "30m",
      target: "http://192.168.1.50:17432",
      authMode: "ready",
    })
  })

  test("local defaults to a manual public release install", () => {
    expect(parseArgs(["local"])).toEqual({
      command: "local",
      dryRun: false,
      ttl: "2h",
      source: "release",
      rebuild: false,
      authMode: "ready",
    })
  })

  test("openclaw and auth profiles expose ready and clean preparation explicitly", () => {
    expect(parseArgs(["openclaw"])).toEqual({
      command: "openclaw",
      dryRun: false,
      ttl: "2h",
      source: "release",
      rebuild: false,
      authMode: "ready",
    })
    expect(parseArgs(["openclaw", "--clean"])).toMatchObject({
      command: "openclaw",
      authMode: "clean",
    })
    expect(
      parseArgs(["auth", "--import-host", "--openclaw-source", "/srv/openclaw"])
    ).toEqual({
      command: "auth",
      dryRun: false,
      ttl: "2h",
      importHost: true,
      openclawSource: "/srv/openclaw",
    })
  })

  test("desktop defaults to an isolated checkout launch", () => {
    expect(parseArgs(["desktop"])).toEqual({
      command: "desktop",
      dryRun: false,
      ttl: "2h",
      rebuild: false,
      keep: false,
    })
    expect(
      parseArgs([
        "desktop",
        "--fixture",
        "basic-docs",
        "--rebuild",
        "--keep",
        "--name",
        "onboarding",
      ])
    ).toEqual({
      command: "desktop",
      dryRun: false,
      ttl: "2h",
      name: "onboarding",
      fixture: "basic-docs",
      rebuild: true,
      keep: true,
    })
  })

  test("desktop agent selects one isolated CLI and optional pairing controls", () => {
    expect(parseArgs(["agent", "codex"])).toEqual({
      command: "agent",
      client: "codex",
      replace: false,
    })
    expect(
      parseArgs([
        "agent",
        "claude-code",
        "--name",
        "desktop-review",
        "--code",
        "ABCDE-FGHJK",
        "--replace",
      ])
    ).toEqual({
      command: "agent",
      client: "claude-code",
      name: "desktop-review",
      code: "ABCDE-FGHJK",
      replace: true,
    })
    expect(parseArgs(["agent", "opencode"])).toEqual({
      command: "agent",
      client: "opencode",
      replace: false,
    })
  })

  test("parses checkout, fixture, network, and rebuild options exactly", () => {
    expect(
      parseArgs([
        "local",
        "--source",
        "checkout",
        "--fixture",
        "basic-docs",
        "--host-port",
        "17432",
        "--public-host",
        "worktable-lab.example.test",
        "--rebuild",
      ])
    ).toEqual({
      command: "local",
      dryRun: false,
      ttl: "2h",
      source: "checkout",
      fixture: "basic-docs",
      hostPort: 17432,
      publicHost: "worktable-lab.example.test",
      rebuild: true,
      authMode: "ready",
    })
  })

  test("rejects production Cloud and insecure Cloud origins", () => {
    expect(() =>
      validateOrigin("https://app.worktable.cloud", "cloud")
    ).toThrow("Production")
    expect(() =>
      validateOrigin("https://app.worktable.cloud", "target")
    ).toThrow("Production")
    expect(() =>
      validateOrigin("https://app.worktable.cloud.", "target")
    ).toThrow("Production")
    expect(() =>
      validateOrigin("http://staging.example.test", "cloud")
    ).toThrow("HTTPS")
  })

  test("rejects origins carrying request or credential data", () => {
    for (const value of [
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
      "https://example.com/#fragment",
    ])
      expect(() => validateOrigin(value, "target")).toThrow()
  })

  test("rejects client targets that resolve to the guest itself", () => {
    for (const value of [
      "http://localhost:7432",
      "http://worktable.localhost:7432",
      "http://127.0.0.1:7432",
      "http://127.42.0.8:7432",
      "http://[::1]:7432",
      "http://0.0.0.0:7432",
      "http://[::ffff:127.0.0.1]:7432",
      "http://[::ffff:127.42.0.8]:7432",
      "http://[::ffff:0.0.0.0]:7432",
    ])
      expect(() => validateOrigin(value, "target")).toThrow(
        "reachable from inside the sandbox"
      )
  })

  test("rejects command-specific and malformed flags", () => {
    expect(() =>
      parseArgs(["client", "--origin", "https://example.com"])
    ).toThrow("only valid")
    expect(() => parseArgs(["cloud", "--ttl", "forever"])).toThrow(
      "positive duration"
    )
    expect(() => parseArgs(["clean", "--name", "mine"])).toThrow("accepts only")
    expect(() => parseArgs(["cloud", "--unknown"])).toThrow("Unknown option")
    expect(() => parseArgs(["local", "--source", "branch"])).toThrow(
      "release or checkout"
    )
    expect(() => parseArgs(["local", "--rebuild"])).toThrow(
      "requires --source checkout"
    )
    expect(() => parseArgs(["desktop", "--source", "release"])).toThrow(
      "only valid with lab local"
    )
    expect(() => parseArgs(["local", "--keep"])).toThrow(
      "only valid with lab desktop"
    )
    expect(() => parseArgs(["agent"])).toThrow("requires one client")
    expect(() => parseArgs(["agent", "cursor"])).toThrow("GUI profile")
    expect(() => parseArgs(["agent", "codex", "--ttl", "1h"])).toThrow(
      "not valid"
    )
    expect(() => parseArgs(["desktop", "--code", "ABCDE-FGHJK"])).toThrow(
      "only valid"
    )
    expect(() => parseArgs(["cloud", "--fixture", "empty"])).toThrow(
      "only valid"
    )
    expect(() => parseArgs(["local", "--fixture", "../daily"])).toThrow(
      "fixture"
    )
    expect(() => parseArgs(["local", "--host-port", "0"])).toThrow("1 to 65535")
  })

  test("public hosts are client-safe and cannot inject generated helpers", () => {
    expect(validatePublicHost("192.168.1.50")).toBe("192.168.1.50")
    expect(validatePublicHost("linux-host.tailnet.ts.net")).toBe(
      "linux-host.tailnet.ts.net"
    )
    expect(validatePublicHost("[fd00::1234]")).toBe("[fd00::1234]")
    for (const value of [
      "0.0.0.0",
      "0",
      "127.0.0.1",
      "2130706433",
      "017700000001",
      "localhost",
      "localhost.",
      "foo.localhost.",
      "https://example.com",
      "host/path",
      "host'quote",
      "host$(command)",
      "host`command`",
    ])
      expect(() => validatePublicHost(value)).toThrow()
  })
})
