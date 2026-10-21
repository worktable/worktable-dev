import { afterEach, beforeEach, expect, it } from "bun:test"
import { Hono } from "hono"
import { defaultSharingPolicy } from "@worktable/types"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { setLinkedSharing } from "./linked-sharing.ts"
import { closeShareLinkStores } from "./share-links-store.ts"
import { sharesRouter } from "./routes/shares.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TokenIdentity } from "./token-store.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { useResolvedDocumentHandle } from "./document-query.ts"
import { createPublicVisitorCommentsRouter } from "./routes/public-visitor-comments.ts"
import { visitorCommentsRouter } from "./routes/visitor-comments.ts"
import { writeDoc, writeSpace } from "./store.ts"
import { visitorCommentNamespace } from "./visitor-comment-access.ts"
import {
  closeVisitorCommentStores,
  commentPause,
  pauseVisitorComments,
  receiveVisitorComment,
} from "./visitor-comment-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import {
  VISITOR_HEADERS,
  SHARE_CAPABILITY_HEADER,
} from "@worktable/hosted-contract"
const originalEnv = { ...process.env }
let appDir: string
let root: string
let documentId: string
const owner: TokenIdentity = {
  user: "owner",
  workspace: "test",
  credentialClass: "local",
  scopes: ["*"],
  agent: null,
  principal: { id: "local:owner", type: "human", displayName: "Owner" },
}
function app(identity = owner, trustedVisitor = false) {
  const server = new Hono()
  server.use("*", async (c, next) => {
    c.set("identity", identity)
    return next()
  })
  server.route("/api/spaces/:spaceId/visitor-comments", visitorCommentsRouter)
  server.route("/api/shares", sharesRouter)
  server.route(
    "/public/share/comments",
    createPublicVisitorCommentsRouter(trustedVisitor)
  )
  return server
}
beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "comment-routes-private-"))
  root = await mkdtemp(join(tmpdir(), "comment-routes-workspace-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(root)
  process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
  delete process.env["WORKTABLE_HOSTED"]
  ensureWorkspaceManifest()
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "space",
    name: "Space",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  await writeDoc("space", "report", "# Report")
  const materialized = await useResolvedDocumentHandle(
    { spaceId: "space", path: "report", materializeIdentity: true },
    (handle) => handle.documentId
  )
  if (typeof materialized !== "string")
    throw new Error("Expected a durable fixture document")
  documentId = materialized
  await getWorkspaceCollaborationEpoch()
  setLinkedSharing({
    workspaceId: "ws_synthetic",
    shareOrigin: "https://share.example.test",
    htmlShareOrigin: "https://html.example.test",
  })
})
afterEach(async () => {
  closeVisitorCommentStores()
  closeShareLinkStores()
  setLinkedSharing(null)
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  process.env = { ...originalEnv }
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(root, { recursive: true, force: true }),
  ])
})
it("keeps visitor text behind the person boundary even when agents have every scope", async () => {
  const namespace = await visitorCommentNamespace()
  const made = receiveVisitorComment({
    worktableId: namespace.worktableId,
    linkId: "link",
    linkLabel: "Client",
    linkCreator: owner.principal.id,
    documentId,
    spaceId: "space",
    kind: "doc",
    visitorName: "Visitor",
    visitorKey: "a".repeat(64),
    clientKey: "b".repeat(32),
    body: "PRIVATE_VISITOR_SENTINEL",
    requestId: "request01",
  })
  const url = `/api/spaces/space/visitor-comments?documentId=${documentId}`
  const person = await app().request(url)
  expect(person.status).toBe(200)
  const reply = await person.json()
  expect(reply.comments[0].body).toBe("PRIVATE_VISITOR_SENTINEL")
  expect(JSON.stringify(reply)).not.toContain("visitor_key")
  const identities: TokenIdentity[] = [
    {
      ...owner,
      agent: "labelled",
      principal: { id: "agent:labelled", type: "agent", displayName: "Agent" },
    },
    {
      ...owner,
      principal: {
        id: "agent:resource",
        type: "agent",
        displayName: "Resource",
      },
    },
    { ...owner, agent: "agent" },
    { ...owner, operatorVerification: true },
  ]
  for (const identity of identities) {
    const server = app(identity)
    const read = await server.request(url)
    expect(read.status).toBe(403)
    expect(await read.text()).not.toContain("PRIVATE_VISITOR_SENTINEL")
    expect(
      (
        await server.request(
          `/api/spaces/space/visitor-comments/${made.id}/done`,
          { method: "POST" }
        )
      ).status
    ).toBe(403)
    expect(
      (
        await server.request(`/api/spaces/space/visitor-comments/${made.id}`, {
          method: "DELETE",
        })
      ).status
    ).toBe(403)
  }
  expect(
    (
      await app().request(
        `/api/spaces/space/visitor-comments/${made.id}/replies`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: "Team reply" }),
        }
      )
    ).status
  ).toBe(201)
  const updated = await (await app().request(url)).json()
  expect(updated.comments[0].replies[0].body).toBe("Team reply")
  expect(
    (
      await app().request(`/api/spaces/space/visitor-comments/${made.id}`, {
        method: "DELETE",
      })
    ).status
  ).toBe(200)
  expect((await (await app().request(url)).json()).comments).toEqual([])
})
it("does not accept forged verified-visitor headers on the ordinary local HTTP surface", async () => {
  const headers = {
    "Content-Type": "application/json",
    [SHARE_CAPABILITY_HEADER]: "T".repeat(43),
    [VISITOR_HEADERS.KEY]: "a".repeat(64),
    [VISITOR_HEADERS.CLIENT]: "b".repeat(32),
    [VISITOR_HEADERS.VERIFIED]: "1",
  }
  const request = await app().request("/public/share/comments", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Visitor",
      body: "forged",
      requestId: "request01",
    }),
  })
  expect(request.status).toBe(403)
  expect((await request.json()).code).toBe("GATEWAY_REQUIRED")
})

