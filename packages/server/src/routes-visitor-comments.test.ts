import { afterEach, beforeEach, expect, it } from "bun:test"
import { Hono } from "hono"
import { defaultSharingPolicy } from "@worktable/types"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { setLinkedSharing } from "./linked-sharing.ts"
import { closeShareLinkStores } from "./share-links-store.ts"
import { sharesRouter } from "./routes/shares.ts"
import { pendingRouter } from "./routes/activity.ts"
import { documentsRouter } from "./routes/documents.ts"
import { wsManager } from "./ws.ts"
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
  visitorCommentStoreFile,
  VisitorCommentRefused,
} from "./visitor-comment-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import {
  VISITOR_HEADERS,
  SHARE_CAPABILITY_HEADER,
  SHARE_COMMENT_CURSOR_HEADER,
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
  server.route("/api/pending", pendingRouter)
  server.route("/api/spaces/:spaceId/documents", documentsRouter)
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
  // JSON escaping expands control characters before the existing text cleanup.
  const expanded = "\u0001".repeat(1500) + "Visible after cleanup"
  expect(Buffer.byteLength(JSON.stringify({ body: expanded }))).toBeGreaterThan(
    8192
  )
  expect((await send(expanded, "request_encoded_body")).status).toBe(201)
  // A spike remains durable across unrelated edits, but only current comment
  // links offer an actionable pause in Pending. Retained comments still belong
  // to the document after their link is downgraded or revoked.
  for (let index = 0; index < 31; index++) {
    try {
      receiveVisitorComment({
        worktableId: context.worktableId,
        linkId: made.link.id,
        linkLabel: "Original label",
        linkCreator: owner.principal.id,
        documentId,
        spaceId: "space",
        kind: "doc",
        visitorName: "Visitor",
        visitorKey: index.toString(16).padStart(64, "0"),
        clientKey: index.toString(16).padStart(32, "0"),
        body: "Synthetic review",
        requestId: `spike-request-${index}`,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(VisitorCommentRefused)
      break
    }
  }
  expect(commentPause(context.worktableId, made.link.id)).toBe("spike")
  const inbox = async () => {
    const response = await server.request("/api/pending")
    expect(response.status).toBe(200)
    return (await response.json()).items as Array<{
      kind: string
      linkId?: string
      linkLabel?: string
    }>
  }
  expect(await inbox()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "visitorCommentsPaused",
        linkId: made.link.id,
      }),
    ])
  )
  const change = (body: unknown) =>
    server.request(`/api/shares/links/${made.link.id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify(body),
    })
  closeVisitorCommentStores()
  const privatePath = visitorCommentStoreFile()
  const privateBytes = await readFile(privatePath)
  for (const unavailable of ["future", "corrupt"]) {
    try {
      if (unavailable === "future") {
        const future = new Database(privatePath)
        future.exec("PRAGMA user_version=99")
        future.close()
      } else await writeFile(privatePath, "Not a SQLite database")
      for (const path of [
        "/api/shares/links?kind=doc&spaceId=space&path=report",
        "/api/shares/links/all",
      ])
        expect((await server.request(path)).status).toBe(200)
      const saved = await change({ label: "Current label" })
      expect(saved.status).toBe(200)
      expect((await saved.json()).link.label).toBe("Current label")
      expect(await inbox()).toEqual([])
      expect(
        (
          await server.request(
            `/api/spaces/space/visitor-comments?documentId=${documentId}`
          )
        ).status
      ).toBe(503)
    } finally {
      closeVisitorCommentStores()
      await writeFile(privatePath, privateBytes)
    }
  }
  expect(commentPause(context.worktableId, made.link.id)).toBe("spike")
  expect(await inbox()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "visitorCommentsPaused",
        linkLabel: "Current label",
      }),
    ])
  )
  expect((await change({ level: "view" })).status).toBe(200)
  expect(
    (await inbox()).some((item) => item.kind === "visitorCommentsPaused")
  ).toBe(false)
  expect((await inbox()).some((item) => item.kind === "visitorComments")).toBe(
    true
  )
  expect((await change({ level: "comment" })).status).toBe(200)
  expect(
    (await inbox()).some((item) => item.kind === "visitorCommentsPaused")
  ).toBe(true)
  expect(
    (
      await server.request(`/api/shares/links/${made.link.id}`, {
        method: "DELETE",
      })
    ).status
  ).toBe(200)
  expect(
    (await inbox()).some((item) => item.kind === "visitorCommentsPaused")
  ).toBe(false)
  expect((await inbox()).some((item) => item.kind === "visitorComments")).toBe(
    true
  )

  await writeDoc("space", "empty", "# Empty")
  const fresh = await server.request("/api/shares/links", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      target: { kind: "doc", spaceId: "space", path: "empty" },
      level: "comment",
    }),
  })
  expect(fresh.status).toBe(201)
  const freshLink = (await fresh.json()).link
  const pageSummary = async () =>
    (
      await (
        await server.request("/api/spaces/space/documents/page?path=empty")
      ).json()
    ).page.sharing.visitorComments
  expect(await pageSummary()).toMatchObject({
    documentId: freshLink.documentId,
    available: true,
  })
  const notices: string[] = []
  const socket = {
    data: { identity: owner, spaceId: "space", canAccess: () => true },
    send: (message: string) => notices.push(message),
    close() {},
  }
  wsManager.subscribe(socket, "space")
  try {
    expect(
      (
        await server.request(`/api/shares/links/${freshLink.id}`, {
          method: "DELETE",
        })
      ).status
    ).toBe(200)
    expect(
      notices
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === "visitor_comments_changed")
    ).toEqual([
      {
        type: "visitor_comments_changed",
        spaceId: "space",
        data: { documentId: freshLink.documentId, linkId: freshLink.id },
      },
    ])
    expect(await pageSummary()).toMatchObject({ available: false })
  } finally {
    wsManager.unsubscribe(socket)
  }
})

it("pages complete visitor history within row and byte limits using current access", async () => {
  const server = app(owner, true)
  const json = { "Content-Type": "application/json" }
  const policy = { ...defaultSharingPolicy(), levels: ["view", "comment"] }
  expect(
    (
      await server.request("/api/shares/policy", {
        method: "PUT",
        headers: json,
        body: JSON.stringify(policy),
      })
    ).status
  ).toBe(200)
  const makeLink = async () => {
    const response = await server.request("/api/shares/links", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        target: { kind: "doc", spaceId: "space", path: "report" },
        level: "comment",
      }),
    })
    expect(response.status).toBe(201)
    return response.json()
  }
  const made = await makeLink()
  const change = (comments: { visitorsSee: "own" | "all" }) =>
    server.request(`/api/shares/links/${made.link.id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ comments }),
    })
  expect((await change({ visitorsSee: "all" })).status).toBe(200)
  const visitorKey = "a".repeat(64)
  const headers = {
    [SHARE_CAPABILITY_HEADER]: made.url.split("/").at(-1),
    [VISITOR_HEADERS.KEY]: visitorKey,
  }
  const namespace = await visitorCommentNamespace()
  receiveVisitorComment({
    worktableId: namespace.worktableId,
    linkId: made.link.id,
    linkLabel: "History",
    linkCreator: owner.principal.id,
    documentId,
    spaceId: "space",
    kind: "doc",
    visitorName: "Visitor",
    visitorKey,
    clientKey: "b".repeat(32),
    body: "Seed",
    requestId: "history_seed",
  })
  closeVisitorCommentStores()
  const fixture = new Database(visitorCommentStoreFile())
  const seed = fixture
    .query("SELECT * FROM visitor_comments LIMIT 1")
    .get() as Record<string, string | number | null>
  fixture.close()
  const columns = Object.keys(seed)
  // Seed persisted history directly so the fixture does not bypass admission
  // limits in product code or spend hundreds of requests creating old receipts.
  const seedHistory = (count: number, withReplies = false) => {
    closeVisitorCommentStores()
    const db = new Database(visitorCommentStoreFile())
    try {
      db.transaction(() => {
        db.exec("DELETE FROM visitor_replies")
        db.exec("DELETE FROM visitor_comments")
        const insert = db.query(
          `INSERT INTO visitor_comments(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`
        )
        const reply = db.query(
          "INSERT INTO visitor_replies(id,comment_id,author_id,author_name,body,created_at) VALUES(?,?,?,?,?,?)"
        )
        for (let i = 0; i < count; i++) {
          const row = {
            ...seed,
            id: `vc_${i.toString(16).padStart(22, "0")}`,
            request_id: `history_${i}`,
            visitor_key: i % 2 === 0 ? visitorKey : "c".repeat(64),
            body: withReplies ? "界".repeat(2000) : `Comment ${i}`,
          }
          insert.run(
            ...columns.map((column) => row[column as keyof typeof row])
          )
          if (withReplies)
            for (let j = 0; j < 20; j++)
              reply.run(
                `vr_${(i * 20 + j).toString(16).padStart(22, "0")}`,
                row.id,
                owner.principal.id,
                "Owner",
                "界".repeat(2000),
                seed.received_at as number
              )
        }
      })()
    } finally {
      db.close()
    }
  }
  interface Page {
    visitorsSee: "own" | "all"
    comments: Array<{ id: string; mine: boolean; replies: unknown[] }>
    nextCursor: string | null
    reset?: true
  }
  const read = async (cursor?: string, extra: Record<string, string> = {}) => {
    const response = await server.request("/public/share/comments", {
      headers: {
        ...headers,
        ...extra,
        ...(cursor ? { [SHARE_COMMENT_CURSOR_HEADER]: cursor } : {}),
      },
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024 * 1024)
    return JSON.parse(body) as Page
  }
  const history = async () => {
    const ids: string[] = []
    const sizes: number[] = []
    let cursor: string | undefined
    do {
      const page = await read(cursor)
      sizes.push(page.comments.length)
      ids.push(...page.comments.map((row) => row.id))
      expect(page.nextCursor).not.toBe(cursor)
      cursor = page.nextCursor ?? undefined
      expect(sizes.length).toBeLessThan(30)
    } while (cursor)
    expect(new Set(ids).size).toBe(ids.length)
    return { ids, sizes }
  }
  const expectedIds = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => `vc_${(count - i - 1).toString(16).padStart(22, "0")}`
    )
  seedHistory(206)
  expect(await history()).toEqual({
    ids: expectedIds(206),
    sizes: [100, 100, 6],
  })
  const first = await read()
  expect(first.nextCursor).not.toBeNull()
  const oldCursor = first.nextCursor!
  expect(
    (
      await server.request("/public/share/comments", {
        headers: {
          ...headers,
          [SHARE_COMMENT_CURSOR_HEADER]: "invalid!",
        },
      })
    ).status
  ).toBe(400)
  expect(
    (await read(oldCursor, { [VISITOR_HEADERS.KEY]: "c".repeat(64) })).reset
  ).toBe(true)
  expect((await change({ visitorsSee: "own" })).status).toBe(200)
  const restricted = await read(oldCursor)
  expect(restricted.reset).toBe(true)
  expect(restricted.visitorsSee).toBe("own")
  expect(restricted.comments.every((row) => row.mine)).toBe(true)
  expect((await history()).ids).toEqual(
    expectedIds(206).filter((id) => parseInt(id.slice(3), 16) % 2 === 0)
  )
  const otherLink = await makeLink()
  expect(
    await read(oldCursor, {
      [SHARE_CAPABILITY_HEADER]: otherLink.url.split("/").at(-1),
    })
  ).toMatchObject({ reset: true, comments: [], nextCursor: null })
  expect((await change({ visitorsSee: "all" })).status).toBe(200)
  // Replies make the byte limit take effect before the row limit. The next
  // boundary must follow the last returned receipt, not the last loaded row.
  seedHistory(20, true)
  const large = await read()
  expect(large.comments.length).toBeGreaterThan(0)
  expect(large.comments.length).toBeLessThan(20)
  expect(large.comments.every((row) => row.replies.length === 20)).toBe(true)
  expect((await history()).ids).toEqual(expectedIds(20))
  expect(
    (
      await server.request("/api/shares/policy", {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ ...policy, allowVisitorsSeeAll: false }),
      })
    ).status
  ).toBe(200)
  expect(await read(large.nextCursor!)).toMatchObject({
    reset: true,
    visitorsSee: "own",
  })
  expect(
    (
      await server.request(`/api/shares/links/${made.link.id}`, {
        method: "DELETE",
      })
    ).status
  ).toBe(200)
  expect(
    (
      await server.request("/public/share/comments", {
        headers: {
          ...headers,
          [SHARE_COMMENT_CURSOR_HEADER]: large.nextCursor!,
        },
      })
    ).status
  ).toBe(404)
})
