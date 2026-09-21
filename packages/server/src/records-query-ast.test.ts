import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const testDir = join(tmpdir(), `worktable-query-ast-${Date.now()}`);
let app: Hono;

async function query(body: unknown) {
  return req(app, "POST", "/api/spaces/meta/records/tasks/query", body);
}

async function seed() {
  await req(app, "POST", "/api/spaces", { name: "Meta" });
  await req(app, "POST", "/api/spaces/meta/records", { id: "projects", name: "Projects", fields: { title: { type: "string" }, status: { type: "select", values: ["active", "done"] } } });
  await req(app, "POST", "/api/spaces/meta/records", {
    id: "tasks",
    name: "Tasks",
    fields: {
      title: { type: "string", required: true },
      status: { type: "select", values: ["open", "blocked", "done"] },
      priority: { type: "number" },
      project: { type: "relation", references: "projects" },
      projects: { type: "relation", references: "projects", many: true },
      tags: { type: "multi_select", values: ["a", "b", "c"] },
    },
  });
  await req(app, "POST", "/api/spaces/meta/records/projects", { data: { title: "Atlas", status: "active" } });
  await req(app, "POST", "/api/spaces/meta/records/projects", { data: { title: "Beacon", status: "done" } });
  const tasks = [
    { title: "T1", status: "open", priority: 3, project: "atlas", projects: ["atlas", "beacon"], tags: ["a"] },
    { title: "T2", status: "open", priority: 1, project: "beacon", projects: ["atlas"], tags: ["a", "b"] },
    { title: "T3", status: "blocked", priority: 5, project: "atlas" },
    { title: "T4", status: "done", priority: 2 },
    { title: "T5", status: "open", priority: 4, project: "atlas", tags: ["c"] },
  ];
  for (const data of tasks) await req(app, "POST", "/api/spaces/meta/records/tasks", { data });
}

