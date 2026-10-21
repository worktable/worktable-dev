import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { Hono } from "hono"
import { SignJWT, exportJWK, generateKeyPair } from "jose"
import { ACTOR_HEADERS, GATEWAY_HEADER } from "@worktable/hosted-contract"
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { createAnnotation } from "./annotation-store.ts"
import { requireIdentity, trustedLocalIdentity, verifyBearer } from "./auth.ts"
import { resetAuthServerJwtState } from "./oauth-jwt.ts"
import { useResolvedDocumentHandle } from "./document-query.ts"
import * as documentQuery from "./document-query.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { warmSearchIndex } from "./search-index.ts"
import { activityRouter, pendingRouter } from "./routes/activity.ts"
import { annotationsRouter } from "./routes/annotations.ts"
import { documentsRouter } from "./routes/documents.ts"
import { searchRouter } from "./routes/search.ts"
import { visitorCommentsRouter } from "./routes/visitor-comments.ts"
import { workspaceRouter } from "./routes/workspace.ts"
import { readSpace, writeDoc, writeSpace } from "./store.ts"
import { activateLocalTeams } from "./team-activation.ts"
import { clearTeamAuthInstances, getTeamAuth } from "./team-auth.ts"
import { closeTeamDatabases, currentTeamWorktable } from "./team-database.ts"
import { findTeamMember } from "./team-members.ts"
import {
  bindTeamAgentCredential,
  createTeamAgent,
  runWithTeamIdentity,
  setSpaceAccessPolicy,
} from "./team-policy.ts"
import { createToken, type TokenIdentity } from "./token-store.ts"
import {
  notifyVisitorComments,
  notifyRetainedVisitorComments,
  visitorCommentNamespace,
} from "./visitor-comment-access.ts"
import {
  closeVisitorCommentStores,
  receiveVisitorComment,
  sweepVisitorComments,
} from "./visitor-comment-store.ts"
import * as visitorStore from "./visitor-comment-store.ts"
import { pendingVisitorComments } from "./visitor-comment-pending.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import {
  writeWorkspaceExportV2,
  extractWorkspaceExportV2,
} from "./workspace-transfer-v2.ts"
import { wsManager } from "./ws.ts"

const originalEnv = { ...process.env }
let appDir: string
let root: string
beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "visitor-quarantine-app-"))
  root = await mkdtemp(join(tmpdir(), "visitor-quarantine-workspace-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
  process.env["WORKTABLE_RECORDS_INDEX"] = "0"
  delete process.env["WORKTABLE_HOSTED"]
  delete process.env["WORKTABLE_AUTH_SERVER_URL"]
  delete process.env["WORKTABLE_PUBLIC_URL"]
  delete process.env["WORKTABLE_REQUIRE_AUTH"]
  process.env["HOST"] = "127.0.0.1"
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "space",
    name: "Space",
    settings: {},
    createdBy: "user",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  await writeDoc("space", "report", "# Report\nPUBLIC_CONTROL")
})
afterEach(async () => {
  wsManager.closeAll()
  closeVisitorCommentStores()
  clearTeamAuthInstances()
  closeTeamDatabases()
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  process.env = { ...originalEnv }
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(root, { recursive: true, force: true }),
  ])
})

function surface() {
  const app = new Hono()
  app.use("/api/*", trustedLocalIdentity())
  app.route("/api/activity", activityRouter)
  app.route("/api/pending", pendingRouter)
  app.route("/api/search", searchRouter)
  app.route("/api/workspace", workspaceRouter)
  app.route("/api/spaces/:spaceId/documents", documentsRouter)
  app.route("/api/spaces/:spaceId/annotations", annotationsRouter)
  app.route("/api/spaces/:spaceId/visitor-comments", visitorCommentsRouter)
  return app
}

async function allBytes(directory: string): Promise<Buffer[]> {
  const result: Buffer[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await allBytes(path)))
    else if (entry.isFile()) result.push(await readFile(path))
  }
  return result
}

