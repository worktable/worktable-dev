import { afterEach, describe, expect, it } from "bun:test"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  completePairingWithRetry,
  ensureOpenClawInstallationId,
  pairWorktableChannel,
  registerWorktableAgent,
  resumePendingPairingCompletion,
} from "./pairing.js"

const servers: Array<ReturnType<typeof Bun.serve>> = []
const tempDirs: string[] = []
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH
const originalStateDir = process.env.OPENCLAW_STATE_DIR
const originalFetch = globalThis.fetch

async function createDiscoveredPluginFixture(
  parentDir: string
): Promise<string> {
  const pluginDir = join(parentDir, "worktable-plugin")
  await mkdir(join(pluginDir, "dist"), { recursive: true })
  await Promise.all([
    copyFile(
      new URL("../openclaw.plugin.json", import.meta.url),
      join(pluginDir, "openclaw.plugin.json")
    ),
    copyFile(
      new URL("../package.json", import.meta.url),
      join(pluginDir, "package.json")
    ),
    writeFile(join(pluginDir, "dist", "index.js"), "export default {}\n"),
    writeFile(join(pluginDir, "dist", "setup-entry.js"), "export default {}\n"),
  ])
  return pluginDir
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir
  }
  globalThis.fetch = originalFetch
})

describe("OpenClaw Worktable pairing completion", () => {
  it("rejects an empty participant name before starting Agent Registration", async () => {
    let requested = false
    globalThis.fetch = (async () => {
      requested = true
      return Response.json({})
    }) as unknown as typeof fetch

    await expect(
      registerWorktableAgent({
        server: "https://app.worktable.cloud",
        email: "owner@example.com",
        participantName: " \t ",
        readUserCode: () => Promise.resolve("BCDF-GHJK"),
      })
    ).rejects.toThrow("participant name is required")
    expect(requested).toBe(false)
  })

  it("keeps CLI pairing pending until the Gateway proves the channel connection", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "worktable-pairing-"))
    tempDirs.push(configDir)
    const configPath = join(configDir, "openclaw.json")
    const pluginDir = await createDiscoveredPluginFixture(configDir)
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          plugins: {
            allow: ["worktable"],
            load: { paths: [pluginDir] },
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    )
    process.env.OPENCLAW_CONFIG_PATH = configPath
    process.env.OPENCLAW_STATE_DIR = configDir
    const progress: string[] = []
    let completionRequests = 0
    let redeemedInstallationId: string | undefined
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          event?: string
          installationId?: string
        }
        if (request.url.endsWith("/api/pairing/redeem")) {
          redeemedInstallationId = body.installationId
          return Response.json({
            mcpUrl: `${new URL(request.url).origin}/mcp`,
            token: "wtb_pending_bearer",
            scopes: ["threads:read", "threads:write", "threads:participate"],
            workspaceName: "Worktable",
            participantName: "Klaus",
            defaultSpaceId: "connected-agents",
          })
        }
        if (request.url.endsWith("/api/pairing/progress")) {
          progress.push(body.event ?? "")
          return Response.json({ ok: true })
        }
        if (request.url.endsWith("/api/pairing/complete")) {
          completionRequests += 1
          return Response.json({ ok: true })
        }
        return Response.json({ error: "Not found" }, { status: 404 })
      },
    })
    servers.push(server)

    const result = await pairWorktableChannel({
      server: `http://127.0.0.1:${server.port}`,
      pairingCode: "PAIR1-CODE2",
    })

    expect(result).toEqual({
      workspaceName: "Worktable",
      participantName: "Klaus",
    })
    expect(progress).toEqual(["config_written", "verifying"])
    expect(completionRequests).toBe(0)
    expect(redeemedInstallationId).toMatch(/^oci_[A-Za-z0-9_-]{24}$/)
    expect(await ensureOpenClawInstallationId()).toBe(redeemedInstallationId!)
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      channels: {
        worktable: {
          enabled: true,
          server: `http://127.0.0.1:${server.port}`,
          token: "wtb_pending_bearer",
          defaultSpaceId: "connected-agents",
          pendingPairingCode: "PAIR1-CODE2",
        },
      },
    })
  })

  it("retries the idempotent completion request with the retained bearer", async () => {
    const requests: Array<{
      authorization: string | null
      body: unknown
    }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        })
        if (requests.length === 1) {
          return Response.json({ error: "Temporary outage" }, { status: 503 })
        }
        return Response.json({ ok: true })
      },
    })
    servers.push(server)

    await completePairingWithRetry(
      `http://127.0.0.1:${server.port}`,
      "PAIR1-CODE2",
      "wtb_retained_bearer",
      { delayMs: 1 }
    )

    expect(requests).toEqual([
      {
        authorization: "Bearer wtb_retained_bearer",
        body: { code: "PAIR1-CODE2" },
      },
      {
        authorization: "Bearer wtb_retained_bearer",
        body: { code: "PAIR1-CODE2" },
      },
    ])
  })

  it("clears durable pending state only after resumed completion succeeds", async () => {
    let attempts = 0
    let cleared = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        attempts += 1
        if (attempts === 1) {
          return Response.json({ error: "Temporary outage" }, { status: 503 })
        }
        return Response.json({ ok: true })
      },
    })
    servers.push(server)

    await resumePendingPairingCompletion(
      {
        origin: `http://127.0.0.1:${server.port}`,
        pairingCode: "PAIR1-CODE2",
        token: "wtb_retained_bearer",
      },
      {
        delayMs: 1,
        clearPending: async () => {
          cleared += 1
        },
      }
    )

    expect(attempts).toBe(2)
    expect(cleared).toBe(1)
  })

  it("retains pending state when resumed completion is still unavailable", async () => {
    let cleared = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ error: "Still unavailable" }, { status: 503 })
      },
    })
    servers.push(server)

    await expect(
      resumePendingPairingCompletion(
        {
          origin: `http://127.0.0.1:${server.port}`,
          pairingCode: "PAIR1-CODE2",
          token: "wtb_retained_bearer",
        },
        {
          attempts: 2,
          delayMs: 1,
          clearPending: async () => {
            cleared += 1
          },
        }
      )
    ).rejects.toThrow("Still unavailable")
    expect(cleared).toBe(0)
  })
})
