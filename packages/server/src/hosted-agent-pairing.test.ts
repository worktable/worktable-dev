import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ACTOR_HEADERS,
  AGENT_ROUTE_HEADERS,
  ENV,
  GATEWAY_HEADER,
} from "@worktable/hosted-contract"
import { setAppDirOverride } from "./app-storage.ts"
import { startServer } from "./index.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

// Worktable Cloud routes an agent that paired with this workspace through the
// gateway's per-workspace agent address. These are the trust rules for it.

const admission = "gateway-admission-secret-value"
const owner = "user_owner_123"
const agentBase = "https://app.worktable.cloud/w/ws_123"
const originalEnv = { ...process.env }
let appDir: string
let workspaceDir: string
let server: ReturnType<typeof startServer>
let origin: string

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-hosted-agent-app-"))
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-hosted-agent-ws-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  process.env[ENV.HOSTED] = "1"
  process.env[ENV.GATEWAY_SECRET] = admission
  process.env[ENV.OWNER_SUBJECT] = owner
  process.env[ENV.RESOURCE_URL] = "https://app.worktable.cloud/api/mcp"
  server = startServer(0, "127.0.0.1")
  origin = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  await server.stop(true).catch(() => undefined)
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  rmSync(appDir, { recursive: true, force: true })
  rmSync(workspaceDir, { recursive: true, force: true })
})

function call(
  path: string,
  options: {
    method?: string
    body?: unknown
    owner?: boolean
    agentRoute?: boolean
    bearer?: string
    worktableCredential?: boolean
  } = {}
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      [GATEWAY_HEADER]: admission,
      ...(options.agentRoute === false
        ? {}
        : { [AGENT_ROUTE_HEADERS.BASE]: agentBase }),
      ...(options.owner
        ? {
            [ACTOR_HEADERS.ID]: `workos:${owner}`,
            [ACTOR_HEADERS.TYPE]: "human",
            [ACTOR_HEADERS.NAME]: "Cloud Owner",
          }
        : {}),
      ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
      ...(options.worktableCredential
        ? { [AGENT_ROUTE_HEADERS.CREDENTIAL]: "worktable" }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "openclaw", version: "0" },
  },
}

describe("an agent paired with a Cloud workspace", () => {
  it("connects through the workspace's agent address with the credential it was issued", async () => {
    const target = {
      kind: "agent-adapter",
      adapter: "openclaw",
      participantName: "Atlas",
    }

    // Only the signed-in owner may pair, and only once the gateway routes agents.
    expect((await call("/api/pairing", { body: { target } })).status).toBe(403)
    expect(
      (
        await call("/api/pairing", {
          body: { target },
          owner: true,
          agentRoute: false,
        })
      ).status
    ).toBe(403)
    const created = await call("/api/pairing", {
      body: { target },
      owner: true,
    })
    expect(created.status).toBe(201)
    const pairing = (await created.json()) as {
      code: string
      serverOrigin: string
      mcpUrl: string
    }
    expect(pairing.serverOrigin).toBe(agentBase)
    expect(pairing.mcpUrl).toBe(`${agentBase}/api/mcp`)

    const redeemed = await call("/api/pairing/redeem", {
      body: {
        code: pairing.code,
        hostname: "studio",
        installationId: "oci_cloud_install",
      },
    })
    expect(redeemed.status).toBe(200)
    const { token, mcpUrl } = (await redeemed.json()) as {
      token: string
      mcpUrl: string
    }
    expect(mcpUrl).toBe(`${agentBase}/api/mcp`)
    const completed = await call("/api/pairing/complete", {
      body: { code: pairing.code },
      bearer: token,
    })
    expect(completed.status).toBe(200)

    // The agent's own credential works only as the gateway's agent route marks it.
    expect(
      (
        await call("/api/mcp", {
          body: initialize,
          bearer: token,
          worktableCredential: true,
        })
      ).status
    ).toBe(200)
    expect(
      (await call("/api/mcp", { body: initialize, bearer: token })).status
    ).toBe(401)

    // The owner sees and manages it like a local agent.
    const listed = await call("/api/agent-connections", { owner: true })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      connections: [
        {
          displayName: "Atlas",
          platform: "openclaw",
          mode: "always-on",
          machine: "studio",
        },
      ],
    })
    expect((await call("/api/agent-connections")).status).toBe(403)
  })
})
