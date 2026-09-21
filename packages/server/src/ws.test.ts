import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createThread, threadPath } from "./thread-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import { WsManager } from "./ws.ts"

describe("WsManager", () => {
  it("broadcasts a doc-list invalidation when aliases change", async () => {
    const messages: unknown[] = []
    const manager = new WsManager()
    const client = {
      data: { spaceId: "space", canReadDocs: true },
      send(value: string) {
        messages.push(JSON.parse(value))
      },
      close() {},
    }
    manager.subscribe(client, "space")

    await manager.handleChange({ type: "docAliases", spaceId: "space" })

    expect(messages).toEqual([{ type: "doc_update", spaceId: "space" }])
  })

  it("broadcasts participant-list invalidation", async () => {
    const messages: unknown[] = []
    const manager = new WsManager()
    const client = {
      data: { spaceId: "space", canReadThreads: true },
      send(value: string) {
        messages.push(JSON.parse(value))
      },
      close() {},
    }
    manager.subscribe(client, "space")

    await manager.handleChange({ type: "participants", spaceId: "space" })

    expect(messages).toEqual([
      { type: "participants_update", spaceId: "space" },
    ])
  })

  it("broadcasts participant changes to the Worktable thread scope without a Space", async () => {
    const messages: unknown[] = []
    const manager = new WsManager()
    manager.subscribe(
      {
        data: { spaceId: "__worktable_threads__", canReadThreads: true },
        send(value: string) {
          messages.push(JSON.parse(value))
        },
        close() {},
      },
      "__worktable_threads__"
    )

    await manager.handleChange({ type: "participants" })

    expect(messages).toEqual([{ type: "participants_update" }])
  })

  it("broadcasts a payload-free thread-list invalidation during reconciliation", async () => {
    const messages: unknown[] = []
    const manager = new WsManager()
    manager.subscribe(
      {
        data: { spaceId: "space", canReadThreads: true },
        send(value: string) {
          messages.push(JSON.parse(value))
        },
        close() {},
      },
      "space"
    )

    await manager.handleChange({
      type: "threadCollectionReconcile",
      spaceId: "space",
    })

    expect(messages).toEqual([{ type: "thread_update" }])
  })

  it("broadcasts workspace-visible thread updates through global invalidation", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "worktable-ws-private-"))
    setWorkspaceRootOverride(workspaceDir)
    try {
      const created = await createThread("private-space", {
        author: {
          id: "ptc_private_author",
          kind: "human",
          name: "Finn",
        },
        recipient: {
          id: "ptc_private_agent",
          kind: "agent",
          name: "Atlas",
        },
        body: "Private.",
        idempotencyKey: "global-invalidation",
      })
      const messages: unknown[] = []
      const manager = new WsManager()
      manager.subscribe(
        {
          data: {
            spaceId: "__worktable_threads__",
            canReadThreads: true,
          },
          send(value: string) {
            messages.push(JSON.parse(value))
          },
          close() {},
        },
        "__worktable_threads__"
      )

      await manager.handleChange({
        type: "thread",
        spaceId: "private-space",
        threadId: created.thread.id,
      })

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: "thread_update",
        threadId: created.thread.id,
        data: { messages: [{ body: "Private." }] },
      })
      expect(messages[1]).toEqual({ type: "thread_update" })
    } finally {
      setWorkspaceRootOverride(null)
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })

  it("filters non-thread payloads from thread-only subscribers", () => {
    const messages: unknown[] = []
    const manager = new WsManager()
    manager.subscribe(
      {
        data: { spaceId: "space", canReadThreads: true },
        send(value: string) {
          messages.push(JSON.parse(value))
        },
        close() {},
      },
      "space"
    )

    manager.broadcast("space", {
      type: "doc_update",
      spaceId: "space",
      data: { content: "private doc body" },
    })
    manager.broadcast("space", {
      type: "record_update",
      spaceId: "space",
      data: { title: "private record body" },
    })
    manager.broadcast("space", {
      type: "space_update",
      spaceId: "space",
      data: { name: "private space metadata" },
    })
    manager.broadcast("space", {
      type: "widget_update",
      spaceId: "space",
      data: { html: "private HTML Doc body" },
    })
    manager.broadcast("space", {
      type: "annotation_update",
      spaceId: "space",
      data: { body: "private annotation body" },
    })
    manager.broadcast("space", {
      type: "participants_update",
      spaceId: "space",
    })

    expect(messages).toEqual([
      { type: "participants_update", spaceId: "space" },
    ])
  })

  it("sends thread payloads to every client with workspace thread access", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "worktable-ws-threads-"))
    setWorkspaceRootOverride(workspaceDir)
    try {
      const member = {
        id: "ptc_member_agent",
        kind: "agent" as const,
        name: "Member",
      }
      const recipient = {
        id: "ptc_other_agent_1",
        kind: "agent" as const,
        name: "Recipient",
      }
      const created = await createThread("space", {
        author: member,
        recipient,
        body: "Private message body",
        idempotencyKey: "private-thread",
      })
      const manager = new WsManager()
      const received = {
        member: [] as Array<Record<string, unknown>>,
        outsider: [] as Array<Record<string, unknown>>,
        owner: [] as Array<Record<string, unknown>>,
        noScope: [] as Array<Record<string, unknown>>,
        revoked: [] as Array<Record<string, unknown>>,
      }
      const clients = [
        {
          target: received.member,
          data: {
            spaceId: "space",
            canReadThreads: true,
          },
        },
        {
          target: received.outsider,
          data: {
            spaceId: "space",
            canReadThreads: true,
          },
        },
        {
          target: received.owner,
          data: {
            spaceId: "space",
            canReadThreads: true,
          },
        },
        {
          target: received.revoked,
          data: { spaceId: "space", canReadThreads: true, credentialRevoked: true },
        },
        {
          target: received.noScope,
          data: {
            spaceId: "space",
            canReadThreads: false,
          },
        },
      ].map(({ target, data }) => ({
        data,
        send(value: string) {
          target.push(JSON.parse(value))
        },
        close() {},
      }))
      for (const client of clients) manager.subscribe(client, "space")

      await manager.handleChange({
        type: "thread",
        spaceId: "space",
        threadId: created.thread.id,
      })

      expect(received.member[0]).toMatchObject({
        type: "thread_update",
        data: { messages: [{ body: "Private message body" }] },
      })
      expect(received.member[1]).toEqual({
        type: "thread_update",
      })
      expect(received.member).toHaveLength(2)
      expect(received.owner).toHaveLength(2)
      expect(received.outsider).toHaveLength(2)
      expect(received.outsider[0]).toMatchObject({
        type: "thread_update",
        data: { messages: [{ body: "Private message body" }] },
      })
      expect(received.noScope).toHaveLength(0)
      expect(received.revoked).toHaveLength(0)

      for (const target of Object.values(received)) target.length = 0
      await rm(threadPath("space", created.thread.id))
      await manager.handleChange({
        type: "thread",
        spaceId: "space",
        threadId: created.thread.id,
      })

      const deleted = [
        {
          type: "thread_deleted",
          location: { kind: "space", spaceId: "space" },
          spaceId: "space",
          threadId: created.thread.id,
        },
        {
          type: "thread_update",
        },
      ]
      expect(received.member).toEqual(deleted)
      expect(received.outsider).toEqual(deleted)
      expect(received.owner).toEqual(deleted)
      expect(received.noScope).toHaveLength(0)
      expect(received.revoked).toHaveLength(0)
    } finally {
      setWorkspaceRootOverride(null)
      await rm(workspaceDir, { recursive: true, force: true })
    }
  })
})
