import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import { annotationsRouter } from "./routes/annotations.ts";
import { parseChangedPath } from "./watcher.ts";
import { readDocumentPage } from "./document-page-service.ts";
import { readDocumentInventory } from "./document-inventory.ts";
import { readDocumentAnnotationsV2, readDocumentPortableStateV2 } from "./document-data-v2.ts";
import { buildDocumentCatalog } from "./document-catalog.ts";
import { readDoc, writeDoc } from "./store.ts";
import { buildWidgetFile } from "./widget-authoring.ts";
import { writeWidget } from "./widget-store.ts";
import { recordDocAlias, retireDocAlias } from "./doc-aliases.ts";
import { stringifyCanonicalYaml } from "./yaml.ts";
import {
  listWidgetVersions,
  recordExternalWidgetChange,
} from "./widget-version-store.ts";

function buildTestApp() {
  const app = new Hono();
  // Route behavior fixtures enter after the production identity boundary.
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity());
    await next();
  });
  app.onError((err, c) => c.json({ error: err.message, code: "INTERNAL_ERROR" }, 500));
  app.route("/api/spaces", spacesRouter);
  app.route("/api/spaces/:spaceId/widgets", widgetsRouter);
  app.route("/api/spaces/:spaceId/annotations", annotationsRouter);
  return app;
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  return { status: res.status, text, json: contentType.includes("json") && text ? JSON.parse(text) : null, headers: res.headers };
}

const VALID_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-surface:#fff;--ad-text:#111;--ad-muted:#666;--ad-border:#ddd;--ad-accent:#2563eb}html[data-theme="dark"]{--ad-bg:#111;--ad-surface:#222;--ad-text:#fff;--ad-muted:#aaa;--ad-border:#333;--ad-accent:#8ab4ff}body{background:var(--ad-bg);color:var(--ad-text)}</style></head><body><p>hi</p></body></html>`;

const testDir = join(tmpdir(), `worktable-widget-nested-${Date.now()}`);
const appDir = join(tmpdir(), `worktable-widget-nested-app-${Date.now()}`);

