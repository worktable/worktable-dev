import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { ACTOR_HEADERS, GATEWAY_HEADER } from "@worktable/hosted-contract"
import { JSDOM } from "jsdom"
import type { CreatedShareLink, DocumentShareLinks } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { renameDocAndSync } from "./doc-rename.ts"
import { ownerIdentity } from "./auth.ts"
import { gatewayAdmits } from "./hosted.ts"
import { publicSharesRouter } from "./routes/public-shares.ts"
import { sharesRouter } from "./routes/shares.ts"
import { setSpaceArchived, writeDoc, writeSpace } from "./store.ts"
import { closeShareLinkStores } from "./share-links-store.ts"
import { setWidgetArchived, updateWidgetMetadata } from "./widget-store.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const originalEnv = { ...process.env }
const gatewaySecret = "g".repeat(43)
let appDir: string
let workspaceDir: string

function app(): Hono {
  const next = new Hono()
  next.use("*", async (c, proceed) => {
    if (!gatewayAdmits(c.req.raw)) {
      return c.json({ error: "Forbidden" }, 403)
    }
    // As the app's auth sets it for a signed-in browser person.
    const actor = c.req.header(ACTOR_HEADERS.ID)
    if (actor)
      c.set("identity", {
        ...ownerIdentity(),
        principal: { id: actor, type: "human", displayName: "Owner" },
      })
    return proceed()
  })
  next.route("/api/shares", sharesRouter)
  next.route("/public/share", publicSharesRouter)
  return next
}

function admittedHeaders(owner = false): HeadersInit {
  return {
    [GATEWAY_HEADER]: gatewaySecret,
    ...(owner
      ? {
          [ACTOR_HEADERS.ID]: "workos:user_owner",
          [ACTOR_HEADERS.TYPE]: "human",
          [ACTOR_HEADERS.NAME]: "Owner",
        }
      : {}),
  }
}

type Artifact = { kind: "doc" | "html"; spaceId: string; artifactKey: string }

async function ownerRequest(
  method: string,
  path: string,
  body?: unknown,
  owner = true
): Promise<Response> {
  return app().fetch(
    new Request(`http://tenant/api/shares/links${path}`, {
      method,
      headers: {
        ...admittedHeaders(owner),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  )
}

function target(artifact: Artifact) {
  return {
    kind: artifact.kind,
    spaceId: artifact.spaceId,
    path: artifact.artifactKey,
  }
}

async function createLink(
  artifact: Artifact,
  extra: Record<string, unknown> = {}
): Promise<Response> {
  return ownerRequest("POST", "", { target: target(artifact), ...extra })
}

async function created(
  artifact: Artifact
): Promise<CreatedShareLink & { token: string }> {
  const response = await createLink(artifact)
  expect(response.status).toBe(201)
  const body = (await response.json()) as CreatedShareLink
  return { ...body, token: body.url.split("/").at(-1)! }
}

async function documentLinks(artifact: Artifact): Promise<DocumentShareLinks> {
  const query = new URLSearchParams(target(artifact))
  return (await (
    await ownerRequest("GET", `?${query}`)
  ).json()) as DocumentShareLinks
}

async function writeHtml(
  artifactKey: string,
  html: string,
  name = "Report"
): Promise<Artifact> {
  const manifestPath = join(workspaceDir, "worktable.workspace.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`
  )
  const written = await createHtmlDocument({
    spaceId: "space",
    explicitId: artifactKey,
    name,
    html,
    createdBy: "test",
    permissions: {
      network: true,
      records: {},
      state: { read: true, write: true },
    },
    versionSource: "test",
    versionUpdatedBy: "test",
  })
  expect(written.error).toBeUndefined()
  return { kind: "html", spaceId: "space", artifactKey }
}

async function publicRequest(
  token: string,
  path = "/public/share",
  method = "GET",
  headers: Record<string, string> = {}
): Promise<Response> {
  return app().fetch(
    new Request(`http://tenant${path}`, {
      method,
      headers: {
        ...admittedHeaders(),
        ...headers,
        "x-worktable-share-capability": token,
      },
    })
  )
}

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "worktable-share-routes-app-"))
  workspaceDir = await mkdtemp(
    join(tmpdir(), "worktable-share-routes-workspace-")
  )
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  ensureWorkspaceManifest()
  process.env["WORKTABLE_HOSTED"] = "1"
  process.env["WORKTABLE_GATEWAY_SECRET"] = gatewaySecret
  process.env["WORKTABLE_OWNER_SUBJECT"] = "user_owner"
  process.env["WORKTABLE_CLOUD_WORKSPACE_ID"] = "workspace_cloud_123"
  process.env["WORKTABLE_SHARE_BASE_URL"] = "https://share.worktable.cloud"
  process.env["WORKTABLE_HTML_SHARE_BASE_URL"] =
    "https://html.worktable-usercontent.com"
  // Links are for everyone; Cloud leaves the sharing preview off.
  delete process.env["WORKTABLE_SHARING_PREVIEW"]
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
  closeShareLinkStores()
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  process.env = { ...originalEnv }
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})


