import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  allocatePort,
  assertPortAvailable,
  buildLocalLabNetwork,
  discoverNetworkOptional,
  formatUrlHost,
  isUsableLanAddress,
  localOrigin,
  needsHostNetwork,
  selectLanAddress,
} from "./network.ts"
import { renderGuide, renderGuideSummary } from "./render-guide.ts"

describe("lab networking", () => {
  test("allows an explicit host when optional discovery is unavailable", () => {
    expect(
      discoverNetworkOptional(() => {
        throw new Error("no IPv4 route")
      })
    ).toBeUndefined()
    expect(
      buildLocalLabNetwork({
        hostPort: 17432,
        publicHost: "acceptance.example.test",
      })
    ).toEqual({
      hostPort: 17432,
      publicHost: "acceptance.example.test",
      publicOrigin: "http://acceptance.example.test:17432",
      lanOrigin: "http://acceptance.example.test:17432",
      loopbackOrigin: "http://127.0.0.1:17432",
    })
  })

  test("prefers the route source and excludes client-invalid addresses", () => {
    const candidates = [
      { name: "docker0", address: "172.17.0.1", internal: false },
      { name: "eth0", address: "192.168.1.50", internal: false },
    ]
    expect(selectLanAddress(candidates, "192.168.1.50")).toBe("192.168.1.50")
    expect(isUsableLanAddress("0.0.0.0")).toBeFalse()
    expect(isUsableLanAddress("127.0.0.1")).toBeFalse()
  })

  test("falls back to a non-container interface", () => {
    expect(
      selectLanAddress([
        { name: "br-abc", address: "172.18.0.1", internal: false },
        { name: "en0", address: "10.0.0.25", internal: false },
      ])
    ).toBe("10.0.0.25")
  })

  test("agent workstations require host LAN discovery for Codex callbacks", () => {
    expect(needsHostNetwork("cloud")).toBeTrue()
    expect(needsHostNetwork("client")).toBeTrue()
    expect(needsHostNetwork("local")).toBeTrue()
    expect(needsHostNetwork("clean")).toBeFalse()
  })

  test("renders a published Codex callback for client workstations", () => {
    const guide = renderGuide({
      kind: "client",
      name: "client-lab",
      ttl: "2h",
      versions: { claude: "1.0.0", codex: "1.0.0" },
      auth: {
        claude: { kind: "guest-login" },
        codex: { kind: "guest-login" },
      },
      network: { lanAddress: "192.168.1.50" },
      callbackHostPort: 17432,
      target: "http://192.168.1.50:7432",
    })
    expect(guide).toContain("Target: http://192.168.1.50:7432")
    expect(guide).toContain(
      "Codex callback: http://192.168.1.50:17432/callback"
    )
  })

  test("keeps cloud and client destinations in attached summaries", () => {
    const auth = {
      claude: { kind: "guest-login" as const },
      codex: { kind: "guest-login" as const },
    }

    expect(
      renderGuideSummary({
        kind: "client",
        name: "client-lab",
        ttl: "2h",
        versions: { claude: "1.0.0", codex: "1.0.0" },
        auth,
        target: "https://customer.example.test",
      })
    ).toContain("Target: https://customer.example.test")
    expect(
      renderGuideSummary({
        kind: "cloud",
        name: "cloud-lab",
        ttl: "2h",
        versions: { claude: "1.0.0", codex: "1.0.0" },
        auth,
        origin: "https://staging.example.test",
      })
    ).toContain("Cloud staging: https://staging.example.test")
  })

  test("describes supported ephemeral auth without exposing a credential", () => {
    const guide = renderGuide({
      kind: "client",
      name: "client-lab",
      ttl: "2h",
      versions: { claude: "1.0.0", codex: "1.0.0" },
      auth: {
        claude: {
          kind: "secret",
          envName: "CLAUDE_CODE_OAUTH_TOKEN",
          allowedHost: "api.anthropic.com",
        },
        codex: {
          kind: "secret",
          envName: "OPENAI_API_KEY",
          allowedHost: "api.openai.com",
        },
      },
    })
    expect(guide).toContain("can use ephemeral CLAUDE_CODE_OAUTH_TOKEN")
    expect(guide).toContain("can use ephemeral OPENAI_API_KEY")
  })

  test("requires network information when rendering a Cloud callback", () => {
    expect(() =>
      renderGuide({
        kind: "cloud",
        name: "cloud-lab",
        ttl: "2h",
        versions: { claude: "1.0.0", codex: "1.0.0" },
        auth: {
          claude: { kind: "guest-login" },
          codex: { kind: "guest-login" },
        },
        origin: "https://staging.example.test",
        callbackHostPort: 5555,
      })
    ).toThrow("requires host network")
  })

  test("allocates distinct usable ports", async () => {
    const first = await allocatePort("127.0.0.1")
    const second = await allocatePort("127.0.0.1")
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(0)
  })

  test("renders only client-facing local origins", () => {
    expect(localOrigin("192.168.1.50", 17432)).toBe("http://192.168.1.50:17432")
    expect(localOrigin("fd00::1234", 17432)).toBe("http://[fd00::1234]:17432")
    expect(() => formatUrlHost("0.0.0.0")).toThrow("bind address")
  })

  test("accepts an available requested port", async () => {
    const port = await allocatePort("127.0.0.1")
    await expect(
      assertPortAvailable(port, "127.0.0.1")
    ).resolves.toBeUndefined()
  })

  test("rejects an occupied requested port", async () => {
    const server = createServer()
    await new Promise<void>((resolve) =>
      server.listen({ host: "127.0.0.1", port: 0 }, resolve)
    )
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("no port")
    try {
      await expect(
        assertPortAvailable(address.port, "127.0.0.1")
      ).rejects.toThrow("already in use")
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  test("local guide never presents the wildcard bind as a client URL", () => {
    const options = {
      kind: "local",
      name: "local-lab",
      ttl: "2h",
      versions: { claude: "1.0.0", codex: "1.0.0" },
      auth: {
        claude: { kind: "guest-login" },
        codex: { kind: "guest-login" },
      },
      local: {
        source: "release",
        fixture: "empty",
        hostPort: 17432,
        publicHost: "192.168.1.50",
        publicOrigin: "http://192.168.1.50:17432",
        lanOrigin: "http://192.168.1.50:17432",
        loopbackOrigin: "http://127.0.0.1:17432",
      },
    } as const
    const guide = renderGuide(options)
    expect(guide).toContain("## Commands in order")
    expect(guide).toContain("### 1. Check lab readiness")
    expect(guide).toContain("```sh\n~/bin/lab-status\n```")
    expect(guide).toContain("Mac / LAN: http://192.168.1.50:17432")
    expect(guide).toContain(
      "the Mac / LAN HTTP endpoint is cleartext. Use it only on a trusted network"
    )
    expect(guide).toContain("Both clients are installed")
    expect(guide).not.toContain("http://0.0.0.0")
    const summary = renderGuideSummary(options)
    expect(summary).toStartWith(
      "Worktable local lab\n\nSandbox: local-lab\nMac URL: http://192.168.1.50:17432"
    )
    expect(summary).toContain(
      "the Mac / LAN HTTP endpoint is cleartext. Use it only on a trusted network"
    )
    expect(summary).toEndWith("Full guide: ~/WORKTABLE_LAB.txt")
  })

  test("OpenClaw guide leads with the real channel acceptance path", () => {
    const guide = renderGuide({
      kind: "openclaw",
      name: "openclaw-lab",
      ttl: "2h",
      versions: {
        claude: "1.0.0",
        codex: "1.0.0",
        openclaw: "2026.7.1-2",
      },
      auth: {
        claude: { kind: "guest-login" },
        codex: { kind: "guest-login" },
      },
      authMode: "ready",
      local: {
        source: "checkout",
        hostPort: 17432,
        publicHost: "192.168.1.50",
        publicOrigin: "http://192.168.1.50:17432",
        lanOrigin: "http://192.168.1.50:17432",
        loopbackOrigin: "http://127.0.0.1:17432",
      },
    })

    expect(guide).toContain(
      "OpenClaw reuses the isolated lab Codex subscription through the supported Codex harness"
    )
    expect(guide).toContain("openclaw gateway run")
    expect(guide).toContain(
      "openclaw plugins inspect worktable --runtime --json"
    )
    expect(guide).toContain("root has a separate empty OpenClaw state")
    expect(guide).toContain(
      "msb exec --tty --user tester openclaw-lab -- bash -l"
    )
    expect(guide.indexOf("~/bin/lab-status")).toBeLessThan(
      guide.indexOf("## Flow and explanations")
    )
    expect(guide).toContain("Prove thread continuity")
    expect(guide).not.toContain(
      "Connect either Claude Code or Codex during setup"
    )
  })
})
