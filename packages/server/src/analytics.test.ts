import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ACTOR_HEADERS,
  ANALYTICS_HEADER,
  GATEWAY_HEADER,
  type AnalyticsGrant,
  ENV,
  HOSTED_BROWSER_SCOPES,
  BROWSER_ASSERTION_TYPE,
  browserAssertionAudience,
  browserAssertionIssuer,
  browserRequestBinding,
} from "@worktable/hosted-contract"
import {
  captureWorkSaved,
  flushAnalytics,
  requestAnalyticsContext,
  shutdownAnalytics,
  withAnalyticsContext,
} from "./analytics"
import { createRecord, updateRecord } from "./record-store"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace"
import { setAppDirOverride } from "./app-storage"
import { ownerIdentity } from "./auth"
import { handleRemoteMcpRequest } from "./routes/mcp"
import {
  writeDoc,
  writeSpace,
  readDoc,
  getDocCollaborationCacheEpoch,
} from "./store"
import { startServer } from "./index"
import { SignJWT, base64url } from "jose"
import * as Y from "yjs"
import * as syncProtocol from "y-protocols/sync"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import { getServerEditor } from "./blocknote"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch"
import { createRegisteredDocument } from "./document-write-service"

const names = [
  "WORKTABLE_HOSTED",
  "WORKTABLE_ANALYTICS_ENABLED",
  "POSTHOG_PROJECT_TOKEN",
  "POSTHOG_API_HOST",
  "WORKTABLE_ANALYTICS_CONSENT_URL",
  "WORKTABLE_ANALYTICS_RUNTIME_ID",
  "WORKTABLE_CLOUD_WORKSPACE_ID",
  "WORKTABLE_GATEWAY_SECRET",
  ENV.OWNER_SUBJECT,
  ENV.RESOURCE_URL,
  ENV.BROWSER_ASSERTION_KEYRING,
]
let previous: Array<string | undefined>
let root: string
let server: ReturnType<typeof Bun.serve>
let permitted = true
let collectorUnavailable = false
let runtime: ReturnType<typeof startServer> | undefined
const sockets: WebSocket[] = []
let events: Array<{
  event: string
  distinct_id: string
  properties: Record<string, unknown>
}>
const grant = (): AnalyticsGrant => ({
  distinctId: "workos:user_analytics",
  consentSubject: "user_analytics",
  actorType: "human",
  surface: "web",
  expiresAt: Date.now() + 59_000,
})

beforeEach(async () => {
  previous = names.map((name) => process.env[name])
  events = []
  permitted = true
  collectorUnavailable = false
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname === "/consent")
        return Response.json({ enabled: permitted })
      if (collectorUnavailable)
        return new Response("Unavailable", { status: 503 })
      const text =
        request.headers.get("content-encoding") === "gzip"
          ? await new Response(
              request.body!.pipeThrough(new DecompressionStream("gzip"))
            ).text()
          : await request.text()
      const payload = JSON.parse(text)
      events.push(...(payload.batch ?? [payload]))
      return Response.json({ status: 1 })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const values = [
    "1",
    "true",
    "phc_analytics_test",
    origin,
    `${origin}/consent`,
    "runtime_test",
    "worktable_test",
    "gateway_test",
  ]
  names.forEach((name, index) => {
    process.env[name] = values[index]
  })
  root = await mkdtemp(join(tmpdir(), "worktable-analytics-"))
  setWorkspaceRootOverride(join(root, "workspace"))
  setAppDirOverride(join(root, "app"))
  ensureWorkspaceManifest()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "test",
    name: "Private space",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: "user",
    settings: {},
  })
})
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  if (runtime) {
    await runtime.stop(true)
    runtime = undefined
  }
  await shutdownAnalytics()
  server.stop(true)
  names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name]
    else process.env[name] = previous[index]
  })
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

const publicOrigin = "https://app.worktable.cloud"
const assertionSecret = base64url.encode(new Uint8Array(32).fill(7))

