import { advanceGenerationOnWrite } from "./shared-reads.ts"
import { LinkGrantSchema } from "@worktable/types"
import type { RecordFile } from "@worktable/types"
import { saveSharingPolicy } from "./share-links-store.ts"
import { createHash } from "node:crypto"
import {
  buildRecordCollectionSchema,
  writeRecordCollectionSchema,
  writeRecord,
  writeWidgetState,
} from "./record-store.ts"
import * as linkQueries from "./link-query.ts"
import * as linkAccess from "./link-sharing-access.ts"
import * as grantSchemas from "./link-grant.ts"
import * as recordQueries from "./record-query.ts"
import * as widgetStore from "./widget-store.ts"
import { linkReadMemo } from "./link-read-memo.ts"
import { recordIndex } from "./record-index.ts"
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import {
  defaultSharingPolicy,
  type CreatedShareLink,
  type DocumentShareLinks,
  type ShareLinkBlockedBy,
  type SharingPolicy,
} from "@worktable/types"
import { Hono } from "hono"
import * as fsPromises from "node:fs/promises"
import { existsSync } from "node:fs"
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { renameDocAndSync } from "./doc-rename.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import * as collaborationEpoch from "./collaboration-epoch.ts"
import * as documentPages from "./document-page-service.ts"
import { readDocumentPage } from "./document-page-service.ts"
import { useResolvedDocumentHandle } from "./document-query.ts"
import { deleteHtmlDocument } from "./html-document-delete.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import { moveHtmlDocument } from "./html-document-move.ts"
import * as publicRenderer from "./public-share-renderer.ts"
import { wsManager } from "./ws.ts"
import * as views from "./share-link-views.ts"
import { setLinkedSharing } from "./linked-sharing.ts"
import { createPublicSharesRouter } from "./routes/public-shares.ts"
import { sharesRouter } from "./routes/shares.ts"
import { drainV1ShareLinks } from "./share-links-drain.ts"
import { settleShareLinkReconciles } from "./share-links-lifecycle.ts"
import {
  createDocumentShare,
  resolveDocumentShare,
  stopDocumentShare,
} from "./share-store.ts"
import {
  closeShareLinkStores,
  documentShareLinkSummary,
  getShareLink,
  refreshShareLinkGrantProofs,
  flushShareLinkUse,
  importV1ShareLink,
  revokeShareLink,
  restoreSharingPolicy,
  sharingPolicyForBackup,
  shareLinksDatabasePath,
  updateShareLink,
  shareUnlockSecret,
} from "./share-links-store.ts"
import { authorizeShareAction } from "./share-policy.ts"
import { operatorSnapshotDirectory } from "./operator-snapshot.ts"
import { setDocArchived, writeDoc, writeSpace } from "./store.ts"
import type { TokenIdentity } from "./token-store.ts"
import { updateWidgetMetadata } from "./widget-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  workspaceCacheKey,
} from "./workspace.ts"
import {
  drainWorkspaceChanges,
  notifyWorkspaceChangeAndWaitOrThrow,
} from "./workspace-events.ts"
import { writeWorkspaceSnapshot } from "./workspace-snapshot.ts"
import { recoverMissingWorkspaceSnapshot } from "./workspace-snapshot-restore.ts"

// Links on a Worktable shared through Link: not hosted, so this also covers
// lifecycle revocation outside Cloud.

const originalEnv = { ...process.env }
const sharing = {
  workspaceId: "ws_synthetic",
  shareOrigin: "https://share.example.test",
  htmlShareOrigin: "https://html.example.test",
}
let appDir: string
let workspaceDir: string

function person(scopes = ["*"]): TokenIdentity {
  return {
    user: "owner",
    workspace: "synthetic",
    credentialClass: "local",
    scopes,
    agent: null,
    principal: { id: "local:owner", type: "human", displayName: "Owner" },
  }
}

const agent: TokenIdentity = {
  ...person(),
  agent: "codex",
  principal: { id: "agent:codex", type: "agent", displayName: "Codex" },
}

function app(identity: TokenIdentity = person()): Hono {
  const next = new Hono()
  next.use("*", advanceGenerationOnWrite)
  next.use("*", async (c, proceed) => {
    c.set("identity", identity)
    await proceed()
  })
  next.route("/api/shares", sharesRouter)
  next.route(
    "/public/share",
    createPublicSharesRouter(() => sharing.shareOrigin)
  )
  return next
}

async function send(
  method: string,
  path: string,
  body?: unknown,
  identity?: TokenIdentity
): Promise<Response> {
  return await app(identity).request(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  })
}

async function createLink(
  path: string,
  extra: Record<string, unknown> = {},
  kind: "doc" | "html" = "doc"
): Promise<CreatedShareLink & { token: string }> {
  const response = await send("POST", "/api/shares/links", {
    target: { kind, spaceId: "space", path },
    ...extra,
  })
  expect(response.status).toBe(201)
  const created = (await response.json()) as CreatedShareLink
  return { ...created, token: created.url.split("/").at(-1)! }
}

async function view(
  token: string,
  surface = "/public/share",
  unlock?: string
): Promise<Response> {
  return await app().request(surface, {
    headers: {
      "x-worktable-share-capability": token,
      ...(unlock ? { "x-worktable-share-unlock": unlock } : {}),
    },
  })
}

async function documentLinks(
  path: string,
  kind = "doc"
): Promise<DocumentShareLinks> {
  const query = new URLSearchParams({ kind, spaceId: "space", path })
  return (await (
    await send("GET", `/api/shares/links?${query}`)
  ).json()) as DocumentShareLinks
}

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "worktable-share-links-app-"))
  workspaceDir = await mkdtemp(join(tmpdir(), "worktable-share-links-ws-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  ensureWorkspaceManifest()
  delete process.env["WORKTABLE_HOSTED"]
  setLinkedSharing(sharing)
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "space",
    name: "Test space",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
})

afterEach(async () => {
  await recordIndex.whenIdle()
  recordIndex.stop()
  setLinkedSharing(null)
  closeShareLinkStores()
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  process.env = { ...originalEnv }
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})

async function useHtmlStorageV2(): Promise<void> {
  const manifestPath = join(workspaceDir, "worktable.workspace.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`
  )
}

