import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { recordsRouter } from "./routes/records.ts";
import { widgetsRouter } from "./routes/widgets.ts";

function buildTestApp() {
  const app = new Hono();
  // Route behavior fixtures enter after the production identity boundary.
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity());
    await next();
  });
  app.onError((err, c) => c.json({ error: err.message, code: "INTERNAL_ERROR" }, 500));
  app.route("/api/spaces", spacesRouter);
  app.route("/api/spaces/:spaceId/records", recordsRouter);
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

const testDir = join(tmpdir(), `worktable-records-groundwork-${Date.now()}`);
const tasksDir = join(testDir, "spaces", "meta", "records", "tasks");

describe("records groundwork: query enforcement, tolerant reader, diagnostics", () => {
  let app: Hono;

  beforeEach(async () => {
    mkdirSync(join(testDir, "spaces"), { recursive: true });
    setWorkspaceRootOverride(testDir);
    app = buildTestApp();
    await req(app, "POST", "/api/spaces", { name: "Meta" });
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: { title: { type: "string", required: true }, status: { type: "enum", values: ["open", "done"] } },
    });
  });

  afterEach(() => {
    setWorkspaceRootOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("rejects invalid widget query bodies and enforces the limit cap on the widget bridge", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "task-app",
      name: "Task App",
      html: "<!doctype html><html><head></head><body></body></html>",
      permissions: { records: { tasks: { read: true } } },
    });
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "One" } });

    const overCap = await req(app, "POST", "/api/spaces/meta/widgets/task-app/records/tasks/query", { limit: 999999 });
    expect(overCap.status).toBe(400);
    expect(overCap.json.code).toBe("VALIDATION_ERROR");

    const junkOrder = await req(app, "POST", "/api/spaces/meta/widgets/task-app/records/tasks/query", { order: "DESC" });
    expect(junkOrder.status).toBe(400);

    const junkLimit = await req(app, "POST", "/api/spaces/meta/widgets/task-app/records/tasks/query", { limit: "all" });
    expect(junkLimit.status).toBe(400);

    const valid = await req(app, "POST", "/api/spaces/meta/widgets/task-app/records/tasks/query", { limit: 10, order: "asc", orderBy: "title" });
    expect(valid.status).toBe(200);
    expect(valid.json.records).toHaveLength(1);
  });

  it("returns 404 for queries against a missing space", async () => {
    const res = await req(app, "POST", "/api/spaces/nope/records/tasks/query", {});
    expect(res.status).toBe(404);
  });

  it("reads schemas from newer versions, skips validation for unknown field types, and preserves unknown keys on round-trip", async () => {
    const v2Schema = [
      "version: 2",
      'kind: "worktable.recordSchema"',
      "id: projects",
      "name: Projects",
      "viewsVersion: 3",
      "fields:",
      "  title:",
      "    type: string",
      "    required: true",
      "  owner:",
      "    type: relation",
      "    references: people",
      "    onDelete: setNull",
      'createdAt: "2026-01-01T00:00:00.000Z"',
      'updatedAt: "2026-01-01T00:00:00.000Z"',
      "createdBy: future-server",
      "",
    ].join("\n");
    mkdirSync(join(testDir, "spaces", "meta", "records", "projects"), { recursive: true });
    writeFileSync(join(testDir, "spaces", "meta", "records", "projects", "schema.yaml"), v2Schema);

    // The v2 collection is listed with its schema, not dropped.
    const list = await req(app, "GET", "/api/spaces/meta/records");
    const projects = list.json.collections.find((c: { id: string }) => c.id === "projects");
    expect(projects).toBeDefined();
    expect(projects.schema.version).toBe(2);

    // Records are writable: the unknown `relation` type skips type validation,
    // while `required` on a known type still enforces.
    const missingTitle = await req(app, "POST", "/api/spaces/meta/records/projects", { data: { owner: "someone" } });
    expect(missingTitle.status).toBe(400);
    const created = await req(app, "POST", "/api/spaces/meta/records/projects", { data: { title: "Atlas", owner: "someone" } });
    expect(created.status).toBe(201);

    // A schema upsert from this (older) server preserves the version and the
    // keys it doesn't understand instead of downgrading the file.
    const upsert = await req(app, "POST", "/api/spaces/meta/records", { id: "projects", name: "Projects (renamed)" });
    expect(upsert.status).toBe(200);
    const roundTripped = await readFile(join(testDir, "spaces", "meta", "records", "projects", "schema.yaml"), "utf8");
    expect(roundTripped).toContain("version: 2");
    expect(roundTripped).toContain("viewsVersion: 3");
    expect(roundTripped).toContain("onDelete:");
    expect(roundTripped).toContain("Projects (renamed)");
  });

  it("preserves unknown record-file keys and newer versions across updates", async () => {
    const v2Record = [
      "version: 2",
      'kind: "worktable.record"',
      "id: alpha",
      "collectionId: tasks",
      'createdAt: "2026-01-01T00:00:00.000Z"',
      'updatedAt: "2026-01-01T00:00:00.000Z"',
      "createdBy: future-server",
      "computedRank: 7",
      "data:",
      "  title: Alpha",
      "",
    ].join("\n");
    writeFileSync(join(tasksDir, "alpha.yaml"), v2Record);

    const read = await req(app, "GET", "/api/spaces/meta/records/tasks/alpha");
    expect(read.status).toBe(200);
    expect(read.json.record.version).toBe(2);

    const update = await req(app, "PATCH", "/api/spaces/meta/records/tasks/alpha", { data: { status: "open" } });
    expect(update.status).toBe(200);
    const yaml = await readFile(join(tasksDir, "alpha.yaml"), "utf8");
    expect(yaml).toContain("version: 2");
    expect(yaml).toContain("computedRank: 7");
    expect(yaml).toContain('status: "open"');
  });

  it("excludes unreadable record files from queries but surfaces them as diagnostics", async () => {
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Good" } });
    writeFileSync(join(tasksDir, "broken.yaml"), "title: [unclosed\n  - nope: {\n");

    const query = await req(app, "POST", "/api/spaces/meta/records/tasks/query", {});
    expect(query.status).toBe(200);
    expect(query.json.records).toHaveLength(1);

    const collection = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(collection.status).toBe(200);
    expect(collection.json.diagnostics).toHaveLength(1);
    expect(collection.json.diagnostics[0].file).toBe("broken.yaml");
    expect(collection.json.diagnostics[0].error).toBeTruthy();

    // A direct single-record read still reports the underlying parse error.
    const direct = await req(app, "GET", "/api/spaces/meta/records/tasks/broken");
    expect(direct.status).toBe(404);
    expect(direct.json.error).toContain("Failed to parse record");

    // Diagnostics clear once the file is fixed.
    writeFileSync(join(tasksDir, "broken.yaml"), [
      "version: 1",
      'kind: "worktable.record"',
      "id: broken",
      "collectionId: tasks",
      'createdAt: "2026-01-01T00:00:00.000Z"',
      'updatedAt: "2026-01-01T00:00:00.000Z"',
      "createdBy: user",
      "data:",
      "  title: Fixed",
      "",
    ].join("\n"));
    const after = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(after.json.diagnostics).toHaveLength(0);
    expect(after.json.records).toHaveLength(2);
  });

  it("drops cached diagnostics when the collection folder disappears", async () => {
    writeFileSync(join(tasksDir, "broken.yaml"), "title: [unclosed\n");
    const withBroken = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(withBroken.json.diagnostics).toHaveLength(1);

    rmSync(tasksDir, { recursive: true, force: true });
    const afterDelete = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(afterDelete.json.records).toHaveLength(0);
    expect(afterDelete.json.diagnostics).toHaveLength(0);
  });
});
