import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js"
import {
  McpBridgeError,
  formatMcpBridgeError,
} from "@worktable/mcp-connect/bridge"
import { setAppDirOverride } from "./app-storage.ts"
import { startServer } from "./index.ts"
import { listDocVersions } from "./store.ts"
import { createToken } from "./token-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

const repoRoot = resolve(import.meta.dir, "../../..")
const connectRoot = join(repoRoot, "packages", "mcp-connect")
const mcpbPath = join(connectRoot, "dist", "worktable-claude-desktop.mcpb")
const agplBuild =
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).license ===
  "AGPL-3.0-only"
const capturedSource = [
  "WORKTABLE_PUBLIC_SOURCE_REPOSITORY",
  "WORKTABLE_PUBLIC_SOURCE_COMMIT",
  "WORKTABLE_PUBLIC_SOURCE_TAG",
].some((key) => process.env[key] !== undefined)

let unpackedDir: string
let unpackedBridge: string
let appDir: string
let workspaceDir: string
let worktableServer: ReturnType<typeof startServer> | null = null
const savedEnv = new Map<string, string | undefined>()
const ISOLATED_ENV_KEYS = [
  "HOST",
  "WORKTABLE_MCP_TOKEN",
  "WORKTABLE_PUBLIC_URL",
  "WORKTABLE_REQUIRE_AUTH",
  "WORKTABLE_AUTH_SERVER_URL",
] as const

function inheritedEnv(
  overrides: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...overrides }
}

function buildArtifacts(): void {
  const result = Bun.spawnSync(["bun", "run", "build:mcpb"], {
    cwd: connectRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!result.success) {
    throw new Error(
      `${result.stdout.toString()}\n${result.stderr.toString()}`.trim()
    )
  }
}

beforeAll(() => {
  buildArtifacts()
  unpackedDir = mkdtempSync(join(tmpdir(), "worktable-mcpb-unpacked-"))
  const unpack = Bun.spawnSync(["unzip", "-q", mcpbPath, "-d", unpackedDir])
  if (!unpack.success) throw new Error("Could not unpack the test MCPB")
  unpackedBridge = join(unpackedDir, "server", "index.js")
})

afterAll(() => {
  if (unpackedDir && existsSync(unpackedDir)) {
    rmSync(unpackedDir, { recursive: true, force: true })
  }
})

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-bridge-app-"))
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-bridge-ws-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  for (const key of ISOLATED_ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(async () => {
  if (worktableServer) {
    await worktableServer.stop(true).catch(() => undefined)
    worktableServer = null
  }
  for (const key of ISOLATED_ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  for (const dir of [appDir, workspaceDir]) {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

interface BridgeConnection {
  client: Client
  transport: StdioClientTransport
  stderr: () => string
}

async function connectBridge(
  endpoint: string,
  options: { token?: string; entry?: string; connectTimeoutMs?: number } = {}
): Promise<BridgeConnection> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [options.entry ?? unpackedBridge],
    env: inheritedEnv({
      WORKTABLE_MCP_URL: endpoint,
      WORKTABLE_MCP_TOKEN: options.token ?? "",
      WORKTABLE_BRIDGE_CLIENT_NAME: "worktable-bridge-test",
      WORKTABLE_BRIDGE_CLIENT_VERSION: "0.0.1-test",
    }),
    stderr: "pipe",
  })
  let stderr = ""
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const client = new Client(
    { name: "worktable-bridge-test-client", version: "0.0.1-test" },
    { capabilities: {} }
  )
  try {
    await client.connect(
      transport,
      options.connectTimeoutMs === undefined
        ? undefined
        : { timeout: options.connectTimeoutMs }
    )
  } catch (error) {
    await transport.close().catch(() => undefined)
    throw error
  }
  return { client, transport, stderr: () => stderr }
}

function parseToolJson(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || !("content" in result)) {
    throw new Error("Expected a completed tool result")
  }
  const content = (result as { content: unknown }).content
  if (!Array.isArray(content)) throw new Error("Expected tool content")
  const first = content[0]
  if (
    !first ||
    typeof first !== "object" ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("Expected text result")
  }
  return JSON.parse(first.text) as Record<string, unknown>
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function withStageTimeout<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    // test-policy: external-readiness-backoff
    await Bun.sleep(20)
  }
  throw new Error(
    `MCP bridge child ${pid} was still alive after ${timeoutMs}ms`
  )
}

function startWorktable(): string {
  worktableServer = startServer(0, "127.0.0.1")
  return `http://127.0.0.1:${worktableServer.port}/mcp`
}

async function createCustomMcpServer(
  options: {
    resources?: boolean
    onCancelled?: () => void
    onSlowStarted?: () => void
  } = {}
): Promise<ReturnType<typeof Bun.serve>> {
  // Stateless HTTP creates a fresh MCP server per POST, so a cancellation
  // notification cannot abort the handler owned by an earlier POST. Correlate
  // it in the fixture so the simulated slow request does not leak at teardown.
  const pendingSlowRequests = new Set<() => void>()
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method === "POST") {
        const message = (await request
          .clone()
          .json()
          .catch(() => null)) as {
          method?: string
        } | null
        if (message?.method === "notifications/cancelled") {
          options.onCancelled?.()
          for (const complete of [...pendingSlowRequests]) complete()
        }
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      const server = new Server(
        { name: "bridge-fixture", version: "1.0.0" },
        {
          capabilities: {
            tools: {},
            ...(options.resources ? { resources: {} } : {}),
          },
          instructions: "fixture instructions",
        }
      )
      server.setRequestHandler(ListToolsRequestSchema, (message) => {
        const secondPage = message.params?.cursor === "page-2"
        return {
          tools: [
            {
              name: secondPage ? "second" : "first",
              description: secondPage ? "Second page" : "First page",
              inputSchema: { type: "object" as const },
            },
          ],
          ...(secondPage ? {} : { nextCursor: "page-2" }),
        }
      })
      server.setRequestHandler(
        CallToolRequestSchema,
        async (message, extra) => {
          if (message.params.name === "slow") {
            options.onSlowStarted?.()
            return await new Promise<CallToolResult>((resolve) => {
              const complete = () => {
                pendingSlowRequests.delete(complete)
                extra.signal.removeEventListener("abort", complete)
                resolve({
                  isError: true,
                  content: [{ type: "text", text: "cancelled upstream" }],
                })
              }
              pendingSlowRequests.add(complete)
              if (extra.signal.aborted) complete()
              else
                extra.signal.addEventListener("abort", complete, { once: true })
            })
          }
          if (message.params.name === "failure") {
            return {
              isError: true,
              structuredContent: { code: "EXPECTED_TOOL_ERROR" },
              content: [{ type: "text", text: "expected failure" }],
            }
          }
          return {
            structuredContent: { echoed: message.params.arguments ?? null },
            content: [{ type: "text", text: "structured result" }],
          }
        }
      )
      await server.connect(transport)
      return transport.handleRequest(request)
    },
  })
  return http
}

