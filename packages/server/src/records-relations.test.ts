import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { recordIndex } from "./record-index.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { recordsRouter } from "./routes/records.ts";

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
  return app;
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let workspaceDir: string;
let appDir: string;
let app: Hono;

async function seed() {
  await req(app, "POST", "/api/spaces", { name: "Meta" });
  await req(app, "POST", "/api/spaces/meta/records", { id: "projects", name: "Projects", fields: { title: { type: "string", required: true } } });
  await req(app, "POST", "/api/spaces/meta/records", {
    id: "tasks",
    name: "Tasks",
    fields: {
      title: { type: "string", required: true },
      project: { type: "relation", references: "projects", onDelete: "restrict" },
      reviewers: { type: "relation", references: "people", many: true, onDelete: "setNull" },
      mention: { type: "relation", references: "people", onDelete: "setNull" },
    },
  });
  await req(app, "POST", "/api/spaces/meta/records", { id: "people", name: "People", fields: { name: { type: "string", required: true } } });
  await req(app, "POST", "/api/spaces/meta/records/projects", { data: { title: "Atlas" } });
  await req(app, "POST", "/api/spaces/meta/records/people", { data: { name: "Ada" } });
  await req(app, "POST", "/api/spaces/meta/records/people", { data: { name: "Grace" } });
  await req(app, "POST", "/api/spaces/meta/records/tasks", {
    data: { title: "Fix bridge", project: "atlas", reviewers: ["ada", "grace"], mention: "ada" },
  });
}