describe("share links", () => {
  it("prepares a person's live access under current policy without making a link", async () => {
    process.env["WORKTABLE_RECORDS_INDEX"] = "0"
    await useHtmlStorageV2()
    saveSharingPolicy(
      { ...defaultSharingPolicy(), liveLinks: true },
      "local:owner"
    )
    await writeRecordCollectionSchema(
      "space",
      buildRecordCollectionSchema({
        id: "deals",
        name: "Deals",
        fields: { name: { type: "text" }, visibility: { type: "text" } },
      })
    )
    const at = new Date().toISOString()
    for (const visibility of ["public", "private"])
      await writeRecord("space", {
        version: 1,
        kind: "worktable.record",
        id: visibility,
        collectionId: "deals",
        createdAt: at,
        updatedAt: at,
        createdBy: "test",
        metadata: {},
        data: {
          name: visibility === "public" ? "Visible" : "HIDDEN_SENTINEL",
          visibility,
        },
      })
    await createHtmlDocument({
      spaceId: "space",
      name: "Access",
      html: "<script>worktable.records.query('deals')</script>",
      permissions: {
        network: false,
        records: { deals: { read: true } },
        state: {},
      },
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    await drainWorkspaceChanges()
    const grant = LinkGrantSchema.parse({
      version: 1,
      collections: {
        deals: {
          fields: ["name"],
          rows: { field: "visibility", op: "eq", value: "public" },
        },
      },
    })
    const input = {
      target: { kind: "html", spaceId: "space", path: "access" },
      grant,
      observe: false,
    }
    saveSharingPolicy(defaultSharingPolicy(), "local:owner")
    expect((await send("POST", "/api/shares/links/access", input)).status).toBe(
      400
    )
    saveSharingPolicy(
      { ...defaultSharingPolicy(), liveLinks: true },
      "local:owner"
    )
    expect(
      (await send("POST", "/api/shares/links/access", input, agent)).status
    ).toBe(403)
    const prepared = await send("POST", "/api/shares/links/access", input)
    expect(prepared.status).toBe(200)
    const access = await prepared.json()
    expect(access.counts).toEqual({ deals: 1 })
    expect(access.effectiveGrant.collections.deals.fields).toEqual(["name"])
    expect(access.issues).toEqual([])
    expect(JSON.stringify(access)).not.toContain("HIDDEN_SENTINEL")
    expect((await documentLinks("access", "html")).links).toEqual([])
    const original = linkAccess.prepareShareLinkAccess
    const document = (await widgetStore.readWidgetDocument("space", "access"))
      .data!
    const originalRename = fsPromises.rename
    let releaseSource!: () => void
    const sourceGate = new Promise<void>((resolve) => {
      releaseSource = resolve
    })
    let sourceReady!: () => void
    const atSource = new Promise<void>((resolve) => {
      sourceReady = resolve
    })
    // Hold the real V2 publish after its properties commit, before the source
    // replacement. A read of that pair denies permissions until it matches.
    const publication = spyOn(fsPromises, "rename").mockImplementation(
      async (from, to) => {
        if (
          String(to) ===
          join(workspaceDir, "spaces", "space", "docs", "access.html")
        ) {
          sourceReady()
          await sourceGate
        }
        return originalRename(from, to)
      }
    )
    let releasePublication: (() => void) | undefined
    const published = widgetStore
      .writeWidget(
        "space",
        document.widget,
        `${document.html}\n<!-- Published -->`
      )
      .then((result) => {
        releasePublication = result.release
        expect(result.error).toBeNull()
      })
    const duringPublish = spyOn(
      linkAccess,
      "prepareShareLinkAccess"
    ).mockImplementation(async (...args) => {
      const result = await original(...args)
      expect(result?.effectiveGrant.collections).toEqual({})
      releaseSource()
      await published
      return result
    })
    try {
      await Promise.race([
        atSource,
        published.then(() => {
          throw new Error("HTML publish did not reach its source")
        }),
      ])
      const stale = await send("POST", "/api/shares/links/access", input)
      expect(stale.status).toBe(503)
      expect((await stale.json()).code).toBe("LINK_PREVIEW_CHANGED")
    } finally {
      releaseSource()
      try {
        await published
      } finally {
        releasePublication?.()
        publication.mockRestore()
        duringPublish.mockRestore()
      }
    }
    const retried = await send("POST", "/api/shares/links/access", input)
    expect(retried.status).toBe(200)
    expect((await retried.json()).counts).toEqual({ deals: 1 })
    let invalidate: "schema" | "policy" = "schema"
    const changed = spyOn(
      linkAccess,
      "prepareShareLinkAccess"
    ).mockImplementation(async (...args) => {
      const result = await original(...args)
      if (invalidate === "schema") {
        await writeRecordCollectionSchema(
          "space",
          buildRecordCollectionSchema({
            id: "deals",
            name: "Deals",
            fields: {
              name: { type: "text" },
              visibility: { type: "text" },
              stage: { type: "text" },
            },
          })
        )
      } else {
        saveSharingPolicy(
          { ...defaultSharingPolicy(), liveLinks: true, records: "none" },
          "local:owner"
        )
      }
      return result
    })
    try {
      for (const change of ["schema", "policy"] as const) {
        invalidate = change
        const stale = await send("POST", "/api/shares/links/access", input)
        expect(stale.status).toBe(503)
        expect((await stale.json()).code).toBe("LINK_PREVIEW_CHANGED")
      }
    } finally {
      changed.mockRestore()
    }
    const narrowedResponse = await send(
      "POST",
      "/api/shares/links/access",
      input
    )
    expect(narrowedResponse.status).toBe(200)
    const narrowed = await narrowedResponse.json()
    expect(narrowed.effectiveGrant.collections).toEqual({})
    expect(narrowed.counts).toEqual({})
    expect(narrowed.issues).toHaveLength(1)
  })

  it("refuses live link mutations after source edits and accepts a fresh retry", async () => {
    await useHtmlStorageV2()
    saveSharingPolicy(
      { ...defaultSharingPolicy(), liveLinks: true },
      "local:owner"
    )
    const html = "<h1>Report</h1>"
    await createHtmlDocument({
      spaceId: "space",
      explicitId: "race",
      name: "Race",
      html,
      permissions: { network: false, records: {}, state: {} },
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    const target = { kind: "html", spaceId: "space", path: "race" }
    const initial = (await (
      await send("POST", "/api/shares/links", { target, label: "Original" })
    ).json()) as CreatedShareLink
    const document = (await widgetStore.readWidgetDocument("space", "race"))
      .data!
    const grant = { version: 1, collections: {}, state: "visitor" }
    const originalSchemas = grantSchemas.readLinkGrantSchemas
    const publish = async (source: string) => {
      const result = await widgetStore.writeWidget(
        "space",
        document.widget,
        source
      )
      result.release?.()
      expect(result.error).toBeNull()
      await drainWorkspaceChanges()
    }
    for (const method of ["POST", "PATCH"] as const) {
      const url =
        method === "POST"
          ? "/api/shares/links"
          : `/api/shares/links/${initial.link.id}`
      const input = {
        ...(method === "POST" ? { target } : {}),
        label: "Updated",
        grant,
      }
      const changed = spyOn(
        grantSchemas,
        "readLinkGrantSchemas"
      ).mockImplementation(async (...args) => {
        const result = await originalSchemas(...args)
        await publish("<script>window.legacy = true</script>")
        return result
      })
      try {
        const refused = await send(method, url, input)
        expect(refused.status).toBe(503)
        expect((await refused.json()).code).toBe("LINK_PREVIEW_CHANGED")
      } finally {
        changed.mockRestore()
      }
      const links = (await documentLinks("race", "html")).links
      expect(links.find((link) => link.id === initial.link.id)?.label).toBe(
        "Original"
      )
      expect(links).toHaveLength(method === "POST" ? 1 : 2)
      await publish(html)
      expect((await send(method, url, input)).status).toBe(
        method === "POST" ? 201 : 200
      )
    }
  })

  it("opens live tools through ticketed frames and grant-only reads, including policy changes during a read", async () => {
    process.env["WORKTABLE_RECORDS_INDEX"] = "1"
    const policy = (await (await send("GET", "/api/shares/policy")).json())
      .policy as SharingPolicy
    expect(
      (await send("PUT", "/api/shares/policy", { ...policy, liveLinks: true }))
        .status
    ).toBe(200)
    await writeRecordCollectionSchema(
      "space",
      buildRecordCollectionSchema({
        id: "deals",
        name: "Deals",
        fields: { name: { type: "text" }, secret: { type: "text" } },
      })
    )
    const at = new Date().toISOString()
    await writeRecord("space", {
      version: 1,
      kind: "worktable.record",
      id: "private-id",
      collectionId: "deals",
      createdAt: at,
      updatedAt: at,
      createdBy: "test",
      metadata: {},
      data: { name: "Public name", secret: "Hidden data" },
    })
    await createHtmlDocument({
      spaceId: "space",
      name: "Board",
      html: "<!doctype html><html><head></head><body><h1>Board</h1></body></html>",
      permissions: {
        network: true,
        records: { deals: { read: true } },
        state: {},
      },
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    await createHtmlDocument({
      spaceId: "space",
      name: "Other board",
      html: "<h1>Other</h1>",
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    await writeWidgetState("space", "board", { team: "default" })
    const beforeLive = await readDocumentPage({
      spaceId: "space",
      path: "board",
      rawSourceAuthorized: false,
      annotationsAuthorized: false,
      sharingAuthorized: true,
    })
    expect(
      beforeLive?.kind === "document" ? beforeLive.sharing?.activeLinks : null
    ).toBe(0)
    const grant = LinkGrantSchema.parse({
      version: 1,
      collections: { deals: { fields: ["name"], timestamps: false } },
      state: "team-read",
    })
    await writeDoc("space", "plan", "# Plan")
    expect(
      (
        await send("POST", "/api/shares/links", {
          target: { kind: "doc", spaceId: "space", path: "plan" },
          grant,
        })
      ).status
    ).toBe(400)
    expect(
      (
        await send("POST", "/api/shares/links", {
          target: { kind: "html", spaceId: "space", path: "board" },
          grant: {
            ...grant,
            collections: {
              deals: { ...grant.collections.deals, fields: ["missing"] },
            },
          },
        })
      ).status
    ).toBe(400)
    const created = await createLink("board", { grant }, "html")
    expect(Date.parse(created.link.expiresAt!) - Date.now()).toBeGreaterThan(
      29 * 86_400_000
    )
    const neverExpires = await createLink(
      "board",
      { grant, expiresAt: null },
      "html"
    )
    expect(neverExpires.link.expiresAt).toBeNull()
    const page = await readDocumentPage({
      spaceId: "space",
      path: "board",
      rawSourceAuthorized: false,
      annotationsAuthorized: false,
      sharingAuthorized: true,
    })
    expect(page?.kind === "document" ? page.sharing?.activeLinks : null).toBe(2)
    const projection = await (await view(created.token)).json()
    expect(projection.live.poll).toBe(30)
    const frame = await view(projection.contentTicket, "/public/share/content")
    expect(frame.status).toBe(200)
    expect(frame.headers.get("Content-Security-Policy")).toContain(
      "script-src 'unsafe-inline'"
    )
    expect(frame.headers.get("Content-Security-Policy")).toContain(
      "connect-src 'none'"
    )
    const html = await frame.text()
    expect(createHash("sha256").update(html).digest("base64url")).toBe(
      projection.live.rev
    )
    expect(html).toContain("mode:'share'")
    expect(html).not.toContain(created.token)
    expect((await view(created.token, "/public/share/content")).status).toBe(
      404
    )
    expect(
      (await send("PATCH", `/api/shares/links/${created.link.id}`, { grant }))
        .status
    ).toBe(200)
    expect(
      (await view(projection.contentTicket, "/public/share/content")).status
    ).toBe(404)
    const bridge = (
      token: string,
      call: unknown = {
        v: 1,
        op: "records.query",
        collection: "deals",
        query: {},
      }
    ) =>
      app().request("/public/share/bridge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-worktable-share-capability": token,
          Origin: sharing.shareOrigin,
          Cookie: "member=ignored",
          Authorization: "Bearer ignored",
        },
        body: JSON.stringify(call),
      })
    // A watcher echo can advance the first cold snapshot after a fixture
    // write. Like the outer broker, retry that explicit transient response.
    const readRecords = async (token: string): Promise<Response> => {
      let response = await bridge(token)
      for (
        let attempt = 0;
        response.status === 429 && attempt < 10;
        attempt++
      ) {
        if ((await response.clone().json()).error?.code !== "LINK_BUSY") break
        await drainWorkspaceChanges()
        response = await bridge(token)
      }
      return response
    }
    recordIndex.start()
    await recordIndex.whenReady()
    const response = await readRecords(created.token)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.result.records[0].data).toEqual({ name: "Public name" })
    expect(JSON.stringify(result)).not.toContain("private-id")
    expect(JSON.stringify(result)).not.toContain("Hidden data")
    expect(
      await (await bridge(created.token, { v: 1, op: "state.read" })).json()
    ).toEqual({ ok: true, result: { state: { team: "default" } } })
    await writeWidgetState("space", "board", { large: "x".repeat(1024 * 1024) })
    await drainWorkspaceChanges()
    // Use the other link's cold state read, rather than the warm two-second
    // memo for the small state just read above.
    const oversized = await bridge(neverExpires.token, {
      v: 1,
      op: "state.read",
    })
    expect(oversized.status).toBe(400)
    expect(oversized.headers.get("Retry-After")).toBeNull()
    expect(await oversized.json()).toEqual({
      ok: false,
      error: { code: "INVALID_QUERY", message: "This result is too large." },
    })
    await writeWidgetState("space", "board", { team: "default" })
    await drainWorkspaceChanges()
    const otherLink = await (await readRecords(neverExpires.token)).json()
    expect(otherLink.result.records[0].id).not.toBe(result.result.records[0].id)
    expect(
      (
        await bridge(created.token, {
          v: 1,
          op: "records.create",
          collection: "deals",
          data: {},
        })
      ).status
    ).toBe(400)
    recordIndex.stop()
    const building = await bridge(created.token, {
      v: 1,
      op: "records.query",
      collection: "deals",
      query: { fields: ["name"] },
    })
    expect(building.status).toBe(503)
    expect(building.headers.get("Retry-After")).toBe("1")
    process.env["WORKTABLE_RECORDS_INDEX"] = "0"
    expect(
      (
        await bridge(created.token, {
          v: 1,
          op: "records.query",
          collection: "deals",
          query: { fields: ["name"] },
        })
      ).status
    ).toBe(503)
    process.env["WORKTABLE_RECORDS_INDEX"] = "1"
    recordIndex.start()
    await recordIndex.whenReady()
    const plain = await createLink("board", {}, "html")
    const unavailable = await bridge("X".repeat(43))
    expect(unavailable.status).toBe(404)
    expect(await (await bridge(plain.token)).text()).toBe(
      await unavailable.text()
    )
    const stalled = await app().fetch(
      new Request("https://runtime.example.test/public/share/bridge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-worktable-share-capability": created.token,
        },
        body: new ReadableStream<Uint8Array>(),
      })
    )
    expect(stalled.status).toBe(429)
    expect(stalled.headers.get("Retry-After")).toBe("1")
    expect((await bridge(created.token)).status).toBe(200)
    // Both reads overlap behind the same middleware as the hosted router.
    const originalRead = linkQueries.queryRecordsForLink
    let entered = 0
    let releaseReads!: () => void
    const readGate = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    const safety = setTimeout(() => releaseReads(), 1000)
    const overlap = spyOn(
      linkQueries,
      "queryRecordsForLink"
    ).mockImplementation(async (...args) => {
      if (++entered === 2) releaseReads()
      await readGate
      return originalRead(...args)
    })
    try {
      const reads = await Promise.all([
        bridge(created.token),
        bridge(created.token),
      ])
      expect(entered).toBe(2)
      expect(reads.map((read) => read.status)).toEqual([200, 200])
    } finally {
      releaseReads()
      clearTimeout(safety)
      overlap.mockRestore()
    }
    let resume!: () => void
    const stalledWork = new Promise<void>((resolve) => {
      resume = resolve
    })
    let settled!: () => void
    const workSettled = new Promise<void>((resolve) => {
      settled = resolve
    })
    const slow = spyOn(linkQueries, "queryRecordsForLink").mockImplementation(
      async (...args) => {
        try {
          await stalledWork
          return await originalRead(...args)
        } finally {
          settled()
        }
      }
    )
    try {
      const timed = await bridge(created.token)
      expect(timed.status).toBe(429)
      expect(timed.headers.get("Retry-After")).toBe("1")
    } finally {
      resume()
      await workSettled
      slow.mockRestore()
    }
    expect((await readRecords(created.token)).status).toBe(200)
    const duringOtherSpaceWrite = spyOn(
      linkQueries,
      "queryRecordsForLink"
    ).mockImplementation(async (...args) => {
      const read = await originalRead(...args)
      await writeSpace({
        type: "worktable.space",
        version: 1,
        id: "other",
        name: "Other",
        createdAt: at,
        updatedAt: at,
        createdBy: "test",
        settings: {},
      })
      await writeDoc("other", "notes", "# Other activity")
      return read
    })
    try {
      expect((await bridge(created.token)).status).toBe(200)
    } finally {
      duringOtherSpaceWrite.mockRestore()
    }
    const toolReads = spyOn(widgetStore, "readWidgetDocument")
    const duringSameSpaceWrite = spyOn(
      linkQueries,
      "queryRecordsForLink"
    ).mockImplementation(async (...args) => {
      const read = await originalRead(...args)
      await writeDoc("space", "unrelated-notes", "# Unrelated activity")
      const edited = await updateWidgetMetadata("space", "other-board", {
        name: "Other board edited",
      })
      try {
        expect(edited.error).toBeNull()
      } finally {
        edited.release?.()
      }
      await notifyWorkspaceChangeAndWaitOrThrow({
        type: "widget",
        spaceId: "space",
        widgetId: "other-board",
      })
      await writeRecordCollectionSchema(
        "space",
        buildRecordCollectionSchema({
          id: "unrelated",
          name: "Unrelated",
          fields: { label: { type: "text" } },
        })
      )
      return read
    })
    try {
      expect((await bridge(created.token)).status).toBe(200)
      duringSameSpaceWrite.mockRestore()
      expect((await bridge(created.token)).status).toBe(200)
      expect(toolReads).not.toHaveBeenCalled()
    } finally {
      duringSameSpaceWrite.mockRestore()
      toolReads.mockRestore()
    }
    const duringOwnToolWrite = spyOn(
      linkQueries,
      "queryRecordsForLink"
    ).mockImplementation(async (...args) => {
      const read = await originalRead(...args)
      const edited = await updateWidgetMetadata("space", "board", {
        name: "Board edited",
      })
      try {
        expect(edited.error).toBeNull()
      } finally {
        edited.release?.()
      }
      await notifyWorkspaceChangeAndWaitOrThrow({
        type: "widget",
        spaceId: "space",
        widgetId: "board",
      })
      return read
    })
    try {
      expect((await bridge(created.token)).status).toBe(429)
    } finally {
      duringOwnToolWrite.mockRestore()
    }
    expect((await readRecords(created.token)).status).toBe(200)
    const duringOwnRecordWrite = spyOn(
      linkQueries,
      "queryRecordsForLink"
    ).mockImplementation(async (...args) => {
      const read = await originalRead(...args)
      await writeRecord("space", {
        version: 1,
        kind: "worktable.record",
        id: "private-id",
        collectionId: "deals",
        createdAt: at,
        updatedAt: at,
        createdBy: "test",
        metadata: {},
        data: { name: "Changed name", secret: "Hidden data" },
      })
      return read
    })
    try {
      expect((await bridge(created.token)).status).toBe(429)
    } finally {
      duringOwnRecordWrite.mockRestore()
    }
    await writeRecordCollectionSchema(
      "space",
      buildRecordCollectionSchema({
        id: "deals",
        name: "Deals",
        fields: { name: { type: "document" }, secret: { type: "text" } },
      })
    )
    expect((await bridge(created.token)).status).toBe(403)
    await writeRecordCollectionSchema(
      "space",
      buildRecordCollectionSchema({
        id: "deals",
        name: "Deals",
        fields: { name: { type: "text" }, secret: { type: "text" } },
      })
    )
    expect((await readRecords(created.token)).status).toBe(200)
    const original = linkQueries.queryRecordsForLink
    const paused = spyOn(linkQueries, "queryRecordsForLink").mockImplementation(
      async (...args) => {
        const read = await original(...args)
        expect(
          (
            await send("PUT", "/api/shares/policy", {
              ...policy,
              liveLinks: true,
              records: "none",
            })
          ).status
        ).toBe(200)
        return read
      }
    )
    try {
      expect((await bridge(created.token)).status).toBe(404)
    } finally {
      paused.mockRestore()
    }
    expect((await bridge(created.token)).status).toBe(403)
    expect(
      (await send("PUT", "/api/shares/policy", { ...policy, liveLinks: false }))
        .status
    ).toBe(200)
    expect((await bridge(created.token)).status).toBe(404)
    // Two real 1.5s timeout paths plus filesystem fixture setup and recovery.
  }, 10_000)

  it("updates totals and counts when an unreturned row leaves the link's scope", async () => {
    process.env["WORKTABLE_RECORDS_INDEX"] = "1"
    saveSharingPolicy(
      { ...defaultSharingPolicy(), liveLinks: true },
      "local:owner"
    )
    await writeRecordCollectionSchema(
      "space",
      buildRecordCollectionSchema({
        id: "clients",
        name: "Clients",
        fields: { name: { type: "text" } },
      })
    )
    await writeRecordCollectionSchema(
      "space",
      buildRecordCollectionSchema({
        id: "deals",
        name: "Deals",
        fields: {
          name: { type: "text" },
          visibility: { type: "text" },
          client: { type: "relation", references: "clients" },
        },
      })
    )
    const at = new Date().toISOString()
    const row = (id: string, visibility: string): RecordFile => ({
      version: 1,
      kind: "worktable.record",
      id,
      collectionId: "deals",
      createdAt: at,
      updatedAt: at,
      createdBy: "test",
      metadata: {},
      data: { name: id, visibility, client: "client-id" },
    })
    await writeRecord("space", {
      version: 1,
      kind: "worktable.record",
      id: "client-id",
      collectionId: "clients",
      createdAt: at,
      updatedAt: at,
      createdBy: "test",
      metadata: {},
      data: { name: "Public client" },
    })
    await writeRecord("space", row("first", "public"))
    await writeRecord("space", row("second", "public"))
    await createHtmlDocument({
      spaceId: "space",
      name: "Counts",
      html: "<h1>Counts</h1>",
      permissions: {
        network: false,
        records: { deals: { read: true }, clients: { read: true } },
        state: {},
      },
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    const rows = { field: "visibility", op: "eq", value: "public" }
    const scoped = await createLink(
      "counts",
      {
        grant: LinkGrantSchema.parse({
          version: 1,
          collections: {
            deals: { fields: ["name", "client"], rows },
            clients: { fields: ["name"] },
          },
        }),
      },
      "html"
    )
    const summary = await createLink(
      "counts",
      {
        grant: LinkGrantSchema.parse({
          version: 1,
          collections: { deals: { fields: [], rows } },
        }),
      },
      "html"
    )
    const bridge = (token: string, value: unknown) =>
      app().request("/public/share/bridge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-worktable-share-capability": token,
        },
        body: JSON.stringify(value),
      })
    const call = async (token: string, value: unknown) => {
      let response: Response
      for (let attempt = 0; ; attempt++) {
        response = await bridge(token, value)
        if (response.status !== 429 || attempt === 10) break
        await drainWorkspaceChanges()
      }
      expect(response.status).toBe(200)
      return (await response.json()).result
    }
    const query = (query: unknown) => ({
      v: 1,
      op: "records.query",
      collection: "deals",
      query,
    })
    recordIndex.start()
    await recordIndex.whenReady()
    await drainWorkspaceChanges()
    const aggregate = query({ aggregate: { select: { n: { fn: "count" } } } })
    const limitedQuery = query({ limit: 1, expand: { client: ["name"] } })
    const requests = [
      [scoped.token, limitedQuery],
      [summary.token, aggregate],
    ] as const
    // Both memoized loads outlive their initiating response. Later callers
    // join the same loads and still need all contributing rows remembered.
    let resume!: () => void
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const run = recordQueries.runQueryV2
    let loads = 0
    const slow = spyOn(recordQueries, "runQueryV2").mockImplementation(
      async (...args) => {
        loads++
        await gate
        return run(...args)
      }
    )
    const readMemo = linkReadMemo.read.bind(linkReadMemo)
    let joined!: () => void
    const secondCallers = new Promise<void>((resolve) => {
      joined = resolve
    })
    let memoCalls = 0
    const memo = spyOn(linkReadMemo, "read").mockImplementation(
      <T>(key: string, load: () => Promise<T>): Promise<T> => {
        const value = readMemo(key, load)
        if (++memoCalls === 4) joined()
        return value
      }
    )
    try {
      const expired = await Promise.all(
        requests.map(([token, value]) => bridge(token, value))
      )
      expect(expired.map((response) => response.status)).toEqual([429, 429])
      expect(loads).toBe(2)
      const successful = Promise.all(
        requests.map(([token, value]) => bridge(token, value))
      )
      await secondCallers
      resume()
      const responses = await successful
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      const [limited, counted] = await Promise.all(
        responses.map(async (response) => (await response.json()).result)
      )
      expect(limited.records).toHaveLength(1)
      expect(limited.total).toBe(2)
      expect(
        Object.values(
          limited.expanded.clients as Record<string, RecordFile>
        ).map((row) => row.data)
      ).toEqual([{ name: "Public client" }])
      expect(counted.groups).toEqual([{ n: 2 }])
      expect(loads).toBe(2)
    } finally {
      resume()
      slow.mockRestore()
      memo.mockRestore()
    }
    // Even an unchanged policy save advances authorization. Repeating the
    // same warm queries must record contributors in the new journal.
    const before = await (await send("GET", "/api/shares/policy")).json()
    expect(
      (await send("PUT", "/api/shares/policy", before.policy)).status
    ).toBe(200)
    const after = await (await send("GET", "/api/shares/policy")).json()
    expect(after.policy).toEqual(before.policy)
    expect(after.revision).toBeGreaterThan(before.revision)
    let unreturnedId = "second"
    const refreshed = spyOn(recordQueries, "runQueryV2")
    try {
      const [limited] = await Promise.all(
        requests.map(([token, value]) => call(token, value))
      )
      const shown = limited.records[0].data.name
      expect(["first", "second"]).toContain(shown)
      unreturnedId = shown === "first" ? "second" : "first"
      expect(refreshed).toHaveBeenCalledTimes(2)
    } finally {
      refreshed.mockRestore()
    }
    const cursors = await Promise.all(
      [scoped, summary].map(
        async ({ token }) => (await call(token, { v: 1, op: "changes" })).cursor
      )
    )
    await writeRecord("space", row(unreturnedId, "private"))
    await notifyWorkspaceChangeAndWaitOrThrow({
      type: "record",
      spaceId: "space",
      collectionId: "deals",
      recordId: unreturnedId,
    })
    for (const [index, { token }] of [scoped, summary].entries()) {
      let changed: string[] = []
      for (let attempt = 0; attempt < 20; attempt++) {
        changed = (
          await call(token, { v: 1, op: "changes", since: cursors[index] })
        ).collections
        if (changed.includes("deals")) break
        // test-policy: external-readiness-backoff. Await the bounded background record delivery.
        await Bun.sleep(5)
      }
      expect(changed).toEqual(["deals"])
    }
    expect((await call(scoped.token, query({ limit: 1 }))).total).toBe(1)
    expect((await call(summary.token, aggregate)).groups).toEqual([{ n: 1 }])
  }, 10_000)

  it("keeps links saved while links had several ways to read Records", async () => {
    process.env["WORKTABLE_RECORDS_INDEX"] = "1"
    saveSharingPolicy(
      { ...defaultSharingPolicy(), liveLinks: true },
      "local:owner"
    )
    await writeRecordCollectionSchema(
      "space",
      buildRecordCollectionSchema({
        id: "deals",
        name: "Deals",
        fields: {
          name: { type: "text" },
          stage: { type: "select", values: ["won"] },
        },
      })
    )
    const at = new Date().toISOString()
    await writeRecord("space", {
      version: 1,
      kind: "worktable.record",
      id: "deal",
      collectionId: "deals",
      createdAt: at,
      updatedAt: at,
      createdBy: "test",
      metadata: {},
      data: { name: "Renewal", stage: "won" },
    })
    await createHtmlDocument({
      spaceId: "space",
      name: "Board",
      html: "<h1>Board</h1>",
      permissions: {
        network: false,
        records: { deals: { read: true } },
        state: {},
      },
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    await writeDoc("space", "plan", "# Plan")
    const grant = LinkGrantSchema.parse({
      version: 1,
      collections: { deals: { fields: ["name"] } },
    })
    const [scoped, totals, saved] = [
      await createLink("board", { grant }, "html"),
      await createLink("board", { grant }, "html"),
      await createLink("board", { grant }, "html"),
    ]
    const doc = await createLink("plan")
    // Grants and the owner policy as earlier versions stored them.
    const stored = (collection: Record<string, unknown>) =>
      JSON.stringify({
        version: 1,
        collections: {
          deals: {
            rows: null,
            fields: ["name"],
            timestamps: true,
            ...collection,
          },
        },
        limits: {
          rowsPerQuery: 200,
          queriesPerMinute: 120,
          rowsPerHour: 10_000,
        },
        state: "visitor",
      })
    closeShareLinkStores()
    const db = new Database(shareLinksDatabasePath())
    for (const [link, collection] of [
      [scoped, { mode: "scoped" }],
      [
        totals,
        {
          mode: "summaries",
          fields: [],
          summaries: {
            groupBy: ["stage"],
            measures: [],
            fns: ["count"],
            minGroupSize: 5,
          },
        },
      ],
      [
        saved,
        { mode: "fixed", fixed: [{ id: "read-1", query: {}, params: {} }] },
      ],
    ] as const) {
      db.query("UPDATE share_links SET grant_json = ? WHERE id = ?").run(
        stored(collection),
        link.link.id
      )
      // The proof an earlier reader wrote for that grant.
      db.query(
        "INSERT OR REPLACE INTO share_link_grants (link_id, grant_json, reader_version) VALUES (?, ?, 1)"
      ).run(link.link.id, stored(collection))
    }
    db.close()
    // The boot refresh keeps the proof of a grant this version reads and drops
    // the others, so the document's summary counts only links that open.
    expect(refreshShareLinkGrantProofs()).toEqual({ kept: 1, dropped: 2 })
    const board = getShareLink(scoped.link.id)!
    expect(
      documentShareLinkSummary(
        board.spaceId,
        board.documentId,
        Date.now(),
        null,
        () => true,
        false,
        true
      ).activeLinks
    ).toBe(1)
    const bridge = async (token: string) => {
      let response = await app().request("/public/share/bridge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-worktable-share-capability": token,
        },
        body: JSON.stringify({
          v: 1,
          op: "records.query",
          collection: "deals",
          query: {},
        }),
      })
      for (
        let attempt = 0;
        response.status === 429 && attempt < 10;
        attempt++
      ) {
        await drainWorkspaceChanges()
        response = await app().request("/public/share/bridge", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-worktable-share-capability": token,
          },
          body: JSON.stringify({
            v: 1,
            op: "records.query",
            collection: "deals",
            query: {},
          }),
        })
      }
      return response
    }
    recordIndex.start()
    await recordIndex.whenReady()
    // A scoped grant opens as before; totals and saved reads close their own
    // link only.
    expect((await view(scoped.token)).status).toBe(200)
    const opened = await bridge(scoped.token)
    expect(opened.status).toBe(200)
    expect(
      (await opened.json()).result.records.map(
        (record: RecordFile) => record.data
      )
    ).toEqual([{ name: "Renewal" }])
    expect([
      (await view(totals.token)).status,
      (await view(saved.token)).status,
    ]).toEqual([404, 404])
    expect((await view(doc.token)).status).toBe(200)

    // A policy that allowed only totals or saved reads turns live Records
    // off, and pauses nothing.
    for (const records of ["summaries", "fixed"]) {
      closeShareLinkStores()
      const policyDb = new Database(shareLinksDatabasePath())
      policyDb
        .query(
          "UPDATE share_policy SET policy = ?, revision = revision + 1 WHERE id = 1"
        )
        .run(
          JSON.stringify({
            ...defaultSharingPolicy(),
            liveLinks: true,
            records,
          })
        )
      policyDb.close()
      expect(
        (await (await send("GET", "/api/shares/policy")).json()).policy
      ).toMatchObject({ paused: false, liveLinks: true, records: "none" })
      expect([
        (await view(scoped.token)).status,
        (await view(doc.token)).status,
      ]).toEqual([200, 200])
      expect((await bridge(scoped.token)).status).toBe(403)
    }
  })

  it("requires passwords, binds unlocks to current credentials, and expires links", async () => {
    await writeDoc("space", "plan", "# Plan")
    const password = "test-only visitor password"
    const plain = await createLink("plan")
    const created = await createLink("plan", { password })
    expect(JSON.stringify(created)).not.toContain("argon2")
    const policy = (await (await send("GET", "/api/shares/policy")).json()) as {
      policy: SharingPolicy
      revision: number
    }
    expect(
      (
        await send("PUT", "/api/shares/policy", {
          ...policy.policy,
          requirePassword: true,
        })
      ).status
    ).toBe(200)
    expect((await view(plain.token)).status).toBe(404)
    const page = await readDocumentPage({
      spaceId: "space",
      path: "plan",
      rawSourceAuthorized: false,
      annotationsAuthorized: false,
      sharingAuthorized: true,
    })
    expect(page?.kind === "document" ? page.sharing?.activeLinks : null).toBe(1)
    expect((await view(created.token)).status).toBe(401)
    const unlock = (value: string, token = created.token) =>
      app().request("/public/share/unlock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-worktable-share-capability": token,
        },
        body: JSON.stringify({ password: value }),
      })
    expect((await unlock("wrong")).status).toBe(401)
    const response = await unlock(password)
    expect(response.status).toBe(200)
    const unlocked = (await response.json()) as {
      ticket: string
      maxAge: number
    }
    expect(unlocked.maxAge).toBeLessThanOrEqual(12 * 60 * 60)
    expect(
      (await view(created.token, "/public/share", unlocked.ticket)).status
    ).toBe(200)
    const changed = await send(
      "PATCH",
      `/api/shares/links/${created.link.id}`,
      { password: "replacement password" }
    )
    expect(changed.status).toBe(200)
    expect(
      (await view(created.token, "/public/share", unlocked.ticket)).status
    ).toBe(401)
    expect((await unlock(password)).status).toBe(401)
    const next = (await (await unlock("replacement password")).json()) as {
      ticket: string
    }
    const limited = await createLink("plan", { password })
    const wrong = spyOn(Bun.password, "verify").mockResolvedValue(false)
    try {
      for (let attempt = 0; attempt < 30; attempt++)
        expect((await unlock("wrong", limited.token)).status).toBe(401)
      const blocked = await unlock("wrong", limited.token)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/)
      expect(blocked.headers.get("Cache-Control")).toContain("no-store")
      expect(wrong).toHaveBeenCalledTimes(30)
    } finally {
      wrong.mockRestore()
    }
    updateShareLink(created.link.id, { expiresAt: Date.now() - 1 })
    expect(
      (await view(created.token, "/public/share", next.ticket)).status
    ).toBe(410)
    revokeShareLink(created.link.id, "local:owner")
    expect(
      (await view(created.token, "/public/share", next.ticket)).status
    ).toBe(404)
  })

  it("keeps pending legacy HTML links usable without exposing their bearer token in frames", async () => {
    await createHtmlDocument({
      spaceId: "space",
      explicitId: "legacy",
      name: "Legacy",
      html: "<h1>Legacy report</h1>",
      createdBy: "test",
      permissions: {
        network: false,
        records: {},
        state: { read: false, write: false },
      },
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    const legacy = await createDocumentShare({
      kind: "html",
      spaceId: "space",
      artifactKey: "legacy",
    })
    const epoch = await getWorkspaceCollaborationEpoch()
    let resume!: () => void
    const held = spyOn(
      collaborationEpoch,
      "getWorkspaceCollaborationEpoch"
    ).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resume = () => resolve(epoch)
        })
    )
    const draining = drainV1ShareLinks()
    try {
      expect(shareUnlockSecret()).not.toBeNull()
      const outer = await view(legacy.token)
      expect(outer.status).toBe(200)
      const { contentTicket } = (await outer.json()) as {
        contentTicket: string
      }
      expect(contentTicket).not.toContain(legacy.token)
      expect((await view(legacy.token, "/public/share/content")).status).toBe(
        404
      )
      const frame = await view(contentTicket, "/public/share/content")
      expect(frame.status).toBe(200)
      expect(await frame.text()).toContain("Legacy report")
      await stopDocumentShare({
        kind: "html",
        spaceId: "space",
        artifactKey: "legacy",
      })
      expect((await view(contentTicket, "/public/share/content")).status).toBe(
        404
      )
    } finally {
      resume?.()
      await draining
      held.mockRestore()
    }
  })

  it("opens several links to one document on their own, and revoking one leaves the rest", async () => {
    await writeDoc("space", "plan", "# Plan\n\nShared detail.")
    const acme = await createLink("plan", { label: "Acme" })
    const board = await createLink("plan", { label: "Board" })
    expect(acme.url).toMatch(
      /^https:\/\/share\.example\.test\/s\/ws_synthetic\/[A-Za-z0-9_-]{43}$/
    )
    expect(acme.link).toMatchObject({
      label: "Acme",
      level: "view",
      status: "active",
      path: "plan",
      tokenHint: acme.token.slice(-4),
      lastUsedAt: null,
    })

    for (const { token } of [acme, board]) {
      const page = await view(token)
      expect(page.status).toBe(200)
      expect(
        ((await page.json()) as { projectionHtml: string }).projectionHtml
      ).toContain("Shared detail.")
    }

    const revoked = await send("DELETE", `/api/shares/links/${acme.link.id}`)
    expect(
      ((await revoked.json()) as { link: { status: string } }).link.status
    ).toBe("revoked")
    const gone = await view(acme.token)
    expect(gone.status).toBe(404)
    expect(await gone.text()).toBe("")
    expect((await view(board.token)).status).toBe(200)

    // A view notes its use in memory; the store hears of it when flushed.
    expect((await documentLinks("plan")).links[0]?.lastUsedAt).toBeNull()
    flushShareLinkUse()
    const listed = await documentLinks("plan")
    expect(listed.canCreate).toBe(true)
    expect(listed.links.map((link) => link.id)).toEqual([board.link.id])
    expect(Date.parse(listed.links[0]!.lastUsedAt!) % 60_000).toBe(0)
    // Its URL can be copied again later.
    expect(listed.links[0]?.url).toBe(board.url)

    updateShareLink(board.link.id, { expiresAt: Date.now() - 1 })
    expect((await view(board.token)).status).toBe(410)
    expect((await documentLinks("plan")).links[0]?.status).toBe("expired")

    // A view whose render outlasts a revoke is not sent.
    const late = await createLink("plan", { label: "Late" })
    const read = views.readShareLinkDocument
    const revokedWhileReading = spyOn(
      views,
      "readShareLinkDocument"
    ).mockImplementationOnce(async (...args) => {
      revokeShareLink(late.link.id, "local:owner")
      return read(...args)
    })
    expect((await view(late.token)).status).toBe(404)
    expect(revokedWhileReading).toHaveBeenCalledTimes(1)
    revokedWhileReading.mockRestore()
  })

  it("tells the document page how many links still open, so it needs no request of its own", async () => {
    await writeDoc("space", "plan", "# Plan")
    const page = async (sharingAuthorized = true) => {
      const result = await readDocumentPage({
        spaceId: "space",
        path: "plan",
        rawSourceAuthorized: false,
        annotationsAuthorized: false,
        sharingAuthorized,
      })
      return result?.kind === "document" ? result.sharing : null
    }
    expect(await page()).toEqual({ activeLinks: 0, canCreate: true })
    expect(await page(false)).toBeUndefined()
    const locked = await createLink("plan", { password: "test-only password" })
    expect(await page()).toEqual({ activeLinks: 1, canCreate: true })
    await send("DELETE", `/api/shares/links/${locked.link.id}`)

    const open = await createLink("plan")
    const revoked = await createLink("plan")
    const expired = await createLink("plan")
    await send("DELETE", `/api/shares/links/${revoked.link.id}`)
    updateShareLink(expired.link.id, { expiresAt: Date.now() - 1 })
    expect(await page()).toEqual({ activeLinks: 1, canCreate: true })
    expect((await view(open.token)).status).toBe(200)
    const nextExpiry = Date.now() + 60_000
    updateShareLink(open.link.id, { expiresAt: nextExpiry })
    expect(await page()).toEqual({
      activeLinks: 1,
      canCreate: true,
      nextExpiry: new Date(nextExpiry).toISOString(),
    })

    closeShareLinkStores()
    const db = new Database(shareLinksDatabasePath())
    db.run(
      "UPDATE share_links SET password_hash = 'later-version' WHERE id = ?",
      [open.link.id]
    )
    db.close()
    expect(await page()).toEqual({ activeLinks: 0, canCreate: true })
  })

  it("keeps tokens only as digests and sealed, so the store's files hold none in the clear", async () => {
    await writeDoc("space", "plan", "# Plan")
    const { token, link, url } = await createLink("plan")
    const other = await createLink("plan")
    expect((await view(token)).status).toBe(200)
    flushShareLinkUse()

    // A seal opens only for its own link: one moved onto another gives no URL.
    closeShareLinkStores()
    const db = new Database(shareLinksDatabasePath())
    const seal = (id: string) =>
      db
        .query<
          { nonce: Uint8Array; sealed: Uint8Array },
          [string]
        >("SELECT nonce, sealed FROM share_link_tokens WHERE link_id = ?")
        .get(id)!
    const original = seal(other.link.id)
    const moved = seal(link.id)
    db.query(
      "UPDATE share_link_tokens SET nonce = ?, sealed = ? WHERE link_id = ?"
    ).run(moved.nonce, moved.sealed, other.link.id)
    const urls = async () =>
      new Map(
        (await documentLinks("plan")).links.map((listed) => [
          listed.id,
          listed.url,
        ])
      )
    expect(await urls()).toEqual(
      new Map([
        [other.link.id, undefined],
        [link.id, url],
      ])
    )
    db.query(
      "UPDATE share_link_tokens SET nonce = ?, sealed = ? WHERE link_id = ?"
    ).run(original.nonce, original.sealed, other.link.id)
    db.close()
    expect((await urls()).get(other.link.id)).toBe(other.url)
    // A revoked link's seal goes with it.
    await send("DELETE", `/api/shares/links/${other.link.id}`)
    closeShareLinkStores()
    const after = new Database(shareLinksDatabasePath())
    expect(
      after
        .query("SELECT count(*) AS n FROM share_link_tokens WHERE link_id = ?")
        .get(other.link.id)
    ).toEqual({ n: 0 })
    after.close()

    const directory = join(shareLinksDatabasePath(), "..")
    expect((await stat(shareLinksDatabasePath())).mode & 0o777).toBe(0o600)
    const bytes = Buffer.concat(
      await Promise.all(
        (await readdir(directory)).map((name) =>
          readFile(join(directory, name))
        )
      )
    )
    expect(bytes.includes(Buffer.from(token))).toBe(false)
    expect(bytes.includes(Buffer.from(token, "base64url"))).toBe(false)

    const nearMiss = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`
    const missed = await view(nearMiss)
    const malformed = await view("not-a-token")
    expect(missed.status).toBe(404)
    expect(malformed.status).toBe(404)
    expect(await missed.text()).toBe(await malformed.text())
  })

  it("serves nothing it does not understand, and no older link once it can't read the owner policy", async () => {
    await writeDoc("space", "plan", "# Plan")
    // A link an older binary made, not yet moved.
    const legacyToken = (
      await createDocumentShare({
        kind: "doc",
        spaceId: "space",
        artifactKey: "plan",
      })
    ).token
    const locked = await createLink("plan")
    const open = await createLink("plan")

    // A later version's password on one link.
    closeShareLinkStores()
    const db = new Database(shareLinksDatabasePath())
    db.query("UPDATE share_links SET password_hash = 'later' WHERE id = ?").run(
      locked.link.id
    )
    expect((await view(locked.token)).status).toBe(404)
    expect((await view(open.token)).status).toBe(200)
    expect((await view(legacyToken)).status).toBe(200)

    // A later version of the whole store: its policy can't be checked, so
    // today's links stay closed too.
    closeShareLinkStores()
    db.exec("PRAGMA user_version = 2")
    db.close()
    expect((await view(open.token)).status).toBe(404)
    expect((await view(legacyToken)).status).toBe(404)
    const closed = await send("GET", "/api/shares/links/all")
    expect(closed.status).toBe(503)
    expect(await closed.json()).toMatchObject({
      code: "SHARE_LINKS_UNAVAILABLE",
    })
  })

  it("follows a Doc through renames and moves, and archiving ends its links for good", async () => {
    await writeDoc("space", "draft", "# Draft\n\nKept across moves.")
    const { token, link } = await createLink("draft")

    expect(
      (await renameDocAndSync("space", "draft", "notes/final")).error
    ).toBeNull()
    const moved = await view(token)
    expect(moved.status).toBe(200)
    expect(
      ((await moved.json()) as { projectionHtml: string }).projectionHtml
    ).toContain("Kept across moves.")
    expect((await documentLinks("notes/final")).links[0]).toMatchObject({
      id: link.id,
      path: "notes/final",
    })

    expect(
      (await setDocArchived("space", "notes/final", true)).error
    ).toBeNull()
    expect((await view(token)).status).toBe(404)
    expect(
      (await setDocArchived("space", "notes/final", false)).error
    ).toBeNull()
    expect((await view(token)).status).toBe(404)
    expect((await documentLinks("notes/final")).links).toEqual([])
  })

  it("shows the images a shared Doc embeds from its Space, and a changed image at once", async () => {
    const previous = process.env["WORKTABLE_FILES_PREVIEW"]
    process.env["WORKTABLE_FILES_PREVIEW"] = "1"
    try {
      const docs = join(workspaceDir, "spaces", "space", "docs")
      await mkdir(join(docs, "spec"), { recursive: true })
      await writeFile(join(docs, "spec", "shot.png"), "first image")
      await writeFile(join(docs, "secret.png"), "not embedded")
      await writeDoc(
        "space",
        "spec",
        "# Spec\n\n![Signup error](spec/shot.png)\n\n[Other](secret.png)"
      )
      const { token } = await createLink("spec")
      const projection = async () =>
        ((await (await view(token)).json()) as { projectionHtml: string })
          .projectionHtml

      const first = await projection()
      expect(first).toContain(
        `data:image/png;base64,${Buffer.from("first image").toString("base64")}`
      )
      // Only what the Doc embeds: a linked file is not placed in the page.
      expect(first).not.toContain(
        Buffer.from("not embedded").toString("base64")
      )

      // A new version of the image shows without the Doc changing; its new
      // size tells it apart even within the same millisecond.
      await writeFile(join(docs, "spec", "shot.png"), "second image, longer")
      expect(await projection()).toContain(
        Buffer.from("second image, longer").toString("base64")
      )

      // A rich Doc's image blocks show the same way.
      await writeDoc("space", "board", [
        {
          id: "image-1",
          type: "image",
          props: { url: "spec/shot.png", caption: "Shot", name: "shot.png" },
          children: [],
        },
      ])
      const rich = await createLink("board")
      expect(
        ((await (await view(rich.token)).json()) as { projectionHtml: string })
          .projectionHtml
      ).toContain(Buffer.from("second image, longer").toString("base64"))

      // A code example's image is code, never read; an image missing at first
      // shows once its file arrives; an image repeated past the page's budget
      // keeps the placeholder at every occurrence.
      await writeFile(join(docs, "big.png"), Buffer.alloc(1536 * 1024, 7))
      await writeDoc(
        "space",
        "notes",
        "# Notes\n\n~~~md\n![Example](secret.png)\n~~~\n\n![Later](later.png)\n\n![a](big.png) ![b](big.png) ![c](big.png)\n"
      )
      noteSpaceChanged("space")
      const notes = await createLink("notes")
      const notesPage = async () =>
        ((await (await view(notes.token)).json()) as { projectionHtml: string })
          .projectionHtml
      const before = await notesPage()
      expect(before).not.toContain(
        Buffer.from("not embedded").toString("base64")
      )
      expect(before).not.toContain("data:image")
      await writeFile(join(docs, "later.png"), "later image")
      noteSpaceChanged("space")
      expect(await notesPage()).toContain(
        Buffer.from("later image").toString("base64")
      )
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"]
      else process.env["WORKTABLE_FILES_PREVIEW"] = previous
    }
  })

  it("follows an HTML Doc through moves and title edits until it is deleted", async () => {
    await useHtmlStorageV2()
    const written = await createHtmlDocument({
      spaceId: "space",
      explicitId: "status",
      name: "Status board",
      html: "<main><h1>Operational</h1><script>fetch('/x')</script></main>",
      createdBy: "test",
      permissions: { network: false, records: {}, state: {} },
      versionSource: "test",
      versionUpdatedBy: "test",
    })
    expect(written.error).toBeUndefined()
    const { token } = await createLink("status", {}, "html")

    const moved = await moveHtmlDocument("space", "status", "boards/status")
    expect(moved.ok).toBe(true)
    const frame = (await (await view(token)).json()) as {
      contentTicket: string
    }
    expect((await view(token, "/public/share/content")).status).toBe(404)
    const content = await view(frame.contentTicket, "/public/share/content")
    expect(content.status).toBe(200)
    const html = await content.text()
    expect(html).toContain("Operational")
    expect(html).not.toContain("<script")

    const renamed = await updateWidgetMetadata("space", "boards/status", {
      name: "Live status",
    })
    expect(renamed.error).toBeNull()
    renamed.release?.()
    expect(await (await view(token)).json()).toMatchObject({
      kind: "html",
      title: "Live status",
    })

    expect((await deleteHtmlDocument("space", "boards/status")).ok).toBe(true)
    expect((await view(token)).status).toBe(404)
    expect((await view(token, "/public/share/content")).status).toBe(404)
  })

  it("ends links when their document is removed or archived on disk, or the workspace is replaced", async () => {
    await writeDoc("space", "external", "# Original")
    await writeDoc("space", "shelved", "# Shelved")
    await writeDoc("space", "kept", "# Kept")
    const removed = await createLink("external")
    const shelved = await createLink("shelved")
    const kept = await createLink("kept")

    await rm(join(workspaceDir, "spaces", "space", "docs", "external.md"))
    await notifyWorkspaceChangeAndWaitOrThrow({
      type: "doc",
      spaceId: "space",
      docPath: "external",
    })
    await settleShareLinkReconciles()
    await writeDoc("space", "external", "# Replacement")
    expect((await view(removed.token)).status).toBe(404)

    // Archived by editing the metadata, then restored the same way.
    const metaPath = join(workspaceDir, "spaces", "space", "docs.meta.json")
    const before = existsSync(metaPath)
      ? await readFile(metaPath, "utf8")
      : JSON.stringify({ version: 1, docs: {} })
    const meta = JSON.parse(before) as {
      docs: Record<string, Record<string, unknown>>
    }
    meta.docs["shelved"] = {
      ...meta.docs["shelved"],
      archived: { archivedAt: new Date().toISOString(), archivedBy: "user" },
    }
    await writeFile(metaPath, JSON.stringify(meta))
    await notifyWorkspaceChangeAndWaitOrThrow({
      type: "documentCorpus",
      spaceId: "space",
    })
    await settleShareLinkReconciles()
    await writeFile(metaPath, before)
    await notifyWorkspaceChangeAndWaitOrThrow({
      type: "documentCorpus",
      spaceId: "space",
    })
    expect((await view(shelved.token)).status).toBe(404)
    expect((await view(kept.token)).status).toBe(200)

    await notifyWorkspaceChangeAndWaitOrThrow({ type: "workspaceReset" })
    expect((await view(kept.token)).status).toBe(404)
    const all = (await (
      await send("GET", "/api/shares/links/all?status=revoked")
    ).json()) as { links: Array<{ id: string }> }
    expect(all.links.map((link) => link.id).sort()).toEqual(
      [removed.link.id, shelved.link.id, kept.link.id].sort()
    )
  })

  it("lets only people share", async () => {
    await writeDoc("space", "plan", "# Plan")
    const target = { kind: "doc", spaceId: "space", path: "plan" }
    expect(
      (await send("POST", "/api/shares/links", { target }, agent)).status
    ).toBe(403)
    expect(
      (
        await send(
          "GET",
          "/api/shares/links/all",
          undefined,
          person(["docs:read"])
        )
      ).status
    ).toBe(403)
    // The decision itself denies agents, whatever reached it.
    expect(authorizeShareAction(agent, "read", "space")).toMatchObject({
      allowed: false,
      status: 403,
    })

    const comment = await send("POST", "/api/shares/links", {
      target,
      level: "comment",
    })
    expect(comment.status).toBe(400)
    expect(await comment.json()).toMatchObject({ code: "LEVEL_NOT_AVAILABLE" })
    expect(existsSync(shareLinksDatabasePath())).toBe(false)
    const past = await send("POST", "/api/shares/links", {
      target,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    expect(past.status).toBe(400)
    const escaping = await send("POST", "/api/shares/links", {
      target: { ...target, path: "../plan" },
    })
    expect(escaping.status).toBe(400)
  })
})

describe("moving today's links into links v2", () => {
  // This Worktable's file of today's links. Older releases kept every
  // Worktable's links in one shared file, which each Worktable empties of its
  // own links before reading them here.
  const v1File = () =>
    join(appDir, "document-shares", `${workspaceCacheKey()}.json`)

  /** A link as an earlier version makes it, in its file. */
  async function legacyLink(
    artifactKey: string,
    kind: "doc" | "html" = "doc"
  ): Promise<{ token: string; createdAt: string }> {
    return await createDocumentShare({ kind, spaceId: "space", artifactKey })
  }

  it("makes no store for a Worktable whose links aren't in the shared file", async () => {
    // Every Worktable on the machine sees the file older releases shared. One
    // whose links aren't in it gets no store, so a later recovery can still
    // restore its owner policy.
    await writeFile(
      join(appDir, "document-shares.json"),
      JSON.stringify({
        type: "worktable.document-shares",
        version: 1,
        shares: [
          {
            token: "O".repeat(43),
            kind: "doc",
            spaceId: "space",
            artifactKey: "plan",
            workspaceEpoch: "A".repeat(43),
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8"
    )
    await drainV1ShareLinks()
    expect(existsSync(shareLinksDatabasePath())).toBe(false)
  })

  it("moves links from the file older releases shared between Worktables", async () => {
    await writeDoc("space", "plan", "# Plan")
    const token = "L".repeat(43)
    // A release from before each Worktable kept its own file, and no store yet.
    await writeFile(
      join(appDir, "document-shares.json"),
      JSON.stringify({
        type: "worktable.document-shares",
        version: 1,
        shares: [
          {
            token,
            kind: "doc",
            spaceId: "space",
            artifactKey: "plan",
            workspaceEpoch: await getWorkspaceCollaborationEpoch(),
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8"
    )
    expect(existsSync(shareLinksDatabasePath())).toBe(false)
    await drainV1ShareLinks()
    expect((await documentLinks("plan")).links).toHaveLength(1)
    expect((await view(token)).status).toBe(200)
  })

  /** What an older binary reads from the file: strictly parsed, or it throws. */
  async function v1FileAsOlderBinaryReadsIt(token: string) {
    expect(JSON.parse(await readFile(v1File(), "utf8"))).toEqual({
      type: "worktable.document-shares",
      version: 1,
      shares: [],
    })
    return await resolveDocumentShare(token)
  }

  it("keeps their URLs working, drops links that open nothing, and leaves an empty file older binaries read", async () => {
    await useHtmlStorageV2()
    await writeDoc("space", "plan", "# Plan\n\nMoved over.")
    await writeDoc("space", "retired", "# Retired")
    await writeDoc("space", "removed", "# Removed")
    expect(
      (
        await createHtmlDocument({
          spaceId: "space",
          explicitId: "status",
          name: "Status board",
          html: "<main><h1>Operational</h1></main>",
          createdBy: "test",
          permissions: { network: false, records: {}, state: {} },
          versionSource: "test",
          versionUpdatedBy: "test",
        })
      ).error
    ).toBeUndefined()
    const plan = await legacyLink("plan")
    const status = await legacyLink("status", "html")
    const retired = await legacyLink("retired")
    const removed = await legacyLink("removed")
    // Today's links outside Cloud end only when the watcher sees the change.
    expect((await setDocArchived("space", "retired", true)).error).toBeNull()
    await rm(join(workspaceDir, "spaces", "space", "docs", "removed.md"))
    // A link from before the workspace was last replaced opens nothing.
    const file = JSON.parse(await readFile(v1File(), "utf8"))
    file.shares.push({
      ...file.shares[0],
      token: "E".repeat(43),
      workspaceEpoch: "E".repeat(43),
    })
    await writeFile(v1File(), JSON.stringify(file))

    await drainV1ShareLinks()

    expect(await v1FileAsOlderBinaryReadsIt(plan.token)).toBeNull()
    const moved = await documentLinks("plan")
    expect(moved.links).toHaveLength(1)
    // The same URL opens it, and whoever manages it can copy that URL again.
    expect(moved.links[0]).toMatchObject({
      label: "",
      status: "active",
      createdAt: plan.createdAt,
      tokenHint: plan.token.slice(-4),
      url: `${sharing.shareOrigin}/s/${sharing.workspaceId}/${plan.token}`,
    })
    expect(
      ((await (await view(plan.token)).json()) as { projectionHtml: string })
        .projectionHtml
    ).toContain("Moved over.")
    const outer = await view(status.token)
    expect(outer.status).toBe(200)
    const { contentTicket } = (await outer.json()) as { contentTicket: string }
    expect(
      await (await view(contentTicket, "/public/share/content")).text()
    ).toContain("Operational")
    for (const token of [retired.token, removed.token, "E".repeat(43)]) {
      expect((await view(token)).status).toBe(404)
    }
    const all = (await (await send("GET", "/api/shares/links/all")).json()) as {
      links: unknown[]
    }
    expect(all.links).toHaveLength(2)

    // Moved links follow their document.
    expect(
      (await renameDocAndSync("space", "plan", "notes/plan")).error
    ).toBeNull()
    expect((await view(plan.token)).status).toBe(200)
    expect((await documentLinks("notes/plan")).links).toHaveLength(1)
  })

  it("finishes a move cut short without copying or reviving links, and follows what an older binary does meanwhile", async () => {
    const links: Record<string, { token: string; createdAt: string }> = {}
    for (const path of ["kept", "revoked", "stopped"]) {
      await writeDoc("space", path, `# ${path}`)
      links[path] = await legacyLink(path)
    }

    // A move cut short: every link copied, the old file not yet emptied.
    const epoch = await getWorkspaceCollaborationEpoch()
    for (const [path, link] of Object.entries(links)) {
      const documentId = (await useResolvedDocumentHandle(
        { spaceId: "space", path, materializeIdentity: true },
        (handle) => handle.documentId
      )) as string
      importV1ShareLink({
        token: link.token,
        workspaceEpoch: epoch,
        spaceId: "space",
        documentId,
        kind: "doc",
        createdAt: Date.parse(link.createdAt),
      })
    }
    // Meanwhile someone revokes a copied link, and an older binary stops
    // another in the old file.
    const [copied] = (await documentLinks("revoked")).links
    expect(
      (await send("DELETE", `/api/shares/links/${copied!.id}`)).status
    ).toBe(200)
    await stopDocumentShare({
      kind: "doc",
      spaceId: "space",
      artifactKey: "stopped",
    })
    await drainV1ShareLinks()

    expect((await documentLinks("kept")).links).toHaveLength(1)
    expect((await view(links["kept"]!.token)).status).toBe(200)
    for (const path of ["revoked", "stopped"]) {
      expect((await documentLinks(path)).links).toHaveLength(0)
      expect((await view(links[path]!.token)).status).toBe(404)
    }
    expect(await v1FileAsOlderBinaryReadsIt(links["kept"]!.token)).toBeNull()

    // An older binary run in between makes a link in the old file; the next
    // boot moves it.
    await writeDoc("space", "later", "# Later")
    const later = await createDocumentShare({
      kind: "doc",
      spaceId: "space",
      artifactKey: "later",
    })
    await drainV1ShareLinks()
    expect((await documentLinks("later")).links).toHaveLength(1)
    expect(await v1FileAsOlderBinaryReadsIt(later.token)).toBeNull()
    expect((await view(later.token)).status).toBe(200)
  })

  it("keeps unreadable Spaces pending and never finalizes a failed legacy rewrite", async () => {
    await writeDoc("space", "plan", "# Plan")
    const plan = await legacyLink("plan")
    await useResolvedDocumentHandle(
      { spaceId: "space", path: "plan", materializeIdentity: true },
      (handle) => handle.documentId
    )
    const spaceFile = join(workspaceDir, "spaces", "space", "space.json")
    const originalSpace = await readFile(spaceFile, "utf8")
    await writeFile(spaceFile, "invalid json")
    await drainV1ShareLinks()
    expect(JSON.parse(await readFile(v1File(), "utf8")).shares).toHaveLength(1)
    await writeFile(spaceFile, originalSpace)
    const originalRename = fsPromises.rename
    const failingWrite = spyOn(fsPromises, "rename").mockImplementation(
      async (from, to) => {
        if (String(to) === v1File())
          throw Object.assign(new Error("write unavailable"), { code: "EIO" })
        return originalRename(from, to)
      }
    )
    try {
      await expect(drainV1ShareLinks()).rejects.toThrow("write unavailable")
    } finally {
      failingWrite.mockRestore()
    }
    expect(JSON.parse(await readFile(v1File(), "utf8")).shares).toHaveLength(1)
    // An older binary revokes the still-present share after the failed write.
    await stopDocumentShare({
      kind: "doc",
      spaceId: "space",
      artifactKey: "plan",
    })
    await drainV1ShareLinks()
    expect((await view(plan.token)).status).toBe(404)
    expect((await documentLinks("plan")).links).toHaveLength(0)
  })

  it("recovers a durable legacy removal before SQLite was settled", async () => {
    await writeDoc("space", "plan", "# Plan")
    const plan = await legacyLink("plan")
    await useResolvedDocumentHandle(
      { spaceId: "space", path: "plan", materializeIdentity: true },
      (handle) => handle.documentId
    )
    const originalRename = fsPromises.rename
    const interrupted = spyOn(fsPromises, "rename").mockImplementation(
      async (from, to) => {
        await originalRename(from, to)
        if (String(to) === v1File())
          throw new Error("interrupted after removal")
      }
    )
    try {
      await expect(drainV1ShareLinks()).rejects.toThrow(
        "interrupted after removal"
      )
    } finally {
      interrupted.mockRestore()
    }
    expect(await v1FileAsOlderBinaryReadsIt(plan.token)).toBeNull()
    const journal = await readFile(`${v1File()}.moving`, "utf8")
    expect(journal).not.toContain(plan.token)
    closeShareLinkStores()
    await drainV1ShareLinks()
    expect((await view(plan.token)).status).toBe(200)
    expect((await documentLinks("plan")).links).toHaveLength(1)
    await drainV1ShareLinks()
    expect((await view(plan.token)).status).toBe(200)
  })

  it("makes a legacy link manageable after its path conflict is resolved", async () => {
    await writeDoc("space", "plan", "# Plan")
    const plan = await legacyLink("plan")
    const collision = join(workspaceDir, "spaces", "space", "docs", "plan.html")
    await writeFile(collision, "<h1>Collision</h1>")
    await notifyWorkspaceChangeAndWaitOrThrow({
      type: "docAliases",
      spaceId: "space",
    })
    await drainV1ShareLinks()
    expect(JSON.parse(await readFile(v1File(), "utf8")).shares).toHaveLength(1)

    await rm(collision)
    await notifyWorkspaceChangeAndWaitOrThrow({
      type: "docAliases",
      spaceId: "space",
    })
    const deadline = Date.now() + 2000
    while (
      JSON.parse(await readFile(v1File(), "utf8")).shares.length &&
      Date.now() < deadline
    ) {
      // test-policy: external-readiness-backoff — wait for the event-triggered drain to persist its result.
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await v1FileAsOlderBinaryReadsIt(plan.token)
    const [moved] = (await documentLinks("plan")).links
    expect(moved).toBeDefined()
    expect((await view(plan.token)).status).toBe(200)
    expect(
      (await send("DELETE", `/api/shares/links/${moved!.id}`)).status
    ).toBe(200)
    expect((await view(plan.token)).status).toBe(404)
  })
})

