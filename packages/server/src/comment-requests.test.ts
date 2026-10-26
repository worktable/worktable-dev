import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { Annotation } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import { resolveParticipant } from "./participant-store.ts"
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
      const answered = await post(`/${id}/replies`, {
        body: "I saw this. Should I lower it?",
      })
      expect(statuses(answered.json.annotation)).toEqual([["Finn", "replied"]])
      expect(answered.json.annotation.requests?.[0]?.replyId).toBe(
        answered.json.annotation.thread[0]?.id
      )

      // Another reply from Finn asks nobody: agents don't wake each other.
      const again = await post(`/${id}/replies`, { body: "Waiting on you." })
      expect(statuses(again.json.annotation)).toEqual([["Finn", "replied"]])

      caller = ownerIdentity()
      const followUp = await post(`/${id}/replies`, { body: "Yes, try $39." })
      expect(statuses(followUp.json.annotation)).toEqual([
        ["Finn", "replied"],
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
  })
}
