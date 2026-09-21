import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { Hono } from "hono"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { resolveParticipant } from "./participant-store.ts"
import { threadsRouter } from "./routes/threads.ts"
import { writeSpace } from "./store.ts"
import type { TokenIdentity } from "./token-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

let workspaceDir: string
let appDir: string
let app: Hono

const finn: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["threads:read", "threads:write"],
  agent: "claude-code@work",
  principal: {
    id: "token:finn",
    type: "agent",
    displayName: "Finn",
    authorizedBy: "local:owner",
  },
}
const atlas: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["threads:*"],
  agent: "openclaw@personal",
  principal: {
    id: "token:atlas",
    type: "agent",
    displayName: "Atlas",
    authorizedBy: "local:owner",
  },
}

function space(id: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: "Connected Agents",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

function buildApp(identity: TokenIdentity): Hono {
  const testApp = new Hono()
  testApp.use("*", async (c, next) => {
    c.set("identity", identity)
    await next()
  })
  testApp.route("/api/threads", threadsRouter)
  testApp.route("/api/spaces/:spaceId/threads", threadsRouter)
  return testApp
}

async function request(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  )
  const json = await response.json().catch(() => ({}))
  return {
    status: response.status,
    json: json as Record<string, unknown>,
  }
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(
    join(tmpdir(), "worktable-thread-route-workspace-")
  )
  appDir = await mkdtemp(join(tmpdir(), "worktable-thread-route-app-"))
  setWorkspaceRootOverride(workspaceDir)
  setAppDirOverride(appDir)
  await writeSpace(space("connected-agents"))
  await resolveParticipant(finn, {
    name: "Finn",
    defaultSpaceId: "connected-agents",
  })
  await resolveParticipant(atlas, {
    name: "Atlas",
    defaultSpaceId: "connected-agents",
  })
  app = buildApp(finn)
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all([
    rm(workspaceDir, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ])
})