describe("owner policy", () => {
  const target = { kind: "doc", spaceId: "space", path: "plan" }
  const DAY_MS = 86_400_000
  const inDays = (days: number) =>
    new Date(Date.now() + days * DAY_MS).toISOString()

  async function savePolicy(
    change: Partial<SharingPolicy>,
    identity?: TokenIdentity
  ): Promise<Response> {
    return await send(
      "PUT",
      "/api/shares/policy",
      { ...defaultSharingPolicy(), ...change },
      identity
    )
  }

  async function policyNow(): Promise<SharingPolicy> {
    const response = await send("GET", "/api/shares/policy")
    expect(response.status).toBe(200)
    return ((await response.json()) as { policy: SharingPolicy }).policy
  }

  async function activeOnPage(): Promise<number | undefined> {
    const page = await readDocumentPage({
      spaceId: "space",
      path: "plan",
      rawSourceAuthorized: false,
      annotationsAuthorized: false,
      sharingAuthorized: true,
    })
    return page?.kind === "document" ? page.sharing?.activeLinks : undefined
  }

  it("keeps preview policy at its defaults where the preview was off, once", async () => {
    const upgrade = (preview: "0" | "1") => {
      closeShareLinkStores()
      const db = new Database(shareLinksDatabasePath())
      db.query(
        "DELETE FROM share_meta WHERE key = 'preview_policy_settled'"
      ).run()
      db.close()
      process.env["WORKTABLE_SHARING_PREVIEW"] = preview
    }
    const opened: Partial<SharingPolicy> = {
      liveLinks: true,
      levels: ["view", "comment"],
      maxExpiryDays: 30,
    }
    expect((await savePolicy(opened)).status).toBe(200)

    // Saved while the preview was on, then turned off: those settings stay
    // off, and the rest of the policy stays as saved.
    upgrade("0")
    expect(await policyNow()).toMatchObject({
      liveLinks: false,
      levels: ["view"],
      maxExpiryDays: 30,
    })
    // Once: the owner turns them on again and they stay on.
    expect((await savePolicy(opened)).status).toBe(200)
    closeShareLinkStores()
    expect(await policyNow()).toMatchObject(opened)

    // Where the preview was on, the policy applies as saved.
    upgrade("1")
    expect(await policyNow()).toMatchObject(opened)

    // A policy saved by an earlier version is read as today's first.
    const store = () => new Database(shareLinksDatabasePath())
    closeShareLinkStores()
    let db = store()
    db.query("UPDATE share_policy SET policy = ? WHERE id = 1").run(
      JSON.stringify({
        ...defaultSharingPolicy(),
        ...opened,
        records: "summaries",
        allowVisitorsSeeAll: true,
      })
    )
    db.close()
    upgrade("0")
    expect(await policyNow()).toMatchObject({
      liveLinks: false,
      levels: ["view"],
      maxExpiryDays: 30,
    })

    // A damaged policy stays paused, and the owner can still replace it.
    closeShareLinkStores()
    db = store()
    db.query("UPDATE share_policy SET policy = '{' WHERE id = 1").run()
    db.close()
    upgrade("0")
    expect(await policyNow()).toMatchObject({ paused: true })
    expect((await savePolicy({})).status).toBe(200)
    expect(await policyNow()).toMatchObject({ paused: false })
  })

  it("applies policy tightened during a legacy render and tells other human sessions", async () => {
    await writeDoc("space", "plan", "# Plan")
    const legacy = await createDocumentShare({
      kind: "doc",
      spaceId: "space",
      artifactKey: "plan",
    })
    const messages: unknown[] = []
    const agentMessages: unknown[] = []
    const humanSocket = {
      data: { spaceId: "space", identity: person() },
      send: (value: string) => messages.push(JSON.parse(value)),
      close() {},
    }
    const agentSocket = {
      data: { spaceId: "space", identity: agent },
      send: (value: string) => agentMessages.push(JSON.parse(value)),
      close() {},
    }
    wsManager.subscribe(humanSocket, "space")
    wsManager.subscribe(agentSocket, "space")
    const original = publicRenderer.renderPublicDocProjection
    const rendering = spyOn(
      publicRenderer,
      "renderPublicDocProjection"
    ).mockImplementationOnce(async (...args) => {
      const body = await original(...args)
      expect((await savePolicy({ paused: true })).status).toBe(200)
      return body
    })
    try {
      expect((await view(legacy.token)).status).toBe(404)
      expect(messages).toEqual([{ type: "share_policy_changed", revision: 1 }])
      expect(agentMessages).toEqual([])
    } finally {
      rendering.mockRestore()
      wsManager.unsubscribe(humanSocket)
      wsManager.unsubscribe(agentSocket)
    }
  })

  it("checks policy again after document resolution before creating a link", async () => {
    await writeDoc("space", "plan", "# Plan")
    const original = documentPages.publicShareKind
    for (const [change, status] of [
      [{ paused: true }, 403],
      [{ maxExpiryDays: 7 }, 400],
    ] as const) {
      await savePolicy({})
      const resolution = spyOn(
        documentPages,
        "publicShareKind"
      ).mockImplementation(async (handle) => {
        const kind = await original(handle)
        expect((await savePolicy(change)).status).toBe(200)
        return kind
      })
      try {
        const response = await send("POST", "/api/shares/links", { target })
        expect(response.status).toBe(status)
      } finally {
        resolution.mockRestore()
      }
      expect((await documentLinks("plan")).links).toHaveLength(0)
    }
  })

  it("cuts existing links at their next view when tightened, and lets them open again when loosened", async () => {
    await writeDoc("space", "plan", "# Plan")
    // A link of the earlier format that views fall back to until it moves.
    const legacyToken = (
      await createDocumentShare({
        kind: "doc",
        spaceId: "space",
        artifactKey: "plan",
      })
    ).token
    const { token, link } = await createLink("plan")
    const dead = await (await view("not-a-token")).text()
    expect(await policyNow()).toEqual(defaultSharingPolicy())
    for (const identity of [agent, person(["docs:read"])]) {
      expect(
        (await send("GET", "/api/shares/policy", undefined, identity)).status
      ).toBe(403)
      expect((await savePolicy({ paused: true }, identity)).status).toBe(403)
    }

    const tightened: Array<[Partial<SharingPolicy>, ShareLinkBlockedBy]> = [
      [{ paused: true }, "paused"],
      [{ spaces: { mode: "selected", spaceIds: ["elsewhere"] } }, "space"],
    ]
    for (const [change, blockedBy] of tightened) {
      expect((await savePolicy(change)).status).toBe(200)
      const stopped = await view(token)
      expect(stopped.status).toBe(404)
      // Visitors can't tell a link the policy stops from any dead link.
      expect(await stopped.text()).toBe(dead)
      expect((await view(legacyToken)).status).toBe(404)
      expect(await documentLinks("plan")).toMatchObject({
        canCreate: false,
        createBlockedBy: blockedBy,
        links: [{ id: link.id, status: "blocked", blockedBy }],
      })
      expect(await activeOnPage()).toBe(0)
      expect((await send("POST", "/api/shares/links", { target })).status).toBe(
        403
      )

      expect((await savePolicy({})).status).toBe(200)
      expect((await view(token)).status).toBe(200)
      expect((await view(legacyToken)).status).toBe(200)
      expect(await activeOnPage()).toBe(1)
    }

    // The longest expiry ends links older than it, and new links must
    // expire within it.
    const createdAt = Date.now() - 10 * DAY_MS
    closeShareLinkStores()
    const db = new Database(shareLinksDatabasePath())
    db.query("UPDATE share_links SET created_at = ? WHERE id = ?").run(
      createdAt,
      link.id
    )
    db.close()
    expect((await savePolicy({ maxExpiryDays: 7 })).status).toBe(200)
    expect((await view(token)).status).toBe(410)
    expect((await documentLinks("plan")).links[0]).toMatchObject({
      status: "blocked",
      blockedBy: "expiry-cap",
      expiresAt: new Date(createdAt + 7 * DAY_MS).toISOString(),
    })
    for (const expiresAt of [null, inDays(30)]) {
      const refused = await send("POST", "/api/shares/links", {
        target,
        expiresAt,
      })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({ code: "EXPIRY_TOO_LONG" })
    }
    expect(
      (
        await send("POST", "/api/shares/links", {
          target,
          expiresAt: inDays(7),
        })
      ).status
    ).toBe(201)

    expect((await savePolicy({ maxExpiryDays: 30 })).status).toBe(200)
    expect((await view(token)).status).toBe(200)
  })

  it("refuses a save made from an older copy, so it can't undo a newer change", async () => {
    const read = (await (await send("GET", "/api/shares/policy")).json()) as {
      revision: number
    }
    const saveFrom = async (revision: number, change: Partial<SharingPolicy>) =>
      await app().request("/api/shares/policy", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": `"${revision}"`,
        },
        body: JSON.stringify({ ...defaultSharingPolicy(), ...change }),
      })
    // One window pauses links; another, still showing the copy from before,
    // changes the longest expiry.
    expect((await saveFrom(read.revision, { paused: true })).status).toBe(200)
    const stale = await saveFrom(read.revision, { maxExpiryDays: 30 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      code: "POLICY_CHANGED",
      policy: { paused: true, maxExpiryDays: null },
      revision: read.revision + 1,
    })
    expect((await policyNow()).paused).toBe(true)
  })

  it("applies the saved policy in full", async () => {
    await writeDoc("space", "plan", "# Plan")
    const { token } = await createLink("plan")
    expect((await savePolicy({ levels: ["comment"] })).status).toBe(200)
    expect((await policyNow()).levels).toEqual(["comment"])
    expect((await view(token)).status).toBe(404)
    expect(
      (await savePolicy({ levels: ["view", "comment"], liveLinks: true }))
        .status
    ).toBe(200)
    expect(await policyNow()).toMatchObject({
      levels: ["view", "comment"],
      liveLinks: true,
    })
    expect((await view(token)).status).toBe(200)
  })

  it("travels in operator backups, and comes back only onto a machine with no links store", async () => {
    await writeDoc("space", "plan", "# Plan")
    const { token } = await createLink("plan")
    expect((await savePolicy({ paused: true, maxExpiryDays: 30 })).status).toBe(
      200
    )
    const snapshots = await mkdtemp(join(tmpdir(), "worktable-share-backup-"))
    try {
      const captured = join(snapshots, "capture")
      const snapshot = await writeWorkspaceSnapshot(captured, {
        captureTeamState: true,
      })
      expect(snapshot.sharingPolicy).toMatchObject({
        paused: true,
        maxExpiryDays: 30,
      })
      // Links stay out of backups: no token, sealed or not, and no store.
      const store = new Database(shareLinksDatabasePath(), { readonly: true })
      const sealed = Buffer.from(
        store
          .query<
            { sealed: Uint8Array },
            []
          >("SELECT sealed FROM share_link_tokens")
          .get()!.sealed
      )
      store.close()
      const names = await readdir(captured, { recursive: true })
      expect(names.some((name) => name.includes("sharing.sqlite"))).toBe(false)
      const captureBytes = Buffer.concat(
        await Promise.all(
          names.map((name) =>
            readFile(join(captured, name)).catch(() => Buffer.alloc(0))
          )
        )
      )
      expect(captureBytes.length).toBeGreaterThan(0)
      expect(captureBytes.includes(Buffer.from(token))).toBe(false)
      expect(captureBytes.includes(sealed)).toBe(false)
      // The owner loosens the policy after the backup.
      expect((await savePolicy({ maxExpiryDays: 90 })).status).toBe(200)

      const differentCapture = join(snapshots, "different-capture")
      const differentSnapshot = await writeWorkspaceSnapshot(differentCapture, {
        captureTeamState: true,
      })

      const recover = async (
        operationId: string,
        source = captured,
        selected = snapshot
      ) => {
        await cp(
          source,
          join(await operatorSnapshotDirectory(operationId), "download"),
          { recursive: true }
        )
        await rm(workspaceDir, { recursive: true, force: true })
        await recoverMissingWorkspaceSnapshot(
          operationId,
          selected.workspaceId,
          selected.sourceCheckpoint
        )
      }

      // A machine that still has its links store keeps its newer policy.
      await recover("recovery-with-store")
      expect((await policyNow()).paused).toBe(false)

      // A machine that lost everything gets the policy back, but no links.
      closeShareLinkStores()
      await rm(join(appDir, "sharing"), { recursive: true, force: true })
      // Publication can fail after the app-owned policy was prepared. That
      // unfinished store must take the next chosen snapshot, including after
      // process state is discarded; a published store must keep its policy.
      const originalRename = fsPromises.rename
      const publication = spyOn(fsPromises, "rename").mockImplementation(
        async (from, to) => {
          if (String(to) === workspaceDir)
            throw new Error("workspace publication failed")
          return originalRename(from, to)
        }
      )
      try {
        await expect(recover("recovery-publication-failed")).rejects.toThrow(
          "workspace publication failed"
        )
      } finally {
        publication.mockRestore()
      }
      expect(existsSync(workspaceDir)).toBe(false)
      expect(await restoreSharingPolicy(null)).toBe(true)
      expect(sharingPolicyForBackup()).toBeNull()
      closeShareLinkStores()
      await recover(
        "recovery-selected-next",
        differentCapture,
        differentSnapshot
      )
      expect(await policyNow()).toMatchObject({
        paused: false,
        maxExpiryDays: 90,
      })
      await recover("recovery-published-store-keeps-policy")
      expect(await policyNow()).toMatchObject({
        paused: false,
        maxExpiryDays: 90,
      })
      closeShareLinkStores()
      await rm(join(appDir, "sharing"), { recursive: true, force: true })
      await recover("recovery-fresh-machine")
      expect(await policyNow()).toMatchObject({
        paused: true,
        maxExpiryDays: 30,
      })
      expect((await view(token)).status).toBe(404)
      closeShareLinkStores()
      const unreadable = new Database(shareLinksDatabasePath())
      unreadable
        .query("UPDATE share_policy SET policy = ? WHERE id = 1")
        .run("{")
      unreadable.close()
      await expect(
        writeWorkspaceSnapshot(join(snapshots, "bad-policy"), {
          captureTeamState: true,
        })
      ).rejects.toThrow("Saved sharing policy is unreadable")
      expect(existsSync(join(snapshots, "bad-policy"))).toBe(false)
      closeShareLinkStores()
      const futureStore = new Database(shareLinksDatabasePath())
      futureStore.exec("PRAGMA user_version = 99")
      futureStore.close()
      await expect(
        writeWorkspaceSnapshot(join(snapshots, "future-policy"), {
          captureTeamState: true,
        })
      ).rejects.toThrow("unsupported version")
      expect(existsSync(join(snapshots, "future-policy"))).toBe(false)
    } finally {
      await rm(snapshots, { recursive: true, force: true })
    }
  })
})