describe("record relations: refs, delete policies, integrity warnings", () => {
  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worktable-rel-ws-"));
    appDir = mkdtempSync(join(tmpdir(), "worktable-rel-app-"));
    mkdirSync(join(workspaceDir, "spaces"), { recursive: true });
    setWorkspaceRootOverride(workspaceDir);
    setAppDirOverride(appDir);
    app = buildTestApp();
    recordIndex.start();
    await recordIndex.whenReady();
    await seed();
  });

  afterEach(() => {
    recordIndex.stop();
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    for (const dir of [workspaceDir, appDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("indexes relation edges and updates them when records change", async () => {
    expect(recordIndex.listInboundRefs("meta", "projects", "atlas")).toEqual([
      { fromCollection: "tasks", fromRecord: "fix-bridge", field: "project" },
    ]);
    expect(recordIndex.listInboundRefs("meta", "people", "grace")).toEqual([
      { fromCollection: "tasks", fromRecord: "fix-bridge", field: "reviewers" },
    ]);
    // Retargeting drops the old edge and adds the new one.
    await req(app, "POST", "/api/spaces/meta/records/projects", { data: { title: "Beacon" } });
    await req(app, "PATCH", "/api/spaces/meta/records/tasks/fix-bridge", { data: { project: "beacon" } });
    expect(recordIndex.listInboundRefs("meta", "projects", "atlas")).toEqual([]);
    expect(recordIndex.listInboundRefs("meta", "projects", "beacon")).toHaveLength(1);
  });

  it("onDelete restrict blocks deletion until the reference is removed", async () => {
    const blocked = await req(app, "DELETE", "/api/spaces/meta/records/projects/atlas");
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("onDelete: restrict");
    // Record still present.
    expect((await req(app, "GET", "/api/spaces/meta/records/projects/atlas")).status).toBe(200);

    await req(app, "PATCH", "/api/spaces/meta/records/tasks/fix-bridge", { data: { project: null } });
    const allowed = await req(app, "DELETE", "/api/spaces/meta/records/projects/atlas");
    expect(allowed.status).toBe(200);
  });

  it("onDelete setNull clears single references and filters id lists", async () => {
    const deleted = await req(app, "DELETE", "/api/spaces/meta/records/people/ada");
    expect(deleted.status).toBe(200);
    const task = (await req(app, "GET", "/api/spaces/meta/records/tasks/fix-bridge")).json.record;
    expect(task.data.mention).toBeNull();
    expect(task.data.reviewers).toEqual(["grace"]);
    expect(recordIndex.listInboundRefs("meta", "people", "ada")).toEqual([]);
  });

  it("delete policies also enforce from the file scan when the index is off", async () => {
    recordIndex.stop();
    const blocked = await req(app, "DELETE", "/api/spaces/meta/records/projects/atlas");
    expect(blocked.status).toBe(409);
    const deleted = await req(app, "DELETE", "/api/spaces/meta/records/people/grace");
    expect(deleted.status).toBe(200);
    const task = (await req(app, "GET", "/api/spaces/meta/records/tasks/fix-bridge")).json.record;
    expect(task.data.reviewers).toEqual(["ada"]);
  });

  it("surfaces dangling references as integrity warnings", async () => {
    // A relation with no declared policy defaults to none: deleting the target
    // leaves a dangling id, which must surface instead of rotting silently.
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "notes",
      name: "Notes",
      fields: { about: { type: "relation", references: "projects" } },
    });
    await req(app, "POST", "/api/spaces/meta/records/notes", { data: { title: "n1", about: "atlas" } });
    await req(app, "PATCH", "/api/spaces/meta/records/tasks/fix-bridge", { data: { project: null } });
    expect((await req(app, "DELETE", "/api/spaces/meta/records/projects/atlas")).status).toBe(200);

    const collection = await req(app, "GET", "/api/spaces/meta/records/notes");
    expect(collection.json.integrityWarnings).toEqual([
      { recordId: "n1", field: "about", target: "projects/atlas" },
    ]);
  });

  it("rejects schemas that combine required with onDelete: setNull", async () => {
    const res = await req(app, "POST", "/api/spaces/meta/records", {
      id: "strict",
      name: "Strict",
      fields: { owner: { type: "relation", references: "people", onDelete: "setNull", required: true } },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("required with onDelete: setNull");
  });

  it("deleting a record that does not exist is idempotent even with restrict refs to its id", async () => {
    // A task points (restrict) at a project id that was never created — a
    // dangling reference. Deleting the ghost id must succeed, not 409.
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Ghost ref", project: "ghost" } });
    const res = await req(app, "DELETE", "/api/spaces/meta/records/projects/ghost");
    expect(res.status).toBe(200);
  });

  it("setNull never wipes a field that no longer points at the deleted record", async () => {
    const { buildRecordFile } = await import("./record-store.ts");
    const { stringifyCanonicalYaml } = await import("./yaml.ts");
    const { writeFileSync } = await import("node:fs");
    await req(app, "POST", "/api/spaces/meta/records/people", { data: { name: "Bob" } });
    // Retarget mention ada -> bob by writing the file directly WITHOUT letting
    // the index ingest it (a simulated missed watcher event): the index still
    // holds the stale ada edge, but the file is the truth.
    const existing = (await req(app, "GET", "/api/spaces/meta/records/tasks/fix-bridge")).json.record;
    const retargeted = buildRecordFile({ id: "fix-bridge", collectionId: "tasks", data: { ...existing.data, mention: "bob" }, existing });
    writeFileSync(join(workspaceDir, "spaces", "meta", "records", "tasks", "fix-bridge.yaml"), stringifyCanonicalYaml(retargeted));

    const deleted = await req(app, "DELETE", "/api/spaces/meta/records/people/ada");
    expect(deleted.status).toBe(200);
    const task = (await req(app, "GET", "/api/spaces/meta/records/tasks/fix-bridge")).json.record;
    // The stale edge must not null the retargeted field; the list field (which
    // really did contain ada) is still filtered.
    expect(task.data.mention).toBe("bob");
    expect(task.data.reviewers).toEqual(["grace"]);
  });

  it("a stale restrict edge does not block a delete the files no longer justify", async () => {
    const { buildRecordFile } = await import("./record-store.ts");
    const { stringifyCanonicalYaml } = await import("./yaml.ts");
    const { writeFileSync } = await import("node:fs");
    await req(app, "POST", "/api/spaces/meta/records/projects", { data: { title: "Beacon" } });
    // Retarget project atlas -> beacon by writing the file directly WITHOUT
    // an ingest: the index keeps the stale restrict edge to atlas.
    const existing = (await req(app, "GET", "/api/spaces/meta/records/tasks/fix-bridge")).json.record;
    const retargeted = buildRecordFile({ id: "fix-bridge", collectionId: "tasks", data: { ...existing.data, project: "beacon" }, existing });
    writeFileSync(join(workspaceDir, "spaces", "meta", "records", "tasks", "fix-bridge.yaml"), stringifyCanonicalYaml(retargeted));

    // The stale edge must not veto: atlas is no longer referenced on disk.
    expect((await req(app, "DELETE", "/api/spaces/meta/records/projects/atlas")).status).toBe(200);
    // And a real reference still blocks.
    expect((await req(app, "DELETE", "/api/spaces/meta/records/projects/beacon")).status).toBe(409);
  });

  it("aborts the whole delete before applying any clears when one would fail validation", async () => {
    const { buildRecordCollectionSchema } = await import("./record-store.ts");
    const { stringifyCanonicalYaml } = await import("./yaml.ts");
    const { writeFileSync, mkdirSync: mkdir2 } = await import("node:fs");
    // A required+setNull schema can no longer be written through the API, but
    // files are canonical — hand-write one to simulate an external edit.
    const schema = buildRecordCollectionSchema({
      id: "strict",
      name: "Strict",
      fields: { title: { type: "string" }, owner: { type: "relation", references: "people", onDelete: "setNull", required: true } },
    });
    mkdir2(join(workspaceDir, "spaces", "meta", "records", "strict"), { recursive: true });
    writeFileSync(join(workspaceDir, "spaces", "meta", "records", "strict", "schema.yaml"), stringifyCanonicalYaml(schema));
    await recordIndex.refreshCollection("meta", "strict");
    const created = await req(app, "POST", "/api/spaces/meta/records/strict", { data: { title: "s1", owner: "ada" } });
    expect(created.status).toBe(201);

    // Deleting ada must fail (clearing strict/s1.owner violates required) and
    // must NOT have half-applied the policy: fix-bridge still mentions ada.
    const blocked = await req(app, "DELETE", "/api/spaces/meta/records/people/ada");
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("would fail validation");
    const task = (await req(app, "GET", "/api/spaces/meta/records/tasks/fix-bridge")).json.record;
    expect(task.data.mention).toBe("ada");
    expect(task.data.reviewers).toEqual(["ada", "grace"]);
  });

  it("fails closed when an unreadable file could hold a restricting reference", async () => {
    const { writeFileSync } = await import("node:fs");
    // A corrupt schema anywhere makes policies unknowable for every target.
    (await import("node:fs")).mkdirSync(join(workspaceDir, "spaces", "meta", "records", "broken"), { recursive: true });
    writeFileSync(join(workspaceDir, "spaces", "meta", "records", "broken", "schema.yaml"), "fields: [nope\n");
    await req(app, "PATCH", "/api/spaces/meta/records/tasks/fix-bridge", { data: { project: null } });
    const blocked = await req(app, "DELETE", "/api/spaces/meta/records/projects/atlas");
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toContain("Cannot verify delete policies");
    // Fixing the schema unblocks.
    rmSync(join(workspaceDir, "spaces", "meta", "records", "broken"), { recursive: true, force: true });
    expect((await req(app, "DELETE", "/api/spaces/meta/records/projects/atlas")).status).toBe(200);
  });

  it("a corrupt record only fails closed where restrict is at stake", async () => {
    const { writeFileSync } = await import("node:fs");
    // tasks declares restrict into projects and setNull into people; a corrupt
    // task file makes PROJECT deletes unverifiable, but people deletes proceed
    // (worst case there is a dangling id, surfaced as an integrity warning).
    writeFileSync(join(workspaceDir, "spaces", "meta", "records", "tasks", "corrupt.yaml"), "data: [broken\n");
    const projectDelete = await req(app, "DELETE", "/api/spaces/meta/records/projects/atlas");
    expect(projectDelete.status).toBe(409);
    expect(projectDelete.json.error).toContain("Cannot verify delete policies");
    expect((await req(app, "DELETE", "/api/spaces/meta/records/people/grace")).status).toBe(200);
  });

  it("integrity warnings say when they are incomplete", async () => {
    const ready = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(ready.json.integrityWarningsComplete).toBe(true);
    recordIndex.stop();
    const unknown = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(unknown.json.integrityWarnings).toEqual([]);
    expect(unknown.json.integrityWarningsComplete).toBe(false);
  });

  it("references to unparseable targets surface as integrity warnings", async () => {
    const { writeFileSync } = await import("node:fs");
    await req(app, "PATCH", "/api/spaces/meta/records/tasks/fix-bridge", { data: { project: "atlas" } });
    // Corrupt the referenced target and let the index ingest the failure.
    writeFileSync(join(workspaceDir, "spaces", "meta", "records", "projects", "atlas.yaml"), "title: [broken\n");
    await recordIndex.ingestFile("meta", "projects", "atlas");

    const collection = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(collection.json.integrityWarnings).toEqual([
      { recordId: "fix-bridge", field: "project", target: "projects/atlas" },
    ]);
  });

  it("a corrupt schema preserves last-known relation edges; a deleted schema drops them", async () => {
    const { writeFileSync } = await import("node:fs");
    expect(recordIndex.listInboundRefs("meta", "projects", "atlas")).toHaveLength(1);

    // Corrupt tasks/schema.yaml: the last good schema's edges must survive so
    // integrity warnings stay live while diagnostics surface the corruption.
    writeFileSync(join(workspaceDir, "spaces", "meta", "records", "tasks", "schema.yaml"), "fields: [broken\n");
    await recordIndex.refreshCollection("meta", "tasks");
    expect(recordIndex.listInboundRefs("meta", "projects", "atlas")).toHaveLength(1);

    // Deleting the schema means the collection declares no relations: edges go.
    rmSync(join(workspaceDir, "spaces", "meta", "records", "tasks", "schema.yaml"), { force: true });
    await recordIndex.refreshCollection("meta", "tasks");
    expect(recordIndex.listInboundRefs("meta", "projects", "atlas")).toEqual([]);
  });

  it("recomputes edges when a relation field is added to an existing schema", async () => {
    await req(app, "POST", "/api/spaces/meta/records", { id: "logs", name: "Logs", fields: { title: { type: "string" } } });
    await req(app, "POST", "/api/spaces/meta/records/logs", { data: { title: "l1", project: "atlas" } });
    expect(recordIndex.listInboundRefs("meta", "projects", "atlas")?.filter((r) => r.fromCollection === "logs")).toEqual([]);

    // Declaring the field afterwards must index the existing values.
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "logs",
      name: "Logs",
      fields: { title: { type: "string" }, project: { type: "relation", references: "projects" } },
    });
    await recordIndex.refreshCollection("meta", "logs");
    expect(recordIndex.listInboundRefs("meta", "projects", "atlas")?.filter((r) => r.fromCollection === "logs")).toEqual([
      { fromCollection: "logs", fromRecord: "l1", field: "project" },
    ]);
  });
});
