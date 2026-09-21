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
import { setAppDirOverride } from "./app-storage.ts";
import { recordIndex } from "./record-index.ts";
import { buildRecordFile } from "./record-store.ts";
import { stringifyCanonicalYaml } from "./yaml.ts";

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
  return { status: res.status, text, json: contentType.includes("json") && text ? JSON.parse(text) : null, headers: res.headers };
}

const testDir = join(tmpdir(), `worktable-record-routes-${Date.now()}`);
const testAppDir = join(tmpdir(), `worktable-record-routes-app-${Date.now()}`);

describe("record REST routes", () => {
  let app: Hono;

  beforeEach(async () => {
    const spacesDir = join(testDir, "spaces");
    mkdirSync(spacesDir, { recursive: true });
    mkdirSync(testAppDir, { recursive: true });
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(testAppDir);
    app = buildTestApp();
    await req(app, "POST", "/api/spaces", { name: "Meta" });
  });

  afterEach(() => {
    recordIndex.stop();
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (existsSync(testAppDir)) rmSync(testAppDir, { recursive: true, force: true });
  });

  it("creates schemas, validates records, queries, updates, and deletes", async () => {
    const schemaRes = await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: {
        title: { type: "string", required: true },
        status: { type: "enum", values: ["open", "done"] },
      },
    });
    expect(schemaRes.status).toBe(201);

    const badRes = await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { status: "open" } });
    expect(badRes.status).toBe(400);

    const createRes = await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Build bridge", status: "open" } });
    expect(createRes.status).toBe(201);
    expect(createRes.json.record.id).toBe("build-bridge");

    const yaml = await readFile(join(testDir, "spaces", "meta", "records", "tasks", "build-bridge.yaml"), "utf8");
    expect(yaml).toContain('kind: "worktable.record"');

    const queryRes = await req(app, "POST", "/api/spaces/meta/records/tasks/query", { where: { status: "open" } });
    expect(queryRes.status).toBe(200);
    expect(queryRes.json.records).toHaveLength(1);

    const updateRes = await req(app, "PATCH", "/api/spaces/meta/records/tasks/build-bridge", { data: { status: "done" } });
    expect(updateRes.status).toBe(200);
    expect(updateRes.json.record.data.status).toBe("done");

    const deleteRes = await req(app, "DELETE", "/api/spaces/meta/records/tasks/build-bridge");
    expect(deleteRes.status).toBe(200);
  });

  it("serves the metadata read (includeRecords=false) without the records payload", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: { title: { type: "string", required: true } },
    });
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Row one" } });
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Row two" } });

    const metaRes = await req(app, "GET", "/api/spaces/meta/records/tasks?includeRecords=false");
    expect(metaRes.status).toBe(200);
    expect(metaRes.json.records).toBeUndefined();
    expect(metaRes.json.schema.id).toBe("tasks");
    expect(metaRes.json.diagnostics).toEqual([]);
    expect(Array.isArray(metaRes.json.integrityWarnings)).toBe(true);
    expect(typeof metaRes.json.integrityWarningsComplete).toBe("boolean");

    // The default read is unchanged: records ride along.
    const fullRes = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(fullRes.status).toBe(200);
    expect(fullRes.json.records).toHaveLength(2);

    // Diagnostics stay fresh on the metadata read: a file that turns
    // unreadable after a clean scan must show up without a full read.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(testDir, "spaces", "meta", "records", "tasks", "broken.yaml"), "::: not yaml {{{");
    const staleRes = await req(app, "GET", "/api/spaces/meta/records/tasks?includeRecords=false");
    expect(staleRes.status).toBe(200);
    expect(staleRes.json.records).toBeUndefined();
    expect(staleRes.json.diagnostics.length).toBeGreaterThan(0);
  });

  it("reports projection drift and reconciles missed creates without editing canonical YAML", async () => {
    await req(app, "POST", "/api/spaces/meta/records", { id: "tasks", name: "Tasks" });
    await req(app, "POST", "/api/spaces/meta/records/tasks", { id: "indexed", data: { title: "Indexed" } });
    recordIndex.start();
    await recordIndex.whenReady();

    const missed = buildRecordFile({ id: "missed", collectionId: "tasks", data: { title: "Missed" } });
    const missedPath = join(testDir, "spaces", "meta", "records", "tasks", "missed.yaml");
    const canonicalYaml = stringifyCanonicalYaml(missed);
    writeFileSync(missedPath, canonicalYaml);

    const health = await req(app, "GET", "/api/spaces/meta/records/tasks?includeRecords=false");
    expect(health.status).toBe(200);
    expect(health.json.projection).toMatchObject({ state: "drifted", canonicalFileCount: 2, indexedFileCount: 1 });

    const originalHealth = recordIndex.collectionHealth.bind(recordIndex);
    recordIndex.collectionHealth = async () => { throw new Error("query hot path must not rescan canonical files"); };
    try {
      const staleQuery = await req(app, "POST", "/api/spaces/meta/records/tasks/query", {});
      expect(staleQuery.json.records).toHaveLength(1);
      expect(staleQuery.json.warnings[0]).toContain("1 of 2 canonical files are indexed");
    } finally {
      recordIndex.collectionHealth = originalHealth;
    }

    const reconciled = await req(app, "POST", "/api/spaces/meta/records/tasks/reconcile");
    expect(reconciled.status).toBe(200);
    expect(reconciled.json.projection).toMatchObject({ state: "ready", canonicalFileCount: 2, indexedFileCount: 2, changedRecordCount: 1 });
    expect(await readFile(missedPath, "utf8")).toBe(canonicalYaml);

    const currentQuery = await req(app, "POST", "/api/spaces/meta/records/tasks/query", {});
    expect(currentQuery.json.records.map((record: { id: string }) => record.id).sort()).toEqual(["indexed", "missed"]);
    expect(currentQuery.json.warnings).toBeUndefined();
  });

  it("warns when a v2 query depends on a drifted referenced collection", async () => {
    await req(app, "POST", "/api/spaces/meta/records", { id: "projects", name: "Projects", fields: { title: { type: "string" } } });
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: { title: { type: "string" }, project: { type: "relation", references: "projects" } },
    });
    await req(app, "POST", "/api/spaces/meta/records/projects", { id: "atlas", data: { title: "Atlas" } });
    await req(app, "POST", "/api/spaces/meta/records/tasks", { id: "ship", data: { title: "Ship", project: "atlas" } });
    recordIndex.start();
    await recordIndex.whenReady();

    const projectPath = join(testDir, "spaces", "meta", "records", "projects", "atlas.yaml");
    writeFileSync(projectPath, (await readFile(projectPath, "utf8")).replace('title: "Atlas"', 'title: "Atlas changed"'));
    expect(await recordIndex.collectionHealth("meta", "tasks")).toMatchObject({ state: "ready" });
    expect(await recordIndex.collectionHealth("meta", "projects")).toMatchObject({ state: "drifted" });

    const result = await req(app, "POST", "/api/spaces/meta/records/tasks/query", { expand: { project: true } });
    expect(result.status).toBe(200);
    expect(result.json.warnings).toHaveLength(1);
    expect(result.json.warnings[0]).toContain('collection "projects"');
  });

  it("rejects strict creates (ifAbsent=true) for existing collections instead of upserting", async () => {
    const first = await req(app, "POST", "/api/spaces/meta/records?ifAbsent=true", {
      id: "tasks",
      name: "Tasks",
      description: "Original",
    });
    expect(first.status).toBe(201);

    const collision = await req(app, "POST", "/api/spaces/meta/records?ifAbsent=true", {
      name: "Tasks",
      description: "Impostor",
    });
    expect(collision.status).toBe(409);
    expect(collision.json.code).toBe("CONFLICT");

    // The existing schema is untouched by the rejected create.
    const read = await req(app, "GET", "/api/spaces/meta/records/tasks?includeRecords=false");
    expect(read.json.schema.description).toBe("Original");

    // Without the flag the route keeps its upsert contract.
    const upsert = await req(app, "POST", "/api/spaces/meta/records", { id: "tasks", name: "Tasks", description: "Updated" });
    expect(upsert.status).toBe(200);
    expect(upsert.json.collection.description).toBe("Updated");

    // A schemaless collection (records, no schema.yaml) is still an existing
    // collection: a strict create must not silently adopt it.
    const looseRecord = await req(app, "POST", "/api/spaces/meta/records/loose", { data: { note: "no schema here" } });
    expect(looseRecord.status).toBe(201);
    const adopt = await req(app, "POST", "/api/spaces/meta/records?ifAbsent=true", { id: "loose", name: "Loose" });
    expect(adopt.status).toBe(409);
    expect(adopt.json.code).toBe("CONFLICT");
  });

  it("archives and restores records through the REST routes", async () => {
    await req(app, "POST", "/api/spaces/meta/records", { id: "tasks", name: "Tasks" });
    const created = await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Keep me" } });
    const recordId = created.json.recordId;

    const archived = await req(app, "POST", `/api/spaces/meta/records/tasks/${recordId}/archive`, { reason: "done with it" });
    expect(archived.status).toBe(200);
    expect(archived.json.record.archive.archivedBy).toBe("user");
    expect(archived.json.record.archive.reason).toBe("done with it");

    // Archived records leave the default read and query, and return via includeArchived.
    const defaultList = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(defaultList.json.records).toHaveLength(0);
    const withArchived = await req(app, "GET", "/api/spaces/meta/records/tasks?includeArchived=true");
    expect(withArchived.json.records).toHaveLength(1);

    const restored = await req(app, "POST", `/api/spaces/meta/records/tasks/${recordId}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.json.record.archive).toBeNull();
    const afterRestore = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(afterRestore.json.records).toHaveLength(1);

    // Missing records 404 instead of minting archive state.
    const missing = await req(app, "POST", "/api/spaces/meta/records/tasks/nope/archive", {});
    expect(missing.status).toBe(404);
  });

  it("archives records whose data drifted schema-invalid (lifecycle writes skip data validation)", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "links",
      name: "Links",
      fields: { site: { type: "url" } },
    });
    const created = await req(app, "POST", "/api/spaces/meta/records/links", { data: { site: "https://ok.example" } });
    const recordId = created.json.recordId;

    // Simulate a direct file edit that leaves the record schema-invalid.
    const { readFile: read, writeFile: write } = await import("node:fs/promises");
    const path = join(testDir, "spaces", "meta", "records", "links", `${recordId}.yaml`);
    await write(path, (await read(path, "utf8")).replace('site: "https://ok.example"', 'site: "not a url"'));

    // Data edits still validate...
    const patch = await req(app, "PATCH", `/api/spaces/meta/records/links/${recordId}`, { data: { site: "still not a url" } });
    expect(patch.status).toBe(400);

    // ...but archive/restore only touch lifecycle metadata and must succeed.
    const archived = await req(app, "POST", `/api/spaces/meta/records/links/${recordId}/archive`, {});
    expect(archived.status).toBe(200);
    expect(archived.json.record.data.site).toBe("not a url");
    const restored = await req(app, "POST", `/api/spaces/meta/records/links/${recordId}/restore`);
    expect(restored.status).toBe(200);
  });

  it("restamps drifted identity on archive so the addressed file is the one written", async () => {
    await req(app, "POST", "/api/spaces/meta/records", { id: "tasks", name: "Tasks" });
    const created = await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Drifter" } });
    const recordId = created.json.recordId;

    // Simulate a manual edit that leaves a stale embedded identity.
    const { readFile: read, writeFile: write } = await import("node:fs/promises");
    const path = join(testDir, "spaces", "meta", "records", "tasks", `${recordId}.yaml`);
    await write(
      path,
      (await read(path, "utf8")).replace('collectionId: "tasks"', 'collectionId: "elsewhere"').replace(`id: "${recordId}"`, 'id: "someone-else"')
    );

    const archived = await req(app, "POST", `/api/spaces/meta/records/tasks/${recordId}/archive`, {});
    expect(archived.status).toBe(200);
    expect(archived.json.record.id).toBe(recordId);
    expect(archived.json.record.collectionId).toBe("tasks");
    // The addressed file was updated in place; nothing was written elsewhere.
    expect((await read(path, "utf8")).includes("archivedAt")).toBe(true);
    expect(existsSync(join(testDir, "spaces", "meta", "records", "elsewhere"))).toBe(false);
  });

  it("gates schema changes on existing rows (conforming-row check, per-record diagnostics)", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: { title: { type: "string", required: true }, estimate: { type: "string" } },
    });
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "One", estimate: "large" } });
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Two" } });

    // Retyping estimate string→number breaks record One; the change is
    // rejected and the diagnostic names the record.
    const retype = await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: { title: { type: "string", required: true }, estimate: { type: "number" } },
    });
    expect(retype.status).toBe(400);
    expect(retype.json.error).toContain("would break 1 existing record");
    expect(retype.json.error).toContain("one");

    // Adding a required field to a populated collection breaks every row.
    const addRequired = await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: { title: { type: "string", required: true }, estimate: { type: "string" }, owner: { type: "string", required: true } },
    });
    expect(addRequired.status).toBe(400);
    expect(addRequired.json.error).toContain("would break 2 existing record(s)");

    // An optional addition conforms and passes.
    const addOptional = await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: { title: { type: "string", required: true }, estimate: { type: "string" }, owner: { type: "string" } },
    });
    expect(addOptional.status).toBe(200);

    // Pre-existing drift (a file-edited row invalid under the OLD schema)
    // must not hold unrelated changes hostage.
    const { readFile: read, writeFile: write } = await import("node:fs/promises");
    const path = join(testDir, "spaces", "meta", "records", "tasks", "one.yaml");
    await write(path, (await read(path, "utf8")).replace('title: "One"', "title: 42"));
    const unrelated = await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: { title: { type: "string", required: true }, estimate: { type: "string" }, owner: { type: "string" }, notes: { type: "text" } },
    });
    expect(unrelated.status).toBe(200);

    // Unrelated drift cannot MASK new breakage on a different field: the
    // gate compares per field, not whole-schema first-error.
    const maskedRetype = await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: { title: { type: "string", required: true }, estimate: { type: "number" }, owner: { type: "string" }, notes: { type: "text" } },
    });
    expect(maskedRetype.status).toBe(400);
    expect(maskedRetype.json.error).toContain("estimate");

    // Metadata-only updates (name/description) never trigger the row scan.
    const rename = await req(app, "POST", "/api/spaces/meta/records", { id: "tasks", name: "Task List", description: "All the tasks" });
    expect(rename.status).toBe(200);
    expect(rename.json.collection.name).toBe("Task List");
  });

  it("gates the FIRST schema on a schemaless collection too", async () => {
    // Records exist, no schema.yaml.
    await req(app, "POST", "/api/spaces/meta/records/loose", { data: { note: "hello" } });

    // A first schema whose rules the existing rows violate is rejected.
    const breaking = await req(app, "POST", "/api/spaces/meta/records", {
      id: "loose",
      name: "Loose",
      fields: { note: { type: "number" } },
    });
    expect(breaking.status).toBe(400);
    expect(breaking.json.error).toContain("would break 1 existing record");

    // Strict create on the schemaless collection 409s (its contract) even
    // though the proposed schema would also fail the gate.
    const strict = await req(app, "POST", "/api/spaces/meta/records?ifAbsent=true", {
      id: "loose",
      name: "Loose",
      fields: { note: { type: "number" } },
    });
    expect(strict.status).toBe(409);

    // A conforming first schema passes (201: the schema is new even though
    // the collection's records predate it).
    const conforming = await req(app, "POST", "/api/spaces/meta/records", {
      id: "loose",
      name: "Loose",
      fields: { note: { type: "string" } },
    });
    expect(conforming.status).toBe(201);
  });

  it("round-trips unknown field types and unknown per-field keys through the route", async () => {
    // A schema echoed back by an older client (or written by a newer server)
    // may carry types and keys this build doesn't know — they must survive.
    const created = await req(app, "POST", "/api/spaces/meta/records", {
      id: "future",
      name: "Future",
      fields: {
        title: { type: "string", required: true, name: "Title" },
        vibe: { type: "sentiment-v3", threshold: 0.7 },
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.collection.fields.vibe.type).toBe("sentiment-v3");
    expect(created.json.collection.fields.vibe.threshold).toBe(0.7);
    expect(created.json.collection.fields.title.name).toBe("Title");

    // A metadata-only edit keeps the unknown field byte-identical.
    const renamed = await req(app, "POST", "/api/spaces/meta/records", {
      id: "future",
      name: "Future Things",
      fields: {
        title: { type: "string", required: true, name: "Title" },
        vibe: { type: "sentiment-v3", threshold: 0.7 },
      },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.collection.fields.vibe.threshold).toBe(0.7);
  });

  it("lets permitted widgets read and write records through the bridge", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "task-app",
      name: "Task App",
      html: "<!doctype html><html><head></head><body></body></html>",
      permissions: { records: { tasks: { read: true, create: true, update: true } } },
    });

    const createRes = await req(app, "POST", "/api/spaces/meta/widgets/task-app/records/tasks", { data: { title: "Widget task" } });
    expect(createRes.status).toBe(201);

    const queryRes = await req(app, "POST", "/api/spaces/meta/widgets/task-app/records/tasks/query", {});
    expect(queryRes.status).toBe(200);
    expect(queryRes.json.records).toHaveLength(1);

    const forbidden = await req(app, "DELETE", "/api/spaces/meta/widgets/task-app/records/tasks/widget-task");
    expect(forbidden.status).toBe(403);
  });
});
