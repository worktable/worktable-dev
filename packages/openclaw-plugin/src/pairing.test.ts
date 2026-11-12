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
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot"
import {
  loadAgentCredential,
  promotePendingAgentAuth,
  saveAgentCredential,
} from "./agent-auth-config.js"
import { WorktableAgentCredentialProvider } from "./agent-auth.js"
import { savedWorktableAccess } from "./channel.js"
import type { WorktableAgentAuth } from "./types.js"
import {
  completePairingWithRetry,
  ensureOpenClawInstallationId,
  knownWorktableAddress,
  pairWorktableChannel,
  requestWorktablePairing,
  resumePendingPairingCompletion,
} from "./pairing.js"

const servers: Array<ReturnType<typeof Bun.serve>> = []
const tempDirs: string[] = []
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH
const originalStateDir = process.env.OPENCLAW_STATE_DIR
const originalFetch = globalThis.fetch
const OPENCLAW_RUNTIME_TIMEOUT_MS = 15_000

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
  clearRuntimeConfigSnapshot()
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

describe("OpenClaw asking Worktable to connect", () => {
  async function serveRequests(
    polls: Array<Record<string, unknown> | ((origin: string) => Record<string, unknown>)>
  ) {
    const stateDir = await mkdtemp(join(tmpdir(), "worktable-request-"))
    tempDirs.push(stateDir)
    process.env.OPENCLAW_STATE_DIR = stateDir
    const seen: Array<{ path: string; body: Record<string, unknown> }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        const body = (await request.json()) as Record<string, unknown>
        seen.push({ path, body })
        if (path === "/api/pairing/requests") {
          return Response.json(
            {
              code: "BCDF-GHJK",
              pollToken: "poll-secret",
              approvalUrl: `${new URL(request.url).origin}/connect?code=BCDF-GHJK`,
              interval: 1,
            },
            { status: 201 }
          )
        }
        if (path === "/api/pairing/requests/poll") {
          const next = polls.shift() ?? { status: "expired" }
          // An HTTP failure instead of an answer.
          if (typeof next === "object" && typeof next.httpStatus === "number") {
            return Response.json({ error: "unavailable" }, { status: next.httpStatus })
          }
          return Response.json(
            typeof next === "function" ? next(new URL(request.url).origin) : next
          )
        }
        // Stop at redeem: the request flow's job ends with the right code.
        return Response.json({ error: "stop" }, { status: 400 })
      },
    })
    servers.push(server)
    return { server: `http://127.0.0.1:${server.port}`, seen }
  }

  it("waits for approval, then pairs with the code Worktable approved", async () => {
    // On Worktable Cloud the approval names the owner's workspace address.
    const { server, seen } = await serveRequests([
      { status: "pending" },
      (origin) => ({
        status: "approved",
        code: "T83PD-NSQDP",
        server: `${origin}/w/ws_approved`,
      }),
    ])
    const shown: string[] = []
    await expect(
      requestWorktablePairing({
        server,
        participantName: "Lobster",
        onApprovalNeeded: ({ code }) => shown.push(code),
        sleep: () => Promise.resolve(),
      })
    ).rejects.toThrow("stop")
    expect(shown).toEqual(["BCDF-GHJK"])
    expect(seen[0]?.body).toMatchObject({
      target: { kind: "agent-adapter", adapter: "openclaw" },
      name: "Lobster",
    })
    expect(seen.at(-1)).toMatchObject({
      path: "/w/ws_approved/api/pairing/redeem",
      body: { code: "T83PD-NSQDP" },
    })
  })

  it("pairs only on the host it was given or on Worktable Cloud", async () => {
    // The approval answer names where the code, the token and every later
    // request go, so an address somewhere else is never followed.
    const { server, seen } = await serveRequests([
      {
        status: "approved",
        code: "T83PD-NSQDP",
        server: "https://elsewhere.example/w/ws_approved",
      },
    ])
    await expect(
      requestWorktablePairing({
        server,
        onApprovalNeeded: () => undefined,
        sleep: () => Promise.resolve(),
      })
    ).rejects.toThrow(
      "answered with an address somewhere else: https://elsewhere.example"
    )
    expect(seen.at(-1)?.path).toBe("/api/pairing/requests/poll")

    const given = "https://worktable.example.com"
    expect(knownWorktableAddress(given, `${given}/w/ws_one`)).toBe(
      `${given}/w/ws_one`
    )
    expect(
      knownWorktableAddress(given, "https://app.worktable.cloud/w/ws_one")
    ).toBe("https://app.worktable.cloud/w/ws_one")
    for (const elsewhere of [
      "http://worktable.example.com/w/ws_one",
      "http://app.worktable.cloud/w/ws_one",
      "https://app.worktable.cloud.elsewhere.example",
      "file:///etc/hosts",
      "not an address",
    ]) {
      expect(() => knownWorktableAddress(given, elsewhere)).toThrow()
    }
  })

  it("keeps waiting through a brief outage, but not past a refusal", async () => {
    const outage = await serveRequests([
      { httpStatus: 503 },
      { status: "approved", code: "T83PD-NSQDP" },
    ])
    await expect(
      requestWorktablePairing({
        server: outage.server,
        onApprovalNeeded: () => undefined,
        sleep: () => Promise.resolve(),
      })
    ).rejects.toThrow("stop")
    expect(outage.seen.at(-1)?.path).toBe("/api/pairing/redeem")

    const refused = await serveRequests([{ httpStatus: 404 }])
    await expect(
      requestWorktablePairing({
        server: refused.server,
        onApprovalNeeded: () => undefined,
        sleep: () => Promise.resolve(),
      })
    ).rejects.toThrow("unavailable")
  })

  it("stops without pairing when the owner declines", async () => {
    const { server, seen } = await serveRequests([
      { status: "pending" },
      { status: "denied" },
    ])
    await expect(
      requestWorktablePairing({
        server,
        onApprovalNeeded: () => undefined,
        sleep: () => Promise.resolve(),
      })
    ).rejects.toThrow("declined")
    expect(seen.some(({ path }) => path === "/api/pairing/redeem")).toBe(false)
  })
})

