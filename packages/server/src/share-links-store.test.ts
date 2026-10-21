import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import type { CreatedShareLink, DocumentShareLinks } from "@worktable/types"
import { Hono } from "hono"
import { existsSync } from "node:fs"
import {
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
import { readDocumentPage } from "./document-page-service.ts"
import { useResolvedDocumentHandle } from "./document-query.ts"
import { deleteHtmlDocument } from "./html-document-delete.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import { moveHtmlDocument } from "./html-document-move.ts"
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
  shareLinksDatabasePath,
  updateShareLink,
} from "./share-links-store.ts"
import { authorizeShareAction } from "./share-policy.ts"
import { setDocArchived, writeDoc, writeSpace } from "./store.ts"
import type { TokenIdentity } from "./token-store.ts"
import { updateWidgetMetadata } from "./widget-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { notifyWorkspaceChangeAndWaitOrThrow } from "./workspace-events.ts"

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
  surface = "/public/share"
): Promise<Response> {
  return await app().request(surface, {
    headers: { "x-worktable-share-capability": token },
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
    expect((await view(board.token)).status).toBe(404)
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

    const open = await createLink("plan")
    const revoked = await createLink("plan")
    const expired = await createLink("plan")
    await send("DELETE", `/api/shares/links/${revoked.link.id}`)
    updateShareLink(expired.link.id, { expiresAt: Date.now() - 1 })
    expect(await page()).toEqual({ activeLinks: 1, canCreate: true })
    expect((await view(open.token)).status).toBe(200)

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

  it("serves nothing it does not understand, and older links still open", async () => {
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

    // A later version of the whole store.
    closeShareLinkStores()
    db.exec("PRAGMA user_version = 2")
    db.close()
    expect((await view(open.token)).status).toBe(404)
    expect((await view(legacyToken)).status).toBe(200)
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
    const content = await view(token, "/public/share/content")
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

  it("lets only people share, and only view links without a password for now", async () => {
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
    const password = await send("POST", "/api/shares/links", {
      target,
      password: "correct horse battery",
    })
    expect(password.status).toBe(400)
    expect(await password.json()).toMatchObject({
      code: "PASSWORD_NOT_AVAILABLE",
    })
    const past = await send("POST", "/api/shares/links", {
      target,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    expect(past.status).toBe(400)
    const escaping = await send("POST", "/api/shares/links", {
      target: { ...target, path: "../plan" },
    })
    expect(escaping.status).toBe(400)
    expect(existsSync(shareLinksDatabasePath())).toBe(false)
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
      await (await view(status.token, "/public/share/content")).text()
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

      expect(await v1FileAsOlderBinaryReadsIt(plan.token)).toBeNull()
      expect((await documentLinks("plan")).links).toHaveLength(1)
      expect((await view(plan.token)).status).toBe(200)
    } finally {
      invalidateServerSettingsCache()
    }
  })
})
