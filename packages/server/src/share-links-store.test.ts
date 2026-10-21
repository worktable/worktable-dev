import { afterEach, beforeEach, describe, expect, it } from "bun:test"
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
import { deleteHtmlDocument } from "./html-document-delete.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import { moveHtmlDocument } from "./html-document-move.ts"
import { setLinkedSharing } from "./linked-sharing.ts"
import { createPublicSharesRouter } from "./routes/public-shares.ts"
import { sharesRouter } from "./routes/shares.ts"
import { settleShareLinkReconciles } from "./share-links-lifecycle.ts"
import {
  closeShareLinkStores,
  flushShareLinkUse,
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
    const locked = await createLink("plan")
    const open = await createLink("plan")
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

  it("ends links when their document is removed on disk or the workspace is replaced", async () => {
    await writeDoc("space", "external", "# Original")
    await writeDoc("space", "kept", "# Kept")
    const removed = await createLink("external")
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
    expect((await view(kept.token)).status).toBe(200)

    await notifyWorkspaceChangeAndWaitOrThrow({ type: "workspaceReset" })
    expect((await view(kept.token)).status).toBe(404)
    const all = (await (
      await send("GET", "/api/shares/links/all?status=revoked")
    ).json()) as { links: Array<{ id: string }> }
    expect(all.links.map((link) => link.id).sort()).toEqual(
      [removed.link.id, kept.link.id].sort()
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
