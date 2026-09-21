import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACTOR_HEADERS, GATEWAY_HEADER } from "@worktable/hosted-contract"
import { JSDOM } from "jsdom"
import {
  drainWorkspaceChanges,
  notifyWorkspaceChangeAndWaitOrThrow,
} from "./workspace-events.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { renameDocAndSync } from "./doc-rename.ts"
import { gatewayAdmits } from "./hosted.ts"
import { publicSharesRouter } from "./routes/public-shares.ts"
import { sharesRouter } from "./routes/shares.ts"
import { setSpaceArchived, writeDoc, writeSpace } from "./store.ts"
import {
  setWidgetArchived,
  updateWidgetMetadata,
  writeWidget,
} from "./widget-store.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { WorkspaceWatcher } from "./watcher.ts"

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

async function ownerRequest(
  method: string,
  artifact: { kind: "doc" | "html"; spaceId: string; artifactKey: string }
): Promise<Response> {
  const query = new URLSearchParams(artifact)
  const request =
    method === "GET"
      ? new Request(`http://tenant/api/shares?${query}`, {
          headers: admittedHeaders(true),
        })
      : new Request("http://tenant/api/shares", {
          method,
          headers: {
            ...admittedHeaders(true),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(artifact),
        })
  return app().fetch(request)
}

async function publicRequest(
  token: string,
  path = "/public/share",
  method = "GET"
): Promise<Response> {
  return app().fetch(
    new Request(`http://tenant${path}`, {
      method,
      headers: {
        ...admittedHeaders(),
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
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  process.env = { ...originalEnv }
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})

describe("Cloud document share HTTP boundary", () => {
  it("creates a Doc link, serves the latest save anonymously, and permanently stops it", async () => {
    const artifact = {
      kind: "doc" as const,
      spaceId: "space",
      artifactKey: "launch-plan",
    }
    await writeDoc(
      artifact.spaceId,
      artifact.artifactKey,
      "# First\n\nPrivate notes."
    )

    const forbidden = await app().fetch(
      new Request("http://tenant/api/shares", {
        method: "POST",
        headers: {
          ...admittedHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(artifact),
      })
    )
    expect(forbidden.status).toBe(403)

    const created = await ownerRequest("POST", artifact)
    expect(created.status).toBe(201)
    expect(created.headers.get("Cache-Control")).toBe("no-store")
    const createdBody = (await created.json()) as {
      share: { url: string; createdAt: string }
    }
    expect(createdBody.share.url).toMatch(
      /^https:\/\/share\.worktable\.cloud\/s\/workspace_cloud_123\/[A-Za-z0-9_-]{43}$/
    )
    const token = createdBody.share.url.split("/").at(-1)!

    const first = await publicRequest(token)
    expect(first.status).toBe(200)
    const firstProjection = (await first.json()) as {
      kind: "doc"
      format: "markdown"
      title: string
      projectionHtml: string
    }
    expect(firstProjection.title).toBe("launch plan")
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

    expect((await ownerRequest("DELETE", artifact)).status).toBe(200)
    const stopped = await publicRequest(token)
    expect(stopped.status).toBe(404)
    expect(await stopped.text()).toBe("")

    const reshared = (await (await ownerRequest("POST", artifact)).json()) as {
      share: { url: string }
    }
    expect(reshared.share.url).not.toBe(createdBody.share.url)
    expect((await publicRequest(token)).status).toBe(404)
  })

  it("invalidates a Doc path share on rename and gives malformed tokens the same page", async () => {
    const artifact = {
      kind: "doc" as const,
      spaceId: "space",
      artifactKey: "old-name",
    }
    await writeDoc(artifact.spaceId, artifact.artifactKey, "# Rename me")
    const created = (await (await ownerRequest("POST", artifact)).json()) as {
      share: { url: string }
    }
    const token = created.share.url.split("/").at(-1)!
    expect(
      (await renameDocAndSync("space", "old-name", "new-name")).error
    ).toBeNull()

    const renamed = await publicRequest(token)
    const malformed = await publicRequest("not-a-token")
    expect(renamed.status).toBe(404)
    expect(malformed.status).toBe(404)
    expect(await renamed.text()).toBe(await malformed.text())
  })

  it("does not revive links after artifacts are removed directly on disk", async () => {
    const doc = {
      kind: "doc" as const,
      spaceId: "space",
      artifactKey: "external-doc",
    }
    await writeDoc(doc.spaceId, doc.artifactKey, "# Original")
    const docShare = (await (await ownerRequest("POST", doc)).json()) as {
      share: { url: string }
    }
    const docToken = docShare.share.url.split("/").at(-1)!

    await rm(
      join(workspaceDir, "spaces", "space", "docs", "external-doc.md")
    )
    await notifyWorkspaceChangeAndWaitOrThrow({
      type: "doc",
      spaceId: "space",
      docPath: "external-doc",
    })
    await writeDoc(doc.spaceId, doc.artifactKey, "# Replacement")
    expect((await publicRequest(docToken)).status).toBe(404)

    const now = new Date().toISOString()
    const html = {
      kind: "html" as const,
      spaceId: "space",
      artifactKey: "external-html",
    }
    const written = await writeWidget(
      html.spaceId,
      {
        version: 1,
        kind: "worktable.widget",
        id: html.artifactKey,
        name: "Original HTML",
        createdAt: now,
        updatedAt: now,
        createdBy: "test",
        metadata: {},
        runtime: { type: "html", entry: "index.html" },
        permissions: { network: false, records: {}, state: {} },
      },
      "<h1>Original</h1>"
    )
    written.release?.()
    const htmlShare = (await (await ownerRequest("POST", html)).json()) as {
      share: { url: string }
    }
    const htmlToken = htmlShare.share.url.split("/").at(-1)!

    const watcher = new WorkspaceWatcher(5)
    watcher.start()
    const watcherReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        off()
        reject(new Error("Timed out waiting for workspace watcher readiness"))
      }, 2_000)
      const off = watcher.on((event) => {
        if (event.type !== "space" || event.spaceId !== "space") return
        clearTimeout(timeout)
        off()
        resolve()
      })
    })
    const spaceFile = join(workspaceDir, "spaces", "space", "space.json")
    await writeFile(spaceFile, await readFile(spaceFile))
    await watcherReady
    const directoryMoveObserved = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        off()
        reject(new Error("Timed out waiting for HTML Doc directory move"))
      }, 2_000)
      const off = watcher.on((event) => {
        if (
          event.type !== "widget" ||
          event.spaceId !== "space" ||
          event.widgetId !== "external-html"
        ) {
          return
        }
        clearTimeout(timeout)
        off()
        resolve()
      })
    })
    try {
      await rm(
        join(workspaceDir, "spaces", "space", "widgets", "external-html"),
        { recursive: true }
      )
      await directoryMoveObserved
      await drainWorkspaceChanges()
    } finally {
      watcher.stop()
    }
    const replacement = await writeWidget(
      html.spaceId,
      {
        version: 1,
        kind: "worktable.widget",
        id: html.artifactKey,
        name: "Replacement HTML",
        createdAt: now,
        updatedAt: now,
        createdBy: "test",
        metadata: {},
        runtime: { type: "html", entry: "index.html" },
        permissions: { network: false, records: {}, state: {} },
      },
      "<h1>Replacement</h1>"
    )
    replacement.release?.()
    expect((await publicRequest(htmlToken)).status).toBe(404)
  })

  it("does not revoke a link while its existing artifact is temporarily unreadable", async () => {
    const artifact = {
      kind: "doc" as const,
      spaceId: "space",
      artifactKey: "external-edit",
    }
    await writeDoc(artifact.spaceId, artifact.artifactKey, [])
    const created = (await (await ownerRequest("POST", artifact)).json()) as {
      share: { url: string }
    }
    const token = created.share.url.split("/").at(-1)!
    const path = join(
      workspaceDir,
      "spaces",
      "space",
      "docs",
      "external-edit.json"
    )

    await writeFile(path, "{", "utf8")
    expect(await (await ownerRequest("GET", artifact)).json()).toEqual({
      share: {
        url: created.share.url,
        createdAt: expect.any(String),
      },
    })
    expect((await publicRequest(token)).status).toBe(404)

    await writeFile(path, "[]\n", "utf8")
    expect((await publicRequest(token)).status).toBe(200)
  })

  it("invalidates every link when its Space is archived", async () => {
    const artifact = {
      kind: "doc" as const,
      spaceId: "space",
      artifactKey: "space-lifecycle",
    }
    await writeDoc(artifact.spaceId, artifact.artifactKey, "# Space lifecycle")
    const created = (await (await ownerRequest("POST", artifact)).json()) as {
      share: { url: string }
    }
    const token = created.share.url.split("/").at(-1)!

    expect((await setSpaceArchived("space", true)).error).toBeNull()
    expect((await publicRequest(token)).status).toBe(404)
    expect((await ownerRequest("POST", artifact)).status).toBe(404)

    expect((await setSpaceArchived("space", false)).error).toBeNull()
    const reshared = (await (await ownerRequest("POST", artifact)).json()) as {
      share: { url: string }
    }
    expect(reshared.share.url).not.toBe(created.share.url)
  })

  it("preserves an HTML link across display-name edits and serves a sanitized projection", async () => {
    const manifestPath = join(workspaceDir, "worktable.workspace.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`
    )
    const artifact = {
      kind: "html" as const,
      spaceId: "space",
      artifactKey: "status",
    }
    const written = await createHtmlDocument({
      spaceId: artifact.spaceId,
      explicitId: artifact.artifactKey,
      name: "Status board",
      html: `<style>.card{color:tomato}</style><main class="card"><h1>Operational</h1><script>fetch("https://attacker.test")</script><a href="https://attacker.test">leave</a></main>`,
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

    const created = (await (await ownerRequest("POST", artifact)).json()) as {
      share: { url: string }
    }
    const token = created.share.url.split("/").at(-1)!
    const outer = await publicRequest(token)
    expect(await outer.json()).toEqual({
      kind: "html",
      title: "Status board",
    })

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