describe("record query AST", () => {
  beforeEach(async () => {
    mkdirSync(join(testDir, "spaces"), { recursive: true });
    setWorkspaceRootOverride(testDir);
    app = buildTestApp();
    await seed();
  });

  afterEach(() => {
    setWorkspaceRootOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("evaluates and/or/not trees with typed comparisons", async () => {
    const res = await query({
      where: {
        and: [
          { or: [{ field: "status", op: "eq", value: "open" }, { field: "status", op: "eq", value: "blocked" }] },
          { field: "priority", op: "gte", value: 3 },
          { not: { field: "title", op: "eq", value: "T5" } },
        ],
      },
      orderBy: [{ field: "priority", dir: "asc" }],
    });
    expect(res.status).toBe(200);
    expect(res.json.records.map((r: { data: { title: string } }) => r.data.title)).toEqual(["T1", "T3"]);
  });

  it("supports in, contains on arrays, and isEmpty", async () => {
    const inRes = await query({ where: { field: "status", op: "in", value: ["blocked", "done"] } });
    expect(inRes.json.records.map((r: { data: { title: string } }) => r.data.title).sort()).toEqual(["T3", "T4"]);

    const containsRes = await query({ where: { field: "tags", op: "contains", value: "b" } });
    expect(containsRes.json.records.map((r: { data: { title: string } }) => r.data.title)).toEqual(["T2"]);

    const emptyRes = await query({ where: { field: "project", op: "isEmpty" } });
    expect(emptyRes.json.records.map((r: { data: { title: string } }) => r.data.title)).toEqual(["T4"]);
  });

  it("distinguishes range boundaries, negative matches, scalar contains, and non-empty fields", async () => {
    const cases = [
      {
        where: { field: "priority", op: "gt", value: 4 },
        expected: ["T3"],
      },
      {
        where: { field: "priority", op: "gte", value: 5 },
        expected: ["T3"],
      },
      {
        where: { field: "priority", op: "lt", value: 2 },
        expected: ["T2"],
      },
      {
        where: { field: "priority", op: "lte", value: 2 },
        expected: ["T2", "T4"],
      },
      {
        where: { field: "status", op: "neq", value: "open" },
        expected: ["T3", "T4"],
      },
      {
        where: { field: "missing", op: "neq", value: "anything" },
        expected: ["T1", "T2", "T3", "T4", "T5"],
      },
      {
        where: { field: "title", op: "contains", value: "2" },
        expected: ["T2"],
      },
      {
        where: { field: "project", op: "isEmpty", value: false },
        expected: ["T1", "T2", "T3", "T5"],
      },
    ] as const;

    for (const { where, expected } of cases) {
      const res = await query({ where });
      expect(res.status).toBe(200);
      expect(
        res.json.records
          .map((record: { data: { title: string } }) => record.data.title)
          .sort(),
      ).toEqual([...expected].sort());
    }

    await req(app, "POST", "/api/spaces/meta/records/tasks", {
      data: { title: "T6", status: "open", tags: [] },
    });
    const multiValueNeq = await query({
      where: { field: "projects.status", op: "neq", value: "active" },
    });
    expect(
      multiValueNeq.json.records
        .map((record: { data: { title: string } }) => record.data.title)
        .sort(),
    ).toEqual(["T3", "T4", "T5", "T6"]);
    const multiValueEq = await query({
      where: { field: "projects.status", op: "eq", value: "active" },
    });
    expect(
      multiValueEq.json.records
        .map((record: { data: { title: string } }) => record.data.title)
        .sort(),
    ).toEqual(["T1", "T2"]);
  });

  it("has is exact array membership, never substring", async () => {
    // "art" vs "cart": contains would match both; has must match exactly.
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "T6", status: "open", tags: ["c"] } });
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "T7", status: "open" } });

    const hasA = await query({ where: { field: "tags", op: "has", value: "a" } });
    expect(hasA.json.records.map((r: { data: { title: string } }) => r.data.title).sort()).toEqual(["T1", "T2"]);

    // Membership is exact: "b" matches only the record whose ARRAY holds "b",
    // not other entries that merely contain the letter.
    const hasB = await query({ where: { field: "tags", op: "has", value: "b" } });
    expect(hasB.json.records.map((r: { data: { title: string } }) => r.data.title)).toEqual(["T2"]);

    // Scalars compare strictly (single relation ids).
    const hasProject = await query({ where: { field: "project", op: "has", value: "atlas" } });
    expect(hasProject.json.records.map((r: { data: { title: string } }) => r.data.title).sort()).toEqual(["T1", "T3", "T5"]);

    // Value is required and must be scalar.
    const missingValue = await query({ where: { field: "tags", op: "has" } });
    expect(missingValue.status).toBe(400);
    const arrayValue = await query({ where: { field: "tags", op: "has", value: ["a"] } });
    expect(arrayValue.status).toBe(400);
  });

  it("filters through one-hop relation paths", async () => {
    const res = await query({ where: { field: "project.status", op: "eq", value: "active" }, orderBy: [{ field: "priority" }] });
    expect(res.json.records.map((r: { data: { title: string } }) => r.data.title)).toEqual(["T1", "T5", "T3"]);
  });

  it("relation-path range comparisons use the target schema's field type", async () => {
    // Non-zero-padded datetimes defeat the untyped ISO sniffer (lexically
    // "2026-10-5" < "2026-9-1"), so only a schema-typed comparison gets this
    // right: Oct 5 > Sep 1.
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "projects",
      name: "Projects",
      fields: { title: { type: "string" }, status: { type: "select", values: ["active", "done"] }, deadline: { type: "datetime" } },
    });
    await req(app, "PATCH", "/api/spaces/meta/records/projects/atlas", { data: { deadline: "2026-10-5" } });
    await req(app, "PATCH", "/api/spaces/meta/records/projects/beacon", { data: { deadline: "2026-2-1" } });

    const res = await query({ where: { field: "project.deadline", op: "gt", value: "2026-9-1" }, orderBy: [{ field: "priority" }] });
    expect(res.status).toBe(200);
    expect(res.json.records.map((r: { data: { title: string } }) => r.data.title)).toEqual(["T1", "T5", "T3"]);
  });

  it("paginates with multi-sort keyset cursors (no gaps, no duplicates)", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await query({ orderBy: [{ field: "status" }, { field: "priority", dir: "desc" }], limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...res.json.records.map((r: { data: { title: string } }) => r.data.title));
      cursor = res.json.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // blocked < done < open; within status, priority desc
    expect(seen).toEqual(["T3", "T4", "T5", "T1", "T2"]);
  });

  it("expands relations into a side map and lists backlinks", async () => {
    const res = await query({
      where: { field: "status", op: "eq", value: "open" },
      expand: { project: ["title"] },
      orderBy: [{ field: "priority" }],
    });
    expect(res.json.expanded.projects.atlas.data).toEqual({ title: "Atlas" });
    expect(res.json.expanded.projects.beacon.data).toEqual({ title: "Beacon" });

    const backRes = await req(app, "POST", "/api/spaces/meta/records/projects/query", {
      backlinks: { collection: "tasks", field: "project" },
      orderBy: [{ field: "title" }],
    });
    expect(backRes.json.backlinks.atlas.sort()).toEqual(["t1", "t3", "t5"]);
    expect(backRes.json.backlinks.beacon).toEqual(["t2"]);
  });

  it("aggregates with groupBy and the full fn set", async () => {
    const res = await query({
      aggregate: {
        groupBy: "status",
        select: { n: { fn: "count" }, total: { fn: "sum", field: "priority" }, top: { fn: "max", field: "priority" } },
      },
    });
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.json.groups.map((g: { key: string }) => [g.key, g]));
    expect(byKey["open"]).toEqual({ key: "open", n: 3, total: 8, top: 4 });
    expect(byKey["blocked"]).toEqual({ key: "blocked", n: 1, total: 5, top: 5 });

    const flat = await query({ aggregate: { select: { n: { fn: "count" }, distinct: { fn: "unique", field: "status" }, avg: { fn: "avg", field: "priority" } } } });
    expect(flat.json.groups).toEqual([{ n: 5, distinct: 3, avg: 3 }]);
  });

  it("aggregate min/max compare with the field's schema type", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: {
        title: { type: "string", required: true },
        status: { type: "select", values: ["open", "blocked", "done"] },
        priority: { type: "number" },
        project: { type: "relation", references: "projects" },
        tags: { type: "multi_select", values: ["a", "b", "c"] },
        due: { type: "datetime" },
      },
    });
    // Non-padded datetimes: lexically "2026-10-5" < "2026-9-1"; typed
    // comparison must pick Oct 5 as the max.
    await req(app, "PATCH", "/api/spaces/meta/records/tasks/t1", { data: { due: "2026-9-1" } });
    await req(app, "PATCH", "/api/spaces/meta/records/tasks/t2", { data: { due: "2026-10-5" } });
    await req(app, "PATCH", "/api/spaces/meta/records/tasks/t3", { data: { due: "2026-2-1" } });
    const res = await query({ aggregate: { select: { latest: { fn: "max", field: "due" }, earliest: { fn: "min", field: "due" } } } });
    expect(res.status).toBe(200);
    expect(res.json.groups).toEqual([{ latest: "2026-10-5", earliest: "2026-2-1" }]);
  });

  it("projects data with select", async () => {
    const res = await query({ where: { field: "status", op: "eq", value: "done" }, select: ["title"] });
    expect(res.json.records[0].data).toEqual({ title: "T4" });
    expect(res.json.records[0].id).toBe("t4");
  });

  it("treats an empty where object as no filter alongside v2 features", async () => {
    const res = await query({ where: {}, orderBy: [{ field: "priority" }], limit: 2 });
    expect(res.status).toBe(200);
    expect(res.json.records).toHaveLength(2);
    expect(res.json.nextCursor).toBeDefined();
  });

  it("keeps legacy semantics for flat filters on fields named and/or/not", async () => {
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "Quirky", status: "open", not: false } });
    // Scalar value on a field named "not" is a legacy equality filter, not AST.
    const res = await query({ where: { not: false } });
    expect(res.status).toBe(200);
    expect(res.json.records.map((r: { data: { title: string } }) => r.data.title)).toEqual(["Quirky"]);
  });

  it("cross-collection reads follow the caller's includeArchived flag", async () => {
    const { buildRecordFile, writeRecord } = await import("./record-store.ts");
    const archived = buildRecordFile({ id: "old-project", collectionId: "projects", data: { title: "Old", status: "active" } });
    archived.archive = { archivedAt: new Date().toISOString(), archivedBy: "user" };
    await writeRecord("meta", archived);
    await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "T6", status: "open", project: "old-project" } });

    // Excluded by default: the archived target neither expands nor matches
    // relation-path predicates.
    const expand = await query({ where: { field: "title", op: "eq", value: "T6" }, expand: { project: true } });
    expect(expand.json.expanded.projects?.["old-project"]).toBeUndefined();
    const path = await query({ where: { and: [{ field: "title", op: "eq", value: "T6" }, { field: "project.status", op: "eq", value: "active" }] } });
    expect(path.json.records).toHaveLength(0);

    // Opting in surfaces it everywhere.
    const withArchived = await query({ where: { field: "title", op: "eq", value: "T6" }, expand: { project: true }, includeArchived: true });
    expect(withArchived.json.expanded.projects["old-project"].data.title).toBe("Old");
  });

  it("rejects malformed AST input loudly", async () => {
    expect((await query({ where: { field: "status", op: "matches", value: "x" } })).status).toBe(400);
    expect((await query({ where: { field: "status", op: "in", value: "open" } })).status).toBe(400);
    // {and: "nope"} is a LEGACY filter now (scalar value -> field named "and");
    // a tree-shaped and with malformed children is still rejected.
    expect((await query({ where: { and: [123] } })).status).toBe(400);
    // Empty connectives are rejected: vacuous truth would make {and: []} and
    // {or: []} silently behave in opposite ways.
    expect((await query({ where: { and: [] } })).status).toBe(400);
    expect((await query({ where: { or: [] } })).status).toBe(400);
    // Tree nodes with extra keys are rejected, never silently narrowed.
    expect((await query({ where: { and: [{ field: "status", op: "eq", value: "open" }], status: "open" } })).status).toBe(400);
    expect((await query({ where: { field: "status", op: "eq", value: "open", bogus: 1 } })).status).toBe(400);
    expect((await query({ cursor: "garbage!" })).status).toBe(400);
    // Legacy flat maps don't combine with v2 features.
    expect((await query({ where: { status: "open" }, expand: { project: true } })).status).toBe(400);
  });

  it("the widget bridge returns the full v2 result shape", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "detail-widget",
      name: "Detail Widget",
      html: "<!doctype html><html><head></head><body></body></html>",
      permissions: { records: { tasks: { read: true }, projects: { read: true } } },
    });
    const res = await req(app, "POST", "/api/spaces/meta/widgets/detail-widget/records/tasks/query", {
      where: { field: "status", op: "eq", value: "open" },
      expand: { project: true },
      orderBy: [{ field: "priority" }],
      limit: 2,
    });
    expect(res.status).toBe(200);
    expect(res.json.records).toHaveLength(2);
    expect(res.json.nextCursor).toBeDefined();
    expect(res.json.expanded.projects).toBeDefined();
  });

  it("gates widget cross-collection reach on target-collection read permission", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "task-widget",
      name: "Task Widget",
      html: "<!doctype html><html><head></head><body></body></html>",
      permissions: { records: { tasks: { read: true } } },
    });
    const bridge = "/api/spaces/meta/widgets/task-widget/records/tasks/query";
    const denied = await req(app, "POST", bridge, { expand: { project: true } });
    expect(denied.status).toBe(403);
    expect(denied.json.missingPermission).toBe("permissions.records.projects.read");
    const deniedPath = await req(app, "POST", bridge, { where: { field: "project.status", op: "eq", value: "active" } });
    expect(deniedPath.status).toBe(403);

    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "full-widget",
      name: "Full Widget",
      html: "<!doctype html><html><head></head><body></body></html>",
      permissions: { records: { tasks: { read: true }, projects: { read: true } } },
    });
    const allowed = await req(app, "POST", "/api/spaces/meta/widgets/full-widget/records/tasks/query", { expand: { project: true } });
    expect(allowed.status).toBe(200);
    expect(allowed.json.expanded.projects.atlas).toBeDefined();
  });
});