async function hostedHeaders(
  path: string,
  method = "GET",
  analytics = true
): Promise<Record<string, string>> {
  const now = Math.floor(Date.now() / 1000)
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      browserRequestBinding(method, new URL(path, publicOrigin))
    )
  )
  const token = await new SignJWT({
    wt: {
      credential: "browser",
      workspaceId: "worktable_test",
      requestHash: base64url.encode(new Uint8Array(digest)),
      scopes: [...HOSTED_BROWSER_SCOPES],
      principal: {
        id: "workos:user_analytics",
        type: "human",
        displayName: "Analytics tester",
      },
    },
  })
    .setProtectedHeader({
      alg: "HS256",
      typ: BROWSER_ASSERTION_TYPE,
      kid: "v1",
    })
    .setIssuer(browserAssertionIssuer(publicOrigin))
    .setAudience(browserAssertionAudience("worktable_test"))
    .setSubject("user_analytics")
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(base64url.decode(assertionSecret))
  return {
    Authorization: `Bearer ${token}`,
    [GATEWAY_HEADER]: "gateway_test",
    [ACTOR_HEADERS.ID]: "workos:user_analytics",
    [ACTOR_HEADERS.TYPE]: "human",
    [ACTOR_HEADERS.NAME]: "Analytics tester",
    ...(analytics ? { [ANALYTICS_HEADER]: JSON.stringify(grant()) } : {}),
  }
}

async function eventually(
  condition: () => Promise<boolean>,
  description: string
): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await condition()) return
    // test-policy: external-readiness-backoff
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function editorSocket(path: string, analytics = true) {
  const client = new Y.Doc()
  const state = { acknowledgements: 0 }
  const socket = new WebSocket(`ws://127.0.0.1:${runtime!.port}${path}`, {
    headers: await hostedHeaders(path, "GET", analytics),
  } as unknown as string[])
  sockets.push(socket)
  socket.binaryType = "arraybuffer"
  socket.onopen = () => {
    const frame = encoding.createEncoder()
    encoding.writeVarUint(frame, 0)
    syncProtocol.writeSyncStep1(frame, client)
    socket.send(encoding.toUint8Array(frame))
  }
  socket.onmessage = (event) => {
    const decoder = decoding.createDecoder(
      new Uint8Array(event.data as ArrayBuffer)
    )
    const type = decoding.readVarUint(decoder)
    if (type === 43) {
      state.acknowledgements++
      return
    }
    if (type !== 0) return
    const reply = encoding.createEncoder()
    encoding.writeVarUint(reply, 0)
    syncProtocol.readSyncMessage(decoder, reply, client, "server")
    if (encoding.length(reply) > 1) socket.send(encoding.toUint8Array(reply))
  }
  await eventually(async () => {
    if (socket.readyState === WebSocket.CLOSED)
      throw new Error(
        "Hosted editor socket was rejected before synchronization"
      )
    return (
      socket.readyState === WebSocket.OPEN &&
      client.getXmlFragment("document-store").length > 0
    )
  }, "authenticated editor synchronization")
  return { socket, client, state }
}

async function editThroughSocket(
  connection: Awaited<ReturnType<typeof editorSocket>>,
  text: string,
  append = false
) {
  const previous = Y.encodeStateVector(connection.client)
  const editor = await getServerEditor()
  connection.client.transact(() => {
    const fragment = connection.client.getXmlFragment("document-store")
    if (append) {
      const firstText = (node: unknown): Y.XmlText | null => {
        if (node instanceof Y.XmlText) return node
        if (!(node instanceof Y.XmlElement || node instanceof Y.XmlFragment))
          return null
        for (const child of node.toArray()) {
          const found = firstText(child)
          if (found) return found
        }
        return null
      }
      const target = firstText(fragment)
      if (!target) throw new Error("Editor document has no text to append to")
      target.insert(target.length, text)
      return
    }
    fragment.delete(0, fragment.length)
    editor.blocksToYXmlFragment(
      [{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }],
      fragment
    )
  }, "human-edit")
  connection.socket.send(new Uint8Array([43]))
  const frame = encoding.createEncoder()
  encoding.writeVarUint(frame, 0)
  syncProtocol.writeUpdate(
    frame,
    Y.encodeStateAsUpdate(connection.client, previous)
  )
  connection.socket.send(encoding.toUint8Array(frame))
}

