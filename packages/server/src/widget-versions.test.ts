import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import { getWidgetProvenance, getWidgetVersion, listWidgetVersions } from "./widget-version-store.ts";

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

const HTML_V1 = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-text:#111}html[data-theme="dark"]{--ad-bg:#111;--ad-text:#eee}body{background:var(--ad-bg);color:var(--ad-text)}</style></head><body><p>v1</p></body></html>`;
const HTML_V2 = HTML_V1.replace("<p>v1</p>", "<p>v2</p>");

const testDir = join(tmpdir(), `worktable-widget-versions-${Date.now()}`);
const appDir = join(tmpdir(), `worktable-widget-versions-app-${Date.now()}`);

describe("widget version history", () => {
  let app: Hono;

  beforeEach(async () => {
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    mkdirSync(join(testDir, "spaces"), { recursive: true });
    app = buildTestApp();
    await req(app, "POST", "/api/spaces", { name: "Meta" });
  });

  afterEach(() => {
    setSystemTime();
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
  });

  it("records create and update versions with before/after content and provenance", async () => {
    setSystemTime(new Date("2026-07-13T14:17:32.773Z"));
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "plans/q3", name: "Q3", html: HTML_V1 });
    await req(app, "PUT", "/api/spaces/meta/widgets/plans/q3", { name: "Q3 v2", html: HTML_V2, updatedBy: "user" });

    const versions = await listWidgetVersions("meta", "plans/q3");
    expect(versions.length).toBe(2);
    expect(versions[0]!.operation).toBe("update");
    expect(versions[1]!.operation).toBe("create");
    // Nested ids map to nested version dirs.
    expect(existsSync(join(testDir, "versions", "meta", "widgets", "plans", "q3"))).toBe(true);

    const full = await getWidgetVersion("meta", "plans/q3", versions[0]!.id);
    expect(full?.before?.content.html).toContain("<p>v1</p>");
    expect(full?.after.content.html).toContain("<p>v2</p>");
    expect(full?.after.content.widget.name).toBe("Q3 v2");
    expect(full?.after.content.widget.permissions).toBeDefined();

    const provenance = await getWidgetProvenance("meta", "plans/q3");
    expect(provenance?.versionId).toBe(versions[0]!.id);
    expect(versions[0]!.createdAt).toBe(versions[1]!.createdAt);
    expect(provenance?.contentHash).toBe(versions[0]!.after.contentHash);
  });

  it("dedupes idempotent rewrites (no version churn from identical regeneration)", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    await req(app, "PUT", "/api/spaces/meta/widgets/tracker", { name: "Tracker", html: HTML_V1 });
    const versions = await listWidgetVersions("meta", "tracker");
    expect(versions.length).toBe(1); // create only — identical PUT recorded nothing
  });

  it("metadata rename records a version (name is versionable content)", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    await req(app, "PATCH", "/api/spaces/meta/widgets/tracker", { name: "Tracker Renamed" });
    const versions = await listWidgetVersions("meta", "tracker");
    expect(versions.length).toBe(2);
    const full = await getWidgetVersion("meta", "tracker", versions[0]!.id);
    expect(full?.after.content.widget.name).toBe("Tracker Renamed");
  });

  it("marks a source-transition checkpoint when agent and human writes alternate", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1, createdBy: "agent" });
    await req(app, "PUT", "/api/spaces/meta/widgets/tracker", { name: "Tracker", html: HTML_V2, updatedBy: "user" });
    const versions = await listWidgetVersions("meta", "tracker");
    // The agent-created version was retroactively marked a meaningful checkpoint
    // when the human write transitioned the source category.
    const createVersion = versions.find((v) => v.operation === "create")!;
    expect(createVersion.checkpoint?.meaningful).toBe(true);
    expect(createVersion.checkpoint?.kind).toBe("source-transition");
  });

  it("records external edits on a versioned widget as updates with a reconstructed before", async () => {
    const { recordExternalWidgetChange } = await import("./widget-version-store.ts");
    const { writeFile } = await import("node:fs/promises");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    await writeFile(join(testDir, "spaces", "meta", "widgets", "tracker", "index.html"), HTML_V2, "utf8");
    await recordExternalWidgetChange("meta", "tracker");
    const versions = await listWidgetVersions("meta", "tracker");
    const external = versions[0]!;
    expect(external.operation).toBe("update");
    const full = await getWidgetVersion("meta", "tracker", external.id);
    // `before` is reconstructed from the last recorded version's after.
    expect(full?.before?.content.html).toContain("<p>v1</p>");
    expect(full?.after.content.html).toContain("<p>v2</p>");
  });

  it("stops serving version snapshots after the widget is deleted", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    const versions = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true")).json.versions;
    const vid = versions[0].id;
    await req(app, "DELETE", "/api/spaces/meta/widgets/tracker");
    expect((await req(app, "GET", `/api/spaces/meta/widgets/tracker/versions/${vid}`)).status).toBe(404);
    const content = await app.fetch(new Request(`http://localhost/api/spaces/meta/widgets/tracker/versions/${vid}/content`));
    expect(content.status).toBe(404);
    expect((await req(app, "POST", `/api/spaces/meta/widgets/tracker/versions/${vid}/restore`, {})).status).toBe(404);
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "tracker",
      name: "Tracker Reborn",
      html: HTML_V2,
    });
    const recreated = await req(app, "GET", "/api/spaces/meta/widgets/tracker/content?format=raw");
    expect(recreated.text).toContain("<p>v2</p>");
    const currentVersions = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true")).json.versions;
    expect(currentVersions.some((version: { id: string }) => version.id === vid)).toBe(false);
    expect((await req(app, "POST", `/api/spaces/meta/widgets/tracker/versions/${vid}/restore`, {})).status).toBe(404);
  });

  it("versions external file edits once, and skips watcher echo of internal writes", async () => {
    const { recordExternalWidgetChange } = await import("./widget-version-store.ts");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });

    // Echo of our own REST write: content hash matches provenance → no version.
    expect(await recordExternalWidgetChange("meta", "tracker")).toBeUndefined();
    expect((await listWidgetVersions("meta", "tracker")).length).toBe(1);

    // A real external edit records exactly one version, attributed filesystem.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(testDir, "spaces", "meta", "widgets", "tracker", "index.html"), HTML_V2, "utf8");
    const provenance = await recordExternalWidgetChange("meta", "tracker");
    expect(provenance?.source).toBe("filesystem");
    const versions = await listWidgetVersions("meta", "tracker");
    expect(versions.length).toBe(2);
    // Idempotent re-fire (second coalesced event after the record) is a no-op.
    expect(await recordExternalWidgetChange("meta", "tracker")).toBeUndefined();
    expect((await listWidgetVersions("meta", "tracker")).length).toBe(2);
  });

  it("records the prior content when an explicit-id create overwrites an existing widget", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    // Create-as-upsert with the same explicit id must not orphan the old HTML.
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker Reborn", html: HTML_V2 });
    const versions = await listWidgetVersions("meta", "tracker");
    expect(versions.length).toBe(2);
    const overwrite = versions[0]!;
    const full = await getWidgetVersion("meta", "tracker", overwrite.id);
    expect(full?.before?.content.html).toContain("<p>v1</p>");
    // The old content is restorable via the create version's after.
    const createVersion = versions[1]!;
    const restore = await req(app, "POST", `/api/spaces/meta/widgets/tracker/versions/${createVersion.id}/restore`, {});
    expect(restore.status).toBe(200);
    const raw = await req(app, "GET", "/api/spaces/meta/widgets/tracker/content?format=raw");
    expect(String(raw.text)).toContain("<p>v1</p>");
  });

  it("checkpoint reports failure when the widget HTML is missing", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    rmSync(join(testDir, "spaces", "meta", "widgets", "tracker", "index.html"), { force: true });
    const res = await req(app, "POST", "/api/spaces/meta/widgets/tracker/versions/checkpoint", { label: "x" });
    expect(res.status).toBe(404);
    expect(res.json.ok).toBeUndefined();
  });

  it("lists versions over REST (checkpoints-only default, ?all=true for everything)", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    await req(app, "PUT", "/api/spaces/meta/widgets/tracker", { name: "Tracker", html: HTML_V2 });
    const all = await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true");
    expect(all.status).toBe(200);
    expect(all.json.versions.length).toBe(2);
    // Content is stripped from list entries.
    expect(all.json.versions[0].after.content).toBeUndefined();
    const checkpoints = await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions");
    expect(checkpoints.json.versions.length).toBe(0); // none marked yet

    const one = await req(app, "GET", `/api/spaces/meta/widgets/tracker/versions/${all.json.versions[1].id}`);
    expect(one.status).toBe(200);
    expect(one.json.version.after.content.html).toContain("<p>v1</p>");
  });

  it("restores a version round-trip including permissions, bypassing the validation gate", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "plans/q3", name: "Q3", html: HTML_V1,
      permissions: { records: { tasks: { read: true } } },
    });
    await req(app, "PUT", "/api/spaces/meta/widgets/plans/q3", {
      name: "Q3 narrowed", html: HTML_V2,
      permissions: { records: {} },
    });
    const versions = (await req(app, "GET", "/api/spaces/meta/widgets/plans/q3/versions?all=true")).json.versions;
    const createVersion = versions.find((v: { operation: string }) => v.operation === "create");

    const restore = await req(app, "POST", `/api/spaces/meta/widgets/plans/q3/versions/${createVersion.id}/restore`, {});
    expect(restore.status).toBe(200);
    expect(restore.json.widget.name).toBe("Q3");
    // Permissions restored with the content — old HTML runs with ITS grants.
    expect(restore.json.widget.permissions.records.tasks.read).toBe(true);

    const html = await req(app, "GET", "/api/spaces/meta/widgets/plans/q3/content?format=raw");
    expect(html.status).toBe(200);
    // Restore recorded its own version, marked as a restore checkpoint chain.
    const after = (await req(app, "GET", "/api/spaces/meta/widgets/plans/q3/versions?all=true")).json.versions;
    expect(after.length).toBe(3);
    expect(after[0].source).toBe("version-restore");
  });

  it("creates manual checkpoints that survive the checkpoints-only filter", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    const cp = await req(app, "POST", "/api/spaces/meta/widgets/tracker/versions/checkpoint", { label: "Before big rework" });
    expect(cp.status).toBe(200);
    const checkpoints = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions")).json.versions;
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0].checkpoint.kind).toBe("manual");
    expect(checkpoints[0].checkpoint.label).toBe("Before big rework");
  });

  it("serves a rendered version snapshot without the runtime bridge", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    await req(app, "PUT", "/api/spaces/meta/widgets/tracker", { name: "Tracker", html: HTML_V2 });
    const versions = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true")).json.versions;
    const createVersion = versions.find((v: { operation: string }) => v.operation === "create");
    const res = await app.fetch(new Request(`http://localhost/api/spaces/meta/widgets/tracker/versions/${createVersion.id}/content?theme=dark`));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<p>v1</p>");
    expect(text).toContain('data-theme="dark"');
    expect(text).not.toContain("worktable.api.request"); // no runtime bridge injected
  });

  it("reserves the versions segment in nested ids but keeps it working flat", async () => {
    for (const id of ["a/versions", "versions/b"]) {
      const res = await req(app, "POST", "/api/spaces/meta/widgets", { id, name: "Bad", html: HTML_V1 });
      expect(res.status).toBe(400);
    }
    const flat = await req(app, "POST", "/api/spaces/meta/widgets", { id: "versions", name: "Legacy", html: HTML_V1 });
    expect(flat.status).toBe(201);
    expect((await req(app, "GET", "/api/spaces/meta/widgets/versions")).status).toBe(200);
    // Widget `versions`' own version list: /widgets/versions/versions
    expect((await req(app, "GET", "/api/spaces/meta/widgets/versions/versions?all=true")).json.versions.length).toBe(1);
  });

  it("retention prunes old non-checkpoint versions but keeps checkpoints forever", async () => {
    const { pruneNonCheckpointVersions } = await import("./version-store.ts");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    await req(app, "POST", "/api/spaces/meta/widgets/tracker/versions/checkpoint", { label: "Keep me" });
    for (let i = 0; i < 4; i++) {
      await req(app, "PUT", "/api/spaces/meta/widgets/tracker", { name: "Tracker", html: HTML_V1.replace("<p>v1</p>", `<p>rev ${i}</p>`) });
    }
    const before = await listWidgetVersions("meta", "tracker");
    expect(before.length).toBe(6); // create + checkpoint + 4 updates

    const pruned = await pruneNonCheckpointVersions("meta", "widgets", "tracker", 2);
    expect(pruned).toBe(3); // create + 2 oldest updates fall past keep=2
    const after = await listWidgetVersions("meta", "tracker");
    expect(after.length).toBe(3);
    // The manual checkpoint survives regardless of age; survivors are the
    // newest two non-checkpoint versions plus every checkpoint.
    expect(after.some((v) => v.checkpoint?.label === "Keep me")).toBe(true);
    expect(after.filter((v) => !v.checkpoint?.meaningful).length).toBe(2);
  });

  it("seeds a restorable baseline for a pre-tracking widget's first update", async () => {
    // Simulate a pre-versioning widget: create, then wipe provenance + history.
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "old-timer", name: "Old Timer", html: HTML_V1 });
    const { deleteWidgetProvenance } = await import("./widget-version-store.ts");
    await deleteWidgetProvenance("meta", "old-timer");
    rmSync(join(testDir, "versions", "meta", "widgets", "old-timer"), { recursive: true, force: true });

    // First tracked update after "upgrade".
    const put = await req(app, "PUT", "/api/spaces/meta/widgets/old-timer", { name: "Old Timer", html: HTML_V2 });
    expect(put.status).toBe(200);

    const versions = (await req(app, "GET", "/api/spaces/meta/widgets/old-timer/versions?all=true")).json.versions;
    expect(versions.length).toBe(2);
    const baseline = versions.find((v: { checkpoint?: { label?: string } }) => v.checkpoint?.label === "Pre-tracking baseline");
    expect(baseline).toBeDefined();
    expect(baseline.checkpoint.meaningful).toBe(true);

    // The ORIGINAL content is restorable via the baseline's `after`.
    const restore = await req(app, "POST", `/api/spaces/meta/widgets/old-timer/versions/${baseline.id}/restore`, {});
    expect(restore.status).toBe(200);
    const raw = await req(app, "GET", "/api/spaces/meta/widgets/old-timer/content?format=raw");
    expect(raw.status).toBe(200);
    expect(String(raw.text)).toContain("<p>v1</p>");
  });

  it("keeps recovery history when index.html is missing until the widget is explicitly deleted", async () => {
    const { recordExternalWidgetChange } = await import("./widget-version-store.ts");
    const { rm } = await import("node:fs/promises");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    // A transient/in-flight state: index.html gone but widget.yaml remains.
    await rm(join(testDir, "spaces", "meta", "widgets", "tracker", "index.html"), { force: true });
    await recordExternalWidgetChange("meta", "tracker");
    // NOT a delete → history and provenance survive.
    expect(await getWidgetProvenance("meta", "tracker")).toBeDefined();
    expect(existsSync(join(testDir, "versions", "meta", "widgets", "tracker"))).toBe(true);
    // Explicit deletion remains the escape hatch for this supported degraded
    // state and retires the generation that the watcher deliberately kept.
    expect((await req(app, "DELETE", "/api/spaces/meta/widgets/tracker")).status).toBe(200);
    expect((await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true")).status).toBe(404);
  });

  it("keeps history when only widget.yaml is deleted (directory + index.html intact)", async () => {
    const { recordExternalWidgetChange } = await import("./widget-version-store.ts");
    const { rm } = await import("node:fs/promises");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    // Only the metadata file is removed; authored index.html and the widget
    // directory remain. This is the corrupt/missing-metadata recovery scenario,
    // NOT a delete — history and provenance must survive so the user can restore.
    await rm(join(testDir, "spaces", "meta", "widgets", "tracker", "widget.yaml"), { force: true });
    await recordExternalWidgetChange("meta", "tracker");
    expect(await getWidgetProvenance("meta", "tracker")).toBeDefined();
    expect(existsSync(join(testDir, "versions", "meta", "widgets", "tracker"))).toBe(true);
  });

  it("retires history + drops provenance when a widget is deleted outside Worktable", async () => {
    const { recordExternalWidgetChange } = await import("./widget-version-store.ts");
    const { rm } = await import("node:fs/promises");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    // Delete the whole widget directory on disk (external `rm -rf`).
    await rm(join(testDir, "spaces", "meta", "widgets", "tracker"), { recursive: true, force: true });
    // Watcher fires for the removed files → coalesced external change.
    await recordExternalWidgetChange("meta", "tracker");
    expect(await getWidgetProvenance("meta", "tracker")).toBeUndefined();
    expect(existsSync(join(testDir, "versions", "meta", "widgets", "tracker"))).toBe(false);
    const { readdirSync } = await import("node:fs");
    const siblings = readdirSync(join(testDir, "versions", "meta", "widgets"));
    expect(siblings.some((name) => name.startsWith("tracker.deleted-"))).toBe(true);
  });

  it("lists versions for recovery even when widget.yaml is corrupt", async () => {
    const { writeFile } = await import("node:fs/promises");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    await writeFile(join(testDir, "spaces", "meta", "widgets", "tracker", "widget.yaml"), "{{{ not yaml", "utf8");
    const res = await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true");
    expect(res.status).toBe(200);
    expect(res.json.versions.length).toBe(1);
  });

  it("reads a version snapshot and rendered content even when widget.yaml is corrupt", async () => {
    const { writeFile } = await import("node:fs/promises");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    const versions = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true")).json.versions;
    // The recovery UI reads the snapshot (and renders it in the compare pane)
    // before offering Restore — both must survive corrupt metadata, or the gate
    // clears the selection and the user can never reach the Restore action.
    await writeFile(join(testDir, "spaces", "meta", "widgets", "tracker", "widget.yaml"), "{{{ not yaml", "utf8");
    const snap = await req(app, "GET", `/api/spaces/meta/widgets/tracker/versions/${versions[0].id}`);
    expect(snap.status).toBe(200);
    expect(snap.json.version.after.content.html).toContain("<p>v1</p>");
    const content = await req(app, "GET", `/api/spaces/meta/widgets/tracker/versions/${versions[0].id}/content`);
    expect(content.status).toBe(200);
    expect(content.text).toContain("<p>v1</p>");
  });

  it("restores from history even when widget.yaml is corrupt", async () => {
    const { writeFile } = await import("node:fs/promises");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    const versions = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true")).json.versions;
    // Corrupt the metadata — the exact filesystem accident restore recovers from.
    await writeFile(join(testDir, "spaces", "meta", "widgets", "tracker", "widget.yaml"), "{{{ not yaml", "utf8");
    const restore = await req(app, "POST", `/api/spaces/meta/widgets/tracker/versions/${versions[0].id}/restore`, {});
    expect(restore.status).toBe(200);
    const read = await req(app, "GET", "/api/spaces/meta/widgets/tracker");
    expect(read.status).toBe(200);
    expect(read.json.widget.name).toBe("Tracker");
  });

  it("captures prior HTML as `before` when an explicit-id create overwrites a corrupt-yaml widget", async () => {
    const { writeFile } = await import("node:fs/promises");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    // Unversioned edits land in index.html while widget.yaml goes corrupt — the
    // recovery state the create-as-upsert path must not silently overwrite.
    await writeFile(join(testDir, "spaces", "meta", "widgets", "tracker", "index.html"), HTML_V2, "utf8");
    await writeFile(join(testDir, "spaces", "meta", "widgets", "tracker", "widget.yaml"), "{{{ not yaml", "utf8");
    const HTML_V3 = HTML_V1.replace("<p>v1</p>", "<p>v3</p>");
    const create = await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V3 });
    expect(create.status).toBe(201);
    // The overwrite preserved the prior (v2) HTML as a restorable `before`.
    const versions = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true")).json.versions;
    const latest = await getWidgetVersion("meta", "tracker", versions[0].id);
    expect(latest?.before?.content.html).toContain("<p>v2</p>");
    expect(latest?.after.content.html).toContain("<p>v3</p>");
  });

  it("captures prior HTML when an AUTO-id create collides with a corrupt-yaml widget dropped from the dedupe pool", async () => {
    const { writeFile } = await import("node:fs/promises");
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V2 });
    // Corrupt widget.yaml → listWidgets omits it, so the dedupe pool no longer
    // knows "tracker" exists. A create WITHOUT an explicit id whose name slugs to
    // "tracker" derives the same id and would overwrite it.
    await writeFile(join(testDir, "spaces", "meta", "widgets", "tracker", "widget.yaml"), "{{{ not yaml", "utf8");
    const HTML_V3 = HTML_V1.replace("<p>v1</p>", "<p>v3</p>");
    const create = await req(app, "POST", "/api/spaces/meta/widgets", { name: "Tracker", html: HTML_V3 });
    expect(create.status).toBe(201);
    expect(create.json.widgetId).toBe("tracker");
    // The prior (v2) HTML is preserved as `before`, not silently dropped.
    const versions = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/versions?all=true")).json.versions;
    const latest = await getWidgetVersion("meta", "tracker", versions[0].id);
    expect(latest?.before?.content.html).toContain("<p>v2</p>");
    expect(latest?.after.content.html).toContain("<p>v3</p>");
  });

  it("serializes concurrent updates so a snapshot never mixes one writer's metadata with another's HTML", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", { id: "tracker", name: "Tracker", html: HTML_V1 });
    const htmlA = HTML_V1.replace("<p>v1</p>", "<p>AAA</p>");
    const htmlB = HTML_V1.replace("<p>v1</p>", "<p>BBB</p>");
    // Fire two updates to the SAME widget id concurrently. Without a per-widget
    // lock the per-file writes could interleave and the post-write snapshot could
    // capture NameA's metadata with BBB's HTML.
    await Promise.all([
      req(app, "PUT", "/api/spaces/meta/widgets/tracker", { name: "NameA", html: htmlA, updatedBy: "user" }),
      req(app, "PUT", "/api/spaces/meta/widgets/tracker", { name: "NameB", html: htmlB, updatedBy: "user" }),
    ]);
    // Every recorded snapshot is an internally consistent name↔html pair.
    const versions = await listWidgetVersions("meta", "tracker", { checkpointsOnly: false });
    for (const v of versions) {
      const snap = await getWidgetVersion("meta", "tracker", v.id);
      const name = snap!.after.content.widget.name;
      const html = snap!.after.content.html;
      if (name === "NameA") expect(html).toContain("AAA");
      if (name === "NameB") expect(html).toContain("BBB");
    }
    // The live on-disk widget is a consistent pair too (no mixed yaml + html).
    const widget = (await req(app, "GET", "/api/spaces/meta/widgets/tracker")).json.widget;
    const html = (await req(app, "GET", "/api/spaces/meta/widgets/tracker/content")).text;
    if (widget.name === "NameA") expect(html).toContain("AAA");
    if (widget.name === "NameB") expect(html).toContain("BBB");
  });
});
