import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { recordIndex } from "./record-index.ts";
import { buildRecordFile, writeRecord } from "./record-store.ts";
import { invalidateSearchIndex } from "./search-index.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { recordsRouter } from "./routes/records.ts";
import { searchRouter } from "./routes/search.ts";
import { ownerIdentity } from "./auth.ts";

function buildTestApp() {
  const app = new Hono();
  app.onError((err, c) => c.json({ error: err.message, code: "INTERNAL_ERROR" }, 500));
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity());
    return next();
  });
  app.route("/api/spaces", spacesRouter);
  app.route("/api/spaces/:spaceId/records", recordsRouter);
  app.route("/api/search", searchRouter);
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

const QUERY_BATTERY: unknown[] = [
  {},
  { includeArchived: true },
  { where: { status: "open" } },
  { where: { status: { in: ["open", "blocked"] } } },
  { where: { title: { contains: "bridge" } } },
  { where: { due: { gte: "2026-02-01", lte: "2026-12-31" } } },
  { where: { priority: { gt: 1 } }, orderBy: "priority", order: "desc" },
  { search: "bridge" },
  { orderBy: "priority" },
  { orderBy: "priority", order: "desc", limit: 2 },
  { limit: 1 },
];

async function seedCollection() {
  await req(app, "POST", "/api/spaces", { name: "Meta" });
  await req(app, "POST", "/api/spaces/meta/records", {
    id: "tasks",
    name: "Launch Tasks",
    fields: { title: { type: "string", required: true }, priority: { type: "number" }, due: { type: "date" } },
  });
  const tiedUpdatedAt = "2026-01-01T00:00:00.000Z";
  for (const record of [
    buildRecordFile({ id: "fix-the-bridge", collectionId: "tasks", data: { title: "Fix the bridge", status: "open", priority: 3, due: "2026-03-01" } }),
    buildRecordFile({ id: "paint-the-shed", collectionId: "tasks", data: { title: "Paint the shed", status: "done", priority: 3, due: "2026-01-15" } }),
    buildRecordFile({ id: "bridge-inspection", collectionId: "tasks", data: { title: "Bridge inspection", status: "blocked", priority: 10, due: "2026-06-30" } }),
  ]) {
    record.updatedAt = tiedUpdatedAt;
    await writeRecord("meta", record);
  }
  const archived = buildRecordFile({ id: "old-task", collectionId: "tasks", data: { title: "Old bridge memo", priority: 7 } });
  archived.archive = { archivedAt: new Date().toISOString(), archivedBy: "user" };
  await writeRecord("meta", archived);
  // One corrupt file on disk, excluded-but-diagnosed by both read paths.
  writeFileSync(join(workspaceDir, "spaces", "meta", "records", "tasks", "corrupt.yaml"), "data: [broken\n  x: {\n");
}