describe("consented committed-work analytics", () => {
  test("hosted sockets and HTML broker preserve saves across withdrawal and collector failure", async () => {
    process.env[ENV.OWNER_SUBJECT] = "user_analytics"
    process.env[ENV.RESOURCE_URL] = `${publicOrigin}/api/mcp`
    process.env[ENV.BROWSER_ASSERTION_KEYRING] = JSON.stringify([
      { kid: "v1", secret: assertionSecret, state: "signing" },
    ])
    await writeDoc(
      "test",
      "live",
      [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Original", styles: {} }],
        },
      ],
      { source: "rest-api" }
    )
    runtime = startServer(0, "127.0.0.1")
    const request = async (path: string, method: string, body: unknown) =>
      fetch(`http://127.0.0.1:${runtime!.port}${path}`, {
        method,
        headers: {
          ...(await hostedHeaders(path, method)),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
    const socketPath = `/yjs/test/live?collaborationEpoch=${encodeURIComponent(await getWorkspaceCollaborationEpoch())}&collaborationCacheEpoch=${encodeURIComponent(await getDocCollaborationCacheEpoch("test", "live"))}`
    const connection = await editorSocket(socketPath)
    await flushAnalytics()
    expect(events).toHaveLength(0)
    const firstAcknowledgement = connection.state.acknowledgements
    await editThroughSocket(connection, "Consented editor content")
    await eventually(
      async () =>
        connection.state.acknowledgements > firstAcknowledgement &&
        JSON.stringify((await readDoc("test", "live")).data).includes(
          "Consented editor content"
        ),
      "editor content commit"
    )
    await flushAnalytics()
    expect(
      events.filter((event) => event.event === "product:work_saved")
    ).toHaveLength(1)
    permitted = false
    const withdrawnAcknowledgement = connection.state.acknowledgements
    await editThroughSocket(connection, "Withdrawn editor content")
    await eventually(
      async () =>
        connection.state.acknowledgements > withdrawnAcknowledgement &&
        JSON.stringify((await readDoc("test", "live")).data).includes(
          "Withdrawn editor content"
        ),
      "save after withdrawal on the same connection"
    )
    await flushAnalytics()
    expect(events).toHaveLength(1)
    expect(connection.socket.readyState).toBe(WebSocket.OPEN)
    permitted = true
    const mixed = await editorSocket(socketPath, false)
    const mixedAcknowledgement = connection.state.acknowledgements
    await editThroughSocket(connection, " Consenting collaborator", true)
    await editThroughSocket(mixed, " Unattributed collaborator", true)
    await eventually(async () => {
      const content = JSON.stringify((await readDoc("test", "live")).data)
      return (
        connection.state.acknowledgements > mixedAcknowledgement &&
        content.includes("Consenting collaborator") &&
        content.includes("Unattributed collaborator")
      )
    }, "mixed-consent collaborative commit")
    await flushAnalytics()
    expect(events).toHaveLength(1)
    const widgetPath = "/api/spaces/test/widgets"
    const html =
      "<!doctype html><html><head></head><body><h1>Private panel</h1></body></html>"
    const created = await request(widgetPath, "POST", {
      id: "panel",
      name: "Private panel",
      html,
      permissions: {
        records: { items: { read: true, create: true, update: true } },
      },
    })
    expect(created.status).toBe(201)
    const record = await request(`${widgetPath}/panel/records/items`, "POST", {
      id: "broker-row",
      data: { title: "Private broker content" },
    })
    expect({
      status: record.status,
      body: await record.clone().json(),
    }).toMatchObject({ status: 201 })
    expect(
      (
        await request(`${widgetPath}/panel/records/items/broker-row`, "PATCH", {
          data: { title: "Private broker content" },
        })
      ).status
    ).toBe(200)
    await flushAnalytics()
    expect(
      events.filter((event) => event.properties.content_type === "html")
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.properties.content_type === "record")
    ).toHaveLength(1)
    collectorUnavailable = true
    expect(
      (
        await request(`${widgetPath}/panel/records/items/broker-row`, "PATCH", {
          data: { title: "Saved during collector outage" },
        })
      ).status
    ).toBe(200)
    const outageAcknowledgement = connection.state.acknowledgements
    await editThroughSocket(connection, "Saved while collector is unavailable")
    await eventually(
      async () =>
        connection.state.acknowledgements > outageAcknowledgement &&
        JSON.stringify((await readDoc("test", "live")).data).includes(
          "Saved while collector is unavailable"
        ),
      "editor save during collector outage"
    )
    await flushAnalytics()
    expect(events).toHaveLength(3)
    for (const secret of [
      "Consented editor content",
      "Private panel",
      "Private broker content",
      "broker-row",
      "Withdrawn editor content",
    ])
      expect(JSON.stringify(events)).not.toContain(secret)
    connection.client.destroy()
    mixed.client.destroy()
  }, 15_000) // Exercises four real save debounces and outage deadlines.
  test("counts real document and record changes once and exports no content", async () => {
    const context = { contributors: [grant()] }
    await withAnalyticsContext(context, async () => {
      expect(
        (await writeDoc("test", "private-doc", "Private authored content")).ok
      ).toBe(true)
      expect(
        (await writeDoc("test", "private-doc", "Private authored content")).ok
      ).toBe(true)
      expect((await writeDoc("test", "empty", "")).ok).toBe(true)
      expect(
        (
          await createRecord("test", "items", {
            id: "row",
            data: { title: "Secret record" },
          })
        ).error
      ).toBeNull()
      await updateRecord("test", "items", "row", {
        metadata: { private: true },
      })
      await updateRecord("test", "items", "row", {
        data: { title: "Changed secret" },
      })
      await updateRecord("test", "items", "row", { data: { title: "" } })
      expect((await writeDoc("test", "private-doc", "")).ok).toBe(true)
      expect((await writeDoc("test", "private-doc", "Automatic reference repair", { source: "system", updatedBy: "system" })).ok).toBe(true)
      expect((await updateRecord("test", "items", "row", { data: { title: "Automatic reference repair" }, updatedBy: "system" })).error).toBeNull()
    })
    await flushAnalytics()
    expect(
      events.filter((event) => event.event === "product:work_saved")
    ).toHaveLength(5)
    expect(
      events.filter((event) => event.properties.content_type === "document")
    ).toHaveLength(2)
    expect(
      events.filter((event) => event.properties.content_type === "record")
    ).toHaveLength(3)
    const payload = JSON.stringify(events)
    for (const secret of [
      "Private authored",
      "private-doc",
      "Secret record",
      "Changed secret",
      "Private space",
      "user@example",
    ])
      expect(payload).not.toContain(secret)
    expect(
      events.every(
        (event) =>
          event.properties.worktable_id === "worktable_test" &&
          event.distinct_id === "workos:user_analytics"
      )
    ).toBe(true)
  })
  test("fails closed for revocation, missing or mixed consent and local operation", async () => {
    permitted = false
    withAnalyticsContext({ contributors: [grant()] }, () =>
      captureWorkSaved("document")
    )
    await flushAnalytics()
    permitted = true
    withAnalyticsContext({ contributors: [grant(), null] }, () =>
      captureWorkSaved("document")
    )
    process.env.WORKTABLE_HOSTED = "0"
    withAnalyticsContext({ contributors: [grant()] }, () =>
      captureWorkSaved("document")
    )
    await flushAnalytics()
    expect(events).toEqual([])
  })
  test("counts a durable Markdown-to-rich save once and suppresses its repeat", async () => {
    const manifestPath = join(root, "workspace", "worktable.workspace.json")
    await Bun.write(
      manifestPath,
      JSON.stringify({ ...(await Bun.file(manifestPath).json()), version: 2 })
    )
    await createRegisteredDocument({
      spaceId: "test",
      path: "durable",
      format: { id: "worktable.markdown", sourceVersion: 1 },
      bytes: Buffer.from("Original content"),
      createdBy: "user",
      source: "mcp",
    })
    const rich = [
      {
        id: "authored",
        type: "paragraph",
        content: [
          { type: "text", text: "New rich content", styles: { bold: true } },
        ],
        children: [],
      },
    ]
    await withAnalyticsContext({ contributors: [grant()] }, async () => {
      expect((await writeDoc("test", "durable", rich)).ok).toBe(true)
      expect((await writeDoc("test", "durable", rich)).ok).toBe(true)
    })
    await flushAnalytics()
    expect(
      events.filter((event) => event.event === "product:work_saved")
    ).toHaveLength(1)
  })
  test("captures metadata for real MCP calls without inputs, results, or duplicate saves", async () => {
    const identity = ownerIdentity()
    identity.principal = {
      id: "oauth:codex:user_analytics",
      type: "agent",
      displayName: "Private agent label",
      authorizedBy: "workos:user_analytics",
    }
    identity.agent = "managed:codex"
    const agentGrant: AnalyticsGrant = {
      ...grant(),
      distinctId: `${identity.principal.id}:worktable:worktable_test`,
      actorType: "agent",
      surface: "mcp",
    }
    const call = async (
      request: Record<string, unknown>,
      tool = "worktable_records_write"
    ) => {
      const response = await handleRemoteMcpRequest(
        new Request("https://app.worktable.cloud/api/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
            [GATEWAY_HEADER]: "gateway_test",
            [ACTOR_HEADERS.ID]: identity.principal.id,
            [ACTOR_HEADERS.TYPE]: "agent",
            [ACTOR_HEADERS.NAME]: "Private agent label",
            [ACTOR_HEADERS.AUTHORIZED_BY]: "workos:user_analytics",
            [ANALYTICS_HEADER]: JSON.stringify(agentGrant),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: tool,
              arguments:
                tool === "worktable_records_write" ? { request } : request,
            },
          }),
        }),
        identity,
        "https://app.worktable.cloud"
      )
      expect(response.status).toBe(200)
      return await response.json()
    }
    expect(
      (
        await call({
          action: "create",
          spaceId: "test",
          collectionId: "items",
          data: { title: "Private tool argument" },
        })
      ).result.isError
    ).not.toBe(true)
    identity.scopes = []
    expect(
      (
        await call({
          action: "create",
          spaceId: "test",
          collectionId: "items",
          data: { title: "Denied secret" },
        })
      ).result.isError
    ).toBe(true)
    expect(
      (await call({ query: "Private search" }, "search")).result.isError
    ).toBe(true)
    identity.scopes = ["*"]
    expect(
      (
        await call({
          action: "update",
          spaceId: "test",
          collectionId: "items",
          recordId: "missing",
          data: { title: "Private failure" },
        })
      ).result.isError
    ).toBe(true)
    await flushAnalytics()
    expect(
      events.filter((event) => event.event === "product:work_saved")
    ).toHaveLength(1)
    const calls = events.filter((event) => event.event === "$mcp_tool_call")
    expect(calls).toHaveLength(4)
    expect(calls.map((event) => event.properties.outcome).sort()).toEqual([
      "denied",
      "denied",
      "error",
      "success",
    ])
    expect(
      calls.every(
        (event) =>
          ["worktable_records_write", "search"].includes(
            event.properties.$mcp_tool_name as string
          ) &&
          event.properties.$mcp_protocol_version === "2025-06-18" &&
          event.properties.$mcp_client_name === "ChatGPT / Codex" &&
          event.properties.$process_person_profile === false
      )
    ).toBe(true)
    expect(
      calls.filter((event) => event.properties.$mcp_error_type === "permission")
    ).toHaveLength(2)
    for (const secret of [
      "Private tool argument",
      "Denied secret",
      "Private failure",
      "Private search",
      "Private agent label",
      "missing",
    ])
      expect(JSON.stringify(events)).not.toContain(secret)
  })
  test("keeps collaborative saves out of person profiles and rejects spoofed actor grants", async () => {
    withAnalyticsContext(
      {
        contributors: [
          grant(),
          {
            ...grant(),
            distinctId: "workos:user_other",
            consentSubject: "user_other",
          },
        ],
      },
      () => captureWorkSaved("document")
    )
    await flushAnalytics()
    expect(events).toHaveLength(1)
    expect(events[0]!.properties).toMatchObject({
      actor_type: "multiple",
      $process_person_profile: false,
    })
    expect(events[0]!.distinct_id).toMatch(/^commit:/)
    const identity = ownerIdentity()
    identity.principal = {
      id: "workos:user_analytics",
      type: "human",
      displayName: "Private name",
    }
    const headers = new Headers({
      [GATEWAY_HEADER]: "gateway_test",
      [ACTOR_HEADERS.ID]: identity.principal.id,
      [ACTOR_HEADERS.TYPE]: "human",
      [ACTOR_HEADERS.NAME]: "Private name",
      [ANALYTICS_HEADER]: JSON.stringify(grant()),
    })
    expect(
      requestAnalyticsContext(
        new Request("https://app.worktable.cloud/api", { headers }),
        identity
      )
    ).not.toBeNull()
    headers.set(
      ANALYTICS_HEADER,
      JSON.stringify({ ...grant(), distinctId: "workos:other" })
    )
    expect(
      requestAnalyticsContext(
        new Request("https://app.worktable.cloud/api", { headers }),
        identity
      )
    ).toBeNull()
  })
})
