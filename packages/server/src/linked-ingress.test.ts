import { LinkGrantSchema, defaultSharingPolicy } from "@worktable/types"
import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import {
  HOSTED_OAUTH_SCOPES,
  LinkedHostReply,
  LINKED_ASSERTION_HEADER,
  LINKED_ASSERTION_ISSUER,
  LINKED_ASSERTION_TYPE,
  LINKED_ASSERTION_TTL_SECONDS,
  VISITOR_HEADERS,
  SHARE_COMMENT_CURSOR_HEADER,
  type ShareVisitor,
  type LinkedRequestGrant,
  type LinkedDestinationBinding,
} from "@worktable/hosted-contract"
import { createHash } from "node:crypto"
import { SignJWT } from "jose"
import { setAppDirOverride } from "./app-storage.ts"
import { rotateWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { hashSharePassword } from "./share-link-credentials.ts"
import {
  closeShareLinkStores,
  createShareLink,
  revokeShareLink,
  saveSharingPolicy,
} from "./share-links-store.ts"
import { useResolvedDocumentHandle } from "./document-query.ts"
import { createLinkedIngress } from "./linked-ingress.ts"
import {
  readGrokBotCandidates,
  readGrokBots,
  saveGrokBot,
  updateGrokBot,
  removeGrokBot,
} from "./grok-bot-store.ts"
import { postThreadMessage } from "./thread-service.ts"
import { drainWorkspaceChanges } from "./workspace-events.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import {
  createDocumentShareIfEligible,
  stopDocumentShare,
} from "./share-store.ts"
import { readDoc, readSpace, writeSpace, writeDoc } from "./store.ts"
import { closeVisitorCommentStores } from "./visitor-comment-store.ts"
import {
  setWorkspaceRootOverride,
  ensureWorkspaceManifest,
} from "./workspace.ts"
import {
  resetWorkspaceRequestLifecycleForTests,
  stopWorkspaceRequestAdmissionAndDrain,
  resumeWorkspaceRequestAdmission,
} from "./workspace-request-lifecycle.ts"

// Public server fixtures speak the contract without importing the private gateway.
async function createLinkedRequest(options: {
  origin: string
  key: Uint8Array
  binding: LinkedDestinationBinding
  grant: LinkedRequestGrant
  method: string
  path: string
  body?: Uint8Array
}): Promise<Request> {
  const body = options.body ?? new Uint8Array()
  const assertion = await new SignJWT({
    request: {
      binding: options.binding,
      grant: options.grant,
      method: options.method,
      path: options.path,
      bodyDigest: createHash("sha256").update(body).digest("hex"),
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: LINKED_ASSERTION_TYPE })
    .setIssuer(LINKED_ASSERTION_ISSUER)
    .setAudience(options.binding.destinationId)
    .setIssuedAt()
    .setExpirationTime(`${LINKED_ASSERTION_TTL_SECONDS}s`)
    .setJti(crypto.randomUUID())
    .sign(options.key)
  return new Request(new URL(options.path, options.origin), {
    method: options.method,
    headers: {
      [LINKED_ASSERTION_HEADER]: assertion,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    ...(options.method === "POST" ? { body: new Uint8Array(body).buffer } : {}),
  })
}

let directory: string
let ingress: Awaited<ReturnType<typeof createLinkedIngress>>
let server: ReturnType<typeof Bun.serve>
const key = crypto.getRandomValues(new Uint8Array(32))
const grant = {
  kind: "mcp" as const,
  principalId: "oauth:test:user_owner",
  displayName: "Test connector",
  scopes: HOSTED_OAUTH_SCOPES,
}

function newIngress(scopes = ["docs:read", "docs:write", "spaces:read"]) {
  const reply = LinkedHostReply.parse({
    state: "linked",
    publicOrigin: "https://app.example.test",
    sharingEnabled: false,
  })
  return createLinkedIngress({
    key,
    binding: {
      installationId: "installation_one",
      destinationId: "a".repeat(32),
      ownerSubject: "user_owner",
      generation: 1,
    },
    scopes,
    publicOrigin: reply.publicOrigin,
    shareOrigin: reply.sharingEnabled ? reply.shareOrigin : undefined,
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "worktable-linked-"))
  setAppDirOverride(join(directory, "app"))
  setWorkspaceRootOverride(join(directory, "workspace"))
  ensureWorkspaceManifest()
  resetWorkspaceRequestLifecycleForTests()
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
  ingress = await newIngress()
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: ingress.fetch })
})

