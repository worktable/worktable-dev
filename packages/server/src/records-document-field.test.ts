import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import fc from "fast-check";
import { parseDocumentReference } from "@worktable/types";
import { docsRouter } from "./routes/docs.ts";
import { recordsRouter } from "./routes/records.ts";
import { spacesRouter } from "./routes/spaces.ts";
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts";

function buildTestApp() {
  const app = new Hono();
  // Route behavior fixtures enter after the production identity boundary.
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity());
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message, code: "INTERNAL_ERROR" }, 500));
  app.route("/api/spaces", spacesRouter);
  app.route("/api/spaces/:spaceId/docs", docsRouter);
  app.route("/api/spaces/:spaceId/records", recordsRouter);
  return app;
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const testDir = join(tmpdir(), `worktable-record-document-${Date.now()}`);

describe("portable record document fields", () => {
  let app: Hono;

  beforeEach(async () => {
    setWorkspaceRootOverride(testDir);
    ensureWorkspaceManifest();
    mkdirSync(join(testDir, "spaces"), { recursive: true });
    app = buildTestApp();
    await req(app, "POST", "/api/spaces", { name: "Meta" });
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "research",
      name: "Research",
      fields: {
        title: { type: "string", required: true },
        source: { type: "document" },
        relatedDocs: { type: "document", many: true },
      },
    });
  });

  afterEach(() => {
    setWorkspaceRootOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("normalizes scalar and many values and keeps schema field order portable", async () => {
    const created = await req(app, "POST", "/api/spaces/meta/records/research", {
      data: {
        title: "Portable paths",
        source: "/specs/Doc%20URLs.md",
        relatedDocs: ["notes/cafe\u0301.json", "/plans/q3"],
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.record.data.source).toBe("specs/Doc URLs");
    expect(created.json.record.data.relatedDocs).toEqual(["notes/café", "plans/q3"]);

    const recordYaml = await readFile(join(testDir, "spaces/meta/records/research/portable-paths.yaml"), "utf8");
    expect(recordYaml).not.toContain("http");
    expect(recordYaml).toContain('source: "specs/Doc URLs"');

    const schemaYaml = await readFile(join(testDir, "spaces/meta/records/research/schema.yaml"), "utf8");
    expect(schemaYaml.indexOf("  title:")).toBeLessThan(schemaYaml.indexOf("  source:"));
    expect(schemaYaml.indexOf("  source:")).toBeLessThan(schemaYaml.indexOf("  relatedDocs:"));
  });

  it("rejects origins, app routes, traversal, malformed encoding, and wrong cardinality", async () => {
    for (const source of [
      "https://example.com/specs/a",
      "/spaces/meta/docs/specs/a",
      "../secret",
      "folder/%2E%2E/secret",
      "folder\\secret",
      "folder/%ZZ",
      "notes/a?mode=edit",
      "notes/a#heading",
    ]) {
      const result = await req(app, "POST", "/api/spaces/meta/records/research", { data: { title: source, source } });
      expect(result.status).toBe(400);
    }
    const wrongMany = await req(app, "POST", "/api/spaces/meta/records/research", { data: { title: "Wrong", relatedDocs: "notes/one" } });
    expect(wrongMany.status).toBe(400);
  });

  it("rejects an empty array for a required many-document field", async () => {
    const schema = await req(app, "POST", "/api/spaces/meta/records", {
      id: "required-sources",
      name: "Required sources",
      fields: {
        title: { type: "string", required: true },
        sources: { type: "document", many: true, required: true },
        payload: { type: "json", required: true },
      },
    });
    expect(schema.status).toBe(201);

    const created = await req(app, "POST", "/api/spaces/meta/records/required-sources", {
      data: { title: "Missing sources", sources: [], payload: [] },
    });
    expect(created.status).toBe(400);
    expect(created.json.error).toBe("Missing required field: sources");

    const withEmptyJson = await req(app, "POST", "/api/spaces/meta/records/required-sources", {
      data: { title: "JSON arrays are values", sources: ["notes/source"], payload: [] },
    });
    expect(withEmptyJson.status).toBe(201);
    const updated = await req(app, "PATCH", `/api/spaces/meta/records/required-sources/${withEmptyJson.json.recordId}`, {
      data: { title: "Still valid" },
    });
    expect(updated.status).toBe(200);
    expect(updated.json.record.data.payload).toEqual([]);
  });

  it("keeps a directly file-authored malformed value readable", async () => {
    const created = await req(app, "POST", "/api/spaces/meta/records/research", { data: { title: "Drifted", source: "notes/good" } });
    const path = join(testDir, "spaces/meta/records/research", `${created.json.recordId}.yaml`);
    await writeFile(path, (await readFile(path, "utf8")).replace('source: "notes/good"', 'source: "https://host/doc"'));

    const read = await req(app, "GET", `/api/spaces/meta/records/research/${created.json.recordId}`);
    expect(read.status).toBe(200);
    expect(read.json.record.data.source).toBe("https://host/doc");
  });

  it("resolves titles, aliases, archive state, missing paths, and invalid file values", async () => {
    const doc = await req(app, "POST", "/api/spaces/meta/docs", {
      title: "Source Notes",
      content: [{ type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Canonical title", styles: {} }] }],
    });
    expect(doc.status).toBe(201);
    await req(app, "POST", `/api/spaces/meta/docs/${doc.json.path}/rename`, { newPath: "archive/renamed-notes" });
    await req(app, "POST", "/api/spaces/meta/docs/archive/renamed-notes/archive", {});

    const resolved = await req(app, "POST", "/api/spaces/meta/docs/resolve-references", {
      paths: [doc.json.path, "missing/well-formed", "https://invalid.example/doc"],
    });
    expect(resolved.status).toBe(200);
    expect(resolved.json.references[0]).toMatchObject({
      storedPath: doc.json.path,
      resolvedPath: "archive/renamed-notes",
      title: "Canonical title",
      state: "archived",
    });
    expect(resolved.json.references[1].state).toBe("missing");
    expect(resolved.json.references[2].state).toBe("invalid");

    const aliasedRecord = await req(app, "POST", "/api/spaces/meta/records/research", {
      data: {
        title: "Stored before rename",
        source: doc.json.path,
        relatedDocs: [doc.json.path],
      },
    });
    expect(aliasedRecord.status).toBe(201);
    const scalarFilter = await req(app, "POST", "/api/spaces/meta/records/research/query", {
      where: { and: [{ field: "source", op: "eq", value: "archive/renamed-notes" }] },
    });
    expect(scalarFilter.json.records.map((record: { id: string }) => record.id)).toContain(aliasedRecord.json.recordId);
    const flatScalarFilter = await req(app, "POST", "/api/spaces/meta/records/research/query", {
      where: { source: "archive/renamed-notes" },
    });
    expect(flatScalarFilter.json.records.map((record: { id: string }) => record.id)).toContain(aliasedRecord.json.recordId);
    const manyFilter = await req(app, "POST", "/api/spaces/meta/records/research/query", {
      where: { and: [{ field: "relatedDocs", op: "has", value: "archive/renamed-notes" }] },
    });
    expect(manyFilter.json.records.map((record: { id: string }) => record.id)).toContain(aliasedRecord.json.recordId);

    const currentRecord = await req(app, "POST", "/api/spaces/meta/records/research", {
      data: { title: "Stored after rename", source: "archive/renamed-notes" },
    });
    expect(currentRecord.status).toBe(201);
    const grouped = await req(app, "POST", "/api/spaces/meta/records/research/query", {
      where: { and: [{ field: "source", op: "eq", value: "archive/renamed-notes" }] },
      aggregate: { groupBy: "source", select: { count: { fn: "count" } } },
    });
    expect(grouped.status).toBe(200);
    expect(grouped.json.groups).toEqual([{ key: "archive/renamed-notes", count: 2 }]);
  });
});

describe("document reference path grammar", () => {
  it("rejects paths the document store sanitizer would rewrite", () => {
    expect(parseDocumentReference("notes/a..b")).toEqual({ error: "must not contain consecutive dots" });
    expect(parseDocumentReference("notes/a%2E%2Eb")).toEqual({ error: "must not contain consecutive dots" });
  });

  it("round-trips canonical Unicode segments", () => {
    fc.assert(fc.property(
      fc.array(
        fc.array(fc.constantFrom("a", "Z", "0", " ", "-", "_", "é", "東"), { minLength: 1, maxLength: 20 }).map((chars) => chars.join("")),
        { minLength: 1, maxLength: 5 }
      ),
      (segments) => {
        const path = segments.map((segment) => segment.normalize("NFC")).join("/");
        const result = parseDocumentReference(path);
        expect(result).toEqual({ path });
      }
    ));
  });
});