describe("Claude Desktop MCPB artifact", () => {
  it("is a validated, self-contained macOS extension with no build-path residue", () => {
    expect(existsSync(join(unpackedDir, "manifest.json"))).toBe(true)
    expect(existsSync(join(unpackedDir, "icon.png"))).toBe(true)
    expect(existsSync(unpackedBridge)).toBe(true)
    expect(
      readdirSync(unpackedDir, { recursive: true })
        .map(String)
        .filter((path) => !path.endsWith("server"))
        .sort()
    ).toEqual([
      ...(agplBuild
        ? ["LICENSE", "NOTICE", ...(capturedSource ? ["SOURCE.json"] : [])]
        : []),
      "THIRD_PARTY_NOTICES.md",
      "icon.png",
      "manifest.json",
      "server/index.js",
    ])
    // The distributable ZIP must retain the notice bytes produced by the
    // dependency/version/hash gate, without dropping or rewriting attribution.
    expect(readFileSync(join(unpackedDir, "THIRD_PARTY_NOTICES.md"))).toEqual(
      readFileSync(join(connectRoot, "dist/mcpb-stage/THIRD_PARTY_NOTICES.md"))
    )

    const manifest = JSON.parse(
      readFileSync(join(unpackedDir, "manifest.json"), "utf8")
    ) as {
      manifest_version: string
      compatibility: { platforms: string[] }
      server: { type: string; entry_point: string }
      tools_generated: boolean
      user_config: {
        endpoint: { required: boolean }
        access_token: { required: boolean; sensitive: boolean }
      }
    }
    expect(manifest.manifest_version).toBe("0.3")
    expect(manifest.compatibility.platforms).toEqual(["darwin"])
    expect(manifest.server.type).toBe("node")
    expect(manifest.server.entry_point).toBe("server/index.js")
    expect(manifest.tools_generated).toBe(true)
    expect(manifest.user_config.endpoint.required).toBe(true)
    expect(manifest.user_config.access_token).toMatchObject({
      required: false,
      sensitive: true,
    })

    const bundle = readFileSync(unpackedBridge, "utf8")
    expect(bundle).not.toContain(repoRoot)
    expect(bundle).not.toContain("sourceMappingURL")
    expect(bundle).not.toContain("Bearer wt_")
    expect(bundle).not.toContain("node_modules/")
  })
})