describe("path-style widget ids", () => {
  let app: Hono;

  beforeEach(async () => {
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    mkdirSync(join(testDir, "spaces"), { recursive: true });
    app = buildTestApp();
    await req(app, "POST", "/api/spaces", { name: "Meta" });
  });

  it("serves a directly added V2 HTML file through the collision-free compatibility route", async () => {
    const legacyDirect = join(
      testDir,
      "spaces",
      "meta",
      "docs",
      "legacy-direct.html"
    )
    writeFileSync(legacyDirect, VALID_HTML)
    expect(
      await readDocumentPage({
        spaceId: "meta",
        path: "legacy-direct",
        rawSourceAuthorized: true,
        annotationsAuthorized: true,
        sharingAuthorized: false,
      })
    ).toMatchObject({ renderer: null })
    rmSync(legacyDirect)
    const manifestPath = join(testDir, "worktable.workspace.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`
    )
    const docs = join(testDir, "spaces", "meta", "docs", "Team Board")
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, "state.html"), VALID_HTML)
    writeFileSync(
      join(testDir, "spaces", "meta", "docs", "broken.html"),
      Buffer.from([0xff])
    )
    const encoded = Buffer.from("Team Board/state", "utf8").toString("base64url")
    const base = `/api/spaces/meta/widgets/__document/${encoded}`

    const read = await req(app, "GET", base)
    expect(read.status).toBe(200)
    expect(read.json.widget).toMatchObject({
      id: "Team Board/state",
      permissions: { network: false, records: {} },
    })
    const content = await req(app, "GET", `${base}/content?format=raw`)
    expect(content.status).toBe(200)
    expect(content.text).toBe(VALID_HTML)
    const unusualPath = 'download"name'
    writeFileSync(
      join(testDir, "spaces", "meta", "docs", `${unusualPath}.html`),
      VALID_HTML
    )
    const unusual = await req(
      app,
      "GET",
      `/api/spaces/meta/widgets/__document/${Buffer.from(unusualPath).toString("base64url")}/content?format=raw`
    )
    expect(unusual.status).toBe(200)
    expect(unusual.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''download%22name.html"
    )
    const listed = await req(app, "GET", "/api/spaces/meta/widgets")
    expect(listed.status).toBe(200)
    expect(
      listed.json.widgets.map((widget: { id: string }) => widget.id)
    ).toContain("Team Board/state")

    const state = await req(app, "PUT", `${base}/state`, {
      state: { tab: "overview" },
    })
    expect(state.status).toBe(200)
    expect((await req(app, "GET", `${base}/state`)).json.state).toEqual({
      tab: "overview",
    })
    expect((await req(app, "POST", `${base}/archive`, {})).status).toBe(200)
    expect((await req(app, "POST", `${base}/restore`, {})).status).toBe(200)

    const beforeAnnotation = await req(
      app,
      "GET",
      "/api/spaces/meta/annotations?widgetId=Team%20Board%2Fstate"
    )
    expect(beforeAnnotation.status).toBe(200)
    expect(beforeAnnotation.json.annotations).toEqual([])
    const annotation = await req(app, "POST", "/api/spaces/meta/annotations", {
      target: { type: "widget", widgetId: "Team Board/state" },
      category: "comment",
      body: "Direct HTML files can be annotated.",
    })
    expect(annotation.status).toBe(200)
    const afterAnnotation = await req(
      app,
      "GET",
      "/api/spaces/meta/annotations?widgetId=Team%20Board%2Fstate"
    )
    expect(afterAnnotation.json.annotations).toHaveLength(1)
    const durable = await buildDocumentCatalog({
      workspaceRoot: testDir,
      spaceId: "meta",
    })
    const directHtml = durable.entries.find(
      (entry) =>
        entry.kind === "document" && entry.descriptor.path === "Team Board/state"
    )
    expect(directHtml?.kind === "document" && directHtml.handle.identity).toBe(
      "durable"
    )

    if (directHtml?.kind !== "document") throw new Error("missing HTML owner")
    const oldOwner = directHtml.handle.documentId
    rmSync(join(docs, "state.html"))
    await recordExternalWidgetChange("meta", "Team Board/state")
    expect((await readDocumentInventory("meta")).entries.has(oldOwner)).toBe(
      false
    )
    expect(
      await readDocumentAnnotationsV2({
        workspaceRoot: testDir,
        spaceId: "meta",
        documentId: oldOwner,
      })
    ).toBeNull()
    expect(
      await readDocumentPortableStateV2({
        workspaceRoot: testDir,
        spaceId: "meta",
        documentId: oldOwner,
      })
    ).toBeNull()
    writeFileSync(join(docs, "state.html"), VALID_HTML)
    await recordExternalWidgetChange("meta", "Team Board/state")
    const replacement = [
      ...(await readDocumentInventory("meta")).entries.values(),
    ].find((entry) => entry.path === "Team Board/state")
    expect(replacement?.documentId).toBeDefined()
    expect(replacement?.documentId).not.toBe(oldOwner)

    writeFileSync(
      join(testDir, "spaces", "meta", "docs", "watch-me.html"),
      VALID_HTML.replace("<p>hi</p>", "<p>watcher version</p>")
    )
    expect(
      await recordExternalWidgetChange("meta", "watch-me", {
        source: "filesystem",
        updatedBy: "external",
      })
    ).toBeDefined()
    expect(
      await listWidgetVersions("meta", "watch-me", {
        checkpointsOnly: false,
      })
    ).toHaveLength(1)

    writeFileSync(
      join(testDir, "spaces", "meta", "docs", "stale.html"),
      VALID_HTML
    )
    const stale = Buffer.from("stale", "utf8").toString("base64url")
    const staleBase = `/api/spaces/meta/widgets/__document/${stale}`
    expect(
      await req(app, "POST", `${staleBase}/move`, { newPath: "moved" })
    ).toMatchObject({ status: 200, json: { to: "moved" } })
    expect(
      await req(app, "POST", `${staleBase}/move`, { newPath: "moved-again" })
    ).toMatchObject({ status: 409, json: { code: "CONFLICT" } })
    expect(await req(app, "DELETE", staleBase)).toMatchObject({
      status: 409,
      json: { code: "CONFLICT" },
    })

    writeFileSync(
      join(testDir, "spaces", "meta", "docs", "delete-me.html"),
      VALID_HTML
    )
    const deleteMe = Buffer.from("delete-me", "utf8").toString("base64url")
    expect(
      await req(app, "DELETE", `/api/spaces/meta/widgets/__document/${deleteMe}`)
    ).toMatchObject({ status: 200 })
    expect(
      existsSync(join(testDir, "spaces", "meta", "docs", "delete-me.html"))
    ).toBe(false)
  }, 15_000)

  afterEach(() => {
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
  });

  it("creates, reads, updates, and logically moves nested widgets alongside other documents", async () => {
    const nested = await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q3-redesign", name: "Q3 Plan", html: VALID_HTML });
    expect(nested.status).toBe(201);
    expect(nested.json.widgetId).toBe("plans/q3-redesign");
    expect(existsSync(join(testDir, "spaces", "meta", "widgets", "plans", "q3-redesign", "widget.yaml"))).toBe(true);

    const flat = await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: VALID_HTML });
    expect(flat.status).toBe(201);

    const list = await req(app, "GET", "/api/spaces/meta/widgets");
    expect(list.json.widgets.map((w: { id: string }) => w.id).sort()).toEqual(["plans/q3-redesign", "tracker"]);

    const read = await req(app, "GET", "/api/spaces/meta/widgets/plans/q3-redesign");
    expect(read.status).toBe(200);
    expect(read.json.widget.id).toBe("plans/q3-redesign");

    const content = await req(app, "GET", "/api/spaces/meta/widgets/plans/q3-redesign/content?theme=dark");
    expect(content.status).toBe(200);
    expect(content.text).toContain("data-theme=\"dark\"");

    const raw = await req(app, "GET", "/api/spaces/meta/widgets/plans/q3-redesign/content?format=raw");
    expect(raw.status).toBe(200);
    expect(raw.text).toBe(VALID_HTML);
    expect(raw.headers.get("content-disposition")).toContain("q3-redesign.html");

    const put = await req(app, "PUT", "/api/spaces/meta/widgets/plans/q3-redesign", { name: "Q3 Plan v2", html: VALID_HTML });
    expect(put.status).toBe(200);
    expect(put.json.widget.name).toBe("Q3 Plan v2");

    const patched = await req(app, "PATCH", "/api/spaces/meta/widgets/plans/q3-redesign", { description: "updated" });
    expect(patched.status).toBe(200);

    const archived = await req(app, "POST", "/api/spaces/meta/widgets/plans/q3-redesign/archive", {});
    expect(archived.status).toBe(200);
    const restored = await req(app, "POST", "/api/spaces/meta/widgets/plans/q3-redesign/restore", {});
    expect(restored.status).toBe(200);

    const legacy = await writeWidget(
      "meta",
      buildWidgetFile({ id: "legacy/movable", name: "Legacy movable" }),
      VALID_HTML,
    );
    expect(legacy.error).toBeNull();
    legacy.release?.();
    await writeDoc("meta", "notes/occupied", "# Existing Markdown\n");

    const collision = await req(
      app,
      "POST",
      "/api/spaces/meta/widgets/legacy/movable/move",
      { newPath: "notes/occupied" },
    );
    expect(collision.status).toBe(409);
    expect((await req(app, "GET", "/api/spaces/meta/widgets/legacy/movable")).status).toBe(200);
    expect((await readDoc("meta", "notes/occupied")).data).toBe("# Existing Markdown\n");

    await recordDocAlias("meta", "Legacy", "tracker", "exact");
    const aliasCollision = await req(
      app,
      "POST",
      "/api/spaces/meta/widgets/legacy/movable/move",
      { newPath: "Legacy" },
    );
    expect(aliasCollision.status).toBe(409);
    expect(await retireDocAlias("meta", "Legacy", "exact")).toBe(true);

    const moved = await req(
      app,
      "POST",
      "/api/spaces/meta/widgets/legacy/movable/move",
      { newPath: "Legacy" },
    );
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({
      ok: true,
      from: "legacy/movable",
      to: "legacy",
    });
    const movedBack = await req(
      app,
      "POST",
      "/api/spaces/meta/widgets/legacy/move",
      { newPath: "legacy/movable" },
    );
    expect(movedBack.status).toBe(200);
    expect(movedBack.json).toMatchObject({
      ok: true,
      from: "legacy",
      to: "legacy/movable",
      documentId: moved.json.documentId,
    });
    const returnedRead = await req(
      app,
      "GET",
      "/api/spaces/meta/widgets/legacy/movable",
    );
    expect(returnedRead.status).toBe(200);
    expect(returnedRead.json.widget.id).toBe("legacy/movable");
    const vacatedRead = await req(app, "GET", "/api/spaces/meta/widgets/legacy");
    expect(vacatedRead.status).toBe(409);
    expect(vacatedRead.json.canonicalPath).toBe("legacy/movable");

    const movedAgain = await req(
      app,
      "POST",
      "/api/spaces/meta/widgets/legacy/movable/move",
      { newPath: "legacy" },
    );
    expect(movedAgain.status).toBe(200);
    expect(movedAgain.json.documentId).toBe(moved.json.documentId);
    const contentBookmark = await req(
      app,
      "GET",
      "/api/spaces/meta/widgets/legacy/movable/content?theme=dark",
    );
    expect(contentBookmark.status).toBe(307);
    const contentLocation = new URL(contentBookmark.headers.get("location")!);
    const canonicalEncoded = Buffer.from("legacy", "utf8").toString(
      "base64url"
    );
    expect(contentLocation.pathname).toBe(
      `/api/spaces/meta/widgets/__document/${canonicalEncoded}/content`,
    );
    expect(contentLocation.search).toBe("?theme=dark");
    // Portable sync can preserve an older case spelling in alias metadata even
    // though HTML bundle ids themselves are lowercase. Specialized access must
    // still resolve through the common namespace instead of trusting a shadow
    // bundle at the comparison-equivalent path.
    expect(await retireDocAlias("meta", "legacy/movable", "exact")).toBe(true);
    await recordDocAlias("meta", "Legacy/Movable", "legacy", "exact");
    const oldRead = await req(app, "GET", "/api/spaces/meta/widgets/legacy/movable");
    expect(oldRead.status).toBe(409);
    expect(oldRead.json.canonicalPath).toBe("legacy");
    const movedRead = await req(app, "GET", "/api/spaces/meta/widgets/legacy");
    expect(movedRead.status).toBe(200);
    expect(movedRead.json.widget.id).toBe("legacy");

    const recreatedOldPath = join(
      testDir,
      "spaces",
      "meta",
      "widgets",
      "legacy",
      "movable",
    );
    mkdirSync(recreatedOldPath, { recursive: true });
    writeFileSync(
      join(recreatedOldPath, "widget.yaml"),
      stringifyCanonicalYaml(
        buildWidgetFile({ id: "legacy/movable", name: "Hidden recreation" }),
      ),
    );
    writeFileSync(join(recreatedOldPath, "index.html"), VALID_HTML);
    const rejectedRecreation = await req(
      app,
      "PATCH",
      "/api/spaces/meta/widgets/legacy/movable",
      { name: "Must not mutate" },
    );
    expect(rejectedRecreation.status).toBe(409);
    expect(rejectedRecreation.json.canonicalPath).toBe("legacy");
    rmSync(recreatedOldPath, { recursive: true, force: true });

    const catalog = await buildDocumentCatalog({
      workspaceRoot: testDir,
      spaceId: "meta",
    });
    expect(catalog.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          descriptor: expect.objectContaining({ path: "plans/q3-redesign" }),
          handle: expect.objectContaining({ identity: "durable" }),
        }),
        expect.objectContaining({
          descriptor: expect.objectContaining({
            path: "legacy",
            documentId: moved.json.documentId,
          }),
          handle: expect.objectContaining({ identity: "durable" }),
        }),
      ]),
    );

    const afterMove = await req(app, "GET", "/api/spaces/meta/widgets");
    expect(afterMove.json.widgets.map((w: { id: string }) => w.id).sort()).toEqual([
      "legacy",
      "plans/q3-redesign",
      "tracker",
    ]);
    // Like the V2 journey above, this exercises many durable writes and moves.
    // Its deadline bounds the whole journey, not a single request's latency.
  }, 15_000);

  it("keeps automatic HTML creates distinct when they arrive together", async () => {
    const aliasTarget = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "tracker",
      name: "Tracker",
      html: VALID_HTML,
    });
    expect(aliasTarget.status).toBe(201);
    await recordDocAlias("meta", "shared-dashboard", "tracker", "exact");
    const creates = await Promise.all(
      Array.from({ length: 2 }, (_, index) =>
        req(app, "POST", "/api/spaces/meta/widgets", {
          name: "Shared dashboard",
          html: VALID_HTML.replace("<p>hi</p>", `<p>create-${index}</p>`),
        }),
      ),
    );

    expect(creates.every((result) => result.status === 201)).toBe(true);
    expect(creates.map((result) => result.json.widgetId).sort()).toEqual([
      "shared-dashboard-2",
      "shared-dashboard-3",
    ]);

    for (const [index, created] of creates.entries()) {
      const content = await req(
        app,
        "GET",
        `/api/spaces/meta/widgets/${created.json.widgetId}/content?format=raw`,
      );
      expect(content.text).toContain(`create-${index}`);
    }
  });

  it("round-trips state for a nested widget", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q3", name: "Q3", html: VALID_HTML });
    const put = await req(app, "PUT", "/api/spaces/meta/widgets/plans/q3/state", { state: { tab: "overview" } });
    expect(put.status).toBe(200);
    const get = await req(app, "GET", "/api/spaces/meta/widgets/plans/q3/state");
    expect(get.status).toBe(200);
    expect(get.json.state).toEqual({ tab: "overview" });
    expect(existsSync(join(testDir, "spaces", "meta", "widgets", "plans", "q3", "state.yaml"))).toBe(true);
  });

  it("rejects reserved names in nested id segments", async () => {
    for (const id of ["foo/records", "records/foo", "a/state/b", "x/archive", "restore/y", "plans/content"]) {
      const res = await req(app, "POST", "/api/spaces/meta/widgets", { id, name: "Bad", html: VALID_HTML });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe("VALIDATION_ERROR");
    }
  });

  it("keeps legacy FLAT reserved-word ids working end to end", async () => {
    // Flat ids like `state` were valid before path-style ids; the position
    // right after /widgets/ can never be an action, so they stay unambiguous.
    for (const id of ["state", "records", "content", "archive", "restore"]) {
      const created = await req(app, "POST", "/api/spaces/meta/widgets", { id, name: `Legacy ${id}`, html: VALID_HTML });
      expect(created.status).toBe(201);
    }
    const read = await req(app, "GET", "/api/spaces/meta/widgets/state");
    expect(read.status).toBe(200);
    expect(read.json.widget.id).toBe("state");

    const content = await req(app, "GET", "/api/spaces/meta/widgets/content/content");
    expect(content.status).toBe(200);
    expect(content.text).toContain("<!doctype html>");

    // Widget `state`'s own state endpoint: /widgets/state/state
    const putState = await req(app, "PUT", "/api/spaces/meta/widgets/state/state", { state: { ok: true } });
    expect(putState.status).toBe(200);
    const getState = await req(app, "GET", "/api/spaces/meta/widgets/state/state");
    expect(getState.json.state).toEqual({ ok: true });

    const archived = await req(app, "POST", "/api/spaces/meta/widgets/archive/archive", {});
    expect(archived.status).toBe(200);
    const restored = await req(app, "POST", "/api/spaces/meta/widgets/archive/restore", {});
    expect(restored.status).toBe(200);

    const list = await req(app, "GET", "/api/spaces/meta/widgets");
    const ids = list.json.widgets.map((w: { id: string }) => w.id);
    for (const id of ["state", "records", "content", "archive", "restore"]) {
      expect(ids).toContain(id);
    }
  });

  it("rejects malformed ids (traversal, empty segments, uppercase, spaces)", async () => {
    for (const id of ["../escape", "a//b", "a/../b", "Plans/Q3", "a b", "/leading", "trailing/"]) {
      const res = await req(app, "POST", "/api/spaces/meta/widgets", { id, name: "Bad", html: VALID_HTML });
      expect(res.status).toBe(400);
    }
  });

  it("dedupes auto-derived ids against occupied folder prefixes", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q3", name: "Q3", html: VALID_HTML });
    // No explicit id: slugify("Plans") = "plans", which is an implicit folder
    // holding plans/q3 — creation must dedupe to plans-2, not fail.
    const res = await req(app, "POST", "/api/spaces/meta/widgets", { name: "Plans", html: VALID_HTML });
    expect(res.status).toBe(201);
    expect(res.json.widgetId).toBe("plans-2");
  });

  it("enforces leaf-only nesting in both directions", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q3", name: "Q3", html: VALID_HTML });

    const under = await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q3/child", name: "Child", html: VALID_HTML });
    expect(under.status).toBe(400);
    expect(under.json.error).toContain("nested under existing widget");

    const over = await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans", name: "Plans", html: VALID_HTML });
    expect(over.status).toBe(400);
    expect(over.json.error).toContain("folder that contains widgets");
  });

  it("keeps record permission enforcement per nested widget (no cross-widget reach)", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q3", name: "Q3", html: VALID_HTML, permissions: { records: { tasks: { read: true } } } });
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/other", name: "Other", html: VALID_HTML });

    const allowed = await req(app, "POST", "/api/spaces/meta/widgets/plans/q3/records/tasks/query", {});
    // 200 or 400 depending on collection existence; the point is it is NOT a 403/404 routing failure.
    expect([200, 400]).toContain(allowed.status);

    const denied = await req(app, "POST", "/api/spaces/meta/widgets/plans/other/records/tasks/query", {});
    expect(denied.status).toBe(403);
    expect(denied.json.missingPermission).toBe("permissions.records.tasks.read");
  });

  it("deletes a nested widget and prunes empty folder husks only", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/deep/q3", name: "Q3", html: VALID_HTML });
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q4", name: "Q4", html: VALID_HTML });

    const del = await req(app, "DELETE", "/api/spaces/meta/widgets/plans/deep/q3");
    expect(del.status).toBe(200);
    expect(existsSync(join(testDir, "spaces", "meta", "widgets", "plans", "deep"))).toBe(false);
    // plans/ still holds q4 — must survive.
    expect(existsSync(join(testDir, "spaces", "meta", "widgets", "plans", "q4", "widget.yaml"))).toBe(true);

    const list = await req(app, "GET", "/api/spaces/meta/widgets");
    expect(list.json.widgets.map((w: { id: string }) => w.id)).toEqual(["plans/q4"]);
  });

  it("404s unknown nested paths and never mis-binds reserved suffixes", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q3", name: "Q3", html: VALID_HTML });
    expect((await req(app, "GET", "/api/spaces/meta/widgets/plans/q3/nope")).status).toBe(404);
    expect((await req(app, "GET", "/api/spaces/meta/widgets/plans")).status).toBe(404);
    expect((await req(app, "GET", "/api/spaces/meta/widgets/plans/q3/state/extra")).status).toBe(404);
    // Reserved word as a collection id still routes as a records call on the widget.
    const res = await req(app, "POST", "/api/spaces/meta/widgets/plans/q3/records/state/query", {});
    expect(res.status).toBe(403); // no permission granted for collection "state"
  });

  it("watcher parses nested widget file changes at any depth", () => {
    const base = "/ws/spaces";
    expect(parseChangedPath(base, "meta/widgets/tracker/widget.yaml", base)).toEqual({ type: "widget", spaceId: "meta", widgetId: "tracker" });
    expect(parseChangedPath(base, "meta/widgets/plans/q3/index.html", base)).toEqual({ type: "widget", spaceId: "meta", widgetId: "plans/q3" });
    expect(parseChangedPath(base, "meta/widgets/plans/deep/q3/widget.yaml", base)).toEqual({ type: "widget", spaceId: "meta", widgetId: "plans/deep/q3" });
    expect(parseChangedPath(base, "meta/widgets/plans/q3/state.yaml", base)).toBeNull();
  });
});
