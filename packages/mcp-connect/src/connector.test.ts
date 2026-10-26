import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  runConnector,
  type ConnectorDependencies,
  type ConnectorIo,
} from "./connector.ts"

interface FakeHostOptions {
  completeFailures?: number
  redeemStatus?: number
  verification?: { ok: boolean; toolCount?: number; message?: string }
  progressFailures?: number
}

let root: string
let configPath: string
let previousConfigEnv: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "worktable-connector-model-"))
  configPath = join(root, "codex", "config.toml")
  mkdirSync(join(root, "codex"), { recursive: true })
  previousConfigEnv = process.env["WORKTABLE_CODEX_CONFIG"]
  process.env["WORKTABLE_CODEX_CONFIG"] = configPath
})

afterEach(() => {
  if (previousConfigEnv === undefined) {
    delete process.env["WORKTABLE_CODEX_CONFIG"]
  } else {
    process.env["WORKTABLE_CODEX_CONFIG"] = previousConfigEnv
  }
  rmSync(root, { recursive: true, force: true })
})

function fakeHost(options: FakeHostOptions = {}): {
  dependencies: Partial<ConnectorDependencies>
  requests: { path: string; body: Record<string, unknown> }[]
  delays: number[]
} {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const delays: number[] = []
  let completeAttempts = 0
  let progressAttempts = 0
  return {
    requests,
    delays,
    dependencies: {
      hostname: () => "test-agent",
      detectClient: (id) => id === "codex",
      sleep: async (delayMs) => {
        delays.push(delayMs)
      },
      verifyMcpEndpoint: async () =>
        options.verification ?? { ok: true, toolCount: 17 },
      postJson: async (url, body) => {
        const path = new URL(url).pathname
        requests.push({ path, body })
        if (path === "/api/pairing/target") {
          return { status: 200, json: { client: "codex" } }
        }
        if (path === "/api/pairing/redeem") {
          const status = options.redeemStatus ?? 200
          return status === 200
            ? {
                status,
                json: {
                  mcpUrl: "https://worktable.example/mcp",
                  token: "wt_replacement",
                  client: "codex",
                  scopes: ["docs:*"],
                  workspaceName: "Test workspace",
                },
              }
            : { status, json: { error: "Unknown or invalid code" } }
        }
        if (path === "/api/pairing/complete") {
          completeAttempts += 1
          return completeAttempts <= (options.completeFailures ?? 0)
            ? { status: 503, json: {} }
            : { status: 200, json: {} }
        }
        if (path === "/api/pairing/progress") {
          progressAttempts += 1
          return progressAttempts <= (options.progressFailures ?? 0)
            ? { status: 503, json: {} }
            : { status: 200, json: {} }
        }
        throw new Error(`Unexpected fake connector request: ${path}`)
      },
    },
  }
}

function captureIo(): {
  io: ConnectorIo
  stdout: string[]
  stderr: string[]
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      log: (line) => stdout.push(line),
      error: (line) => stderr.push(line),
    },
  }
}

