import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { writeSpace } from "./store.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import {
  createHtmlPreviewBroker,
  freezeHtmlPreviewSnapshot,
  freezeSavedHtmlPreviewSnapshotLocked,
  type HtmlPreviewSnapshot,
} from "./html-preview.ts"
import {
  buildRecordCollectionSchema,
  createRecord,
  queryRecords,
  readWidgetState,
  updateRecord,
  writeRecordCollectionSchema,
  writeWidgetState,
} from "./record-store.ts"
import { recordIndex } from "./record-index.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { buildWidgetCsp } from "./widget-runtime-policy.ts"
import { DRAWING_FONTS } from "./preview-fonts.ts"
import {
  injectWidgetHostStyles,
  injectWidgetRuntime,
} from "./widget-authoring.ts"

let root: string
let app: string
const spaceId = "preview"
const path = "dashboards/current"
const api = `/api/spaces/${spaceId}/widgets/__document/${Buffer.from(path).toString("base64url")}`
const permissions = {
  network: false,
  state: { read: true, write: true },
  records: { tasks: { read: true, create: true, update: true, delete: true } },
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "html-preview-ws-"))
  app = await mkdtemp(join(tmpdir(), "html-preview-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(app)
  await ensureWorkspaceManifest()
  const manifestPath = join(root, "worktable.workspace.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 2 }))
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Preview",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  const created = await createHtmlDocument({
    spaceId,
    explicitId: path,
    name: "Dashboard",
    html: "<h1>Original</h1>",
    permissions,
    versionSource: "test",
    versionUpdatedBy: "test",
  })
  expect(created.error).toBeUndefined()
  await writeWidgetState(spaceId, path, { label: "Initial state" })
  await writeRecordCollectionSchema(
    spaceId,
    buildRecordCollectionSchema({
      id: "tasks",
      fields: {
        title: { type: "string" },
        project: { type: "relation", references: "projects" },
      },
    })
  )
  await writeRecordCollectionSchema(
    spaceId,
    buildRecordCollectionSchema({
      id: "projects",
      fields: { title: { type: "string" } },
    })
  )
  expect(
    (
      await createRecord(spaceId, "projects", {
        id: "private",
        data: { title: "Private project" },
      })
    ).error
  ).toBeNull()
  expect(
    (
      await createRecord(spaceId, "tasks", {
        id: "visible",
        data: { title: "Initial task", project: "private" },
      })
    ).error
  ).toBeNull()
})
afterEach(async () => {
  recordIndex.stop()
  invalidateSearchIndex()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all(
    [root, app].map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

test("freezes exact source, permissions and state; later state and source edits cannot change a capture", async () => {
  const frozen = await freezeHtmlPreviewSnapshot({ spaceId, path })
  await writeWidgetState(spaceId, path, { label: "Later state" })
  const changedState = await freezeHtmlPreviewSnapshot({ spaceId, path })
  expect(changedState.sourceRevision).toBe(frozen.sourceRevision)
  expect(changedState.state).toEqual({ label: "Later state" })
  expect(frozen.state).toEqual({ label: "Initial state" })
  await createHtmlDocument({
    spaceId,
    explicitId: path,
    name: "Changed",
    html: "<h1>Later</h1>",
    permissions: { ...permissions, state: { read: false, write: false } },
    versionSource: "test",
    versionUpdatedBy: "test",
  })
  expect(frozen.html).toBe("<h1>Original</h1>")
  expect(frozen.permissions.state.read).toBe(true)
  await expect(
    freezeHtmlPreviewSnapshot({
      spaceId,
      path,
      expectedRevision: frozen.sourceRevision,
    })
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" })
})

test("read-only brokerage rejects on-load mutations and unrelated endpoints even for owner authority", async () => {
  const frozen = await freezeHtmlPreviewSnapshot({ spaceId, path })
  const broker = createHtmlPreviewBroker(frozen, ["*"])
  const attempts = [
    {
      path: `${api}/state`,
      method: "PUT",
      body: JSON.stringify({ state: { label: "Corrupt" } }),
    },
    {
      path: `${api}/records/tasks`,
      method: "POST",
      body: JSON.stringify({ data: { title: "Injected" } }),
    },
    {
      path: `${api}/records/tasks/visible`,
      method: "PATCH",
      body: JSON.stringify({ data: { title: "Corrupt" } }),
    },
    { path: `${api}/records/tasks/visible`, method: "DELETE" },
    { path: "/api/tokens", method: "GET" },
    { path: `${api}/review`, method: "POST" },
    { path: `https://evil.invalid${api}/state`, method: "GET" },
    { path: `${api}/../state`, method: "GET" },
  ]
  for (const request of attempts)
    expect((await broker(request)).status).toBe(403)
  expect(await readWidgetState(spaceId, path)).toEqual({
    label: "Initial state",
  })
  expect(
    (await queryRecords(spaceId, "tasks", {})).records.map(
      (record) => record.data.title
    )
  ).toEqual(["Initial task"])
  const state = await broker({ path: `${api}/state` })
  expect(state).toMatchObject({
    ok: true,
    body: { state: { label: "Initial state" } },
  })
})

test("Records reads intersect caller and document authority, including expanded collections, with per-capture memoization", async () => {
  const frozen = await freezeHtmlPreviewSnapshot({ spaceId, path })
  const query = {
    path: `${api}/records/tasks/query`,
    method: "POST",
    body: "{}",
  }
  const noRecords = createHtmlPreviewBroker(frozen, ["documents:read"])
  expect((await noRecords(query)).status).toBe(403)
  const noDocument = createHtmlPreviewBroker(frozen, ["records:read"])
  expect((await noDocument(query)).status).toBe(403)
  const broker = createHtmlPreviewBroker(frozen, [
    "widgets:read",
    "records:read",
  ])
  expect(
    (
      await broker({
        ...query,
        body: JSON.stringify({ expand: { project: true } }),
      })
    ).status
  ).toBe(403)
  expect(await broker(query)).toMatchObject({
    ok: true,
    body: { records: [{ data: { title: "Initial task" } }] },
  })
  await updateRecord(spaceId, "tasks", "visible", {
    data: { title: "Later task" },
  })
  expect(await broker(query)).toMatchObject({
    ok: true,
    body: { records: [{ data: { title: "Initial task" } }] },
  })
  const fresh = createHtmlPreviewBroker(frozen, [
    "documents:read",
    "records:read",
  ])
  expect(await fresh(query)).toMatchObject({
    ok: true,
    body: { records: [{ data: { title: "Later task" } }] },
  })
  const denied = structuredClone(frozen)
  denied.permissions.state.read = false
  expect(
    (await createHtmlPreviewBroker(denied, ["*"])({ path: `${api}/state` }))
      .status
  ).toBe(403)
})

test("postwrite snapshot can freeze a new identity before inventory publication and matches its committed revision", async () => {
  let captured: HtmlPreviewSnapshot | undefined
  const created = await createHtmlDocument({
    spaceId,
    explicitId: "first-capture",
    name: "New",
    html: "<p>Saved candidate</p>",
    permissions,
    versionSource: "test",
    versionUpdatedBy: "test",
    onSaved: async ({ widget, documentId }) => {
      if (!documentId) throw new Error("Expected managed identity")
      captured = await freezeSavedHtmlPreviewSnapshotLocked({
        spaceId,
        path: widget.id,
        html: "<p>Saved candidate</p>",
        widget,
        documentId,
      })
    },
  })
  expect(created.data).toBeDefined()
  const committed = await freezeHtmlPreviewSnapshot({
    spaceId,
    path: "first-capture",
  })
  expect(captured?.sourceRevision).toBe(committed.sourceRevision)
  expect(captured?.state).toEqual({})
})

test("normal and preview HTML share font defaults while policy keeps authored network assets blocked", () => {
  const live = injectWidgetRuntime(
    "<html><head></head><body>مرحبا 😀</body></html>",
    spaceId,
    path
  )
  const history = injectWidgetHostStyles(
    "<html><head></head><body>مرحبا 😀</body></html>"
  )
  for (const html of [live, history]) {
    expect(html).toContain("/worktable-preview/fonts/")
    expect(html).toContain(`font-family: ${DRAWING_FONTS.sans}`)
  }
  const csp = buildWidgetCsp(false, "https://workspace.invalid")
  expect(csp).toContain(
    "font-src data: https://workspace.invalid/worktable-preview/fonts/"
  )
  expect(csp).toContain("img-src data: blob:")
  expect(csp).toContain("script-src 'unsafe-inline'")
  expect(csp).not.toContain("font-src https:")
})

// These trusted fixtures exercise the real browser/runtime. The scoped test
// launcher does not weaken production Chromium sandbox requirements.
import { previewTest } from "./test-support/synthetic-preview.ts"
import { captureHtmlPreview } from "./html-preview.ts"
import sharp from "sharp"

previewTest(
  "captures live data, diagnoses forbidden on-load writes and bad assets, and bounds unsettled/static HTML",
  async () => {
    const snapshot = await freezeHtmlPreviewSnapshot({ spaceId, path })
    const capture = await captureHtmlPreview({
      snapshot: {
        ...snapshot,
        html: `<html><head><style>@font-face{font-family:UnusedBroken;src:url(data:font/woff2;base64,aW52YWxpZA==);font-display:swap}</style></head><body><h1 id="title">Loading</h1><script>(async()=>{const state=await worktable.state.get();const records=await worktable.records.query('tasks',{});document.querySelector('h1').textContent=state.label+' '+records[0].data.title+' नमस्ते مرحبا 😀';})()</script></body></html>`,
      },
      scopes: ["documents:read", "records:read"],
      options: { width: 600, height: 300 },
    })
    expect(capture.status).toBe("complete")
    expect(capture.width).toBe(600)
    expect(capture.bytes.byteLength).toBeGreaterThan(1000)
    const emoji = await captureHtmlPreview({
      snapshot: {
        ...snapshot,
        html: `<html><body style="margin:0;background:white;color:black;font-size:72px">😀</body></html>`,
      },
      scopes: ["documents:read"],
      options: { width: 300, height: 200, theme: "light" },
    })
    const emojiPixels = await sharp(emoji.bytes).removeAlpha().raw().toBuffer()
    let coloredPixels = 0
    for (let i = 0; i < emojiPixels.length; i += 3) {
      if (
        emojiPixels[i]! > 150 &&
        emojiPixels[i + 1]! > 90 &&
        emojiPixels[i + 2]! < 100
      )
        coloredPixels++
    }
    // FontFace.status=loaded was insufficient: one upstream WOFF2 silently
    // painted no glyph. Require actual yellow emoji pixels in the PNG.
    expect(coloredPixels).toBeGreaterThan(500)
    const attempts = await captureHtmlPreview({
      snapshot: {
        ...snapshot,
        html: `<style>@font-face{font-family:Broken;src:url(data:font/woff2;base64,aW52YWxpZA==);font-display:swap}h1{font-family:Broken}</style><h1>Read-only preview</h1><img src="data:image/png;base64,aW52YWxpZA=="><script>Promise.allSettled([worktable.state.set('label','Corrupt'),worktable.records.create('tasks',{title:'Injected'}),worktable.records.update('tasks','visible',{title:'Corrupt'}),worktable.records.delete('tasks','visible')]);fetch('https://example.invalid/leak').catch(()=>{});</script>`,
      },
      scopes: ["*"],
      options: { width: 600, height: 300 },
    })
    expect(attempts.status).toBe("partial")
    expect(attempts.diagnostics.map((item) => item.code)).toContain(
      "PREVIEW_READ_ONLY"
    )
    expect(attempts.diagnostics.map((item) => item.code)).toContain(
      "preview_image_decode_failed"
    )
    expect(attempts.diagnostics.map((item) => item.code)).toContain(
      "preview_font_load_failed"
    )
    expect(attempts.diagnostics.map((item) => item.code)).toContain(
      "preview_policy_blocked"
    )
    expect(await readWidgetState(spaceId, path)).toEqual({
      label: "Initial state",
    })
    expect(
      (await queryRecords(spaceId, "tasks", {})).records.map(
        (record) => record.data.title
      )
    ).toEqual(["Initial task"])
    const timed = await captureHtmlPreview({
      snapshot: {
        ...snapshot,
        html: `<h1>Unsettled app</h1><script>const until=Date.now()+350;while(Date.now()<until){};Object.defineProperty(document,'fonts',{value:{ready:new Promise(()=>{})}})</script>`,
      },
      scopes: ["documents:read"],
      options: { width: 300, height: 200, timeoutMs: 1000 },
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    )
    // Unsettled authored assets cannot yield a complete capture. A partial
    // image is best effort: a saturated host may exhaust the screenshot
    // reserve, in which case the same hard deadline must fail the capture.
    if (timed.status === "fulfilled") {
      expect(timed.value.status).toBe("partial")
      expect(timed.value.diagnostics.map((item) => item.code)).toContain(
        "preview_timeout"
      )
    } else {
      expect(timed.reason).toBeInstanceOf(Error)
      const error = timed.reason as Error & { code?: string }
      expect(
        error.code === "PREVIEW_TIMEOUT" || error.name === "TimeoutError"
      ).toBe(true)
    }
    const history = await captureHtmlPreview({
      snapshot: {
        ...snapshot,
        historical: true,
        html: `<html><body style="margin:0;background:rgb(0,0,255)"><section style="height:100vh"></section><footer style="height:200px;background:rgb(255,0,0)"></footer><script>document.body.style.background='rgb(255,0,0)'</script></body></html>`,
      },
      scopes: ["documents:read"],
      options: { width: 300, height: 200, fullPage: true },
    })
    expect(history.dataMode).toBe("static-history")
    // Expanding the iframe to the initial 400px content height also expands
    // its 100vh section. The red footer then lies outside the captured image:
    // report that loss explicitly instead of claiming a complete full page.
    expect(history.height).toBe(400)
    expect((await sharp(history.bytes).metadata()).height).toBe(400)
    expect(history.status).toBe("partial")
    expect(history.diagnostics.map((item) => item.code)).toContain(
      "preview_clipped"
    )
    expect(history.diagnostics.map((item) => item.code)).not.toContain(
      "preview_timeout"
    )
    const pixel = await sharp(history.bytes)
      .extract({ left: 10, top: 10, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer()
    expect([...pixel]).toEqual([0, 0, 255])
  }
)

test("guards actual relation reads if its schema is retargeted after permission preflight", async () => {
  const {
    deniedWidgetQueryCollection,
    widgetRecordReadGuard,
    WidgetRecordAccessError,
  } = await import("./widget-runtime-policy.ts")
  const grants = {
    ...permissions,
    records: { ...permissions.records, projects: { read: true } },
  }
  const query = { expand: { project: true as const } }
  expect(
    await deniedWidgetQueryCollection(spaceId, grants, "tasks", query)
  ).toBeNull()
  await writeRecordCollectionSchema(
    spaceId,
    buildRecordCollectionSchema({
      id: "secrets",
      fields: { title: { type: "string" } },
    })
  )
  await createRecord(spaceId, "secrets", {
    id: "private",
    data: { title: "Must not be disclosed" },
  })
  const guard = widgetRecordReadGuard(grants)
  await expect(
    queryRecords(spaceId, "tasks", query, {
      authorizeCollection: async (collection) => {
        guard(collection)
        if (collection === "tasks")
          await writeRecordCollectionSchema(
            spaceId,
            buildRecordCollectionSchema({
              id: "tasks",
              fields: {
                title: { type: "string" },
                project: { type: "relation", references: "secrets" },
              },
            })
          )
      },
    })
  ).rejects.toBeInstanceOf(WidgetRecordAccessError)
})