afterEach(async () => {
  await server?.stop(true)
  await drainWorkspaceChanges()
  closeVisitorCommentStores()
  resetWorkspaceRequestLifecycleForTests()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(directory, { recursive: true, force: true })
})

async function mcpRequest(
  binding = ingress.binding,
  scopes = grant.scopes,
  docPath = "plan"
) {
  return createLinkedRequest({
    origin: server.url.origin,
    key,
    binding,
    grant: { ...grant, scopes },
    method: "POST",
    path: "/api/mcp",
    body: new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "worktable_docs_write",
          arguments: {
            request: {
              action: "write",
              lifetime: "durable",
              spaceId: "space",
              docPath,
              content: "# Local document",
            },
          },
        },
      })
    ),
  })
}

it("keeps the legacy Grok identity and routes additional accounts with the same client label independently", async () => {
  const botIngress = await newIngress([...HOSTED_OAUTH_SCOPES])
  const claim = async (principalId: string) => {
    const response = await botIngress.fetch(
      await createLinkedRequest({
        origin: server.url.origin,
        key,
        binding: botIngress.binding,
        grant: { ...grant, principalId, displayName: "Cursor" },
        method: "POST",
        path: "/api/mcp",
        body: new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "worktable_thread_delivery",
              arguments: {
                request: {
                  action: "claim",
                  waitSeconds: 0,
                  threadLocationVersion: 2,
                },
              },
            },
          })
        ),
      })
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.result.isError).not.toBe(true)
    return body.result.structuredContent.delivery
  }
  const firstId = "oauth:grok:account-one"
  const secondId = "oauth:grok:account-two"
  expect(await claim(firstId)).toBeNull()
  const configure = async (id: string, name: string) => {
    const candidate = (await readGrokBotCandidates()).find((c) => c.id === id)!
    await saveGrokBot(
      {
        connectionId: id,
        principalId: id,
        participantId: candidate.participantId,
        participantKey: candidate.participantKey,
        wakeMethod: "email",
        emailAddress: `${name.toLowerCase()}@mail.grokbot.com`,
        webhookUrl: "",
        webhookKey: "",
        enabled: true,
        executionMinutes: 30,
      },
      name
    )
    const connection = (await readGrokBots()).find(
      (c) => c.connectionId === id
    )!
    await updateGrokBot(connection, { verifiedAt: new Date().toISOString() })
    return connection
  }
  const first = await configure(firstId, "Comet")
  expect(first.participantKey).toBe("agent:Cursor")
  expect(await claim(secondId)).toBeNull()
  const second = await configure(secondId, "Orbit")
  expect(second.participantId).not.toBe(first.participantId)
  const owner = {
    agent: null,
    scopes: ["*"],
    principal: { id: "owner", type: "human" as const, displayName: "Owner" },
  }
  const assign = (to: string, body: string) =>
    postThreadMessage(owner, {
      location: { kind: "worktable" },
      to,
      body,
      idempotencyKey: body,
      expectsReply: true,
    })
  const a = await assign(first.participantId, "For Comet")
  const b = await assign(second.participantId, "For Orbit")
  expect(await claim(secondId)).toMatchObject({ messageId: b.messageId })
  expect(await claim(firstId)).toMatchObject({ messageId: a.messageId })
  expect((await readGrokBotCandidates()).map((c) => c.displayName)).toEqual(
    expect.arrayContaining(["Comet", "Orbit"])
  )
  await removeGrokBot(secondId)
  expect(await claim(secondId)).toBeNull()
  expect(
    (await readGrokBots()).find((c) => c.connectionId === firstId)
      ?.participantId
  ).toBe(first.participantId)
})

