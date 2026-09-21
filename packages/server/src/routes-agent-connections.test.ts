import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { upsertAgentConnection } from "./agent-connection-store.ts"
import { agentConnectionsRouter } from "./routes/agent-connections.ts"
import { authSessionRouter } from "./routes/auth-session.ts"
import { SESSION_COOKIE_NAME, setOwnerPassword } from "./session-store.ts"
import { createToken, verifyToken } from "./token-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

let appDir: string
let workspaceDir: string
let savedRequireAuth: string | undefined
let savedHosted: string | undefined
let app: Hono

function buildApp(): Hono {
  const next = new Hono()
  next.route("/auth", authSessionRouter)
  next.route("/api/agent-connections", agentConnectionsRouter)
  return next
}

function request(
  method: string,
  path = "/api/agent-connections",
  cookie?: string,
  body?: unknown
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function loginCookie(password: string): Promise<string> {
  const response = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
  )
  const setCookie = response.headers.get("Set-Cookie")
  const value = setCookie?.match(
    new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`)
  )?.[1]
  if (!value) throw new Error(`Login failed (${response.status})`)
  return `${SESSION_COOKIE_NAME}=${value}`
}

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "worktable-agent-routes-app-"))
  workspaceDir = await mkdtemp(join(tmpdir(), "worktable-agent-routes-work-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  savedRequireAuth = process.env["WORKTABLE_REQUIRE_AUTH"]
  savedHosted = process.env["WORKTABLE_HOSTED"]
  delete process.env["WORKTABLE_REQUIRE_AUTH"]
  delete process.env["WORKTABLE_HOSTED"]
  app = buildApp()
})

afterEach(async () => {
  if (savedRequireAuth === undefined)
    delete process.env["WORKTABLE_REQUIRE_AUTH"]
  else process.env["WORKTABLE_REQUIRE_AUTH"] = savedRequireAuth
  if (savedHosted === undefined) delete process.env["WORKTABLE_HOSTED"]
  else process.env["WORKTABLE_HOSTED"] = savedHosted
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})

describe("agent connection routes", () => {
  it("rejects local connection inventory on Worktable Cloud", async () => {
    process.env["WORKTABLE_HOSTED"] = "1"
    const response = await app.fetch(request("GET"))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "HOSTED_DISABLED" })
  })

  it("requires the owner and disconnects the verified credential", async () => {
    const password = "correct-horse-battery"
    await setOwnerPassword(password)
    const cookie = await loginCookie(password)
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"

    const credential = await createToken({
      scopes: ["threads:*"],
      agent: "openclaw@oci_route_test",
    })
    await upsertAgentConnection({
      target: {
        kind: "agent-adapter",
        adapter: "openclaw",
        installationId: "oci_route_test",
      },
      mode: "always-on",
      participant: {
        id: "ptc_route_test_123",
        kind: "agent",
        name: "Atlas",
      },
      machine: "studio",
      credentialId: credential.metadata.id,
      displayName: "Studio Claw",
    })

    expect((await app.fetch(request("GET"))).status).toBe(401)

    const listed = await app.fetch(
      request("GET", "/api/agent-connections", cookie)
    )
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as {
      connections: Array<Record<string, unknown> & { id: string }>
    }
    expect(body.connections).toHaveLength(1)
    expect(body.connections[0]?.["credentialId"]).toBeUndefined()
    expect(body.connections[0]).toMatchObject({
      authKind: "local-token",
      displayName: "Studio Claw",
      permissionGroups: null,
    })

    const path = `/api/agent-connections/${body.connections[0]!.id}`
    const renamed = await app.fetch(
      request("PATCH", path, cookie, { displayName: "Research Claw" })
    )
    expect(renamed.status).toBe(200)
    const afterRename = await app.fetch(
      request("GET", "/api/agent-connections", cookie)
    )
    expect(await afterRename.json()).toMatchObject({
      connections: [{ displayName: "Research Claw" }],
    })

    expect((await app.fetch(request("DELETE", path, cookie))).status).toBe(200)
    expect((await app.fetch(request("DELETE", path, cookie))).status).toBe(200)
    expect(await verifyToken(credential.token)).toBeNull()

    const after = await app.fetch(
      request("GET", "/api/agent-connections", cookie)
    )
    expect(await after.json()).toEqual({ connections: [] })
  })
})
