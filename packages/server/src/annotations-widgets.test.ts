import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import { annotationsRouter } from "./routes/annotations.ts";
import { getAnnotationContext, listAnnotations } from "./annotation-store.ts";

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
  return { status: res.status, text, json: contentType.includes("json") && text ? JSON.parse(text) : null };
}

const VALID_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-text:#111}html[data-theme="dark"]{--ad-bg:#111;--ad-text:#eee}body{background:var(--ad-bg);color:var(--ad-text)}</style></head><body><h2>Burndown</h2><p>chart body</p></body></html>`;

const testDir = join(tmpdir(), `worktable-widget-annotations-${Date.now()}`);
const appDir = join(tmpdir(), `worktable-widget-annotations-app-${Date.now()}`);

describe("HTML doc (widget) annotations", () => {
  let app: Hono;

  beforeEach(async () => {
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    mkdirSync(join(testDir, "spaces"), { recursive: true });
    app = buildTestApp();
    await req(app, "POST", "/api/spaces", { name: "Meta" });
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q3", name: "Q3 Plan", description: "Phases", html: VALID_HTML });
  });

  afterEach(() => {
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
  });

  it("creates, lists, replies, and resolves a widget-target annotation over REST", async () => {
    const created = await req(app, "POST", "/api/spaces/meta/annotations", {
      target: { type: "widget", widgetId: "plans/q3" },
      category: "instruction",
      body: "Phase 2 card should mention annotations explicitly.",
    });
    expect(created.status).toBe(200);
    const annotationId = created.json.annotationId;
    expect(created.json.annotation.target).toEqual({ type: "widget", widgetId: "plans/q3" });

    // Nested id → nested annotation file under the widgets root.
    expect(existsSync(join(testDir, "spaces", "meta", "annotations", "widgets", "plans", "q3.annotations.json"))).toBe(true);

    const filtered = await req(app, "GET", "/api/spaces/meta/annotations?widgetId=plans/q3");
    expect(filtered.json.annotations.length).toBe(1);

    const replied = await req(app, "POST", `/api/spaces/meta/annotations/${annotationId}/replies`, { body: "Done — card updated." });
    expect(replied.status).toBe(200);

    const resolved = await req(app, "POST", `/api/spaces/meta/annotations/${annotationId}/resolve`, { reason: "addressed" });
    expect(resolved.status).toBe(200);
    expect(resolved.json.annotation.status).toBe("resolved");
  });

  it("resolves doc-level context for a widget target (name + description + truncated html)", async () => {
    const context = await getAnnotationContext("meta", { type: "widget", widgetId: "plans/q3" });
    expect(context.targetExists).toBe(true);
    expect(context.selectorMatch).toBe("exact");
    expect(context.excerpt).toContain("Q3 Plan");
    expect(context.excerpt).toContain("Phases");
    expect(context.excerpt).toContain("<h2>Burndown</h2>");
  });

  it("reports missing context when the widget is gone, and rejects malformed widget ids", async () => {
    const missing = await getAnnotationContext("meta", { type: "widget", widgetId: "nope" });
    expect(missing).toEqual({ targetExists: false, selectorMatch: "missing" });

    const bad = await req(app, "POST", "/api/spaces/meta/annotations", {
      target: { type: "widget", widgetId: "../escape" },
      category: "comment",
      body: "x",
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("VALIDATION_ERROR");
  });

  it("keeps doc and widget annotations separate when paths collide", async () => {
    // A DOC whose path equals the widget id — legal, separate namespaces.
    await req(app, "POST", "/api/spaces/meta/annotations", {
      target: { type: "doc", docPath: "plans/q3" },
      category: "comment",
      body: "doc-side note",
    });
    await req(app, "POST", "/api/spaces/meta/annotations", {
      target: { type: "widget", widgetId: "plans/q3" },
      category: "comment",
      body: "widget-side note",
    });
    const docSide = await req(app, "GET", "/api/spaces/meta/annotations?docPath=plans/q3");
    const widgetSide = await req(app, "GET", "/api/spaces/meta/annotations?widgetId=plans/q3");
    expect(docSide.json.annotations.length).toBe(1);
    expect(docSide.json.annotations[0].body).toBe("doc-side note");
    expect(widgetSide.json.annotations.length).toBe(1);
    expect(widgetSide.json.annotations[0].body).toBe("widget-side note");
    // Unfiltered list sees both.
    const all = await listAnnotations("meta", {});
    expect(all.total).toBe(2);
  });

  it("cascades annotation deletion when the widget is deleted", async () => {
    await req(app, "POST", "/api/spaces/meta/annotations", {
      target: { type: "widget", widgetId: "plans/q3" },
      category: "instruction",
      body: "orphan-me-not",
    });
    const del = await req(app, "DELETE", "/api/spaces/meta/widgets/plans/q3");
    expect(del.status).toBe(200);
    const after = await listAnnotations("meta", {});
    expect(after.total).toBe(0);
  });
  it("rejects malformed widgetId list filters instead of joining them into paths", async () => {
    const res = await req(app, "GET", "/api/spaces/meta/annotations?widgetId=" + encodeURIComponent("../../../etc"));
    expect(res.status).toBe(200);
    expect(res.json.annotations).toEqual([]);
  });

  it("rejects legacy space/view/list targets with a 400, not a 500", async () => {
    const res = await req(app, "POST", "/api/spaces/meta/annotations", {
      target: { type: "space" },
      category: "comment",
      body: "hello",
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("VALIDATION_ERROR");
  });
});