describe("thread REST routes", () => {
  it("creates and filters Worktable and Space threads through the global surface", async () => {
    const worktableCreated = await request("POST", "/api/threads", {
      to: "Atlas",
      body: "A general Worktable conversation.",
      idempotencyKey: "route-worktable-create",
    })
    expect(worktableCreated.status).toBe(201)
    expect(worktableCreated.json.location).toEqual({ kind: "worktable" })

    const spaceCreated = await request(
      "POST",
      "/api/spaces/connected-agents/threads",
      {
        to: "Atlas",
        body: "A Space conversation.",
        idempotencyKey: "route-space-create",
      }
    )
    expect(spaceCreated.status).toBe(201)

    const all = await request("GET", "/api/threads")
    expect(all.status).toBe(200)
    expect((all.json.threads as unknown[]).length).toBe(2)

    const worktable = await request("GET", "/api/threads?location=worktable")
    expect(worktable.status).toBe(200)
    expect(worktable.json.threads).toMatchObject([
      { location: { kind: "worktable" } },
    ])

    const filteredSpace = await request(
      "GET",
      "/api/threads?location=space&spaceId=connected-agents"
    )
    expect(filteredSpace.status).toBe(200)
    expect(filteredSpace.json.threads).toMatchObject([
      {
        location: { kind: "space", spaceId: "connected-agents" },
        spaceId: "connected-agents",
      },
    ])

    for (const path of [
      "/api/threads?location=space",
      "/api/threads?location=worktable&spaceId=connected-agents",
      "/api/threads?spaceId=connected-agents",
    ]) {
      const invalid = await request("GET", path)
      expect(invalid.status).toBe(400)
      expect(invalid.json.code).toBe("VALIDATION_ERROR")
    }

    const rootFile = JSON.parse(
      await readFile(
        join(workspaceDir, "threads", `${worktableCreated.json.threadId}.json`),
        "utf8"
      )
    ) as Record<string, unknown>
    expect(rootFile).toMatchObject({
      version: 3,
      location: { kind: "worktable" },
    })
    expect(rootFile).not.toHaveProperty("spaceId")
  })

  it("creates, persists, lists, reads, and follows up in one thread", async () => {
    const created = await request(
      "POST",
      "/api/spaces/connected-agents/threads",
      {
        to: "Atlas",
        body: "Start a durable conversation.",
        idempotencyKey: "route-create",
        authorId: "ptc_spoofed",
      }
    )
    expect(created.status).toBe(201)
    const threadId = String(created.json.threadId)
    const listed = await request("GET", "/api/spaces/connected-agents/threads")
    expect(listed.status).toBe(200)
    expect((listed.json.threads as unknown[]).length).toBe(1)

    const queued = await request(
      "GET",
      "/api/spaces/connected-agents/threads?deliveryState=queued"
    )
    expect(queued.status).toBe(200)
    expect((queued.json.threads as unknown[]).length).toBe(1)

    const failed = await request(
      "GET",
      "/api/spaces/connected-agents/threads?deliveryState=failed"
    )
    expect(failed.status).toBe(200)
    expect((failed.json.threads as unknown[]).length).toBe(0)

    const assignment = await request(
      "PUT",
      `/api/spaces/connected-agents/threads/${threadId}/messages/${String(created.json.messageId)}/assignment`,
      { identityId: null }
    )
    expect(assignment.status).toBe(200)
    expect(assignment.json).toEqual({
      threadId,
      revision: expect.any(Number),
    })

    const followed = await request(
      "POST",
      `/api/spaces/connected-agents/threads/${threadId}/messages`,
      {
        body: "A second message in the same thread.",
        idempotencyKey: "route-follow-up",
        waitSeconds: 0,
      }
    )
    expect(followed.status).toBe(200)
    expect(followed.json.threadId).toBe(threadId)

    const read = await request(
      "GET",
      `/api/spaces/connected-agents/threads/${threadId}`
    )
    expect(read.status).toBe(200)
    const thread = read.json.thread as {
      members: Array<{ id: string; name: string }>
      messages: Array<{ authorMemberId: string; body: string }>
    }
    const finnMember = thread.members.find((member) => member.name === "Finn")
    expect(read.json.viewerMemberId).toBe(finnMember?.id)
    expect(thread.messages.map((message) => message.body)).toEqual([
      "Start a durable conversation.",
      "A second message in the same thread.",
    ])
    expect(
      thread.messages.every(
        (message) => message.authorMemberId === finnMember?.id
      )
    ).toBe(true)

    const file = JSON.parse(
      await readFile(
        join(
          workspaceDir,
          "spaces",
          "connected-agents",
          "threads",
          `${threadId}.json`
        ),
        "utf8"
      )
    ) as { id: string }
    expect(file.id).toBe(threadId)

    const invalidCursor = await request(
      "GET",
      `/api/spaces/connected-agents/threads/${threadId}?after=not-a-number`
    )
    expect(invalidCursor.status).toBe(400)
    expect(invalidCursor.json.code).toBe("VALIDATION_ERROR")
  })

  it("enforces the operation scopes at the REST boundary", async () => {
    app = buildApp({ ...finn, scopes: ["threads:read"] })
    const denied = await request(
      "POST",
      "/api/spaces/connected-agents/threads",
      {
        to: "Atlas",
        body: "Denied",
        idempotencyKey: "route-denied",
      }
    )
    expect(denied.status).toBe(403)
    expect(denied.json.code).toBe("FORBIDDEN")
  })

  it("rejects an empty reply target before creating a thread", async () => {
    const invalid = await request(
      "POST",
      "/api/spaces/connected-agents/threads",
      {
        to: "Atlas",
        body: "This must not become a server error.",
        idempotencyKey: "empty-rest-reply-target",
        inReplyTo: "",
      }
    )
    expect(invalid.status).toBe(400)
    expect(invalid.json.code).toBe("VALIDATION_ERROR")

    const listed = await request("GET", "/api/spaces/connected-agents/threads")
    expect(listed.json.threads).toEqual([])
  })

  it("does not report a missing Space as an empty thread list", async () => {
    const missing = await request("GET", "/api/spaces/missing-space/threads")
    expect(missing.status).toBe(400)
    expect(missing.json.code).toBe("THREAD_SPACE_MISMATCH")
  })

  it("returns a retryable service error when idempotency cannot be scanned safely", async () => {
    const input = {
      to: "Atlas",
      body: "Create this exactly once.",
      idempotencyKey: "route-incomplete-scan",
    }
    const created = await request(
      "POST",
      "/api/spaces/connected-agents/threads",
      input
    )
    expect(created.status).toBe(201)
    await writeFile(
      join(
        workspaceDir,
        "spaces",
        "connected-agents",
        "threads",
        "thr_unreadable.json"
      ),
      '{"type":',
      "utf8"
    )

    const retry = await request(
      "POST",
      "/api/spaces/connected-agents/threads",
      input
    )
    expect(retry.status).toBe(503)
    expect(retry.json.code).toBe("THREAD_STORE_INCOMPLETE")
  })

  it("rejects encoded traversal segments without touching outside files", async () => {
    const sentinel = join(workspaceDir, "sentinel.txt")
    await writeFile(sentinel, "safe", "utf8")
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "..",
          "../sentinel",
          "../../sentinel",
          "thr_ok/../../sentinel",
          ".",
          "thr_%"
        ),
        async (unsafeId) => {
          const encoded = encodeURIComponent(unsafeId)
          const response = await request(
            "GET",
            `/api/spaces/connected-agents/threads/${encoded}`
          )
          expect(response.status).not.toBe(200)
          expect(await readFile(sentinel, "utf8")).toBe("safe")
        }
      ),
      { numRuns: 24 }
    )
  })
})
