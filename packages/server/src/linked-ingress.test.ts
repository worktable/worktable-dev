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
  type LinkedRequestGrant,
  type LinkedDestinationBinding,
} from "@worktable/hosted-contract"
import { createHash } from "node:crypto"
import { SignJWT } from "jose"
import { setAppDirOverride } from "./app-storage.ts"
import { rotateWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { createLinkedIngress } from "./linked-ingress.ts"
import { drainWorkspaceChanges } from "./workspace-events.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import {
  createDocumentShareIfEligible,
  stopDocumentShare,
} from "./share-store.ts"
import { readDoc, readSpace, writeSpace } from "./store.ts"
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

function newIngress() {
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
    scopes: ["docs:read", "docs:write", "spaces:read"],
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
  expect(citation.searchParams.get("path")).toContain("/spaces/space/")
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
