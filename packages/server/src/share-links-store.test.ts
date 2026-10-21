import { LinkGrantSchema } from "@worktable/types"
import { createHash } from "node:crypto"
import { buildRecordCollectionSchema, writeRecordCollectionSchema, writeRecord } from "./record-store.ts"
import * as linkQueries from "./link-query.ts"
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
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
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
import { trustedLocalIdentity } from "./auth.ts"
import { systemRouter } from "./routes/system.ts"
import { invalidateServerSettingsCache } from "./settings-store.ts"
import { drainV1ShareLinks } from "./share-links-drain.ts"
import { settleShareLinkReconciles } from "./share-links-lifecycle.ts"
import {
  createDocumentShare,
  resolveDocumentShare,
  stopDocumentShare,
} from "./share-store.ts"
import {
  closeShareLinkStores,
  flushShareLinkUse,
  importV1ShareLink,
  revokeShareLink,
  markV1SharesDrained,
  shareLinksDatabasePath,
  updateShareLink,
} from "./share-links-store.ts"
import { authorizeShareAction } from "./share-policy.ts"
import { operatorSnapshotDirectory } from "./operator-snapshot.ts"
import { setDocArchived, writeDoc, writeSpace } from "./store.ts"
import type { TokenIdentity } from "./token-store.ts"
import { updateWidgetMetadata } from "./widget-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { notifyWorkspaceChangeAndWaitOrThrow } from "./workspace-events.ts"
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
  process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
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
  it("opens live tools through ticketed frames and grant-only reads, including policy changes during a read", async () => {
    process.env["WORKTABLE_RECORDS_INDEX"] = "0"
    const policy = (await (await send("GET", "/api/shares/policy")).json()).policy as SharingPolicy
    expect((await send("PUT", "/api/shares/policy", { ...policy, liveLinks: true })).status).toBe(200)
    await writeRecordCollectionSchema("space", buildRecordCollectionSchema({ id: "deals", name: "Deals", fields: { name: { type: "text" }, secret: { type: "text" } } }))
    const at = new Date().toISOString()
    await writeRecord("space", { version: 1, kind: "worktable.record", id: "private-id", collectionId: "deals", createdAt: at, updatedAt: at, createdBy: "test", metadata: {}, data: { name: "Public name", secret: "Hidden data" } })
    await createHtmlDocument({ spaceId: "space", name: "Board", html: "<!doctype html><html><head></head><body><h1>Board</h1></body></html>", permissions: { network: true, records: { deals: { read: true } }, state: { read: true, write: true } }, versionSource: "test", versionUpdatedBy: "test" })
    const beforeLive = await readDocumentPage({ spaceId: "space", path: "board", rawSourceAuthorized: false, annotationsAuthorized: false, sharingAuthorized: true })
    expect(beforeLive?.kind === "document" ? beforeLive.sharing?.activeLinks : null).toBe(0)
    const grant = LinkGrantSchema.parse({ version: 1, collections: { deals: { fields: ["name"], timestamps: false } } })
    await writeDoc("space", "plan", "# Plan")
    expect((await send("POST", "/api/shares/links", { target: { kind: "doc", spaceId: "space", path: "plan" }, grant })).status).toBe(400)
    expect((await send("POST", "/api/shares/links", { target: { kind: "html", spaceId: "space", path: "board" }, grant: { ...grant, collections: { deals: { ...grant.collections.deals, fields: ["missing"] } } } })).status).toBe(400)
    const created = await createLink("board", { grant }, "html")
    expect(Date.parse(created.link.expiresAt!) - Date.now()).toBeGreaterThan(29 * 86_400_000)
    const neverExpires = await createLink("board", { grant, expiresAt: null }, "html")
    expect(neverExpires.link.expiresAt).toBeNull()
    const page = await readDocumentPage({ spaceId: "space", path: "board", rawSourceAuthorized: false, annotationsAuthorized: false, sharingAuthorized: true })
    expect(page?.kind === "document" ? page.sharing?.activeLinks : null).toBe(2)
    const projection = await (await view(created.token)).json()
    expect(projection.live.poll).toBe(30)
    const frame = await view(projection.contentTicket, "/public/share/content")
    expect(frame.status).toBe(200)
    expect(frame.headers.get("Content-Security-Policy")).toContain("script-src 'unsafe-inline'")
    expect(frame.headers.get("Content-Security-Policy")).toContain("connect-src 'none'")
    const html = await frame.text()
    expect(createHash("sha256").update(html).digest("base64url")).toBe(projection.live.rev)
    expect(html).toContain("mode:'share'")
    expect(html).not.toContain(created.token)
    expect((await view(created.token, "/public/share/content")).status).toBe(404)
    expect((await send("PATCH", `/api/shares/links/${created.link.id}`, { grant })).status).toBe(200)
    expect((await view(projection.contentTicket, "/public/share/content")).status).toBe(404)
    const bridge = (token: string, call: unknown = { v: 1, op: "records.query", collection: "deals", query: {} }) => app().request("/public/share/bridge", { method: "POST", headers: { "Content-Type": "application/json", "x-worktable-share-capability": token, Origin: sharing.shareOrigin, Cookie: "member=ignored", Authorization: "Bearer ignored" }, body: JSON.stringify(call) })
    const response = await bridge(created.token)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.result.records[0].data).toEqual({ name: "Public name" })
    expect(JSON.stringify(result)).not.toContain("private-id")
    expect(JSON.stringify(result)).not.toContain("Hidden data")
    const otherLink = await (await bridge(neverExpires.token)).json()
    expect(otherLink.result.records[0].id).not.toBe(result.result.records[0].id)
    expect((await bridge(created.token, { v: 1, op: "records.create", collection: "deals", data: {} })).status).toBe(400)
    process.env["WORKTABLE_RECORDS_INDEX"] = "1"
    const building = await bridge(created.token, { v: 1, op: "records.query", collection: "deals", query: { fields: ["name"] } })
    expect(building.status).toBe(503)
    expect(building.headers.get("Retry-After")).toBe("1")
    process.env["WORKTABLE_RECORDS_INDEX"] = "0"
    const plain = await createLink("board", {}, "html")
    const unavailable = await bridge("X".repeat(43))
    expect(unavailable.status).toBe(404)
    expect(await (await bridge(plain.token)).text()).toBe(await unavailable.text())
    const stalled = await app().fetch(new Request("https://runtime.example.test/public/share/bridge", { method: "POST", headers: { "Content-Type": "application/json", "x-worktable-share-capability": created.token }, body: new ReadableStream<Uint8Array>() }))
    expect(stalled.status).toBe(429)
    expect(stalled.headers.get("Retry-After")).toBe("1")
    expect((await bridge(created.token)).status).toBe(200)
    const original = linkQueries.queryRecordsForLink
    const paused = spyOn(linkQueries, "queryRecordsForLink").mockImplementation(async (...args) => {
      const read = await original(...args)
      expect((await send("PUT", "/api/shares/policy", { ...policy, liveLinks: true, records: "none" })).status).toBe(200)
      return read
    })
    try { expect((await bridge(created.token)).status).toBe(404) } finally { paused.mockRestore() }
    expect((await bridge(created.token)).status).toBe(403)
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    expect((await bridge(created.token)).status).toBe(404)
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
    const unlock = (value: string) =>
      app().request("/public/share/unlock", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-worktable-share-capability": created.token,
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
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
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
    markV1SharesDrained()
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
    const outer = await view(legacy.token)
    expect(outer.status).toBe(200)
    const { contentTicket } = (await outer.json()) as { contentTicket: string }
    expect(contentTicket).not.toContain(legacy.token)
    expect((await view(legacy.token, "/public/share/content")).status).toBe(404)
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
    // The URL is shown only when a link is made.
    expect(JSON.stringify(listed)).not.toContain(board.token)

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

    // Today's sharing keeps its own request until links v2 is on.
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    closeShareLinkStores()
    expect(await page()).toBeUndefined()
  })

  it("keeps only token digests, so the store's files hold no working link", async () => {
    await writeDoc("space", "plan", "# Plan")
    const { token } = await createLink("plan")
    expect((await view(token)).status).toBe(200)
    flushShareLinkUse()

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
    // Today's links are made only while links v2 is off.
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    const legacy = await send("POST", "/api/shares", {
      kind: "doc",
      spaceId: "space",
      artifactKey: "plan",
    })
    const legacyToken = (
      (await legacy.json()) as { share: { url: string } }
    ).share.url
      .split("/")
      .at(-1)!
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
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

    // With the preview off, that store still keeps today's routes retired,
    // so no link is made outside its owner policy.
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    closeShareLinkStores()
    expect(
      (
        await send("POST", "/api/shares", {
          kind: "doc",
          spaceId: "space",
          artifactKey: "plan",
        })
      ).status
    ).toBe(404)
    expect((await view(legacyToken)).status).toBe(404)
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

  it("leaves today's sharing as it is while the preview is off, and still serves its links when on", async () => {
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    await writeDoc("space", "plan", "# Plan\n\nToday's link.")
    expect((await send("GET", "/api/shares/links/all")).status).toBe(404)
    expect(
      (
        await send("POST", "/api/shares/links", {
          target: { kind: "doc", spaceId: "space", path: "plan" },
        })
      ).status
    ).toBe(404)

    const legacy = await send("POST", "/api/shares", {
      kind: "doc",
      spaceId: "space",
      artifactKey: "plan",
    })
    expect(legacy.status).toBe(201)
    const token = (
      (await legacy.json()) as { share: { url: string } }
    ).share.url
      .split("/")
      .at(-1)!
    expect((await view(token)).status).toBe(200)
    expect(existsSync(join(appDir, "sharing"))).toBe(false)

    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
    const page = await view(token)
    expect(page.status).toBe(200)
    expect(
      ((await page.json()) as { projectionHtml: string }).projectionHtml
    ).toContain("Today's link.")
  })

  it("lets only people share, and keeps passwords behind the preview", async () => {
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
    markV1SharesDrained()
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    const password = await send("POST", "/api/shares/links", {
      target,
      password: "correct horse battery",
    })
    expect(password.status).toBe(400)
    expect(await password.json()).toMatchObject({
      code: "PASSWORD_NOT_AVAILABLE",
    })
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
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
  const v1File = () => join(appDir, "document-shares.json")

  /** A link as today's sharing makes it, while links v2 is off. */
  async function legacyLink(
    artifactKey: string,
    kind: "doc" | "html" = "doc"
  ): Promise<{ token: string; createdAt: string }> {
    const response = await send("POST", "/api/shares", {
      kind,
      spaceId: "space",
      artifactKey,
    })
    expect(response.status).toBe(201)
    const { share } = (await response.json()) as {
      share: { url: string; createdAt: string }
    }
    return { token: share.url.split("/").at(-1)!, createdAt: share.createdAt }
  }

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
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
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

    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
    await drainV1ShareLinks()

    expect(await v1FileAsOlderBinaryReadsIt(plan.token)).toBeNull()
    const moved = await documentLinks("plan")
    expect(moved.links).toHaveLength(1)
    expect(moved.links[0]).toMatchObject({
      label: "",
      status: "active",
      createdAt: plan.createdAt,
      tokenHint: plan.token.slice(-4),
    })
    expect(
      ((await (await view(plan.token)).json()) as { projectionHtml: string })
        .projectionHtml
    ).toContain("Moved over.")
    expect(
      await (
        await view(
          (
            (await (await view(status.token)).json()) as {
              contentTicket: string
            }
          ).contentTicket,
          "/public/share/content"
        )
      ).text()
    ).toContain("Operational")
    for (const token of [retired.token, removed.token, "E".repeat(43)]) {
      expect((await view(token)).status).toBe(404)
    }
    const all = (await (await send("GET", "/api/shares/links/all")).json()) as {
      links: unknown[]
    }
    expect(all.links).toHaveLength(2)

    // Moved links follow their document, and links v2 stays on without the
    // preview. Today's routes no longer make links in the old file.
    expect(
      (await renameDocAndSync("space", "plan", "notes/plan")).error
    ).toBeNull()
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    expect((await view(plan.token)).status).toBe(200)
    expect((await documentLinks("notes/plan")).links).toHaveLength(1)
    expect(
      (
        await send("POST", "/api/shares", {
          kind: "doc",
          spaceId: "space",
          artifactKey: "notes/plan",
        })
      ).status
    ).toBe(404)
  })

  it("finishes a move cut short without copying or reviving links, and follows what an older binary does meanwhile", async () => {
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    const links: Record<string, { token: string; createdAt: string }> = {}
    for (const path of ["kept", "revoked", "stopped"]) {
      await writeDoc("space", path, `# ${path}`)
      links[path] = await legacyLink(path)
    }
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"

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
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    await writeDoc("space", "plan", "# Plan")
    const plan = await legacyLink("plan")
    await useResolvedDocumentHandle(
      { spaceId: "space", path: "plan", materializeIdentity: true },
      (handle) => handle.documentId
    )
    const spaceFile = join(workspaceDir, "spaces", "space", "space.json")
    const originalSpace = await readFile(spaceFile, "utf8")
    await writeFile(spaceFile, "invalid json")
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
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
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    await writeDoc("space", "plan", "# Plan")
    const plan = await legacyLink("plan")
    await useResolvedDocumentHandle(
      { spaceId: "space", path: "plan", materializeIdentity: true },
      (handle) => handle.documentId
    )
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
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
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    await writeDoc("space", "plan", "# Plan")
    const plan = await legacyLink("plan")
    const collision = join(workspaceDir, "spaces", "space", "docs", "plan.html")
    await writeFile(collision, "<h1>Collision</h1>")
    await notifyWorkspaceChangeAndWaitOrThrow({
      type: "docAliases",
      spaceId: "space",
    })
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
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

  it("moves them when the owner turns the sharing preview on", async () => {
    delete process.env["WORKTABLE_SHARING_PREVIEW"]
    invalidateServerSettingsCache()
    try {
      await writeDoc("space", "plan", "# Plan")
      const plan = await legacyLink("plan")

      const system = new Hono()
      system.use("/api/*", trustedLocalIdentity())
      system.route("/api/system", systemRouter)
      const turnedOn = await system.request("/api/system/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sharing: { preview: true } }),
      })
      expect(turnedOn.status).toBe(200)

      // The settings response returns before the background drain. Wait on
      // its durable outcome, without starting a second drain from the test.
      const deadline = Date.now() + 2000
      while (
        JSON.parse(await readFile(v1File(), "utf8")).shares.length &&
        Date.now() < deadline
      ) {
        // test-policy: external-readiness-backoff — wait for the settings-triggered drain.
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(await v1FileAsOlderBinaryReadsIt(plan.token)).toBeNull()
      expect((await documentLinks("plan")).links).toHaveLength(1)
      expect((await view(plan.token)).status).toBe(200)
    } finally {
      invalidateServerSettingsCache()
    }
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
    // A link of today's format that views fall back to until it moves.
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    const legacy = await send("POST", "/api/shares", {
      kind: "doc",
      spaceId: "space",
      artifactKey: "plan",
    })
    const legacyToken = (
      (await legacy.json()) as { share: { url: string } }
    ).share.url
      .split("/")
      .at(-1)!
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
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

  it("keeps settings for unreleased sharing features to the sharing preview", async () => {
    await writeDoc("space", "plan", "# Plan")
    const { token } = await createLink("plan")
    // Links v2 stays on once today's links have moved, preview or not.
    markV1SharesDrained()
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    const previewOnly: Partial<SharingPolicy>[] = [
      { requirePassword: true },
      { levels: ["view", "comment"] },
      { liveLinks: true },
    ]
    for (const change of previewOnly) {
      const refused = await savePolicy(change)
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({
        code: "PREVIEW_POLICY_NOT_AVAILABLE",
      })
    }

    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
    expect((await savePolicy({ requirePassword: true })).status).toBe(200)
    expect((await view(token)).status).toBe(404)

    // Off, the preview's settings act as their defaults and keep their
    // values for when it is on again.
    process.env["WORKTABLE_SHARING_PREVIEW"] = "0"
    expect((await view(token)).status).toBe(200)
    expect((await policyNow()).requirePassword).toBe(false)
    expect((await savePolicy({ maxExpiryDays: 90 })).status).toBe(200)
    process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
    expect(await policyNow()).toMatchObject({
      requirePassword: true,
      maxExpiryDays: 90,
    })
    expect((await view(token)).status).toBe(404)
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
      // The owner loosens the policy after the backup.
      expect((await savePolicy({})).status).toBe(200)

      const recover = async (operationId: string) => {
        await cp(
          captured,
          join(await operatorSnapshotDirectory(operationId), "download"),
          { recursive: true }
        )
        await rm(workspaceDir, { recursive: true, force: true })
        await recoverMissingWorkspaceSnapshot(
          operationId,
          snapshot.workspaceId,
          snapshot.sourceCheckpoint
        )
      }

      // A machine that still has its links store keeps its newer policy.
      await recover("recovery-with-store")
      expect((await policyNow()).paused).toBe(false)

      // A machine that lost everything gets the policy back, but no links.
      closeShareLinkStores()
      await rm(join(appDir, "sharing"), { recursive: true, force: true })
      await recover("recovery-fresh-machine")
      expect(await policyNow()).toMatchObject({
        paused: true,
        maxExpiryDays: 30,
      })
      expect((await view(token)).status).toBe(404)
    } finally {
      await rm(snapshots, { recursive: true, force: true })
    }
  })
})