it("serves real MCP writes and read-only shares through a separate socket, with no implicit owner access", async () => {
  expect(
    (
      await fetch(new URL("/api/mcp", server.url), {
        method: "POST",
        body: "{}",
      })
    ).status
  ).toBe(403)
  const health = await createLinkedRequest({
    origin: server.url.origin,
    key,
    binding: ingress.binding,
    grant: { kind: "health" },
    method: "GET",
    path: "/linked/health",
  })
  expect(await (await fetch(health)).json()).toEqual({ ready: true })
  expect(
    (
      await fetch(
        await createLinkedRequest({
          origin: server.url.origin,
          key,
          binding: ingress.binding,
          grant: { kind: "health" },
          method: "POST",
          path: "/api/mcp",
          body: new Uint8Array(),
        })
      )
    ).status
  ).toBe(403)
  const request = await mcpRequest()
  const replay = request.clone()
  const replayAfterSharing = request.clone()
  const response = await fetch(request)
  expect(response.status).toBe(200)
  const envelope = await response.json()
  expect(envelope.error).toBeUndefined()
  expect(envelope.result.isError).not.toBe(true)
  expect((await readDoc("space", "plan")).data).toContain("Local document")
  expect((await fetch(replay)).status).toBe(403)
  const read = await fetch(
    await createLinkedRequest({
      origin: server.url.origin,
      key,
      binding: ingress.binding,
      grant,
      method: "POST",
      path: "/api/mcp",
      body: new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "worktable_docs_read",
            arguments: {
              request: { action: "read", spaceId: "space", docPath: "plan" },
            },
          },
        })
      ),
    })
  )
  const document = (await read.json()).result.structuredContent
  expect(document.content).toContain("Local document")
  const citation = new URL(document.urlToSendInChat)
  expect(citation.pathname).toBe(
    `/linked/open/${ingress.binding.destinationId}`
  )
  expect(citation.search).toBe("")
  const createdSpace = await fetch(
    await createLinkedRequest({
      origin: server.url.origin,
      key,
      binding: ingress.binding,
      grant,
      method: "POST",
      path: "/api/mcp",
      body: new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "worktable_spaces",
            arguments: {
              request: { action: "create", name: "Attributed space" },
            },
          },
        })
      ),
    })
  )
  const spaceId = (await createdSpace.json()).result.structuredContent.spaceId
  expect((await readSpace(spaceId)).data?.createdBy).toBe(grant.principalId)

  const artifact = {
    kind: "doc" as const,
    spaceId: "space",
    artifactKey: "plan",
  }
  const share = await createDocumentShareIfEligible(artifact, async () => true)
  if (!share) throw new Error("Share not created")
  const shareRequest = () =>
    createLinkedRequest({
      origin: server.url.origin,
      key,
      binding: ingress.binding,
      grant: { kind: "share", capability: share.token },
      method: "GET",
      path: "/public/share",
    })
  // MCP works above without either share origin; even a valid share stays disabled.
  expect((await fetch(await shareRequest())).status).toBe(404)
  expect(
    LinkedHostReply.safeParse({
      state: "linked",
      publicOrigin: "https://app.example.test",
      sharingEnabled: true,
    }).success
  ).toBe(false)
  const sharingReply = LinkedHostReply.parse({
    state: "linked",
    publicOrigin: "https://app.example.test",
    sharingEnabled: true,
    shareOrigin: "https://staging.share.worktable.cloud",
    htmlShareOrigin: "https://staging.html.worktable-usercontent.com",
  })
  ingress.setSharingOrigin(
    sharingReply.sharingEnabled ? sharingReply.shareOrigin : null
  )
  // Updating sharing must retain this boot's replay fence.
  expect((await fetch(replayAfterSharing)).status).toBe(403)
  const shared = await fetch(await shareRequest())
  expect(shared.status).toBe(200)
  expect((await shared.json()).projectionHtml).toContain("Local document")
  ingress.setSharingOrigin(null)
  expect((await fetch(await shareRequest())).status).toBe(404)
  ingress.setSharingOrigin("https://staging.share.worktable.cloud")
  expect((await fetch(await shareRequest())).status).toBe(200)
  await stopDocumentShare(artifact)
  expect((await fetch(await shareRequest())).status).toBe(404)

  await createHtmlDocument({
    spaceId: "space",
    explicitId: "html-proof",
    name: "HTML proof",
    html: "<h1>Local HTML</h1><script>alert(1)</script>",
    createdBy: "test",
    permissions: {
      network: false,
      records: {},
      state: { read: false, write: false },
    },
    versionSource: "test",
    versionUpdatedBy: "test",
  })
  const html = await createDocumentShareIfEligible(
    { kind: "html", spaceId: "space", artifactKey: "html-proof" },
    async () => true
  )
  if (!html) throw new Error("HTML share not created")
  const htmlRequest = () =>
    createLinkedRequest({
      origin: server.url.origin,
      key,
      binding: ingress.binding,
      grant: { kind: "share", capability: html.token },
      method: "GET",
      path: "/public/share/content",
    })
  const content = await fetch(await htmlRequest())
  const markup = await content.text()
  expect(content.status).toBe(200)
  expect(markup).toContain("Local HTML")
  expect(markup).not.toContain("<script")
  expect(content.headers.get("Content-Security-Policy")).toContain(
    "script-src 'none'"
  )
  // The contract already carries later share requests; this runtime
  // still refuses every one of them.
  const ticket = "v1.lnk_frame.1.1767225600.signature"
  const visitor = { verified: true, key: "a".repeat(64) }
  for (const [later, method, path] of [
    [{ capability: html.token, unlock: ticket }, "GET", "/public/share"],
    [{ capability: ticket }, "GET", "/public/share/content"],
    [{ capability: html.token }, "POST", "/public/share/unlock"],
    [{ capability: html.token }, "POST", "/public/share/bridge"],
    [{ capability: html.token, visitor }, "GET", "/public/share/comments"],
    [{ capability: html.token, visitor }, "POST", "/public/share/comments"],
  ] as const)
    expect(
      (
        await fetch(
          await createLinkedRequest({
            origin: server.url.origin,
            key,
            binding: ingress.binding,
            grant: { kind: "share", ...later },
            method,
            path,
          })
        )
      ).status
    ).toBe(403)
  const crossPurpose = await htmlRequest()
  expect(
    (
      await fetch(
        new Request(new URL("/api/mcp", server.url), {
          method: "POST",
          headers: crossPurpose.headers,
          body: "{}",
        })
      )
    ).status
  ).toBe(403)
}, 20_000)