describe("OpenClaw Worktable pairing completion", () => {
  it(
    "reloads rotated credentials from storage even while the runtime snapshot is stale",
    async () => {
      const configDir = await mkdtemp(join(tmpdir(), "worktable-credentials-"))
      tempDirs.push(configDir)
      const configPath = join(configDir, "openclaw.json")
      const pluginDir = await createDiscoveredPluginFixture(configDir)
      process.env.OPENCLAW_CONFIG_PATH = configPath
      process.env.OPENCLAW_STATE_DIR = configDir
      const credential: WorktableAgentAuth = {
        registrationId: "agent_reg_rotating",
        authorizationServer: "https://example.authkit.app",
        identityEndpoint: "https://example.authkit.app/agent/identity",
        tokenEndpoint: "https://example.authkit.app/oauth2/token",
        resource: "https://app.worktable.cloud/api/mcp",
        assertion: "expired",
        assertionExpiresAt: "2000-01-01T00:00:00.000Z",
        refreshToken: "refresh_old",
        refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      }
      const section = {
        enabled: true,
        server: "https://app.worktable.cloud",
        authMode: "agent-registration",
        participantName: "Atlas",
        pendingAgentAuth: credential,
      }
      const config = {
        plugins: { allow: ["worktable"], load: { paths: [pluginDir] } },
        channels: { worktable: section },
      }
      await writeFile(configPath, JSON.stringify(config))
      let refreshes = 0
      const fetchImpl = (async (input, init) => {
        if (String(input) === credential.identityEndpoint) {
          refreshes += 1
          expect(JSON.parse(String(init?.body))).toEqual({
            type: "refresh",
            refresh_token: "refresh_old",
          })
          return Response.json({
            identity: {
              assertion: "assertion_new",
              expires_at: "2099-01-01T00:00:00.000Z",
              refresh_token: {
                value: "refresh_new",
                expires_at: "2099-02-01T00:00:00.000Z",
              },
            },
          })
        }
        expect(new URLSearchParams(String(init?.body)).get("assertion")).toBe(
          "assertion_new"
        )
        return Response.json({ access_token: "access_new", expires_in: 300 })
      }) as typeof fetch
      const provider = () =>
        new WorktableAgentCredentialProvider({
          credential: { ...credential },
          load: () => loadAgentCredential(credential.registrationId),
          save: (next) => saveAgentCredential(credential.registrationId, next),
          fetch: fetchImpl,
        })
      expect(await provider().accessToken()).toBe("access_new")
      // A second client must use the persisted rotation, even before a runtime
      // config reload has replaced the original expired credential snapshot.
      setRuntimeConfigSnapshot(config)
      expect(await provider().accessToken()).toBe("access_new")
      expect(refreshes).toBe(1)
      await promotePendingAgentAuth(credential.registrationId)
      expect(
        await loadAgentCredential(credential.registrationId)
      ).toMatchObject({
        assertion: "assertion_new",
        refreshToken: "refresh_new",
      })
      const stored = JSON.parse(await readFile(configPath, "utf8"))
      expect(stored.channels.worktable.pendingAgentAuth).toBeUndefined()
      expect(stored.channels.worktable.participantName).toBe("Atlas")
    },
    OPENCLAW_RUNTIME_TIMEOUT_MS
  )

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
            participantName: "Atlas",
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
      participantName: "Atlas",
      access: {},
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
  }, OPENCLAW_RUNTIME_TIMEOUT_MS)

  it("records who approved the connection, and keeps what that person trusted only for the same Worktable and approver", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "worktable-owner-"))
    tempDirs.push(configDir)
    const configPath = join(configDir, "openclaw.json")
    const pluginDir = await createDiscoveredPluginFixture(configDir)
    await writeFile(
      configPath,
      JSON.stringify({
        plugins: { allow: ["worktable"], load: { paths: [pluginDir] } },
      })
    )
    process.env.OPENCLAW_CONFIG_PATH = configPath
    process.env.OPENCLAW_STATE_DIR = configDir
    const owner = "ptc_ownerownerowner"
    const teammate = "ptc_teammateteammate"
    let approver: unknown = owner
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (!request.url.endsWith("/api/pairing/redeem")) {
          return Response.json({ ok: true })
        }
        return Response.json({
          mcpUrl: `${new URL(request.url).origin}/mcp`,
          token: "wtb_bearer",
          scopes: ["threads:read"],
          workspaceName: "Worktable",
          participantName: "Atlas",
          ...(approver === undefined ? {} : { ownerMemberId: approver }),
        })
      },
    })
    servers.push(server)
    const pair = () =>
      pairWorktableChannel({
        server: `http://127.0.0.1:${server.port}`,
        pairingCode: "PAIR1-CODE2",
      })
    const saved = async () =>
      JSON.parse(await readFile(configPath, "utf8")).channels.worktable as {
        ownerMemberId?: string
        trustAllMembers?: boolean
        trustAllAgents?: boolean
      }
    const trustEveryone = async () => {
      const config = JSON.parse(await readFile(configPath, "utf8"))
      config.channels.worktable.trustAllMembers = true
      config.channels.worktable.trustAllAgents = true
      await writeFile(configPath, JSON.stringify(config))
    }

    // A first connection takes direction from its approver alone.
    expect((await pair()).access).toEqual({ ownerMemberId: owner })
    expect(await saved()).toMatchObject({ ownerMemberId: owner })
    expect((await saved()).trustAllMembers).toBeUndefined()

    // The same person connecting the same Worktable again keeps their choices.
    await trustEveryone()
    expect((await pair()).access).toEqual({
      ownerMemberId: owner,
      trustAllMembers: true,
      trustAllAgents: true,
    })

    // The channel does not restart for these settings, so each message reads
    // them from storage: turning one off holds even while OpenClaw's runtime
    // snapshot still has it on.
    setRuntimeConfigSnapshot(JSON.parse(await readFile(configPath, "utf8")))
    const config = JSON.parse(await readFile(configPath, "utf8"))
    config.channels.worktable.trustAllAgents = false
    await writeFile(configPath, JSON.stringify(config))
    expect(savedWorktableAccess()).toEqual({
      ownerMemberId: owner,
      trustOwnAgents: true,
      trustAllMembers: true,
      trustAllAgents: false,
    })
    clearRuntimeConfigSnapshot()

    // Someone else approving starts without those choices, under their name.
    // Having turned the owner's own agents off is a restriction, and stays.
    const restricted = JSON.parse(await readFile(configPath, "utf8"))
    restricted.channels.worktable.trustOwnAgents = false
    await writeFile(configPath, JSON.stringify(restricted))
    approver = teammate
    expect((await pair()).access).toEqual({
      ownerMemberId: teammate,
      trustOwnAgents: false,
    })
    expect(await saved()).toMatchObject({ ownerMemberId: teammate })
    expect((await saved()).trustAllAgents).toBeUndefined()

    // An older Worktable names nobody, and anything but a member id is nobody.
    await trustEveryone()
    for (const unnamed of [undefined, "everyone", "*"]) {
      approver = unnamed
      expect((await pair()).access).toEqual({ trustOwnAgents: false })
      const section = await saved()
      expect(section.ownerMemberId).toBeUndefined()
      expect(section.trustAllMembers).toBeUndefined()
      expect(section.trustAllAgents).toBeUndefined()
    }
  }, OPENCLAW_RUNTIME_TIMEOUT_MS * 4)

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
