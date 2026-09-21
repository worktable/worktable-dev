import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  injectDocumentOpening,
  OPENING_DATA_MARKER,
  OPENING_VIEW_MARKER,
} from "./document-opening.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { writeSpace } from "./store.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { createToken } from "./token-store.ts"
import {
  invalidateServerSettingsCache,
  updateServerSettings,
} from "./settings-store.ts"
import { issueSessionCookie } from "./session-store.ts"
import { Hono } from "hono"
import { writeWidget } from "./widget-store.ts"

let root: string
const shell = `<html><head>${OPENING_DATA_MARKER}</head><body>${OPENING_VIEW_MARKER}<main></main></body></html>`
const url = "http://localhost/spaces/preview/documents/doc"
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-opening-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(join(root, "app"))
  invalidateServerSettingsCache()
  await ensureWorkspaceManifest()
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "preview",
    name: "Preview",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  await mkdir(join(root, "spaces/preview/docs"), { recursive: true })
  await writeFile(
    join(root, "spaces/preview/docs/doc.json"),
    JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({
        id: `p-${i}`,
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `Saved paragraph ${i} </script><script>alert(1)</script>`,
            styles: {},
          },
        ],
      }))
    )
  )
})
afterEach(async () => {
  setWorkspaceRootOverride(null)
  invalidateServerSettingsCache()
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

it("puts bounded, escaped reading content in the initial HTML without starting an editor", async () => {
  const html = await injectDocumentOpening(new Request(url), shell)
  expect(html).toContain("Saved paragraph 0")
  expect(html).toContain("Saved paragraph 79")
  expect(html).not.toContain("Saved paragraph 80")
  expect(html).not.toContain("<script>alert(1)</script>")
  const raw = html!.match(
    /<script id="worktable-opening-data" type="application\/json">(.*?)<\/script>/s
  )![1]
  const data = JSON.parse(raw)
  expect(data.pathname).toBe("/spaces/preview/documents/doc")
  expect(data.html).toContain("&lt;/script&gt;")
  expect(html).toContain(
    `<div id="worktable-opening-preview">${data.html}</div>`
  )
})

it("never embeds private content for cross-origin, invalid bearer or non-loopback ambient requests", async () => {
  for (const request of [
    new Request(url, {
      headers: {
        Origin: "http://foreign.test",
        "Sec-Fetch-Site": "cross-site",
      },
    }),
    new Request(url, { headers: { Authorization: "Bearer invalid" } }),
    new Request(url.replace("localhost", "192.168.2.211")),
  ])
    expect(await injectDocumentOpening(request, shell)).toBeNull()
})

it("requires both document navigation and document content scopes", async () => {
  for (const scopes of [["documents:read"], ["docs:read"]]) {
    const token = await createToken({ agent: "preview-test", scopes })
    expect(
      await injectDocumentOpening(
        new Request(url, {
          headers: { Authorization: `Bearer ${token.token}` },
        }),
        shell
      )
    ).toBeNull()
  }
})

it("leaves missing, conflicting and non-document paths to the normal app", async () => {
  expect(
    await injectDocumentOpening(new Request(url + "-missing"), shell)
  ).toBeNull()
  expect(
    await injectDocumentOpening(new Request("http://localhost/settings"), shell)
  ).toBeNull()
  await writeFile(
    join(root, "spaces/preview/docs/doc.md"),
    "# Conflicting source"
  )
  expect(await injectDocumentOpening(new Request(url), shell)).toBeNull()
})

it("includes the preview for an authenticated LAN browser, but not a signed-out browser", async () => {
  await updateServerSettings({ network: { publicUrl: "http://192.168.2.211" } })
  const lanUrl = url.replace("localhost", "192.168.2.211")
  expect(await injectDocumentOpening(new Request(lanUrl), shell)).toBeNull()
  const issuer = new Hono()
  issuer.get("/cookie", async (c) => {
    await issueSessionCookie(c)
    return c.text("ok")
  })
  const issued = await issuer.request("http://192.168.2.211/cookie")
  const cookie = issued.headers.get("Set-Cookie")!.split(";")[0]
  expect(
    await injectDocumentOpening(
      new Request(lanUrl, {
        headers: { Cookie: cookie, "Sec-Fetch-Site": "none" },
      }),
      shell
    )
  ).toContain("Saved paragraph 0")
})

it("renders Markdown text safely in the initial preview", async () => {
  await writeFile(
    join(root, "spaces/preview/docs/readme.md"),
    "# Readable heading\n\n**Bold text**\n\n<script>alert(1)</script>"
  )
  const html = await injectDocumentOpening(
    new Request(url.replace(/doc$/, "readme")),
    shell
  )
  expect(html).toContain("<h1>Readable heading</h1>")
  expect(html).toContain("<strong>Bold text</strong>")
  expect(html).not.toContain("<script>alert(1)</script>")
})

it("preloads authorized HTML code without placing authored HTML in the parent page", async () => {
  const now = new Date().toISOString()
  const written = await writeWidget("preview", {
    version: 1, kind: "worktable.widget", id: "html", name: "HTML",
    createdAt: now, updatedAt: now, createdBy: "test", metadata: {},
    runtime: { type: "html", entry: "index.html" },
    permissions: { network: false, records: {}, state: { read: true, write: true } },
  }, "<h1>Authored frame content</h1><script>parent.alert(1)</script>")
  expect(written.error).toBeNull()
  written.release?.()
  for (const scopes of [["documents:read", "docs:read"], ["widgets:read"]]) {
    const token = await createToken({ agent: "html-preview", scopes })
    expect(await injectDocumentOpening(new Request(url.replace(/doc$/, "html"), {
      headers: { Authorization: `Bearer ${token.token}` },
    }), shell)).toBeNull()
  }
  const token = await createToken({ agent: "html-preview", scopes: ["documents:read", "widgets:read"] })
  const html = await injectDocumentOpening(new Request(url.replace(/doc$/, "html"), {
    headers: { Authorization: `Bearer ${token.token}` },
  }), shell, { "rich-text": [], markdown: [], html: ["/assets/html.js"] })
  expect(html).toContain("/assets/html.js")
  expect(html).not.toContain("Authored frame content")
  expect(html).not.toContain("parent.alert")
  expect(html).toContain(OPENING_VIEW_MARKER)
})