it("rejects any changed destination binding and altered request body before filesystem mutation", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(
        "installationId",
        "destinationId",
        "ownerSubject",
        "workspaceEpoch",
        "generation",
        "bootNonce"
      ),
      fc.uuid(),
      async (field, replacement) => {
        const binding: LinkedDestinationBinding = {
          ...ingress.binding,
          [field]: field === "generation" ? 2 : replacement,
        }
        expect((await fetch(await mcpRequest(binding))).status).toBe(403)
      }
    ),
    { numRuns: 36 }
  )
  const original = await mcpRequest()
  expect(
    (
      await fetch(
        new Request(original.url, {
          method: "POST",
          headers: original.headers,
          body: "{}",
        })
      )
    ).status
  ).toBe(403)
  expect((await readDoc("space", "plan")).data).toBeNull()
})

it("keeps agent permissions bounded and fences revoked, replaced and draining workspaces", async () => {
  const restricted = await fetch(
    await mcpRequest(ingress.binding, ["docs:read"])
  )
  const envelope = await restricted.json()
  expect(
    envelope.result?.isError === true || envelope.error !== undefined
  ).toBe(true)
  expect((await readDoc("space", "plan")).data).toBeNull()
  await stopWorkspaceRequestAdmissionAndDrain()
  expect((await fetch(await mcpRequest())).status).toBe(503)
  resumeWorkspaceRequestAdmission()
  expect((await fetch(await mcpRequest())).status).toBe(200)
  const oldBootRequest = await mcpRequest()
  ingress.revoke()
  expect((await fetch(await mcpRequest())).status).toBe(403)
  ingress = await newIngress()
  server.reload({ fetch: ingress.fetch })
  expect((await fetch(oldBootRequest)).status).toBe(403)
  expect((await fetch(await mcpRequest())).status).toBe(200)
  await rotateWorkspaceCollaborationEpoch()
  expect((await fetch(await mcpRequest())).status).toBe(403)
})

