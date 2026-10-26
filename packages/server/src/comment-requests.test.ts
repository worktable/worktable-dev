import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Annotation } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import { resolveParticipant } from "./participant-store.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { listPending } from "./pending.ts"
import {
  onPendingChange,
  pendingFor,
  pendingList,
  savePendingList,
  type PendingChange,
} from "./pending-list.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"
import { markOpened, readPending } from "./pending-read.ts"
import { annotationsRouter } from "./routes/annotations.ts"
import { writeDoc, writeSpace } from "./store.ts"
import type { TokenIdentity } from "./token-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  writeWorkspaceManifest,
} from "./workspace.ts"

const finn: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["threads:*", "annotations:read", "annotations:write"],
  agent: "claude-code@work",
  principal: {
    id: "token:finn",
    type: "agent",
    displayName: "Finn",
    authorizedBy: "local:owner",
  },
}

let root: string
let appDir: string
let caller: TokenIdentity
let preview: string | undefined

const app = new Hono()
app.use("*", async (c, next) => {
  c.set("identity", caller)
  await next()
})
app.route("/api/spaces/:spaceId/annotations", annotationsRouter)

async function list() {
  const response = await app.fetch(
    new Request("http://localhost/api/spaces/pricing/annotations?docPath=explorer")
  )
  return ((await response.json()) as { annotations: Annotation[] }).annotations
}