describe("HTTP-to-stdio MCP bridge", () => {
  it("runs the exact unpacked child with tool parity and authenticated write attribution", async () => {
    const endpoint = startWorktable()
    const { token, metadata } = await createToken({
      scopes: [
        "docs:*",
        "widgets:*",
        "records:*",
        "annotations:*",
        "search:read",
      ],
      agent: "claude-desktop",
    })
    const download = await fetch(
      endpoint.replace("/mcp", "/integrations/claude-desktop.mcpb")
    )
    expect(download.status).toBe(200)
    expect(download.headers.get("cache-control")).toBe("no-store")
    const servedArtifactDir = mkdtempSync(
      join(tmpdir(), "worktable-served-mcpb-")
    )
    const servedArchive = join(servedArtifactDir, "download.mcpb")
    const servedUnpackedDir = join(servedArtifactDir, "unpacked")
    const servedBridge = join(servedUnpackedDir, "server", "index.js")
    const direct = new Client(
      { name: "direct-test", version: "0.0.1-test" },
      { capabilities: {} }
    )
    let bridged: Awaited<ReturnType<typeof connectBridge>> | undefined
    try {
      writeFileSync(servedArchive, Buffer.from(await download.arrayBuffer()))
      mkdirSync(servedUnpackedDir)
      const unpack = Bun.spawnSync([
        "unzip",
        "-q",
        servedArchive,
        "-d",
        servedUnpackedDir,
      ])
      if (!unpack.success) {
        throw new Error(
          `Could not unpack the served MCPB: ${unpack.stderr.toString()}`
        )
      }
      expect(
        readdirSync(servedUnpackedDir, { recursive: true }).map(String).sort()
      ).toEqual(
        readdirSync(unpackedDir, { recursive: true }).map(String).sort()
      )
      for (const path of [
        "THIRD_PARTY_NOTICES.md",
        "manifest.json",
        "icon.png",
        "server/index.js",
      ]) {
        expect(readFileSync(join(servedUnpackedDir, path))).toEqual(
          readFileSync(join(unpackedDir, path))
        )
      }
      await direct.connect(
        new StreamableHTTPClientTransport(new URL(endpoint), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        })
      )
      bridged = await connectBridge(endpoint, {
        entry: servedBridge,
        token,
      })
      expect(bridged.client.getInstructions()).toBe(direct.getInstructions())
      expect((await bridged.client.listTools()).tools).toEqual(
        (await direct.listTools()).tools
      )
      const state = await bridged.client.callTool({
        name: "worktable_discover",
        arguments: { request: { action: "state" } },
      })
      expect(state.isError).not.toBe(true)
      expect(parseToolJson(state)).toHaveProperty("spaces")
      const created = parseToolJson(
        await bridged.client.callTool({
          name: "worktable_spaces",
          arguments: {
            request: { action: "create", name: "Bridge Acceptance" },
          },
        })
      )
      const spaceId = String(created.spaceId)
      const write = await bridged.client.callTool({
        name: "worktable_docs_write",
        arguments: {
          request: {
            action: "write",
            spaceId,
            docPath: "bridge-proof",
            content: "# Bridge proof\n\nWritten through the MCPB bridge.",
          },
        },
      })
      expect(write.isError).not.toBe(true)

      const read = parseToolJson(
        await bridged.client.callTool({
          name: "worktable_docs_read",
          arguments: {
            request: { action: "read", spaceId, docPath: "bridge-proof" },
          },
        })
      )
      expect(read.content).toContain("Written through the MCPB bridge")
      const versions = await listDocVersions(spaceId, "bridge-proof")
      expect(versions[0]?.createdBy).toBe(`local-token:${metadata.id}`)
      expect(bridged.stderr()).toBe("")
    } finally {
      await bridged?.client.close().catch(() => undefined)
      await direct.close().catch(() => undefined)
      rmSync(servedArtifactDir, { recursive: true, force: true })
    }
  })

  it("forwards pagination, structured tool errors, and cancellation", async () => {
    const cancelled = deferredSignal()
    const slowStarted = deferredSignal()
    const fixture = await createCustomMcpServer({
      onCancelled: cancelled.resolve,
      onSlowStarted: slowStarted.resolve,
    })
    let bridge: Awaited<ReturnType<typeof connectBridge>> | undefined
    try {
      bridge = await connectBridge(`http://127.0.0.1:${fixture.port}/mcp`, {
        connectTimeoutMs: 5_000,
      })
      const first = await bridge.client.listTools(undefined, {
        timeout: 5_000,
      })
      expect(first.tools.map((tool) => tool.name)).toEqual(["first"])
      expect(first.nextCursor).toBe("page-2")
      const second = await bridge.client.listTools(
        { cursor: first.nextCursor },
        { timeout: 5_000 }
      )
      expect(second.tools.map((tool) => tool.name)).toEqual(["second"])

      const failure = await bridge.client.callTool(
        { name: "failure" },
        undefined,
        { timeout: 5_000 }
      )
      expect(failure.isError).toBe(true)
      expect(failure.structuredContent).toEqual({
        code: "EXPECTED_TOOL_ERROR",
      })

      const controller = new AbortController()
      const slow = bridge.client.callTool({ name: "slow" }, undefined, {
        signal: controller.signal,
        timeout: 2_000,
      })
      await withStageTimeout("slow tool start", slowStarted.promise, 500)
      controller.abort()
      const cancellationError = await slow.then(
        () => new Error("cancelled tool unexpectedly resolved"),
        (error: unknown) => error
      )
      expect(cancellationError).toBeInstanceOf(McpError)
      expect(cancellationError).toMatchObject({
        code: ErrorCode.RequestTimeout,
      })
      expect((cancellationError as Error).message).toContain("AbortError")
      await withStageTimeout(
        "upstream cancellation delivery",
        cancelled.promise,
        200
      )
    } finally {
      try {
        if (bridge) {
          await withStageTimeout(
            "bridge client close",
            bridge.client.close(),
            5_000
          )
        }
      } finally {
        await withStageTimeout(
          `bridge fixture stop (${fixture.pendingRequests} pending requests)`,
          fixture.stop(true),
          15_000
        )
      }
    }
  }, 30_000)

  for (const phase of ["starting", "connected"] as const) {
    it(`closes the bundled child on stdin EOF while ${phase}`, async () => {
      const startupSeen = deferredSignal()
      const cancelled = deferredSignal()
      let releaseRequest: (() => void) | undefined
      const pendingServer =
        phase === "starting"
          ? Bun.serve({
              port: 0,
              hostname: "127.0.0.1",
              fetch(request) {
                request.signal.addEventListener("abort", cancelled.resolve, {
                  once: true,
                })
                startupSeen.resolve()
                return new Promise<Response>((resolve) => {
                  releaseRequest = () =>
                    resolve(new Response(null, { status: 503 }))
                })
              },
            })
          : undefined
      const endpoint = pendingServer
        ? `http://127.0.0.1:${pendingServer.port}/mcp`
        : startWorktable()
      // SDK transport.close() sends signals as a fallback. Exercise plain EOF
      // instead, including an initialization message buffered during startup.
      const child = Bun.spawn(["node", unpackedBridge], {
        env: inheritedEnv({ WORKTABLE_MCP_URL: endpoint }),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              // Exceed both Node stream high-water marks. Backpressure must
              // not hide EOF while the upstream request is still pending.
              clientInfo: {
                name: "eof-proof-" + "x".repeat(256 * 1024),
                version: "1.0.0",
              },
            },
          }) + "\n"
        )
        if (phase === "starting") {
          await withStageTimeout(
            "upstream startup request",
            startupSeen.promise,
            2_000
          )
        } else {
          const reader = child.stdout.getReader()
          let response = ""
          try {
            while (!response.includes("\n")) {
              const chunk = await withStageTimeout(
                "bridge initialization",
                reader.read(),
                2_000
              )
              if (chunk.done)
                throw new Error("Bridge exited before initialization")
              response += new TextDecoder().decode(chunk.value)
            }
          } finally {
            reader.releaseLock()
          }
          expect(JSON.parse(response.split("\n")[0]!)).toMatchObject({
            id: 1,
            result: { serverInfo: { name: expect.any(String) } },
          })
        }
        child.stdin.end()
        expect(
          await withStageTimeout("bridge stdin EOF", child.exited, 2_000)
        ).toBe(0)
        expect(await new Response(child.stderr).text()).toBe("")
        await waitForProcessExit(child.pid)
        expect(() => process.kill(child.pid, 0)).toThrow()
        if (phase === "starting") {
          await withStageTimeout(
            "upstream startup cancellation",
            cancelled.promise,
            2_000
          )
        } else {
          const secret = "wt_secret_that_must_never_escape"
          expect(formatMcpBridgeError(new Error(secret))).not.toContain(secret)
          expect(
            formatMcpBridgeError(
              new McpBridgeError("UNAUTHORIZED", "credential rejected")
            )
          ).toBe("worktable-mcp-bridge: credential rejected")
        }
      } finally {
        if (child.exitCode === null) child.kill()
        await child.exited
        releaseRequest?.()
        await pendingServer?.stop(true)
      }
    })
  }
})