it("quarantines visitor text from real agent credentials, content paths, Pending, sockets and portable exports", async () => {
  const sentinel = `visitoronly${crypto.randomUUID().replaceAll("-", "")}`
  const ordinary = await createAnnotation("space", {
    target: { type: "doc", docPath: "report" },
    category: "comment",
    body: "PUBLIC_ANNOTATION",
    author: { type: "user", id: "user" },
  })
  const resolvedDocumentId = await useResolvedDocumentHandle(
    { spaceId: "space", path: "report", materializeIdentity: true },
    (handle) => handle.documentId
  )
  if (typeof resolvedDocumentId !== "string")
    throw new Error("Expected fixture document")
  const documentId: string = resolvedDocumentId
  const namespace = await visitorCommentNamespace()
  const comment = receiveVisitorComment({
    worktableId: namespace.worktableId,
    linkId: "synthetic-link",
    linkLabel: "Client",
    linkCreator: "local:owner",
    documentId,
    spaceId: "space",
    kind: "doc",
    visitorName: sentinel,
    body: sentinel,
    visitorKey: "a".repeat(64),
    clientKey: "b".repeat(32),
    requestId: "request01",
  })
  await warmSearchIndex()
  const app = surface()
  const person = await app.request(
    `/api/spaces/space/visitor-comments?documentId=${documentId}`
  )
  expect(person.status).toBe(200)
  expect(await person.text()).toContain(sentinel)
  const pending = await app.request("/api/pending")
  expect(pending.status).toBe(200)
  expect(await pending.json()).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ kind: "visitorComments", count: 1 }),
    ]),
  })

  const messages: string[] = []
  let mayEdit = true
  const owner: TokenIdentity = {
    user: "owner",
    workspace: root,
    credentialClass: "local",
    scopes: ["*"],
    agent: null,
    principal: { id: "local:owner", type: "human", displayName: "Owner" },
  }
  const { data: space } = await readSpace("space")
  if (!space) throw new Error("Expected fixture Space")
  const catalogReads = spyOn(documentQuery, "readDocumentIdentities")
  try {
    expect(
      await pendingVisitorComments(
        owner,
        [
          ...Array.from({ length: 6 }, (_, index) => ({
            ...space,
            id: `unrelated-${index}`,
          })),
          space,
        ],
        undefined,
        () => true
      )
    ).toEqual([
      expect.objectContaining({
        kind: "visitorComments",
        documentId,
        count: 1,
      }),
    ])
    expect(catalogReads.mock.calls.map(([spaceId]) => spaceId)).toEqual([
      "space",
    ])
  } finally {
    catalogReads.mockRestore()
  }
  wsManager.subscribe(
    {
      data: {
        identity: owner,
        spaceId: "space",
        canAccess: (_space, edit) => !edit || mayEdit,
      },
      send: (value) => messages.push(value),
      close() {},
    },
    "space"
  )

  async function probe(token: string) {
    const identity = await verifyBearer(token)
    expect(identity?.principal.type).toBe("agent")
    if (!identity) throw new Error("Expected an authenticated agent")
    const headers = { Authorization: `Bearer ${token}` }
    const privateRead = await app.request(
      `/api/spaces/space/visitor-comments?documentId=${documentId}`,
      { headers }
    )
    expect(privateRead.status).toBe(403)
    for (const [method, suffix] of [
      ["POST", "/replies"],
      ["POST", "/done"],
      ["DELETE", ""],
    ] as const) {
      const response = await app.request(
        `/api/spaces/space/visitor-comments/${comment.id}${suffix}`,
        {
          method,
          headers: { ...headers, "Content-Type": "application/json" },
          body: method === "POST" ? JSON.stringify({ body: "No" }) : undefined,
        }
      )
      expect(response.status).toBe(403)
    }
    for (const path of [
      "/api/activity",
      "/api/pending",
      `/api/search?query=${sentinel}`,
      "/api/spaces/space/documents/page?path=report",
      "/api/spaces/space/documents/source?path=report",
      "/api/spaces/space/annotations",
      `/api/spaces/space/annotations/${ordinary.annotation.id}?includeTargetContext=true`,
      `/api/spaces/space/annotations/${ordinary.annotation.id}/context`,
    ]) {
      const response = await app.request(path, { headers })
      // Teams keeps raw-source downloads behind its separate owner boundary.
      const expected = identity.team && path.includes("/source?") ? 403 : 200
      expect(response.status, `${identity.agent}: ${path}`).toBe(expected)
      const body = await response.text()
      expect(body).not.toContain(sentinel)
      if (path === "/api/pending")
        expect(body).not.toContain('"visitorComments')
      if (path.includes("/source?") && response.ok)
        expect(body).toContain("PUBLIC_CONTROL")
    }
    expect(
      (await app.request("/api/workspace/export", { headers })).status
    ).toBe(403)
    await runWithTeamIdentity(identity, async () => {
      const forged = {
        target: { type: "doc", docPath: "report" },
        category: "comment",
        body: "Not published",
        metadata: { "worktable.origin": {} },
      }
      for (const [method, path, body] of [
        ["POST", "/api/spaces/space/annotations", forged],
        [
          "POST",
          "/api/spaces/space/annotations",
          {
            ...forged,
            metadata: {},
            idempotencyKey: `visitor-comment:${comment.id}`,
          },
        ],
        [
          "PATCH",
          `/api/spaces/space/annotations/${ordinary.annotation.id}`,
          { metadata: { "worktable.origin": null } },
        ],
        [
          "POST",
          "/api/spaces/space/documents/annotations",
          { ...forged, path: "report" },
        ],
        [
          "PATCH",
          `/api/spaces/space/documents/annotations/${ordinary.annotation.id}`,
          { metadata: { "worktable.origin": null } },
        ],
      ] as const) {
        expect(
          (
            await app.request(path, {
              method,
              headers: { ...headers, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            })
          ).status
        ).toBe(400)
      }
      await expect(
        dispatchOperation(
          "annotations.create",
          { spaceId: "space", ...forged },
          { identity, principal: identity.principal, scopes: identity.scopes }
        )
      ).rejects.toThrow("Source metadata is set by Worktable")
      await expect(
        dispatchOperation(
          "annotations.update",
          {
            spaceId: "space",
            annotationId: ordinary.annotation.id,
            patch: { metadata: { "worktable.origin": null } },
          },
          { identity, principal: identity.principal, scopes: identity.scopes }
        )
      ).rejects.toThrow("Source metadata is set by Worktable")
      for (const [operation, args] of [
        ["annotations.list", { spaceId: "space" }],
        [
          "annotations.read",
          {
            spaceId: "space",
            annotationId: ordinary.annotation.id,
            includeTargetContext: true,
          },
        ],
        [
          "annotations.context",
          { spaceId: "space", annotationId: ordinary.annotation.id },
        ],
        ["docs.read", { spaceId: "space", docPath: "report" }],
        ["workspace.search", { query: sentinel, spaceId: "space" }],
      ] as const) {
        const result = await dispatchOperation(operation, args, {
          identity,
          principal: identity.principal,
          scopes: identity.scopes,
        })
        expect(JSON.stringify(result)).not.toContain(sentinel)
        if (operation === "docs.read")
          expect(JSON.stringify(result)).toContain("PUBLIC_CONTROL")
      }
    })
    const agentMessages: string[] = []
    wsManager.subscribe(
      {
        data: {
          identity,
          spaceId: "space",
          canAccess: () => true,
          canReadAnnotations: true,
        },
        send: (value) => agentMessages.push(value),
        close() {},
      },
      "space"
    )
    notifyVisitorComments("space", documentId, "synthetic-link")
    expect(agentMessages).toEqual([])
  }

  const solo = await createToken({ scopes: ["*"], agent: "quarantine" })
  await probe(solo.token)
  const visitorNotices = () =>
    messages
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "visitor_comments_changed")
  expect(visitorNotices()).toEqual([
    {
      type: "visitor_comments_changed",
      spaceId: "space",
      data: { documentId, linkId: "synthetic-link" },
    },
  ])
  expect(messages.join()).not.toContain(sentinel)
  mayEdit = false
  notifyVisitorComments("space", documentId, "synthetic-link")
  expect(visitorNotices()).toHaveLength(1)

  // Exercise the hosted OAuth admission path with a real signature and JWKS,
  // then the exact resolved agent identity at the private-route boundary.
  const beforeOAuth = { ...process.env }
  const pair = await generateKeyPair("RS256")
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: "RS256",
    kid: "quarantine",
  }
  let issuer = ""
  const authorizationServer = Bun.serve({
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname.endsWith("/jwks")
        ? Response.json({ keys: [jwk] })
        : Response.json({ issuer, jwks_uri: `${issuer}/jwks` })
    },
  })
  issuer = `http://127.0.0.1:${authorizationServer.port}`
  try {
    process.env["WORKTABLE_HOSTED"] = "1"
    process.env["WORKTABLE_AUTH_SERVER_URL"] = issuer
    process.env["WORKTABLE_OWNER_SUBJECT"] = "synthetic-owner"
    process.env["WORKTABLE_RESOURCE_URL"] = "https://tenant.example.test/mcp"
    process.env["WORKTABLE_GATEWAY_SECRET"] = "synthetic-quarantine-gateway"
    resetAuthServerJwtState()
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "quarantine" })
      .setIssuer(issuer)
      .setSubject("synthetic-owner")
      .setAudience(process.env["WORKTABLE_RESOURCE_URL"]!)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey)
    const headers = {
      Authorization: `Bearer ${token}`,
      [GATEWAY_HEADER]: process.env["WORKTABLE_GATEWAY_SECRET"]!,
      [ACTOR_HEADERS.ID]: "oauth:quarantine",
      [ACTOR_HEADERS.TYPE]: "agent",
      [ACTOR_HEADERS.NAME]: "Connected agent",
      [ACTOR_HEADERS.AUTHORIZED_BY]: "workos:synthetic-owner",
    }
    const gateway = new Hono()
    gateway.use("*", requireIdentity())
    gateway.get("/mcp/probe", async (c) => {
      const identity = c.get("identity") as TokenIdentity
      expect(identity.principal.type).toBe("agent")
      expect(identity.credentialClass).toBe("resource")
      const contents = await dispatchOperation(
        "annotations.list",
        { spaceId: "space" },
        { identity, principal: identity.principal, scopes: identity.scopes }
      )
      expect(JSON.stringify(contents)).toContain("PUBLIC_ANNOTATION")
      expect(JSON.stringify(contents)).not.toContain(sentinel)
      const privateSurface = new Hono()
      privateSurface.use("*", async (request, next) => {
        request.set("identity", identity)
        return next()
      })
      privateSurface.route(
        "/api/spaces/:spaceId/visitor-comments",
        visitorCommentsRouter
      )
      const refused = await privateSurface.request(
        `/api/spaces/space/visitor-comments?documentId=${documentId}`
      )
      expect(refused.status).toBe(403)
      expect(await refused.text()).not.toContain(sentinel)
      const agentMessages: string[] = []
      wsManager.subscribe(
        {
          data: { identity, spaceId: "space", canAccess: () => true },
          send: (value) => agentMessages.push(value),
          close() {},
        },
        "space"
      )
      notifyVisitorComments("space", documentId, "synthetic-link")
      expect(agentMessages).toEqual([])
      return c.json({ ok: true })
    })
    expect((await gateway.request("/mcp/probe", { headers })).status).toBe(200)
    expect(
      (
        await gateway.request("/mcp/probe", {
          headers: { ...headers, [GATEWAY_HEADER]: "forged" },
        })
      ).status
    ).toBe(401)
    const refused = await app.request(
      `/api/spaces/space/visitor-comments?documentId=${documentId}`,
      { headers }
    )
    expect(refused.status).toBe(401)
  } finally {
    authorizationServer.stop(true)
    process.env = { ...beforeOAuth }
    resetAuthServerJwtState()
  }

  // The package is inspected after decompression; compressed-byte absence
  // alone would not establish that outside text stayed out of the export.
  await mkdir(join(root, ".trash"), { recursive: true })
  await writeFile(join(root, ".trash", "control.txt"), "TRASH_CONTROL")
  const exported = await writeWorkspaceExportV2(join(appDir, "portable.wtb"), {
    history: { mode: "all" },
  })
  await extractWorkspaceExportV2(
    exported.destination,
    join(appDir, "extracted")
  )
  for (const bytes of [
    ...(await allBytes(root)),
    ...(await allBytes(join(appDir, "extracted"))),
  ])
    expect(bytes.toString()).not.toContain(sentinel)

  const activated = await activateLocalTeams(
    "http://localhost",
    {
      name: "Owner",
      email: "owner@example.test",
      password: "Synthetic-members-only-123",
    },
    owner
  )
  const issuedAgentTokens: string[] = []
  const teamAgentGrants: Array<{
    subjectType: "agent"
    subjectId: string
    access: "edit"
  }> = []
  for (const ownership of ["personal", "team"] as const) {
    const agent = createTeamAgent(
      { name: ownership, platform: "codex", ownership },
      activated.identity
    )
    const credential = await createToken({ scopes: ["*"], agent: ownership })
    bindTeamAgentCredential(
      agent.id,
      credential.metadata.principal.id,
      activated.identity
    )
    if (ownership === "team") {
      teamAgentGrants.push({
        subjectType: "agent",
        subjectId: agent.id,
        access: "edit",
      })
      setSpaceAccessPolicy(
        {
          spaceId: "space",
          visibility: "restricted",
          grants: teamAgentGrants,
        },
        activated.identity
      )
    }
    issuedAgentTokens.push(credential.token)
    await probe(credential.token)
  }
  const cookies = (headers: Headers) =>
    new Headers({
      Cookie: headers
        .getSetCookie()
        .map((cookie) => cookie.split(";", 1)[0])
        .join("; "),
    })
  const auth = await getTeamAuth("http://localhost")
  const invitation = await auth.api.createInvitation({
    headers: cookies(activated.headers),
    body: {
      organizationId: currentTeamWorktable()!.organizationId,
      email: "reviewer@example.test",
      role: "member",
    },
  })
  const enrolled = await auth.api.signUpEmail({
    body: {
      name: "Reviewer",
      email: "reviewer@example.test",
      password: "Synthetic-members-only-123",
    },
    returnHeaders: true,
  })
  const memberHeaders = cookies(enrolled.headers)
  await auth.api.acceptInvitation({
    headers: memberHeaders,
    body: { invitationId: invitation.id },
  })
  const member = findTeamMember(enrolled.response.user.id)!
  const grantMember = (access: "read" | "edit" | "manage") =>
    setSpaceAccessPolicy(
      {
        spaceId: "space",
        visibility: "restricted",
        grants: [
          ...teamAgentGrants,
          { subjectType: "member", subjectId: member.id, access },
        ],
      },
      activated.identity
    )
  const privatePath = `/api/spaces/space/visitor-comments?documentId=${documentId}`
  grantMember("read")
  expect(
    (await app.request(privatePath, { headers: memberHeaders })).status
  ).toBe(403)
  grantMember("edit")
  const editable = await app.request(privatePath, { headers: memberHeaders })
  expect(editable.status).toBe(200)
  expect(await editable.text()).toContain(sentinel)
  expect(
    (
      await app.request(`/api/spaces/space/visitor-comments/${comment.id}`, {
        method: "DELETE",
        headers: memberHeaders,
      })
    ).status
  ).toBe(403)
  grantMember("manage")
  const fallback = await app.request("/api/pending", { headers: memberHeaders })
  expect(fallback.status).toBe(200)
  expect(await fallback.json()).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ kind: "visitorComments", count: 1 }),
    ]),
  })
  grantMember("read")
  expect(
    (await app.request(privatePath, { headers: memberHeaders })).status
  ).toBe(403)
  grantMember("edit")
  const passPath = `/api/spaces/space/visitor-comments/${comment.id}/pass`
  const passHeaders = new Headers(memberHeaders)
  passHeaders.set("Content-Type", "application/json")
  const input = {
    category: "instruction",
    note: "Please check this request.",
    quote: sentinel,
    includeName: false,
  }
  const interrupted = spyOn(
    visitorStore,
    "markVisitorCommentPassed"
  ).mockImplementationOnce(() => {
    throw new visitorStore.VisitorCommentsUnavailable()
  })
  try {
    expect(
      (
        await app.request(passPath, {
          method: "POST",
          headers: passHeaders,
          body: JSON.stringify(input),
        })
      ).status
    ).toBe(503)
  } finally {
    interrupted.mockRestore()
  }
  // The ordinary annotation committed before the interruption. Retrying as
  // another member recovers it, with the first member's credit and words.
  const ownerPassHeaders = cookies(activated.headers)
  ownerPassHeaders.set("Content-Type", "application/json")
  const recovered = await app.request(passPath, {
    method: "POST",
    headers: ownerPassHeaders,
    body: JSON.stringify({ ...input, note: "A different retry note" }),
  })
  expect(recovered.status).toBe(200)
  const passed = await recovered.json()
  expect(passed.created).toBe(false)
  expect(passed.annotation.author).toMatchObject({
    type: "user",
    id: member.actorId,
    name: "Reviewer",
  })
  expect(passed.annotation.body).toStartWith(
    "Please check this request.\n\n> Outside input, unverified."
  )
  expect(passed.annotation.body).toContain(`\n> ${sentinel}`)
  expect(passed.annotation.metadata["worktable.origin"]).toMatchObject({
    kind: "visitorComment",
    v: 1,
    visitorCommentId: comment.id,
    visitorName: null,
    passedBy: { id: member.actorId },
    quote: sentinel,
    quoteEdited: false,
  })
  expect(
    visitorStore.readVisitorComment(namespace.worktableId, comment.id)
  ).toMatchObject({
    status: "passed",
    annotation_id: passed.annotation.id,
    passed_by: member.actorId,
  })
  for (const token of issuedAgentTokens) {
    const headers = { Authorization: `Bearer ${token}` }
    const visible = await app.request(
      `/api/spaces/space/annotations/${passed.annotation.id}?includeTargetContext=true`,
      { headers }
    )
    expect(visible.status).toBe(200)
    expect(await visible.text()).toContain(sentinel)
    expect((await app.request(privatePath, { headers })).status).toBe(403)
    const identity = (await verifyBearer(token))!
    await runWithTeamIdentity(identity, async () => {
      const visible = await dispatchOperation(
        "annotations.read",
        {
          spaceId: "space",
          annotationId: passed.annotation.id,
          includeTargetContext: true,
        },
        { identity, principal: identity.principal, scopes: identity.scopes }
      )
      expect(JSON.stringify(visible)).toContain(sentinel)
    })
  }
  mayEdit = true
  const noticesBeforeRetention = visitorNotices().length
  await notifyRetainedVisitorComments(
    sweepVisitorComments(Date.now() + 181 * 24 * 3_600_000)
  )
  expect(visitorNotices()).toHaveLength(noticesBeforeRetention + 1)
  expect(visitorNotices().at(-1)).toEqual({
    type: "visitor_comments_changed",
    spaceId: "space",
    data: { documentId, linkId: "synthetic-link" },
  })
  expect(messages.join()).not.toContain(sentinel)
}, 20_000)
