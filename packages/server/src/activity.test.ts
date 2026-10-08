import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  DEFAULT_AGENT_TOKEN_SCOPES,
  defaultConversationIdentityId,
  type ActivityPage,
  type PendingResult,
  type SpaceFile,
} from "@worktable/types"
import { Hono } from "hono"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAsActivityActor } from "./activity-log.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { resolveParticipant } from "./participant-store.ts"
import { activityRouter, pendingRouter } from "./routes/activity.ts"
import { annotationsRouter } from "./routes/annotations.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { setSpaceArchived, writeSpace } from "./store.ts"
import { postThreadMessage } from "./thread-service.ts"
import type { TokenIdentity } from "./token-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const codex: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["*"],
  agent: "codex",
  principal: {
    id: "local-token:codex",
    type: "agent",
    displayName: "Codex",
    authorizedBy: "local:owner",
  },
}

let root = ""
let appDir = ""
let client: Client | null = null

function space(id: string, name: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

/** The production boundary: identity first, then attribution for the request. */
function app(identity: TokenIdentity = ownerIdentity()): Hono {
  const server = new Hono()
  server.use("*", async (c, next) => {
    c.set("identity", identity)
    return next()
  })
  server.use("*", (c, next) =>
    runAsActivityActor(c.get("identity").principal, next)
  )
  server.route("/api/activity", activityRouter)
  server.route("/api/pending", pendingRouter)
  server.route("/api/spaces/:spaceId/annotations", annotationsRouter)
  return server
}

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await app().fetch(
    new Request(`http://localhost${path}`, {
      method: init?.method ?? "GET",
      ...(init?.body
        ? {
            body: JSON.stringify(init.body),
            headers: { "Content-Type": "application/json" },
          }
        : {}),
    })
  )
  expect(response.status).toBeLessThan(300)
  return (await response.json()) as T
}

async function agentTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!client) {
    const server = createWorktableMcpServer({
      version: "test",
      scopes: [...DEFAULT_AGENT_TOKEN_SCOPES, "annotations:write"],
      principal: codex.principal,
    })
    client = new Client({ name: "activity-test", version: "1" })
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])
  }
  const result = await client.callTool({ name, arguments: { request: args } })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-activity-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-activity-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(appDir)
  ensureWorkspaceManifest()
  invalidateSearchIndex()
  await writeSpace(space("company", "Company"))
  await writeSpace(space("old", "Old"))
})

afterEach(async () => {
  await client?.close()
  client = null
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  invalidateSearchIndex()
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ])
})

describe("workspace activity", () => {
  it("tells people who did what, newest first, without repeating itself", async () => {
    // An agent writes a doc and revises it the same day.
    const written = await agentTool("worktable_docs_write", {
      action: "write",
      spaceId: "company",
      docPath: "pulse",
      content: "# Pulse\n",
      lifetime: "durable",
    })
    await agentTool("worktable_docs_write", {
      action: "write",
      spaceId: "company",
      docPath: "pulse",
      content: "# Pulse\n\nQ3 is on track.\n",
      expectedRevision: written["revision"],
    })
    // The person asks for a change; the agent does it and resolves the request.
    const { annotation } = await request<{ annotation: { id: string } }>(
      "/api/spaces/company/annotations",
      {
        method: "POST",
        body: {
          target: { type: "doc", docPath: "pulse" },
          category: "instruction",
          body: "Add the hiring risks.",
        },
      }
    )
    await agentTool("worktable_annotations_write", {
      action: "resolve",
      spaceId: "company",
      annotationId: annotation.id,
    })
    // Work in an archived Space stays out of the workspace view.
    await agentTool("worktable_docs_write", {
      action: "write",
      spaceId: "old",
      docPath: "notes",
      content: "# Notes\n",
      lifetime: "durable",
    })
    await setSpaceArchived("old", true)

    const page = await request<ActivityPage>("/api/activity")
    expect(
      page.entries.map((entry) => [
        entry.action,
        entry.actor.kind,
        entry.actor.name,
        entry.target.kind === "doc" ? entry.target.title : null,
        entry.quote ?? null,
      ])
    ).toEqual([
      ["comment.resolved", "agent", "Codex", "Pulse", "Add the hiring risks."],
      ["comment.created", "person", "Owner", "Pulse", "Add the hiring risks."],
      ["doc.created", "agent", "Codex", "Pulse", null],
    ])
    expect(page.entries[1]?.category).toBe("instruction")

    // A Space Home reads its own history, archived or not.
    const archived = await request<ActivityPage>("/api/activity?spaceId=old")
    expect(archived.entries.map((entry) => entry.action)).toEqual([
      "doc.created",
    ])

    // Pages continue where the previous one stopped.
    const first = await request<ActivityPage>("/api/activity?limit=2")
    expect(first.nextCursor).not.toBeNull()
    const rest = await request<ActivityPage>(
      `/api/activity?limit=2&before=${first.nextCursor}`
    )
    expect(rest.entries.map((entry) => entry.action)).toEqual(["doc.created"])
    expect(rest.nextCursor).toBeNull()
  })

  it("lists what is waiting on the reader until they answer", async () => {
    const owner = ownerIdentity()
    const ownerParticipant = (
      await resolveParticipant(owner, { name: "Owner" })
    ).participant
    await resolveParticipant(codex, {
      name: "Codex",
      defaultSpaceId: "company",
    })
    const asked = await postThreadMessage(codex, {
      location: { kind: "space", spaceId: "company" },
      to: "Owner",
      body: "Which invitation variant should we ship?",
      idempotencyKey: "ask-owner",
      responseIdentityId: defaultConversationIdentityId(ownerParticipant.id),
      waitSeconds: 0,
    })

    const pending = await request<PendingResult>("/api/pending")
    expect(pending.items).toMatchObject([
      {
        kind: "threadRequest",
        threadId: asked.threadId,
        from: { kind: "agent", name: "Codex" },
        excerpt: "Which invitation variant should we ship?",
      },
    ])

    await postThreadMessage(owner, {
      threadId: asked.threadId,
      body: "The shorter one.",
      idempotencyKey: "owner-answer",
      inReplyTo: asked.messageId,
      responseTo: asked.messageId,
      expectsReply: false,
    })
    expect((await request<PendingResult>("/api/pending")).items).toEqual([])
  })
})