it("carries password unlocks and frame tickets over authenticated Link requests", async () => {
  const previous = process.env["WORKTABLE_SHARING_PREVIEW"]
  process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
  try {
    ingress.setSharingOrigin("https://share.example.test")
    await createHtmlDocument({
      spaceId: "space",
      explicitId: "protected",
      name: "Protected",
      html: "<h1>Protected report</h1>",
      createdBy: "test",
      permissions: {
        network: false,
        records: {},
        state: { read: false, write: false },
      },
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    const documentId = (await useResolvedDocumentHandle(
      { spaceId: "space", path: "protected", materializeIdentity: true },
      (handle) => handle.documentId
    )) as string
    const password = "test-only password"
    const { token, link } = createShareLink({
      workspaceEpoch: ingress.binding.workspaceEpoch,
      spaceId: "space",
      documentId,
      kind: "html",
      label: "",
      level: "view",
      createdBy: { id: "local:owner", name: "Owner" },
      expiresAt: null,
      passwordHash: await hashSharePassword(password),
      comments: {
        acceptComments: true,
        anonymousAllowed: false,
        showSharerName: false,
        visitorsSee: "own",
      },
    })
    const request = async (
      path: string,
      capability = token,
      unlock?: string,
      value?: string
    ) =>
      fetch(
        await createLinkedRequest({
          origin: server.url.origin,
          key,
          binding: ingress.binding,
          grant: { kind: "share", capability, ...(unlock ? { unlock } : {}) },
          method: value === undefined ? "GET" : "POST",
          path,
          ...(value === undefined
            ? {}
            : {
                body: new TextEncoder().encode(
                  JSON.stringify({ password: value })
                ),
              }),
        })
      )
    expect((await request("/public/share")).status).toBe(401)
    expect(
      (await request("/public/share/unlock", token, undefined, "wrong")).status
    ).toBe(401)
    const unlocked = await request(
      "/public/share/unlock",
      token,
      undefined,
      password
    )
    expect(unlocked.status).toBe(200)
    const { ticket } = await unlocked.json()
    const projection = await request("/public/share", token, ticket)
    expect(projection.status).toBe(200)
    const { contentTicket } = await projection.json()
    expect(contentTicket).not.toContain(token)
    expect((await request("/public/share/content", token, ticket)).status).toBe(
      404
    )
    const content = await request("/public/share/content", contentTicket)
    expect(content.status).toBe(200)
    expect(await content.text()).toContain("Protected report")
    expect((await request("/public/share/content", ticket)).status).toBe(404)
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    expect((await request("/public/share/content", contentTicket)).status).toBe(
      403
    )
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
    revokeShareLink(link.id, "local:owner")
    expect((await request("/public/share/content", contentTicket)).status).toBe(
      404
    )
  } finally {
    if (previous === undefined) delete process.env["WORKTABLE_SHARING_PREVIEW"]
    else process.env["WORKTABLE_SHARING_PREVIEW"] = previous
    closeShareLinkStores()
  }
}, 20_000)

it("carries only signed visitor authority to comments and isolates each visitor", async () => {
  const previous = process.env["WORKTABLE_SHARING_PREVIEW"]
  process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
  try {
    ingress.setSharingOrigin("https://share.example.test")
    saveSharingPolicy(
      { ...defaultSharingPolicy(), levels: ["view", "comment"] },
      "local:owner"
    )
    await writeDoc("space", "feedback", "# Feedback")
    const documentId = await useResolvedDocumentHandle(
      { spaceId: "space", path: "feedback", materializeIdentity: true },
      (handle) => handle.documentId
    )
    if (typeof documentId !== "string")
      throw new Error("Expected a durable document")
    const { token, link } = createShareLink({
      workspaceEpoch: ingress.binding.workspaceEpoch,
      spaceId: "space",
      documentId,
      kind: "doc",
      level: "comment",
      label: "Feedback",
      createdBy: { id: "local:owner", name: "Owner" },
      expiresAt: null,
      comments: {
        acceptComments: true,
        anonymousAllowed: false,
        showSharerName: false,
        visitorsSee: "own",
      },
    })
    const visitor: ShareVisitor = {
      verified: true,
      key: "a".repeat(64),
      client: "b".repeat(32),
    }
    const payload = new TextEncoder().encode(
      JSON.stringify({
        name: "Visitor",
        body: "SIGNED_VISITOR_FEEDBACK",
        requestId: "request01",
      })
    )
    const signed = (
      method: string,
      authority: ShareVisitor | undefined,
      path = "/public/share/comments",
      body = payload,
      commentCursor?: string
    ) =>
      createLinkedRequest({
        origin: server.url.origin,
        key,
        binding: ingress.binding,
        grant: {
          kind: "share",
          capability: token,
          ...(authority ? { visitor: authority } : {}),
          ...(commentCursor === undefined ? {} : { commentCursor }),
        },
        method,
        path,
        body: method === "POST" ? body : undefined,
      })
    // Incoming headers never augment the signed authority, even for a valid envelope.
    const forged = await signed("POST", { verified: false, key: visitor.key })
    forged.headers.set(VISITOR_HEADERS.VERIFIED, "1")
    forged.headers.set(VISITOR_HEADERS.CLIENT, visitor.client!)
    expect((await fetch(forged)).status).toBe(403)
    expect(
      (await fetch(await signed("POST", { verified: true, key: visitor.key })))
        .status
    ).toBe(403)
    expect((await fetch(await signed("GET", undefined))).status).toBe(403)
    expect(
      (await fetch(await signed("GET", visitor, "/public/share"))).status
    ).toBe(403)
    expect(
      (
        await fetch(
          await signed(
            "POST",
            visitor,
            undefined,
            new Uint8Array(16 * 1024 + 1)
          )
        )
      ).status
    ).toBe(403)
    const posted = await fetch(await signed("POST", visitor))
    expect(posted.status).toBe(201)
    const receipt = await posted.json()
    const own = await fetch(
      await signed("GET", { verified: false, key: visitor.key })
    )
    expect(own.status).toBe(200)
    expect((await own.json()).comments).toMatchObject([
      { body: "SIGNED_VISITOR_FEEDBACK", mine: true },
    ])
    const other = await fetch(
      await signed("GET", { verified: false, key: "c".repeat(64) })
    )
    expect((await other.json()).comments).toEqual([])
    const cursor = Buffer.from(
      JSON.stringify({
        receivedAt: Date.parse(receipt.receivedAt),
        id: receipt.id,
        scope: "s".repeat(43),
      })
    ).toString("base64url")
    const unsigned = await signed("GET", { verified: false, key: visitor.key })
    unsigned.headers.set(SHARE_COMMENT_CURSOR_HEADER, cursor)
    expect((await (await fetch(unsigned)).json()).reset).toBeUndefined()
    const continued = await fetch(
      await signed(
        "GET",
        { verified: false, key: visitor.key },
        undefined,
        undefined,
        cursor
      )
    )
    expect(continued.status).toBe(200)
    expect((await continued.json()).reset).toBe(true)
    for (const request of [
      await signed("POST", visitor, undefined, undefined, cursor),
      await signed("GET", undefined, "/public/share", undefined, cursor),
    ])
      expect((await fetch(request)).status).toBe(403)
    const expanded = new TextEncoder().encode(
      JSON.stringify({
        name: "Visitor",
        body: "\u0001".repeat(1500) + "SIGNED_ESCAPED_COMMENT",
        requestId: "request_expanded",
      })
    )
    expect(expanded.byteLength).toBeGreaterThan(8192)
    expect(
      (await fetch(await signed("POST", visitor, undefined, expanded))).status
    ).toBe(201)
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    expect((await fetch(await signed("GET", visitor))).status).toBe(403)
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
    revokeShareLink(link.id, "local:owner")
    expect((await fetch(await signed("GET", visitor))).status).toBe(404)
  } finally {
    if (previous === undefined) delete process.env["WORKTABLE_SHARING_PREVIEW"]
    else process.env["WORKTABLE_SHARING_PREVIEW"] = previous
    closeShareLinkStores()
  }
}, 20_000)

it("carries bounded live bridge calls and reserves MCP capacity while share bodies are held", async () => {
  const previous = process.env["WORKTABLE_SHARING_PREVIEW"]
  process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
  const closeBodies: Array<() => void> = []
  const held: Promise<Response>[] = []
  try {
    ingress.setSharingOrigin("https://share.example.test")
    saveSharingPolicy(
      { ...defaultSharingPolicy(), liveLinks: true },
      "local:owner"
    )
    await createHtmlDocument({
      spaceId: "space",
      explicitId: "live",
      name: "Live",
      html: "<script type=\"application/worktable\">await worktable.ui.render({tag:'h1',children:['Live report']});</script>",
      createdBy: "test",
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    const documentId = (await useResolvedDocumentHandle(
      { spaceId: "space", path: "live", materializeIdentity: true },
      (handle) => handle.documentId
    )) as string
    const { token } = createShareLink({
      workspaceEpoch: ingress.binding.workspaceEpoch,
      spaceId: "space",
      documentId,
      kind: "html",
      label: "",
      level: "view",
      createdBy: { id: "local:owner", name: "Owner" },
      expiresAt: null,
      comments: {
        acceptComments: true,
        anonymousAllowed: false,
        showSharerName: false,
        visitorsSee: "own",
      },
      grant: LinkGrantSchema.parse({ version: 1 }),
    })
    const body = new TextEncoder().encode(JSON.stringify({ v: 1, op: "ping" }))
    const request = (value = body) =>
      createLinkedRequest({
        origin: server.url.origin,
        key,
        binding: ingress.binding,
        grant: { kind: "share", capability: token },
        method: "POST",
        path: "/public/share/bridge",
        body: value,
      })
    expect(await (await fetch(await request())).json()).toEqual({
      ok: true,
      result: {},
    })
    const projection = await fetch(
      await createLinkedRequest({
        origin: server.url.origin,
        key,
        binding: ingress.binding,
        grant: { kind: "share", capability: token },
        method: "GET",
        path: "/public/share",
      })
    )
    expect(projection.status).toBe(200)
    const { contentTicket, live } = await projection.json()
    const frameRequest = (contentRevision?: string) =>
      createLinkedRequest({
        origin: server.url.origin,
        key,
        binding: ingress.binding,
        grant: {
          kind: "share",
          capability: contentTicket,
          ...(contentRevision ? { contentRevision } : {}),
        },
        method: "GET",
        path: "/public/share/content",
      })
    const frame = await fetch(await frameRequest())
    expect(frame.status).toBe(200)
    expect(await frame.text()).toContain("Live report")
    expect((await fetch(await frameRequest(live.rev))).status).toBe(304)
    const wrongPath = await createLinkedRequest({
      origin: server.url.origin,
      key,
      binding: ingress.binding,
      grant: { kind: "share", capability: token, contentRevision: live.rev },
      method: "POST",
      path: "/public/share/bridge",
      body,
    })
    expect((await fetch(wrongPath)).status).toBe(403)
    const clientCall = await createLinkedRequest({
      origin: server.url.origin,
      key,
      binding: ingress.binding,
      grant: {
        kind: "share",
        capability: token,
        clientAddress: "a".repeat(32),
      },
      method: "POST",
      path: "/public/share/bridge",
      body,
    })
    expect((await fetch(clientCall)).status).toBe(200)
    const forbiddenRead = await createLinkedRequest({
      origin: server.url.origin,
      key,
      binding: ingress.binding,
      grant: { kind: "share", capability: token },
      method: "POST",
      path: "/public/share/bridge",
      body: new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          op: "records.query",
          collection: "ungranted",
          query: {},
        })
      ),
    })
    const refused = await fetch(forbiddenRead)
    expect(refused.status).toBe(403)
    expect((await refused.json()).error.code).toBe("LINK_FORBIDDEN")
    expect(
      (await fetch(await request(new Uint8Array(16 * 1024 + 1)))).status
    ).toBe(403)
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    expect((await fetch(await request())).status).toBe(403)
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
    for (let index = 0; index < 6; index++) {
      const signed = await request()
      const slow = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body)
          closeBodies.push(() => {
            try {
              controller.close()
            } catch {
              /* A response can already have cancelled the upload. */
            }
          })
        },
      })
      held.push(fetch(new Request(signed, { body: slow })))
    }
    let overloaded: Response | undefined
    for (let attempt = 0; attempt < 50; attempt++) {
      overloaded = await fetch(await request())
      if (overloaded.status === 429) break
      await overloaded.body?.cancel()
      // test-policy: external-readiness-backoff. Wait for the six real socket uploads to reach admission.
      await Bun.sleep(5)
    }
    expect(overloaded?.status).toBe(429)
    expect(overloaded?.headers.get("Retry-After")).toBe("1")
    expect((await fetch(await mcpRequest())).status).toBe(200)
    expect((await readDoc("space", "plan")).data).not.toBeNull()
    closeBodies.forEach((close) => close())
    expect(
      (await Promise.all(held)).every((response) => response.status === 200)
    ).toBe(true)
    expect((await fetch(await request())).status).toBe(200)
  } finally {
    closeBodies.forEach((close) => close())
    await Promise.allSettled(held)
    if (previous === undefined) delete process.env["WORKTABLE_SHARING_PREVIEW"]
    else process.env["WORKTABLE_SHARING_PREVIEW"] = previous
    closeShareLinkStores()
  }
}, 20_000)