describe("Cloud document share HTTP boundary", () => {
  it("creates a Doc link, serves the latest save anonymously, copies it again, and permanently stops it", async () => {
    const artifact = {
      kind: "doc" as const,
      spaceId: "space",
      artifactKey: "launch-plan",
    }
    await writeDoc(
      artifact.spaceId,
      artifact.artifactKey,
      `# First\n\nPrivate notes.\n\n${"Shared detail. ".repeat(80)}`
    )

    const forbidden = await ownerRequest(
      "POST",
      "",
      { target: target(artifact) },
      false
    )
    expect(forbidden.status).toBe(403)

    const response = await createLink(artifact)
    expect(response.status).toBe(201)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    const link = (await response.json()) as CreatedShareLink
    expect(link.url).toMatch(
      /^https:\/\/share\.worktable\.cloud\/s\/workspace_cloud_123\/[A-Za-z0-9_-]{43}$/
    )
    const token = link.url.split("/").at(-1)!

    const first = await publicRequest(token)
    expect(first.status).toBe(200)
    const firstProjection = (await first.json()) as {
      kind: "doc"
      format: "markdown"
      title: string
      projectionHtml: string
    }
    expect(firstProjection.title).toBe("First")
    expect(firstProjection.projectionHtml).toContain("Private notes.")
    const firstPage = new JSDOM(firstProjection.projectionHtml).window.document
    expect(
      [...firstPage.querySelectorAll("h1")].map((heading) =>
        heading.textContent?.trim()
      )
    ).toEqual(["First"])
    expect(firstProjection.format).toBe("markdown")
    expect(first.headers.get("Cache-Control")).toContain("no-store")
    expect(first.headers.get("Content-Type")).toContain("application/json")

    const compressed = await publicRequest(token, "/public/share", "GET", {
      "Accept-Encoding": "gzip",
    })
    expect(compressed.headers.get("Content-Encoding")).toBe("gzip")
    expect(compressed.headers.get("Vary")).toContain("Accept-Encoding")
    expect(
      JSON.parse(
        gunzipSync(new Uint8Array(await compressed.arrayBuffer())).toString()
      )
    ).toEqual(firstProjection)

    await writeDoc(
      artifact.spaceId,
      artifact.artifactKey,
      "# Second\n\nLatest save."
    )
    const latest = await publicRequest(token)
    const latestProjection = (await latest.json()) as {
      projectionHtml: string
    }
    expect(latestProjection.projectionHtml).toContain("Latest save.")

    // Its URL can be copied again later, by the owner who manages it.
    closeShareLinkStores()
    expect((await documentLinks(artifact)).links).toEqual([
      expect.objectContaining({ id: link.link.id, url: link.url }),
    ])

    expect(
      (await ownerRequest("DELETE", `/${link.link.id}`)).status
    ).toBe(200)
    const stopped = await publicRequest(token)
    expect(stopped.status).toBe(404)
    expect(await stopped.text()).toBe("")

    const reshared = await created(artifact)
    expect(reshared.url).not.toBe(link.url)
    expect((await publicRequest(token)).status).toBe(404)
  })

  it("takes passwords without the sharing preview, and keeps comment links and live data behind it", async () => {
    const doc = { kind: "doc" as const, spaceId: "space", artifactKey: "plan" }
    await writeDoc(doc.spaceId, doc.artifactKey, "# Plan")
    const refused = async (extra: Record<string, unknown>, code: string) => {
      const response = await createLink(doc, extra)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code })
    }
    await refused({ level: "comment" }, "LEVEL_NOT_AVAILABLE")
    await refused(
      {
        grant: {
          version: 1,
          collections: {},
          limits: { rowsPerQuery: 200, queriesPerMinute: 120, rowsPerHour: 10_000 },
          state: "visitor",
        },
      },
      "LIVE_NOT_AVAILABLE"
    )
    const link = await created(doc)
    expect(
      (await ownerRequest("POST", "/access", { target: target(doc) })).status
    ).toBe(404)
    expect((await publicRequest(link.token, "/public/share/comments")).status).toBe(
      404
    )
    expect(
      (await publicRequest(link.token, "/public/share/bridge", "POST")).status
    ).toBe(404)

    // An HTML Doc's password link: the visitor unlocks it, and its frame
    // takes a ticket, since the unlock cookie stays on the share origin.
    const artifact = await writeHtml("report", "<h1>Quarterly report</h1>")
    const password = "test-only visitor password"
    const response = await createLink(artifact, { password })
    expect(response.status).toBe(201)
    const locked = (await response.json()) as CreatedShareLink
    expect(locked.link.hasPassword).toBe(true)
    const token = locked.url.split("/").at(-1)!
    expect((await publicRequest(token)).status).toBe(401)
    expect((await publicRequest(token, "/public/share/content")).status).toBe(401)
    const unlock = (value: string) =>
      app().fetch(
        new Request("http://tenant/public/share/unlock", {
          method: "POST",
          headers: {
            ...admittedHeaders(),
            "Content-Type": "application/json",
            "x-worktable-share-capability": token,
          },
          body: JSON.stringify({ password: value }),
        })
      )
    expect((await unlock("wrong password")).status).toBe(401)
    const unlocked = await unlock(password)
    expect(unlocked.status).toBe(200)
    const { ticket } = (await unlocked.json()) as { ticket: string }
    const outer = await publicRequest(token, "/public/share", "GET", {
      "x-worktable-share-unlock": ticket,
    })
    expect(outer.status).toBe(200)
    const projection = (await outer.json()) as { contentTicket?: string }
    expect(projection).not.toHaveProperty("live")
    const frame = await publicRequest(
      projection.contentTicket!,
      "/public/share/content"
    )
    expect(frame.status).toBe(200)
    expect(await frame.text()).toContain("Quarterly report")

    // Removed, the link opens for anyone who has it.
    expect(
      (await ownerRequest("PATCH", `/${locked.link.id}`, { password: null }))
        .status
    ).toBe(200)
    expect((await publicRequest(token)).status).toBe(200)
  })

  it("follows a Doc through a rename and gives malformed tokens the same page", async () => {
    const artifact = {
      kind: "doc" as const,
      spaceId: "space",
      artifactKey: "old-name",
    }
    await writeDoc(artifact.spaceId, artifact.artifactKey, "# Rename me")
    const { token } = await created(artifact)
    expect(
      (await renameDocAndSync("space", "old-name", "new-name")).error
    ).toBeNull()
    expect((await publicRequest(token)).status).toBe(200)

    const unknown = await publicRequest("A".repeat(43))
    const malformed = await publicRequest("not-a-token")
    expect(unknown.status).toBe(404)
    expect(malformed.status).toBe(404)
    expect(await unknown.text()).toBe(await malformed.text())
  })

  it("does not revoke a link while its existing artifact is temporarily unreadable", async () => {
    const artifact = {
      kind: "doc" as const,
      spaceId: "space",
      artifactKey: "external-edit",
    }
    await writeDoc(artifact.spaceId, artifact.artifactKey, [])
    const link = await created(artifact)
    const path = join(
      workspaceDir,
      "spaces",
      "space",
      "docs",
      "external-edit.json"
    )

    await writeFile(path, "{", "utf8")
    expect((await publicRequest(link.token)).status).toBe(404)

    await writeFile(path, "[]\n", "utf8")
    expect((await publicRequest(link.token)).status).toBe(200)
    expect((await documentLinks(artifact)).links).toEqual([
      expect.objectContaining({ id: link.link.id, status: "active" }),
    ])
  })

  it("ends every link when its Space is archived", async () => {
    const artifact = {
      kind: "doc" as const,
      spaceId: "space",
      artifactKey: "space-lifecycle",
    }
    await writeDoc(artifact.spaceId, artifact.artifactKey, "# Space lifecycle")
    const link = await created(artifact)

    expect((await setSpaceArchived("space", true)).error).toBeNull()
    expect((await publicRequest(link.token)).status).toBe(404)
    expect((await createLink(artifact)).status).toBe(404)

    expect((await setSpaceArchived("space", false)).error).toBeNull()
    expect((await publicRequest(link.token)).status).toBe(404)
    const reshared = await created(artifact)
    expect(reshared.url).not.toBe(link.url)
  })

  it("preserves an HTML link across display-name edits and serves a sanitized projection", async () => {
    const artifact = await writeHtml(
      "status",
      `<style>.card{color:tomato}</style><main class="card"><h1>Operational</h1><script>fetch("https://attacker.test")</script><a href="https://attacker.test">leave</a></main>`,
      "Status board"
    )

    const { token } = await created(artifact)
    const outer = await publicRequest(token)
    expect(await outer.json()).toEqual({
      kind: "html",
      title: "Status board",
    })

    // Without the preview, the frame opens with the link itself, as the
    // gateway expects today; no frame ticket is needed.
    const content = await publicRequest(token, "/public/share/content")
    const contentHtml = await content.text()
    expect(content.status).toBe(200)
    expect(contentHtml).toContain("Operational")
    expect(contentHtml).toContain("color:tomato")
    expect(contentHtml).not.toContain("<script")
    const contentPage = new JSDOM(contentHtml).window.document
    const externalLink = contentPage.querySelector("a")
    expect(externalLink?.getAttribute("href")).toBe("https://attacker.test/")
    expect(externalLink?.getAttribute("target")).toBe("_blank")
    expect(externalLink?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(externalLink?.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(content.headers.get("Content-Security-Policy")).toContain(
      "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'none'"
    )
    expect(content.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "cross-origin"
    )

    const renamed = await updateWidgetMetadata("space", "status", {
      name: "Live status",
    })
    expect(renamed.error).toBeNull()
    renamed.release?.()
    const renamedOuter = await publicRequest(token)
    expect(await renamedOuter.json()).toEqual({
      kind: "html",
      title: "Live status",
    })

    expect((await setWidgetArchived("space", "status", true)).error).toBeNull()
    expect((await publicRequest(token)).status).toBe(404)
  })

  it("rejects direct tenant requests and keeps HEAD bodies empty", async () => {
    expect(
      (
        await app().fetch(
          new Request("http://tenant/public/share", {
            headers: { "x-worktable-share-capability": "A".repeat(43) },
          })
        )
      ).status
    ).toBe(403)

    const unavailable = await publicRequest(
      "A".repeat(43),
      "/public/share",
      "HEAD"
    )
    expect(unavailable.status).toBe(404)
    expect(await unavailable.text()).toBe("")
  })
})
