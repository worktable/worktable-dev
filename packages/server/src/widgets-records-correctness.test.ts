import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { recordsRouter } from "./routes/records.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import { searchRouter } from "./routes/search.ts";
import { buildWidgetRuntimeScript } from "./widget-authoring.ts";
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
  app.route("/api/spaces/:spaceId/widgets", widgetsRouter);
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
  const contentType = res.headers.get("content-type") ?? "";
  return { status: res.status, text, json: contentType.includes("json") && text ? JSON.parse(text) : null, headers: res.headers };
}

const testDir = join(tmpdir(), `worktable-wr-correctness-${Date.now()}`);

describe("widgets + records correctness fixes", () => {
  let app: Hono;

  beforeEach(async () => {
    mkdirSync(join(testDir, "spaces"), { recursive: true });
    setWorkspaceRootOverride(testDir);
    app = buildTestApp();
    await req(app, "POST", "/api/spaces", { name: "Meta" });
  });

  afterEach(() => {
    setWorkspaceRootOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("orders numeric fields numerically, not lexicographically", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "items",
      name: "Items",
      fields: { name: { type: "string", required: true }, score: { type: "number" } },
    });
    for (const [name, score] of [["a", 2], ["b", 10], ["c", 1]] as const) {
      await req(app, "POST", "/api/spaces/meta/records/items", { id: name, data: { name, score } });
    }
    const res = await req(app, "POST", "/api/spaces/meta/records/items/query", { orderBy: "score", order: "asc" });
    expect(res.status).toBe(200);
    // Numeric order is 1, 2, 10 — a lexical sort would give "1", "10", "2".
    expect(res.json.records.map((r: { id: string }) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("compares date fields chronologically in range filters", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "events",
      name: "Events",
      fields: { title: { type: "string", required: true }, due: { type: "date" } },
    });
    for (const [id, due] of [["jan", "2026-01-01"], ["jun", "2026-06-01"], ["dec", "2026-12-01"]] as const) {
      await req(app, "POST", "/api/spaces/meta/records/events", { id, data: { title: id, due } });
    }
    const res = await req(app, "POST", "/api/spaces/meta/records/events/query", {
      where: { due: { gte: "2026-05-01", lte: "2026-07-01" } },
    });
    expect(res.status).toBe(200);
    // A Number()-based comparison would coerce ISO dates to NaN and return nothing.
    expect(res.json.records.map((r: { id: string }) => r.id)).toEqual(["jun"]);
  });

  it("treats malformed where operators as non-matching, not match-all", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "tags",
      name: "Tags",
      fields: { name: { type: "string", required: true } },
    });
    for (const id of ["x", "y", "z"]) {
      await req(app, "POST", "/api/spaces/meta/records/tags", { id, data: { name: id } });
    }
    // A valid `in` (array) matches the listed ids.
    const valid = await req(app, "POST", "/api/spaces/meta/records/tags/query", { where: { name: { in: ["x", "z"] } } });
    expect(valid.json.records.map((r: { id: string }) => r.id).sort()).toEqual(["x", "z"]);
    // A malformed `in` (string, not array) must match NOTHING, not the whole collection.
    const badIn = await req(app, "POST", "/api/spaces/meta/records/tags/query", { where: { name: { in: "x" } } });
    expect(badIn.json.records).toHaveLength(0);
    // A malformed `contains` (number, not string) likewise matches nothing.
    const badContains = await req(app, "POST", "/api/spaces/meta/records/tags/query", { where: { name: { contains: 5 } } });
    expect(badContains.json.records).toHaveLength(0);
  });

  it("excludes records with a missing field from range filters", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "scores",
      name: "Scores",
      fields: { title: { type: "string", required: true }, score: { type: "number" } },
    });
    await req(app, "POST", "/api/spaces/meta/records/scores", { id: "has", data: { title: "has", score: 50 } });
    await req(app, "POST", "/api/spaces/meta/records/scores", { id: "missing", data: { title: "missing" } });
    // An upper-bound filter must NOT include the record whose score is absent
    // (the empty-string fallback would otherwise sort below the bound).
    const lte = await req(app, "POST", "/api/spaces/meta/records/scores/query", { where: { score: { lte: 100 } } });
    expect(lte.json.records.map((r: { id: string }) => r.id)).toEqual(["has"]);
    // Lower-bound filter likewise excludes the missing-field record.
    const gte = await req(app, "POST", "/api/spaces/meta/records/scores/query", { where: { score: { gte: 0 } } });
    expect(gte.json.records.map((r: { id: string }) => r.id)).toEqual(["has"]);
  });

  it("accepts structured values for json fields and round-trips them", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "configs",
      name: "Configs",
      fields: { title: { type: "string", required: true }, payload: { type: "json" } },
    });
    const payload = { nested: { a: 1 }, list: [1, 2, 3] };
    const create = await req(app, "POST", "/api/spaces/meta/records/configs", { id: "c1", data: { title: "c1", payload } });
    expect(create.status).toBe(201);
    const read = await req(app, "GET", "/api/spaces/meta/records/configs/c1");
    expect(read.json.record.data.payload).toEqual(payload);
  });

  it("does not lose updates under concurrent patches to the same record", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "counters",
      name: "Counters",
      fields: { title: { type: "string", required: true } },
    });
    await req(app, "POST", "/api/spaces/meta/records/counters", { id: "c", data: { title: "c", a: 0, b: 0 } });
    await Promise.all([
      req(app, "PATCH", "/api/spaces/meta/records/counters/c", { data: { a: 1 } }),
      req(app, "PATCH", "/api/spaces/meta/records/counters/c", { data: { b: 1 } }),
    ]);
    const read = await req(app, "GET", "/api/spaces/meta/records/counters/c");
    // With the read-modify-write held under one lock, both patches survive.
    expect(read.json.record.data.a).toBe(1);
    expect(read.json.record.data.b).toBe(1);
  });

  it("derives unique ids for concurrent creates with the same title", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "notes",
      name: "Notes",
      fields: { title: { type: "string", required: true } },
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => req(app, "POST", "/api/spaces/meta/records/notes", { data: { title: "Same Title" } }))
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(results.map((r) => r.json.record.id));
    expect(ids.size).toBe(5);
    const list = await req(app, "POST", "/api/spaces/meta/records/notes/query", {});
    expect(list.json.records).toHaveLength(5);
  });

  it("indexes records so they surface in workspace search", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "people",
      name: "People",
      fields: { name: { type: "string", required: true } },
    });
    await req(app, "POST", "/api/spaces/meta/records/people", { id: "ada", data: { name: "Ada Lovelace" } });
    const res = await req(app, "GET", "/api/search?query=Lovelace");
    expect(res.status).toBe(200);
    const hit = res.json.results.find((r: { type: string; recordId?: string }) => r.type === "record" && r.recordId === "ada");
    expect(hit).toBeDefined();
    expect(hit.collectionId).toBe("people");
  });

  it("widens widget CSP connect-src only when the network permission is granted", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "offline-widget",
      name: "Offline",
      html: "<!doctype html><html><head></head><body></body></html>",
    });
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "online-widget",
      name: "Online",
      html: "<!doctype html><html><head></head><body></body></html>",
      permissions: { network: true },
    });

    const offline = await req(app, "GET", "/api/spaces/meta/widgets/offline-widget/content");
    const online = await req(app, "GET", "/api/spaces/meta/widgets/online-widget/content");
    const offlineCsp = offline.headers.get("content-security-policy") ?? "";
    const onlineCsp = online.headers.get("content-security-policy") ?? "";

    expect(offlineCsp).toContain("connect-src 'self';");
    expect(offlineCsp).not.toContain("https:");
    expect(onlineCsp).toContain("connect-src 'self' ws: wss: https:");
  });

  it("strips legacy workspace permissions sent by older clients instead of failing", async () => {
    const res = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "legacy-perms",
      name: "Legacy",
      html: "<!doctype html><html><head></head><body></body></html>",
      permissions: { workspaceRead: true, workspaceWrite: true, records: {} },
    });
    expect(res.status).toBe(201);
    const yaml = await readFile(join(testDir, "spaces", "meta", "widgets", "legacy-perms", "widget.yaml"), "utf8");
    expect(yaml).not.toContain("workspaceRead");
    expect(yaml).not.toContain("workspaceWrite");
  });

  it("aliases the legacy agentdash global to worktable for older widgets", () => {
    const script = buildWidgetRuntimeScript("meta", "some-widget");
    expect(script).toContain("window.worktable=");
    expect(script).toContain("window.agentdash=window.worktable");
  });
});
