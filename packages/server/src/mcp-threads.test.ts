import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import {
  listParticipantBindings,
  resolveParticipant,
} from "./participant-store.ts"
import { writeSpace } from "./store.ts"
import {
  createToken,
  revokeToken,
  type RequestPrincipal,
  verifyToken,
} from "./token-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import { drainWorkspaceChanges, onWorkspaceChange } from "./workspace-events.ts"

let workspaceDir: string
let appDir: string
const clients: Client[] = []

const finn: RequestPrincipal = {
  id: "token:finn",
  type: "agent",
  displayName: "Finn",
  authorizedBy: "local:owner",
}
const atlas: RequestPrincipal = {
  id: "token:atlas",
  type: "agent",
  displayName: "Atlas",
  authorizedBy: "local:owner",
}
const mara: RequestPrincipal = {
  id: "token:mara",
  type: "agent",
  displayName: "Mara",
  authorizedBy: "local:owner",
}
const nova: RequestPrincipal = {
  id: "token:nova",
  type: "agent",
  displayName: "Nova",
  authorizedBy: "local:owner",
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

async function connect(
  agent: string,
  principal: RequestPrincipal,
  scopes: string[],
  clientName = agent
): Promise<Client> {
  const server = createWorktableMcpServer({
    version: "test",
    scopes,
    identity: { agent, principal },
    principal,
  })
  const client = new Client({ name: clientName, version: "1" })
  clients.push(client)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

async function call(
  client: Client,
  name: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await client.callTool({
    name,
    arguments: { request },
  })
  if (response.isError) {
    throw new Error(`Tool ${name} failed: ${JSON.stringify(response.content)}`)
  }
  const item = (response as { content: Array<{ type: string; text?: string }> })
    .content[0]
  if (!item || item.type !== "text") {
    throw new Error(`Missing text response for ${name}`)
  }
  const parsed = JSON.parse(item.text ?? "") as Record<string, unknown>
  expect(response.structuredContent).toEqual(parsed)
  return parsed
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(
    join(tmpdir(), "worktable-mcp-thread-workspace-")
  )
  appDir = await mkdtemp(join(tmpdir(), "worktable-mcp-thread-app-"))
  setWorkspaceRootOverride(workspaceDir)
  setAppDirOverride(appDir)
  await writeSpace(space("connected-agents"))
  await resolveParticipant(
    { agent: "openclaw@personal", principal: atlas },
    { name: "Atlas", defaultSpaceId: "connected-agents" }
  )
  await resolveParticipant(
    { agent: "claude-code@work", principal: finn },
    { name: "Finn", defaultSpaceId: "connected-agents" }
  )
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all([
    rm(workspaceDir, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ])
})

describe("thread MCP operations", () => {
  it("lets a conversation-scoped agent register only its own participant", async () => {
    const client = await connect("openclaw@cloud-install", mara, [
      "threads:participate",
    ])
    const first = await call(client, "worktable_thread_delivery", {
      action: "register_participant",
      name: "Mara Cloud",
    })
    const second = await call(client, "worktable_thread_delivery", {
      action: "register_participant",
      name: "Mara Cloud",
    })
    expect(second).toEqual(first)
    expect(first.participant).toMatchObject({
      kind: "agent",
      name: "Mara Cloud",
    })
    await expect(
      call(client, "worktable_threads_write", {
        action: "post",
        to: "Atlas",
        body: "This scope cannot post directly.",
        idempotencyKey: "registration-is-not-write",
      })
    ).rejects.toThrow()
  })

  it("defaults new participants to Worktable and supports location filtering", async () => {
    await resolveParticipant(
      { agent: "codex@new-install", principal: nova },
      { name: "Nova" }
    )
    const client = await connect("codex@new-install", nova, [
      "threads:read",
      "threads:write",
    ])
    const posted = await call(client, "worktable_threads_write", {
      action: "post",
      to: "Atlas",
      body: "Start without a legacy default Space.",
      idempotencyKey: "mcp-worktable-default",
      waitSeconds: 0,
    })
    expect(posted.location).toEqual({ kind: "worktable" })

    const all = await call(client, "worktable_threads_read", {
      action: "list",
    })
    expect(all.threads).toMatchObject([{ location: { kind: "worktable" } }])
    const worktable = await call(client, "worktable_threads_read", {
      action: "list",
      location: { kind: "worktable" },
    })
    expect(worktable.threads).toHaveLength(1)
    const space = await call(client, "worktable_threads_read", {
      action: "list",
      location: { kind: "space", spaceId: "connected-agents" },
    })
    expect(space.threads).toEqual([])

    await expect(
      call(client, "worktable_threads_read", {
        action: "list",
        location: { kind: "worktable" },
        spaceId: "connected-agents",
      })
    ).rejects.toThrow("location and deprecated spaceId")
  })

  it("upgrades an existing adapter binding when its delivery claim supports locations", async () => {
    const client = await connect("openclaw@personal", atlas, [
      "threads:participate",
    ])
    expect(
      (await listParticipantBindings()).find(
        ({ participant }) => participant.name === "Atlas"
      )?.threadLocationVersion
    ).toBeUndefined()

    await call(client, "worktable_thread_delivery", {
      action: "claim",
      waitSeconds: 0,
      threadLocationVersion: 2,
    })

    expect(
      (await listParticipantBindings()).find(
        ({ participant }) => participant.name === "Atlas"
      )?.threadLocationVersion
    ).toBe(2)
  })

  it("carries a reply through the same durable thread across two identities", async () => {
    const finnClient = await connect("claude-code@work", finn, [
      "threads:read",
      "threads:write",
    ])
    const atlasClient = await connect("openclaw@personal", atlas, [
      "threads:read",
      "threads:write",
      "threads:participate",
    ])

    const posted = await call(finnClient, "worktable_threads_write", {
      action: "post",
      to: "Atlas",
      body: "Please inspect the channel seam.",
      idempotencyKey: "mcp-finn-1",
      waitSeconds: 0,
    })
    expect(posted.createdThread).toBe(true)

    const claimed = await call(atlasClient, "worktable_thread_delivery", {
      action: "claim",
      waitSeconds: 0,
    })
    const delivery = claimed.delivery as Record<string, unknown>
    expect((delivery.message as Record<string, unknown>).body).toBe(
      "Please inspect the channel seam."
    )

    await call(atlasClient, "worktable_thread_delivery", {
      action: "accept",
      messageId: delivery.messageId,
      leaseId: delivery.leaseId,
    })
    await call(atlasClient, "worktable_thread_delivery", {
      action: "progress",
      messageId: delivery.messageId,
      leaseId: delivery.leaseId,
      phase: "receiving",
      receivedCharacters: 81,
    })
    const replied = await call(atlasClient, "worktable_threads_write", {
      action: "post",
      threadId: posted.threadId,
      inReplyTo: posted.messageId,
      responseTo: posted.messageId,
      body: "The external channel path supports the required continuity.",
      idempotencyKey: "mcp-atlas-1",
      expectsReply: false,
    })
    expect(replied.threadId).toBe(posted.threadId)

    const read = await call(finnClient, "worktable_threads_read", {
      action: "read",
      threadId: posted.threadId,
      after: posted.cursor,
    })
    expect(
      (read.messages as Array<Record<string, unknown>>).map(
        (message) => message.body
      )
    ).toEqual(["The external channel path supports the required continuity."])
  })

  it("normalizes idempotency keys before persisting and comparing retries", async () => {
    const client = await connect("claude-code@work", finn, [
      "threads:read",
      "threads:write",
    ])
    const request = {
      action: "post",
      to: "Atlas",
      body: "Normalize this retry key.",
      idempotencyKey: "  normalized-mcp-key  ",
      waitSeconds: 0,
    }
    const first = await call(client, "worktable_threads_write", request)
    const retry = await call(client, "worktable_threads_write", request)

    expect(retry.threadId).toBe(first.threadId)
    expect(retry.messageId).toBe(first.messageId)
    const read = await call(client, "worktable_threads_read", {
      action: "read",
      threadId: first.threadId,
    })
    expect(
      (read.messages as Array<{ idempotencyKey: string }>)[0]?.idempotencyKey
    ).toBe("normalized-mcp-key")
  })

  it("rejects an empty reply target at the MCP boundary", async () => {
    const client = await connect("claude-code@work", finn, [
      "threads:read",
      "threads:write",
    ])
    await expect(
      call(client, "worktable_threads_write", {
        action: "post",
        to: "Atlas",
        body: "This must fail validation.",
        idempotencyKey: "empty-mcp-reply-target",
        inReplyTo: "",
      })
    ).rejects.toThrow()

    const listed = await call(client, "worktable_threads_read", {
      action: "list",
      spaceId: "connected-agents",
    })
    expect(listed.threads).toEqual([])
  })

  it("exposes workspace threads to every agent with thread read access", async () => {
    await resolveParticipant(
      { agent: "codex@elsewhere", principal: mara },
      { name: "Mara", defaultSpaceId: "connected-agents" }
    )
    const finnClient = await connect("claude-code@work", finn, [
      "threads:read",
      "threads:write",
    ])
    const maraClient = await connect("codex@elsewhere", mara, ["threads:read"])
    const posted = await call(finnClient, "worktable_threads_write", {
      action: "post",
      to: "Atlas",
      spaceId: "connected-agents",
      body: "Workspace collaborators can discover this.",
      idempotencyKey: "workspace-mcp-thread",
      waitSeconds: 0,
    })

    const listed = await call(maraClient, "worktable_threads_read", {
      action: "list",
      spaceId: "connected-agents",
    })
    expect(listed.threads).toHaveLength(1)
    const read = await call(maraClient, "worktable_threads_read", {
      action: "read",
      threadId: posted.threadId,
    })
    expect((read.thread as { id: string }).id).toBe(posted.threadId as string)
  })

  it("does not report a missing Space as an empty MCP thread list", async () => {
    const client = await connect("claude-code@work", finn, ["threads:read"])
    await expect(
      call(client, "worktable_threads_read", {
        action: "list",
        spaceId: "missing-space",
      })
    ).rejects.toThrow("THREAD_SPACE_MISMATCH")
  })

  it("keeps runtime delivery inaccessible to a normal thread client", async () => {
    const client = await connect("claude-code@work", finn, [
      "threads:read",
      "threads:write",
    ])
    const response = await client.callTool({
      name: "worktable_thread_delivery",
      arguments: { request: { action: "claim", waitSeconds: 0 } },
    })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response.content)).toContain("threads:participate")
  })

  it("binds a managed participant to its credential rather than client metadata", async () => {
    const credential = await createToken({
      scopes: ["threads:read", "threads:write"],
      agent: "managed:codex",
    })
    const managed = await verifyToken(credential.token)
    expect(managed).not.toBeNull()
    const client = await connect(
      managed!.agent!,
      managed!.principal,
      ["threads:read", "threads:write"],
      "spoofed-claude-code-client"
    )

    const participants = await call(client, "worktable_threads_read", {
      action: "participants",
    })
    expect(participants.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Atlas" }),
        expect.objectContaining({ name: "Finn" }),
      ])
    )

    await call(client, "worktable_threads_write", {
      action: "post",
      to: "Atlas",
      spaceId: "connected-agents",
      body: "A message from the shared local credential.",
      idempotencyKey: "managed-codex",
      waitSeconds: 0,
    })

    const listed = await call(client, "worktable_threads_read", {
      action: "list",
      spaceId: "connected-agents",
    })
    const thread = (listed.threads as Array<Record<string, unknown>>)[0]!
    expect(thread.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Codex" }),
        expect.objectContaining({ name: "Atlas" }),
      ])
    )

    expect(
      (await listParticipantBindings()).some(
        ({ participant }) => participant.name === "Codex"
      )
    ).toBe(true)
    await revokeToken(credential.metadata.id)
    expect(
      (await listParticipantBindings()).some(
        ({ participant }) => participant.name === "Codex"
      )
    ).toBe(false)
  })

  it("removes a revoked local human participant and invalidates subscribers", async () => {
    const credential = await createToken({
      scopes: ["threads:read", "threads:write"],
    })
    const identity = await verifyToken(credential.token)
    expect(identity).not.toBeNull()
    const reviewer = await resolveParticipant(identity!, {
      name: "Reviewer",
      defaultSpaceId: "connected-agents",
    })
    expect(
      (await listParticipantBindings()).some(
        ({ participant }) => participant.id === reviewer.participant.id
      )
    ).toBe(true)

    const participantChanges: Array<string | undefined> = []
    const off = onWorkspaceChange((event) => {
      if (event.type === "participants") {
        participantChanges.push(event.spaceId)
      }
    })
    try {
      await revokeToken(credential.metadata.id)
      await drainWorkspaceChanges()
    } finally {
      off()
    }

    expect(
      (await listParticipantBindings()).some(
        ({ participant }) => participant.id === reviewer.participant.id
      )
    ).toBe(false)
    expect(participantChanges).toEqual([undefined, "connected-agents"])
  })
})