async function post(path: string, body: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost/api/spaces/pricing/annotations${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
  return {
    status: response.status,
    json: (await response.json()) as { annotation: Annotation; code?: string },
  }
}

function statuses(annotation: Annotation) {
  return (annotation.requests ?? []).map((request) => [
    request.to.name,
    request.status,
  ])
}

for (const layout of ["Storage V1", "Storage V2"] as const) {
  describe(`sending a comment (${layout})`, () => {
    beforeEach(async () => {
      preview = process.env.WORKTABLE_MCP_PREVIEW
      process.env.WORKTABLE_MCP_PREVIEW = "1"
      root = await mkdtemp(join(tmpdir(), "worktable-comment-requests-"))
      appDir = await mkdtemp(join(tmpdir(), "worktable-comment-requests-app-"))
      setWorkspaceRootOverride(root)
      setAppDirOverride(appDir)
      const manifest = ensureWorkspaceManifest()
      if (layout === "Storage V1") writeWorkspaceManifest({ ...manifest, version: 1 })
      const now = new Date().toISOString()
      await writeSpace({
        type: "worktable.space",
        version: 1,
        id: "pricing",
        name: "Pricing",
        createdAt: now,
        updatedAt: now,
        createdBy: "test",
        settings: {},
      })
      await writeDoc("pricing", "explorer", [
        {
          id: "tiers",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "Team is $49 a month", styles: {} }],
          children: [],
        },
      ])
      await resolveParticipant(finn, { name: "Finn" })
      caller = ownerIdentity()
    })

    afterEach(async () => {
      if (preview === undefined) delete process.env.WORKTABLE_MCP_PREVIEW
      else process.env.WORKTABLE_MCP_PREVIEW = preview
      setWorkspaceRootOverride(null)
      setAppDirOverride(null)
      await rm(root, { recursive: true, force: true })
      await rm(appDir, { recursive: true, force: true })
    })

    it("offers an agent from its first call to Worktable", async () => {
      const atlas = {
        id: "token:atlas",
        type: "agent" as const,
        displayName: "Atlas",
        authorizedBy: "local:owner",
      }
      const server = createWorktableMcpServer({
        version: "test",
        surface: "preview",
        scopes: ["*"],
        identity: { agent: "codex", principal: atlas },
        principal: atlas,
      })
      const client = new Client({ name: "codex", version: "1" })
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverSide), client.connect(clientSide)])
      await client.callTool({
        name: "worktable_docs_read",
        arguments: { request: { action: "read", spaceId: "pricing", docPath: "explorer" } },
      })
      await client.close()

      const response = await app.fetch(
        new Request("http://localhost/api/spaces/pricing/annotations/recipients")
      )
      const { participants } = (await response.json()) as {
        participants: Array<{ name: string }>
      }
      expect(participants.map((participant) => participant.name)).toContain("Codex")
    })

    it("waits on its recipient until they reply, and asks again when the commenter answers", async () => {
      const created = await post("", {
        target: { type: "block", docPath: "explorer", blockId: "tiers" },
        category: "comment",
        body: "Feels high for three people.",
        to: ["Finn"],
      })
      expect(created.status).toBe(200)
      expect(statuses(created.json.annotation)).toEqual([["Finn", "open"]])
      const id = created.json.annotation.id

      caller = finn
      const owner = (await resolveParticipant(ownerIdentity())).participant
      const answered = await post(`/${id}/replies`, {
        body: "I saw this. Should I lower it?",
        to: [owner.id],
      })
      // An agent's reply asks only whom it names, and the ask is Finn's.
      expect(statuses(answered.json.annotation)).toEqual([
        ["Finn", "replied"],
        [owner.name, "open"],
      ])
      expect((await listPending(ownerIdentity())).items).toMatchObject([
        {
          kind: "commentRequest",
          from: { kind: "agent", id: "token:finn" },
          excerpt: "I saw this. Should I lower it?",
        },
      ])
      expect(answered.json.annotation.requests?.[0]?.replyId).toBe(
        answered.json.annotation.thread[0]?.id
      )

      // Another reply from Finn asks nobody: agents don't wake each other.
      const again = await post(`/${id}/replies`, { body: "Waiting on you." })
      expect(statuses(again.json.annotation)).toEqual([
        ["Finn", "replied"],
        [owner.name, "open"],
      ])

      caller = ownerIdentity()
      const followUp = await post(`/${id}/replies`, { body: "Yes, try $39." })
      expect(statuses(followUp.json.annotation)).toEqual([
        ["Finn", "replied"],
        [owner.name, "replied"],
        ["Finn", "open"],
      ])
    })

    it("refuses a recipient this Space can't send comments to, or sending without previews, and keeps nothing", async () => {
      const refused = await post("", {
        target: { type: "doc", docPath: "explorer" },
        category: "comment",
        body: "For someone else.",
        to: ["Nobody"],
      })
      expect(refused.status).toBe(400)
      expect(refused.json.code).toBe("COMMENT_RECIPIENT")

      process.env.WORKTABLE_MCP_PREVIEW = "0"
      const released = await post("", {
        target: { type: "doc", docPath: "explorer" },
        category: "comment",
        body: "For Finn.",
        to: ["Finn"],
      })
      expect(released.status).toBe(400)
      process.env.WORKTABLE_MCP_PREVIEW = "1"

      const plain = await post("", {
        target: { type: "doc", docPath: "explorer" },
        category: "comment",
        body: "Just a note.",
      })
      expect(plain.status).toBe(200)
      expect(plain.json.annotation.requests).toBeUndefined()
    })

    it("waits in the recipient's pending list, and keeps its place across a restart", async () => {
      // As at boot: the list is built before anything is sent.
      await pendingList()
      const changes: PendingChange[] = []
      const stop = onPendingChange((change) => changes.push(change))
      try {
        const finnId = (await resolveParticipant(finn)).participant.id
        const created = await post("", {
          target: { type: "block", docPath: "explorer", blockId: "tiers" },
          category: "comment",
          body: "Feels high for three people.",
          to: ["Finn"],
        })
        const id = created.json.annotation.id
        const first = await pendingFor(finnId)
        expect(first.map((entry) => [entry.kind, entry.revision])).toEqual([
          ["comment", 1],
        ])
        expect(first[0]?.source).toMatchObject({
          kind: "comment",
          annotationId: id,
          path: "explorer",
          excerpt: "Feels high for three people.",
        })

        caller = finn
        await post(`/${id}/replies`, { body: "Should I lower it?" })
        expect(await pendingFor(finnId)).toEqual([])
        caller = ownerIdentity()
        await post(`/${id}/replies`, { body: "Yes, try $39." })
        const second = await pendingFor(finnId)
        expect(second.map((entry) => entry.revision)).toEqual([2])
        expect(changes.map((change) => change.type === "closed" ? `closed:${change.reason}` : "added")).toEqual([
          "added",
          "closed:replied",
          "added",
        ])

        // A restart rebuilds the list from the comments; the open item keeps
        // its revision and is not announced again.
        await savePendingList()
        notifyWorkspaceChange({ type: "workspaceReset" })
        const rebuilt = await pendingFor(finnId)
        expect(rebuilt.map((entry) => [entry.itemId, entry.revision])).toEqual([
          [second[0]!.itemId, 2],
        ])
        expect(changes).toHaveLength(3)

        // A restart that can't read the comments forgets nothing: once they
        // read again, the item keeps its place and isn't announced again.
        const files = (await readdir(root, { recursive: true }))
          .map(String)
          .filter((file) => file.endsWith("annotations.json"))
        const saved = await Promise.all(files.map((file) => readFile(join(root, file), "utf8")))
        await Promise.all(files.map((file) => writeFile(join(root, file), "{")))
        notifyWorkspaceChange({ type: "workspaceReset" })
        expect(await pendingFor(finnId)).toEqual([])
        await savePendingList()
        await Promise.all(files.map((file, index) => writeFile(join(root, file), saved[index]!)))
        notifyWorkspaceChange({ type: "workspaceReset" })
        const recovered = await pendingFor(finnId)
        expect(recovered.map((entry) => [entry.itemId, entry.revision])).toEqual([
          [second[0]!.itemId, 2],
        ])
        expect(changes).toHaveLength(3)
      } finally {
        stop()
      }
    })

    it("shows a person the comments an agent sends them", async () => {
      caller = finn
      await post("", {
        target: { type: "doc", docPath: "explorer" },
        category: "comment",
        body: "Which price should I use?",
        to: [(await resolveParticipant(ownerIdentity())).participant.id],
      })
      const items = (await listPending(ownerIdentity())).items
      expect(items).toMatchObject([
        {
          kind: "commentRequest",
          spaceId: "pricing",
          docPath: "explorer",
          from: { kind: "agent", id: "token:finn" },
          excerpt: "Which price should I use?",
        },
      ])
      expect(items[0]).not.toHaveProperty("agent")
    })

    it("lets the agent count, read and open what waits on it, and tells the commenter how far it got", async () => {
      await pendingList()
      const sent = await post("", {
        target: { type: "doc", docPath: "explorer" },
        category: "comment",
        body: "Feels high for three people.",
        to: ["Finn"],
      })
      const id = sent.json.annotation.id

      // Counting changes nothing.
      expect(await readPending(finn)).toEqual({ revision: 1, count: 1 })
      expect((await list())[0]?.requests?.[0]?.deliveredAt).toBeUndefined()

      const read = await readPending(finn, { mode: "notices", scope: { spaceId: "pricing", docPath: "explorer" } })
      expect(read.items).toMatchObject([
        {
          kind: "comment",
          annotationId: id,
          docPath: "explorer",
          excerpt: "Feels high for three people.",
          onTopic: true,
          open: { tool: "worktable_annotations_read", request: { action: "read", annotationId: id } },
        },
      ])
      const delivered = (await list())[0]?.requests?.[0]
      expect(delivered?.deliveredAt).toBeString()
      expect(delivered?.readAt).toBeUndefined()

      await markOpened(finn, { kind: "comment", annotationId: id })
      expect((await list())[0]?.requests?.[0]?.readAt).toBeString()

      // Only newer items after a revision; an unknown revision reads as
      // everything not yet shown.
      await post("", {
        target: { type: "doc", docPath: "explorer" },
        category: "comment",
        body: "And the Business tier?",
        to: ["Finn"],
      })
      const newer = await readPending(finn, { mode: "notices", since: read.revision })
      expect(newer.items?.map((item) => item.excerpt)).toEqual(["And the Business tier?"])
      expect(await readPending(finn, { since: 999 })).toMatchObject({ count: 0 })
    })
  })
}
