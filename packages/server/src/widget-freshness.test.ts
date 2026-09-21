import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import {
  evictWidgetFreshness,
  getWidgetFreshness,
  isRecordsConnected,
} from "./widget-freshness.ts";
import { readWidget } from "./widget-store.ts";
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts";

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

const VALID_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-text:#111}html[data-theme="dark"]{--ad-bg:#111;--ad-text:#eee}body{background:var(--ad-bg);color:var(--ad-text)}</style></head><body><p>v1</p></body></html>`;
const VALID_HTML_V2 = VALID_HTML.replace("<p>v1</p>", "<p>v2</p>");

const testDir = join(tmpdir(), `worktable-widget-freshness-${Date.now()}`);

async function widgetOf(id: string) {
  const { data } = await readWidget("meta", id);
  if (!data) throw new Error(`missing widget ${id}`);
  return data;
}

describe("HTML doc (widget) freshness", () => {
  let app: Hono;

  beforeEach(async () => {
    mkdirSync(join(testDir, "spaces"), { recursive: true });
    setWorkspaceRootOverride(testDir);
    app = buildTestApp();
    await req(app, "POST", "/api/spaces", { name: "Meta" });
  });

  afterEach(() => {
    setSystemTime();
    setWorkspaceRootOverride(null);
    evictWidgetFreshness("meta");
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("agent-created widgets are unreviewed; a review checkpoint flips humanReviewed", async () => {
    setSystemTime(new Date("2026-07-13T14:17:32.773Z"));
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: VALID_HTML, createdBy: "worktable-agent" });
    let freshness = await getWidgetFreshness("meta", await widgetOf("tracker"));
    expect(freshness.humanReviewed).toBe(false);
    expect(freshness.lastHumanTouch).toBeNull();

    const review = await req(app, "POST", "/api/spaces/meta/widgets/tracker/review", {});
    expect(review.status).toBe(200);
    expect(review.json.freshness.humanReviewed).toBe(true);

    freshness = await getWidgetFreshness("meta", await widgetOf("tracker"));
    expect(freshness.humanReviewed).toBe(true);
    expect(freshness.lastHumanTouch).not.toBeNull();
  });

  it("a widget-frame (opaque origin) cannot self-review; only same-origin app calls record it", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: VALID_HTML, createdBy: "worktable-agent" });
    // A sandboxed widget's direct fetch is cross-origin: Origin: null + Sec-Fetch-Site: cross-site.
    const forged = await app.fetch(new Request("http://localhost/api/spaces/meta/widgets/tracker/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "null", "Sec-Fetch-Site": "cross-site" },
      body: "{}",
    }));
    expect(forged.status).toBe(403);
    expect((await getWidgetFreshness("meta", await widgetOf("tracker"))).humanReviewed).toBe(false);

    // The Worktable app's own same-origin review call is accepted.
    const real = await app.fetch(new Request("http://localhost/api/spaces/meta/widgets/tracker/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
      body: "{}",
    }));
    expect(real.status).toBe(200);
    expect((await getWidgetFreshness("meta", await widgetOf("tracker"))).humanReviewed).toBe(true);
  });

  it("the Origin fallback gate rejects a cross-scheme origin (full-origin, not just host)", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: VALID_HTML, createdBy: "worktable-agent" });
    // No Sec-Fetch-Site (older/proxied browser) → Origin fallback. The request URL
    // is http://localhost, so an https://localhost Origin is CROSS-origin and must
    // be rejected — comparing only host would wrongly accept it.
    const crossScheme = await app.fetch(new Request("http://localhost/api/spaces/meta/widgets/tracker/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://localhost" },
      body: "{}",
    }));
    expect(crossScheme.status).toBe(403);
    expect((await getWidgetFreshness("meta", await widgetOf("tracker"))).humanReviewed).toBe(false);
  });

  it("a widget-frame cannot self-checkpoint into humanReviewed (checkpoint gated like review)", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: VALID_HTML, createdBy: "worktable-agent" });
    // A manual checkpoint stamps sourceCategory "human", so it is a trust anchor
    // too: a sandboxed/served widget must not reach it. Cross-origin POST → 403.
    const forged = await app.fetch(new Request("http://localhost/api/spaces/meta/widgets/tracker/versions/checkpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "null", "Sec-Fetch-Site": "cross-site" },
      body: "{}",
    }));
    expect(forged.status).toBe(403);
    expect((await getWidgetFreshness("meta", await widgetOf("tracker"))).humanReviewed).toBe(false);

    // The app's own same-origin checkpoint is accepted and marks it human-touched.
    const real = await app.fetch(new Request("http://localhost/api/spaces/meta/widgets/tracker/versions/checkpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
      body: "{}",
    }));
    expect(real.status).toBe(200);
    expect((await getWidgetFreshness("meta", await widgetOf("tracker"))).humanReviewed).toBe(true);
  });

  it("served widget content is sandboxed (opaque origin) so new-tab views can't reach the trust anchors", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: VALID_HTML, createdBy: "worktable-agent" });
    // The themed /content response (used by "Open in new tab") must carry a
    // `sandbox` CSP directive so authored JS runs opaque-origin even top-level.
    const res = await app.fetch(new Request("http://localhost/api/spaces/meta/widgets/tracker/content"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy") ?? "").toContain("sandbox allow-scripts");
  });

  it("a widget-frame cannot PUT/create its own source to launder human provenance", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: VALID_HTML, createdBy: "worktable-agent" });
    // A widget's own edit endpoints stamp updatedBy "user" by default (human),
    // so a sandboxed/served widget must not reach PUT/PATCH/create either — else
    // it self-stamps a human version without ever calling /review.
    const put = await app.fetch(new Request("http://localhost/api/spaces/meta/widgets/tracker", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "null", "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ name: "Tracker", html: VALID_HTML_V2 }),
    }));
    expect(put.status).toBe(403);
    const create = await app.fetch(new Request("http://localhost/api/spaces/meta/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "null", "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ id: "tracker", name: "Tracker", html: VALID_HTML_V2 }),
    }));
    expect(create.status).toBe(403);
    // No human touch was recorded and the content is unchanged (still v1).
    expect((await getWidgetFreshness("meta", await widgetOf("tracker"))).lastHumanTouch).toBeNull();
    const content = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/content")).text;
    expect(content).toContain("<p>v1</p>");
    // The app's own same-origin PUT still works.
    const ok = await app.fetch(new Request("http://localhost/api/spaces/meta/widgets/tracker", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ name: "Tracker", html: VALID_HTML_V2, updatedBy: "user" }),
    }));
    expect(ok.status).toBe(200);
  });

  it("an agent update AFTER review un-reviews the widget (no laundering)", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: VALID_HTML, createdBy: "worktable-agent" });
    await req(app, "POST", "/api/spaces/meta/widgets/tracker/review", {});
    // Agent rewrite via PUT with an agent-y updatedBy.
    const put = await req(app, "PUT", "/api/spaces/meta/widgets/tracker", { name: "Tracker", html: VALID_HTML_V2, updatedBy: "worktable-agent" });
    expect(put.status).toBe(200);
    const freshness = await getWidgetFreshness("meta", await widgetOf("tracker"));
    expect(freshness.humanReviewed).toBe(false);
    // The review touch is still the last HUMAN touch.
    expect(freshness.lastHumanTouch).not.toBeNull();
  });

  it("drops review state whose supporting history disappeared on reset", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "tracker",
      name: "Tracker",
      html: VALID_HTML,
      createdBy: "worktable-agent",
    });
    await req(app, "POST", "/api/spaces/meta/widgets/tracker/review", {});
    expect(
      (await getWidgetFreshness("meta", await widgetOf("tracker")))
        .humanReviewed,
    ).toBe(true);

    // Replacement can retain the same provenance version id while omitting
    // the history that made it a human review. A workspace reset must force
    // the derived trust state to be scanned from the new snapshot.
    rmSync(join(testDir, "versions", "meta", "widgets", "tracker"), {
      recursive: true,
      force: true,
    });
    await notifyWorkspaceChangeAndWait({ type: "workspaceReset" });

    const freshness = await getWidgetFreshness(
      "meta",
      await widgetOf("tracker"),
    );
    expect(freshness.humanReviewed).toBe(false);
    expect(freshness.lastHumanTouch).toBeNull();
  });

  it("records-connected widgets never go stale by shell age", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "live-board", name: "Live Board", html: VALID_HTML,
      permissions: { records: { tasks: { read: true } } },
    });
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "static-note", name: "Static Note", html: VALID_HTML });

    const live = await widgetOf("live-board");
    const staticWidget = await widgetOf("static-note");
    expect(isRecordsConnected(live)).toBe(true);
    expect(isRecordsConnected(staticWidget)).toBe(false);

    // Force the age threshold to zero: anything with a stale basis is stale —
    // except records-connected widgets, which are carved out.
    const liveFreshness = await getWidgetFreshness("meta", live, { staleAgeDays: -1 });
    const staticFreshness = await getWidgetFreshness("meta", staticWidget, { staleAgeDays: -1 });
    expect(liveFreshness.stale).toBe(false);
    expect(staticFreshness.stale).toBe(true);
  });

  it("pre-history widgets derive age from stored updatedAt and are never reviewed", async () => {
    // Simulate a widget created before versioning: create normally, then wipe
    // its provenance + versions.
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "old-timer", name: "Old Timer", html: VALID_HTML });
    const { deleteWidgetProvenance } = await import("./widget-version-store.ts");
    await deleteWidgetProvenance("meta", "old-timer");
    rmSync(join(testDir, "versions", "meta", "widgets", "old-timer"), { recursive: true, force: true });
    evictWidgetFreshness("meta", "old-timer");

    const freshness = await getWidgetFreshness("meta", await widgetOf("old-timer"));
    expect(freshness.humanReviewed).toBe(false);
    expect(freshness.lastHumanTouch).toBeNull();
    expect(freshness.ageDays).not.toBeNull();
  });

  it("list surfaces carry freshness; review is absent from MCP", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: VALID_HTML });
    const list = await req(app, "GET", "/api/spaces/meta/widgets");
    expect(list.json.widgets[0].freshness).toBeDefined();
    expect(typeof list.json.widgets[0].freshness.stale).toBe("boolean");

    // The MCP surface must not expose a review tool (agents cannot self-review).
    const { mcpToolAuthorized } = await import("./mcp/tools.ts");
    // Sanity: the function exists and no worktable_review_widget scope entry exists.
    const toolsSource = await Bun.file(join(import.meta.dir, "mcp", "tools.ts")).text();
    expect(
      mcpToolAuthorized(
        "worktable_html_read",
        { action: "read", spaceId: "meta", htmlId: "tracker" },
        ["*"]
      )
    ).toBe(true);
    expect(toolsSource.includes("worktable_review_widget")).toBe(false);
  });
});
