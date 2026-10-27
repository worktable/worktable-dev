import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ACTOR_HEADERS,
  AGENT_ROUTE_HEADERS,
  ENV,
  GATEWAY_HEADER,
  hostedOAuthPrincipalId,
} from "@worktable/hosted-contract"
import { setAppDirOverride } from "./app-storage.ts"
import { issueFileTicket } from "./file-tickets.ts"
import { hostedFileLinkBase } from "./hosted.ts"
import { startServer } from "./index.ts"
import { listThreadParticipantsForDisplay } from "./thread-service.ts"
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
      body: { target, icon: "brain" },
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
          icon: "brain",
          mode: "always-on",
          machine: "studio",
        },
      ],
    })
    expect((await call("/api/agent-connections")).status).toBe(403)
  })
})

describe("a sign-in agent on a Cloud workspace", () => {
  it("takes the name, icon, and platform its owner chose", async () => {
    const path = "/api/agent-connections/sign-ins/client_chatgpt"
    const body = {
      displayName: "Research GPT",
      icon: "flask-conical",
      platform: "chatgpt",
    }
    expect((await call(path, { method: "PUT", body })).status).toBe(403)
    expect(
      (
        await call(path, {
          method: "PUT",
          body: { platform: "skynet" },
          owner: true,
        })
      ).status
    ).toBe(400)
    expect(
      (await call(path, { method: "PUT", body, owner: true })).status
    ).toBe(200)

    const {
      participants: [participant],
    } = await listThreadParticipantsForDisplay()
    expect(participant).toMatchObject({
      kind: "agent",
      name: "Research GPT",
      platform: "chatgpt",
      icon: "flask-conical",
    })

    // Without Threads on Cloud it is not offered as a recipient, though it
    // keeps its avatar in threads it is already in.
    expect(
      (
        await call(path, {
          method: "PUT",
          body: { ...body, threads: false },
          owner: true,
        })
      ).status
    ).toBe(200)
    const withoutThreads = await listThreadParticipantsForDisplay()
    expect(withoutThreads.participants).toHaveLength(0)
    expect(withoutThreads.presentations[participant!.id]).toMatchObject({
      platform: "chatgpt",
    })
    expect(
      withoutThreads.presentations[
        hostedOAuthPrincipalId("client_chatgpt", owner)
      ]
    ).toEqual(withoutThreads.presentations[participant!.id])
  })
})

describe("file links on a Cloud workspace", () => {
  it("trusts the address they're reached at only from the gateway", () => {
    const request = (secret: string) =>
      new Request("http://tenant.internal/api/mcp", {
        headers: {
          [GATEWAY_HEADER]: secret,
          [AGENT_ROUTE_HEADERS.FILE_LINK_BASE]: `${agentBase}/`,
        },
      })
    expect(hostedFileLinkBase(request(admission))).toBe(agentBase)
    expect(hostedFileLinkBase(request("not-the-secret"))).toBeNull()
  })

  it("redeem only through the gateway, with the link's token as the only credential", async () => {
    process.env["WORKTABLE_FILES_PREVIEW"] = "1"
    const { token } = issueFileTicket({
      kind: "download",
      spaceId: "welcome",
      path: "missing.png",
      identity: null,
      principal: { id: "agent:test", type: "agent", displayName: "Test" },
      actor: "agent:test",
    })
    const redeem = (headers: Record<string, string>) =>
      fetch(`${origin}/api/file-links/${token}`, { headers })
    expect((await redeem({})).status).toBe(403)
    // Admitted, the link is redeemed: here it names no file.
    expect((await redeem({ [GATEWAY_HEADER]: admission })).status).toBe(404)
  })
})
