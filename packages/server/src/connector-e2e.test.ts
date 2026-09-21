import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { setAppDirOverride } from "./app-storage.ts"
import { getConnectorBundle } from "./connector-assets.ts"
import { startServer } from "./index.ts"
import { createPairingSession, getPairingSession } from "./pairing-store.ts"
import { listTokens, verifyToken } from "./token-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

let appDir: string
let workspaceDir: string
let agentHome: string
const servers: ReturnType<typeof startServer>[] = []

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-e2e-app-"))
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-e2e-ws-"))
  agentHome = mkdtempSync(join(tmpdir(), "worktable-e2e-agent-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop(true).catch(() => undefined)
  }
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  for (const dir of [appDir, workspaceDir, agentHome]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

function runtimeBinary(): string {
  return spawnSync("sh", ["-c", "command -v node >/dev/null 2>&1"]).status === 0
    ? "node"
    : "bun"
}

async function runConnectorProcess(
  args: string[],
  env: Record<string, string | undefined>
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([runtimeBinary(), ...args], {
    env: { ...globalThis.process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe("connector packaged boundary", () => {
  it("redeems, writes, verifies, and rolls back a replacement through the served artifact", async () => {
    const server = startServer(0, "127.0.0.1")
    servers.push(server)
    const origin = `http://127.0.0.1:${server.port}`
    const bundlePath = join(agentHome, "connect.mjs")
    const bundle = await getConnectorBundle()
    expect(bundle).not.toBeNull()
    await Bun.write(bundlePath, bundle!)
    const codexConfig = join(agentHome, ".codex", "config.toml")

    const initial = await createPairingSession({
      client: "codex",
      scopes: [
        "docs:*",
        "widgets:*",
        "records:*",
        "annotations:*",
        "search:read",
      ],
      mcpUrl: `${origin}/mcp`,
    })
    const connected = await runConnectorProcess(
      [bundlePath, initial.code, "--server", origin, "--client", "codex"],
      { HOME: agentHome, WORKTABLE_CODEX_CONFIG: codexConfig }
    )
    expect(connected).toMatchObject({ exitCode: 0, stderr: "" })
    expect(connected.stdout).toContain("MCP verified")

    const original = Buffer.from(readFileSync(codexConfig))
    expect(original.toString("utf8")).toContain(`url = "${origin}/mcp"`)
    const previousBearer = original
      .toString("utf8")
      .match(/Bearer (wt_[A-Za-z0-9_-]+)/)?.[1]
    expect(previousBearer).toBeDefined()
    expect(await verifyToken(previousBearer!)).not.toBeNull()
    expect((await getPairingSession(initial.session.id))?.status).toBe(
      "verified"
    )

    const replacement = await createPairingSession({
      client: "codex",
      // worktable_discover needs search:read, so verification fails after write.
      scopes: ["docs:*"],
      mcpUrl: `${origin}/mcp`,
    })
    const failed = await runConnectorProcess(
      [
        bundlePath,
        replacement.code,
        "--server",
        origin,
        "--client",
        "codex",
        "--replace",
      ],
      { HOME: agentHome, WORKTABLE_CODEX_CONFIG: codexConfig }
    )
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain("original client configs were restored")
    expect(readFileSync(codexConfig)).toEqual(original)
    expect(await verifyToken(previousBearer!)).not.toBeNull()

    const view = await getPairingSession(replacement.session.id)
    expect(view?.events.map((event) => event.event)).toEqual([
      "redeemed",
      "config_written",
      "verifying",
      "rolled_back",
    ])
    const replacementToken = (await listTokens()).find(
      (token) => token.id === view?.tokenId
    )
    expect(view?.status).toBe("failed")
    expect(replacementToken?.revokedAt).not.toBeNull()
  }, 60_000)

  it("executes the literal served curl-to-shell wrapper and cleans its temporary artifact", async () => {
    const server = startServer(0, "127.0.0.1")
    servers.push(server)
    const origin = `http://127.0.0.1:${server.port}`
    const pairing = await createPairingSession({
      client: "codex",
      scopes: ["docs:*", "search:read"],
      mcpUrl: `${origin}/mcp`,
    })

    const response = await fetch(`${origin}/connect.sh`)
    expect(response.status).toBe(200)
    const scriptPath = join(agentHome, "connect.sh")
    await Bun.write(scriptPath, await response.text())
    const codexConfig = join(agentHome, ".codex", "config.toml")
    const process = Bun.spawn(
      ["sh", scriptPath, pairing.code, "--client", "codex"],
      {
        env: {
          ...globalThis.process.env,
          HOME: agentHome,
          TMPDIR: agentHome,
          WORKTABLE_CODEX_CONFIG: codexConfig,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stdout).toContain("MCP verified")
    expect(readFileSync(codexConfig, "utf8")).toContain(`url = "${origin}/mcp"`)
    expect((await getPairingSession(pairing.session.id))?.status).toBe(
      "verified"
    )
    expect(
      readdirSync(agentHome).filter((name) =>
        name.startsWith("worktable-connect.")
      )
    ).toEqual([])
  }, 60_000)
})