describe("connector transaction model", () => {
  it("writes a tokenless Cloud config, signs the client in, and runs again as already set up", async () => {
    const host = fakeHost()
    const signIns: string[] = []
    const cloud = [
      "--oauth",
      "--server",
      "https://app.worktable.cloud",
      "--client",
      "codex",
    ]
    const first = captureIo()
    expect(
      await runConnector(cloud, first.io, {
        ...host.dependencies,
        signInClient: async (id, onStart) => {
          onStart?.()
          signIns.push(id)
          return "signed-in"
        },
        connectClientOnce: async () => true,
      })
    ).toBe(0)
    const config = readFileSync(configPath, "utf8")
    expect(config).toContain('url = "https://app.worktable.cloud/api/mcp"')
    expect(config).not.toContain("Authorization")
    expect(host.requests).toEqual([])
    expect(signIns).toEqual(["codex"])
    expect(first.stdout.join("\n")).toContain(
      "ChatGPT / Codex is connected to Worktable."
    )

    // Run again, as someone does when they aren't sure it worked. Without a
    // terminal to sign in on, it says how to finish.
    const again = captureIo()
    expect(
      await runConnector(cloud, again.io, {
        ...host.dependencies,
        signInClient: async () => "no-terminal",
      })
    ).toBe(0)
    expect(readFileSync(configPath, "utf8")).toBe(config)
    expect(again.stdout.join("\n")).toContain("already set up")
    expect(again.stdout.join("\n")).toContain("To finish, sign in:")
    expect(again.stderr).toEqual([])

    // With several agents, sign-ins run one at a time. Ctrl+C in one stops
    // the rest, and each still gets the step that finishes it.
    process.env["WORKTABLE_OPENCODE_CONFIG"] = join(root, "opencode.json")
    const attempted: string[] = []
    const stopped = captureIo()
    try {
      expect(
        await runConnector(cloud.slice(0, 3), stopped.io, {
          ...host.dependencies,
          detectClient: (id) => id === "codex" || id === "opencode",
          signInClient: async (id) => {
            attempted.push(id)
            return "cancelled"
          },
        })
      ).toBe(1)
    } finally {
      delete process.env["WORKTABLE_OPENCODE_CONFIG"]
    }
    expect(attempted).toEqual(["codex"])
    const steps = stopped.stdout.join("\n")
    expect(steps).toContain("Signing in didn't finish.")
    expect(steps).toContain("ChatGPT / Codex: ")
    expect(steps).toContain("opencode: ")
  })

  it("asks before pointing a client at a different Worktable", async () => {
    writeFileSync(
      configPath,
      '[mcp_servers.worktable]\nurl = "https://other.example/mcp"\n'
    )
    const output = captureIo()
    expect(
      await runConnector(
        [
          "--oauth",
          "--server",
          "https://app.worktable.cloud",
          "--client",
          "codex",
        ],
        output.io,
        { ...fakeHost().dependencies, signInClient: async () => "no-terminal" }
      )
    ).toBe(1)
    expect(output.stderr.join("\n")).toContain(
      "already connects to Worktable at https://other.example/mcp"
    )
    expect(readFileSync(configPath, "utf8")).toContain("other.example")

    // The same address set up differently, here turned off, isn't done:
    // it asks too, and --replace writes the entry the command makes.
    writeFileSync(
      configPath,
      '[mcp_servers.worktable]\nurl = "https://app.worktable.cloud/api/mcp"\nenabled = false\n'
    )
    const cloud = [
      "--oauth",
      "--server",
      "https://app.worktable.cloud",
      "--client",
      "codex",
    ]
    const dependencies = {
      ...fakeHost().dependencies,
      signInClient: async () => "no-terminal" as const,
    }
    expect(await runConnector(cloud, captureIo().io, dependencies)).toBe(1)
    expect(
      await runConnector([...cloud, "--replace"], captureIo().io, dependencies)
    ).toBe(0)
    expect(readFileSync(configPath, "utf8")).not.toContain("enabled")
  })

  it("preserves a selected Cloud Worktable and rejects a resource on another server before touching configs", async () => {
    const host = fakeHost()
    const output = captureIo()
    expect(
      await runConnector(
        [
          "--oauth",
          "--server",
          "https://app.worktable.cloud",
          "--mcp-url",
          "https://app.worktable.cloud/api/mcp/w/team_one",
          "--client",
          "codex",
        ],
        output.io,
        { ...host.dependencies, signInClient: async () => "no-terminal" }
      )
    ).toBe(0)
    const config = readFileSync(configPath, "utf8")
    expect(config).toContain(
      'url = "https://app.worktable.cloud/api/mcp/w/team_one"'
    )
    expect(
      await runConnector(
        [
          "--oauth",
          "--server",
          "https://app.worktable.cloud",
          "--mcp-url",
          "https://other.example/api/mcp/w/team_one",
          "--client",
          "codex",
        ],
        output.io,
        host.dependencies
      )
    ).toBe(2)
    expect(readFileSync(configPath, "utf8")).toBe(config)
  })

  it("writes a real client config and retries only idempotent completion", async () => {
    writeFileSync(configPath, 'model = "gpt-test"\n')
    const host = fakeHost({ completeFailures: 1 })
    const output = captureIo()

    expect(
      await runConnector(
        ["PAIR-CODE", "--server", "https://worktable.example"],
        output.io,
        host.dependencies
      )
    ).toBe(0)
    const config = readFileSync(configPath, "utf8")
    expect(config).toContain('model = "gpt-test"')
    expect(config).toContain('url = "https://worktable.example/mcp"')
    expect(config).toContain("Bearer wt_replacement")
    expect(
      host.requests.filter((request) => request.path.endsWith("/complete"))
    ).toHaveLength(2)
    expect(
      host.requests.find((request) => request.path.endsWith("/redeem"))?.body
    ).toMatchObject({ hostname: "test-agent" })
    expect(host.delays).toEqual([250])
    expect(output.stderr).toEqual([])
  })

  it("preflights conflicts before redeeming or changing bytes", async () => {
    const original =
      '[mcp_servers.worktable]\nurl = "https://old.example/mcp"\n'
    writeFileSync(configPath, original)
    const host = fakeHost()
    const output = captureIo()

    expect(
      await runConnector(
        ["PAIR-CODE", "--server", "https://worktable.example"],
        output.io,
        host.dependencies
      )
    ).toBe(1)
    expect(readFileSync(configPath, "utf8")).toBe(original)
    expect(
      host.requests.some((request) => request.path.endsWith("/redeem"))
    ).toBe(false)
    expect(output.stderr.join("\n")).toContain("--replace")
  })

  it("restores exact client bytes and confirms revocation after verification fails", async () => {
    const original = 'model = "gpt-test"\n'
    writeFileSync(configPath, original)
    const host = fakeHost({
      verification: { ok: false, message: "scope refused" },
      progressFailures: 1,
    })
    const output = captureIo()

    expect(
      await runConnector(
        ["PAIR-CODE", "--server", "https://worktable.example"],
        output.io,
        host.dependencies
      )
    ).toBe(1)
    expect(readFileSync(configPath, "utf8")).toBe(original)
    expect(
      host.requests.some(
        (request) =>
          request.path.endsWith("/progress") &&
          request.body["event"] === "rolled_back"
      )
    ).toBe(true)
    expect(output.stderr.join("\n")).toContain(
      "original client configs were restored"
    )
  })

  it("does not create a config when redemption fails", async () => {
    const host = fakeHost({ redeemStatus: 404 })
    const output = captureIo()

    expect(
      await runConnector(
        [
          "BAD-CODE",
          "--server",
          "https://worktable.example",
          "--client",
          "codex",
        ],
        output.io,
        host.dependencies
      )
    ).toBe(1)
    expect(existsSync(configPath)).toBe(false)
    expect(output.stderr).toEqual(["Unknown or invalid code"])
  })
})
