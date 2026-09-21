import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
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

const testDir = join(tmpdir(), `worktable-schema-v2-${Date.now()}`);

describe("record schema v2: new field types, read-lift, version stamping", () => {
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

  it("stamps version 1 for v1-only fields and version 2 when v2 features are used", async () => {
    const v1 = await req(app, "POST", "/api/spaces/meta/records", {
      id: "plain",
      name: "Plain",
      fields: { title: { type: "string", required: true }, status: { type: "enum", values: ["a", "b"] } },
    });
    expect(v1.json.collection.version).toBe(1);

    const v2 = await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: {
        title: { type: "string", required: true },
        status: { type: "select", values: ["open", "done"] },
        tags: { type: "multi_select", values: ["red", "blue"] },
        project: { type: "relation", references: "projects", onDelete: "setNull" },
        owners: { type: "relation", references: "people", many: true },
        homepage: { type: "url" },
        contact: { type: "email" },
        estimate: { type: "number", unit: "hours" },
      },
    });
    expect(v2.json.collection.version).toBe(2);
    const yaml = await readFile(join(testDir, "spaces", "meta", "records", "tasks", "schema.yaml"), "utf8");
    expect(yaml).toContain("version: 2");
  });

  it("validates the new field types on write", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Tasks",
      fields: {
        status: { type: "select", values: ["open", "done"] },
        tags: { type: "multi_select", values: ["red", "blue"] },
        project: { type: "relation", references: "projects" },
        owners: { type: "relation", references: "people", many: true },
        homepage: { type: "url" },
        contact: { type: "email" },
      },
    });
    const cases: [Record<string, unknown>, number][] = [
      [{ status: "open" }, 201],
      [{ status: "nope" }, 400],
      [{ tags: ["red", "blue"] }, 201],
      [{ tags: ["red", "green"] }, 400],
      [{ tags: "red" }, 400],
      [{ project: "atlas-rebuild" }, 201],
      [{ project: "Not A Canonical Id!" }, 400],
      [{ owners: ["ada", "grace"] }, 201],
      [{ owners: "ada" }, 400],
      [{ homepage: "https://example.com/x" }, 201],
      [{ homepage: "not a url" }, 400],
      [{ contact: "ada@example.com" }, 201],
      [{ contact: "not-an-email" }, 400],
    ];
    for (const [data, expected] of cases) {
      const res = await req(app, "POST", "/api/spaces/meta/records/tasks", { data: { title: "t", ...data } });
      expect(res.status).toBe(expected);
    }
  });

  it("read-lifts v1 spellings: enum behaves as select, reference keeps its looser string contract", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "legacy",
      name: "Legacy",
      fields: {
        status: { type: "enum", values: ["open", "done"] },
        parent: { type: "reference", references: "legacy" },
      },
    });
    // enum value constraint still enforced (select semantics)
    expect((await req(app, "POST", "/api/spaces/meta/records/legacy", { data: { status: "nope" } })).status).toBe(400);
    expect((await req(app, "POST", "/api/spaces/meta/records/legacy", { data: { status: "open" } })).status).toBe(201);
    // v1 reference only ever required a string — non-canonical values keep working
    expect((await req(app, "POST", "/api/spaces/meta/records/legacy", { data: { parent: "Anything Goes Here" } })).status).toBe(201);
    // and the collection stays version 1: nothing about it needs v2
    const list = await req(app, "GET", "/api/spaces/meta/records");
    expect(list.json.collections.find((c: { id: string }) => c.id === "legacy").schema.version).toBe(1);
  });

  it("round-trips wellKnownType and never downgrades a v2 stamp on later edits", async () => {
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "people",
      name: "People",
      wellKnownType: "schema:Person",
      fields: { name: { type: "string", required: true }, email: { type: "email" } },
    });
    const first = await req(app, "GET", "/api/spaces/meta/records");
    const people = first.json.collections.find((c: { id: string }) => c.id === "people");
    expect(people.schema.wellKnownType).toBe("schema:Person");
    expect(people.schema.version).toBe(2);

    // An edit that only touches v1-compatible aspects keeps version 2 and the annotation.
    const renamed = await req(app, "POST", "/api/spaces/meta/records", { id: "people", name: "Folks" });
    expect(renamed.json.collection.version).toBe(2);
    expect(renamed.json.collection.wellKnownType).toBe("schema:Person");
  });
});