it("isolates visitors on a comment link and rechecks link settings after a held body", async () => {
  const server = app(owner, true)
  const json = { "Content-Type": "application/json" }
  expect(
    (
      await server.request("/api/shares/policy", {
        method: "PUT",
        headers: json,
        body: JSON.stringify({
          ...defaultSharingPolicy(),
          levels: ["view", "comment"],
        }),
      })
    ).status
  ).toBe(200)
  const created = await server.request("/api/shares/links", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      target: { kind: "doc", spaceId: "space", path: "report" },
      level: "comment",
    }),
  })
  expect(created.status).toBe(201)
  const made = await created.json()
  expect(made.link.level).toBe("comment")
  const token = made.url.split("/").at(-1)
  const headers = {
    ...json,
    [SHARE_CAPABILITY_HEADER]: token,
    [VISITOR_HEADERS.KEY]: "a".repeat(64),
    [VISITOR_HEADERS.CLIENT]: "b".repeat(32),
    [VISITOR_HEADERS.VERIFIED]: "1",
  }
  const send = (
    body: string,
    requestId: string,
    extra: Record<string, string> = {}
  ) =>
    server.request("/public/share/comments", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify({ name: "Visitor", body, requestId }),
    })
  expect(
    (await send("VISIBLE_ONLY_TO_VISITOR_A", "request_visitor_a")).status
  ).toBe(201)
  expect(
    (
      await send("VISIBLE_ONLY_TO_VISITOR_B", "request_visitor_b", {
        [VISITOR_HEADERS.KEY]: "c".repeat(64),
      })
    ).status
  ).toBe(201)
  const mine = await (
    await server.request("/public/share/comments", { headers })
  ).json()
  expect(mine.comments.map((row: { body: string }) => row.body)).toEqual([
    "VISIBLE_ONLY_TO_VISITOR_A",
  ])
  const other = await (
    await server.request("/public/share/comments", {
      headers: { ...headers, [VISITOR_HEADERS.KEY]: "c".repeat(64) },
    })
  ).json()
  expect(other.comments.map((row: { body: string }) => row.body)).toEqual([
    "VISIBLE_ONLY_TO_VISITOR_B",
  ])
  const snapshot = async () => {
    const base = join(appDir, "visitor-comments")
    const [directory] = await readdir(base)
    const files = await readdir(join(base, directory!))
    return Promise.all(
      files.sort().map(async (file) =>
        createHash("sha256")
          .update(await readFile(join(base, directory!, file)))
          .digest("hex")
      )
    )
  }
  closeVisitorCommentStores()
  const before = await snapshot()
  expect(
    (
      await server.request("/public/share/comments", {
        method: "HEAD",
        headers,
      })
    ).status
  ).toBe(200)
  await server.request("/public/share/comments", { headers })
  expect(await snapshot()).toEqual(before)
  let startRead!: () => void
  const reading = new Promise<void>((resolve) => {
    startRead = resolve
  })
  let finishBody!: () => void
  const complete = new Promise<void>((resolve) => {
    finishBody = resolve
  })
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      name: "Visitor",
      body: "must not be saved",
      requestId: "request_held_body",
    })
  )
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        startRead()
        await complete
        controller.enqueue(bytes)
        controller.close()
      },
    },
    { highWaterMark: 0 }
  )
  const pending = server.fetch(
    new Request("https://runtime.example.test/public/share/comments", {
      method: "POST",
      headers,
      body: stream,
    })
  )
  await reading
  try {
    expect(
      (
        await server.request(`/api/shares/links/${made.link.id}`, {
          method: "PATCH",
          headers: json,
          body: JSON.stringify({ comments: { acceptComments: false } }),
        })
      ).status
    ).toBe(200)
  } finally {
    finishBody()
  }
  expect((await pending).status).toBe(404)
  expect((await send("paused", "request_paused_body")).status).toBe(409)
  const after = await (
    await server.request("/public/share/comments", { headers })
  ).json()
  expect(after.accepting).toBe(false)
  expect(after.comments.map((row: { body: string }) => row.body)).not.toContain(
    "must not be saved"
  )
  const context = await visitorCommentNamespace()
  pauseVisitorComments(context.worktableId, made.link.id, true)
  expect(commentPause(context.worktableId, made.link.id)).not.toBeNull()
  expect(
    (
      await server.request(`/api/shares/links/${made.link.id}`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ comments: { acceptComments: true } }),
      })
    ).status
  ).toBe(200)
  expect(commentPause(context.worktableId, made.link.id)).toBeNull()
  expect(
    (await (await server.request("/public/share/comments", { headers })).json())
      .accepting
  ).toBe(true)
  expect((await send("Resumed", "request_resumed_body")).status).toBe(201)
})