describe("record read flip (index vs file scan)", () => {
  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worktable-flip-ws-"));
    appDir = mkdtempSync(join(tmpdir(), "worktable-flip-app-"));
    mkdirSync(join(workspaceDir, "spaces"), { recursive: true });
    setWorkspaceRootOverride(workspaceDir);
    setAppDirOverride(appDir);
    app = buildTestApp();
    await seedCollection();
  });

  afterEach(() => {
    delete process.env["WORKTABLE_RECORDS_INDEX"];
    recordIndex.stop();
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    invalidateSearchIndex();
    for (const dir of [workspaceDir, appDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns identical query results from the index and the file scan", async () => {
    recordIndex.start();
    await recordIndex.whenReady();
    expect(recordIndex.isReady()).toBe(true);

    const viaIndex: unknown[] = [];
    for (const query of QUERY_BATTERY) {
      const res = await req(app, "POST", "/api/spaces/meta/records/tasks/query", query);
      expect(res.status).toBe(200);
      viaIndex.push(res.json.records);
    }

    process.env["WORKTABLE_RECORDS_INDEX"] = "0";
    const viaFiles: unknown[] = [];
    for (const query of QUERY_BATTERY) {
      const res = await req(app, "POST", "/api/spaces/meta/records/tasks/query", query);
      expect(res.status).toBe(200);
      viaFiles.push(res.json.records);
    }

    expect(viaIndex).toEqual(viaFiles);
    expect((viaFiles[0] as Array<{ id: string }>).map((record) => record.id)).toEqual([
      "bridge-inspection",
      "fix-the-bridge",
      "paint-the-shed",
    ]);
    expect((viaFiles[8] as Array<{ id: string }>).map((record) => record.id)).toEqual([
      "fix-the-bridge",
      "paint-the-shed",
      "bridge-inspection",
    ]);
    // Sanity: the battery actually exercised data (not all empty).
    expect((viaIndex[0] as unknown[]).length).toBe(3);
  });

  it("serves writes made through the API immediately from the index (read-your-writes)", async () => {
    recordIndex.start();
    await recordIndex.whenReady();
    const created = await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Just added", status: "open" } });
    expect(created.status).toBe(201);
    const query = await req(app, "POST", "/api/spaces/meta/records/tasks/query", { where: { title: "Just added" } });
    expect(query.json.records).toHaveLength(1);
  });

  it("serves diagnostics from the index that match the file-scan diagnostics", async () => {
    const fromFiles = await req(app, "GET", "/api/spaces/meta/records/tasks");
    recordIndex.start();
    await recordIndex.whenReady();
    const fromIndex = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(fromIndex.json.diagnostics).toHaveLength(1);
    expect(fromIndex.json.diagnostics[0].file).toBe("corrupt.yaml");
    expect(fromFiles.json.diagnostics.map((d: { file: string }) => d.file)).toEqual(
      fromIndex.json.diagnostics.map((d: { file: string }) => d.file),
    );
    expect(fromIndex.json.records.map((r: { id: string }) => r.id).sort()).toEqual(
      fromFiles.json.records.map((r: { id: string }) => r.id).sort(),
    );
  });

  it("keeps records searchable through /api/search in both modes, archived excluded", async () => {
    // File mode (MiniSearch indexes records).
    process.env["WORKTABLE_RECORDS_INDEX"] = "0";
    invalidateSearchIndex();
    const fileMode = await req(app, "GET", "/api/search?query=bridge");
    const fileHits = fileMode.json.results.filter((r: { type: string }) => r.type === "record").map((r: { recordId: string }) => r.recordId).sort();
    expect(fileHits).toEqual(["bridge-inspection", "fix-the-bridge"]);
    const commonFileMode = await req(
      app,
      "GET",
      "/api/search?query=bridge&documentMode=common",
    );
    expect(
      commonFileMode.json.results
        .filter((r: { type: string }) => r.type === "record")
        .map((r: { recordId: string }) => r.recordId)
        .sort(),
    ).toEqual(fileHits);

    // Index mode (FTS5 serves records; MiniSearch drops them on its next build).
    delete process.env["WORKTABLE_RECORDS_INDEX"];
    recordIndex.start();
    await recordIndex.whenReady();
    const created = await req(app, "POST", "/api/spaces/meta/records/tasks", {
      data: { title: "Modeflipbeacon review" },
    });
    expect(created.status).toBe(201);
    const indexedWrite = await req(
      app,
      "GET",
      "/api/search?query=modeflipbeacon&documentMode=common",
    );
    expect(indexedWrite.json.results).toContainEqual(
      expect.objectContaining({ type: "record", title: "Modeflipbeacon review" }),
    );

    // Falling back in the same process must not revive either dormant cache
    // from before the indexed write.
    process.env["WORKTABLE_RECORDS_INDEX"] = "0";
    for (const documentMode of ["", "&documentMode=common"]) {
      const fallback = await req(
        app,
        "GET",
        `/api/search?query=modeflipbeacon${documentMode}`,
      );
      expect(fallback.json.results).toContainEqual(
        expect.objectContaining({
          type: "record",
          title: "Modeflipbeacon review",
        }),
      );
    }

    // Index mode (FTS5 serves records; MiniSearch drops them on its next build).
    delete process.env["WORKTABLE_RECORDS_INDEX"];
    const indexMode = await req(app, "GET", "/api/search?query=bridge");
    const indexHits = indexMode.json.results.filter((r: { type: string }) => r.type === "record").map((r: { recordId: string }) => r.recordId).sort();
    expect(indexHits).toEqual(["bridge-inspection", "fix-the-bridge"]);
    // Collection-name search also resolves through the index.
    const byCollection = await req(app, "GET", "/api/search?query=launch");
    const collectionHits = byCollection.json.results.filter((r: { type: string }) => r.type === "record");
    expect(collectionHits.length).toBeGreaterThanOrEqual(3);
  });

  it("space-scoped search returns in-space records even when another space dominates the limit", async () => {
    // A second space whose records would exhaust a small result limit.
    await req(app, "POST", "/api/spaces", { name: "Noisy" });
    await req(app, "POST", "/api/spaces/noisy/records", { id: "notes", name: "Notes" });
    for (let i = 0; i < 5; i++) {
      await req(app, "POST", "/api/spaces/noisy/records/notes", { data: { title: `Bridge note ${i}` } });
    }
    recordIndex.start();
    await recordIndex.whenReady();

    const scoped = await req(app, "GET", "/api/search?query=bridge&spaceId=meta&maxResults=3");
    const recordHits = scoped.json.results.filter((r: { type: string }) => r.type === "record");
    expect(recordHits.length).toBeGreaterThanOrEqual(1);
    for (const hit of recordHits) expect(hit.spaceId).toBe("meta");
    // The FTS engine must have actually served this — a broken FTS query
    // would silently produce the same results via the scan fallback.
    expect(recordIndex.lastSearchEngine).toBe("fts");
  });

  it("stops serving a collection whose directory was deleted from disk", async () => {
    recordIndex.start();
    await recordIndex.whenReady();
    const before = await req(app, "POST", "/api/spaces/meta/records/tasks/query", {});
    expect(before.json.records.length).toBeGreaterThan(0);

    // Deleting a whole collection directory emits no per-file watcher events,
    // so the read path itself must heal the index.
    rmSync(join(workspaceDir, "spaces", "meta", "records", "tasks"), { recursive: true, force: true });
    const after = await req(app, "POST", "/api/spaces/meta/records/tasks/query", {});
    expect(after.json.records).toEqual([]);
    // The index rows are gone too, not just filtered.
    expect(recordIndex.listCollection("meta", "tasks", true)).toEqual([]);
    const collection = await req(app, "GET", "/api/spaces/meta/records/tasks");
    expect(collection.json.records).toEqual([]);
    expect(collection.json.diagnostics).toEqual([]);
  });
});
