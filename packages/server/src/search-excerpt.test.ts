import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { recordIndex } from "./record-index.ts";
import {
  COMMON_SEARCH_PROJECTION_BUDGET,
  invalidateSearchIndex,
  makeExcerpt,
  search,
  setSearchIndexRebuildHookForTests,
} from "./search-index.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { docsRouter } from "./routes/docs.ts";
import { recordsRouter } from "./routes/records.ts";
import { searchRouter } from "./routes/search.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import type { SearchResult } from "@worktable/types";
import { ownerIdentity } from "./auth.ts";
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts";
import { recordDocAlias, retireDocAlias } from "./doc-aliases.ts";

function buildTestApp() {
  const app = new Hono();
  app.onError((err, c) => c.json({ error: err.message, code: "INTERNAL_ERROR" }, 500));
  app.use("*", async (c, next) => {
    const scopes = c.req.header("x-test-scopes")?.split(",") ?? ["*"];
    c.set("identity", { ...ownerIdentity(), scopes });
    return next();
  });
  app.route("/api/spaces", spacesRouter);
  app.route("/api/spaces/:spaceId/docs", docsRouter);
  app.route("/api/spaces/:spaceId/records", recordsRouter);
  app.route("/api/spaces/:spaceId/widgets", widgetsRouter);
  app.route("/api/search", searchRouter);
  return app;
}

async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  scopes?: string[],
) {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(scopes ? { "x-test-scopes": scopes.join(",") } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function searchResults(
  app: Hono,
  query: string,
  options?: {
    scopes?: string[];
    documentMode?: "common";
    maxResults?: number;
  },
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ query });
  if (options?.documentMode) params.set("documentMode", options.documentMode);
  if (options?.maxResults) params.set("maxResults", String(options.maxResults));
  const res = await req(
    app,
    "GET",
    `/api/search?${params.toString()}`,
    undefined,
    options?.scopes,
  );
  expect(res.status).toBe(200);
  return res.json.results as SearchResult[];
}

let workspaceDir: string;
let appDir: string;
let app: Hono;

const LONG_TAIL = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(" ");

describe("search excerpts", () => {
  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worktable-excerpt-ws-"));
    appDir = mkdtempSync(join(tmpdir(), "worktable-excerpt-app-"));
    mkdirSync(join(workspaceDir, "spaces"), { recursive: true });
    setWorkspaceRootOverride(workspaceDir);
    setAppDirOverride(appDir);
    app = buildTestApp();

    await req(app, "POST", "/api/spaces", { name: "Meta" });
    // Markdown docs are seeded on disk (the REST route only accepts BlockNote).
    const docsDir = join(workspaceDir, "spaces", "meta", "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(
      join(docsDir, "pairing-notes.md"),
      `# Connection design\n\n${LONG_TAIL} The cross-process pairing lock prevents concurrent connects from racing. ${LONG_TAIL}`,
    );
    writeFileSync(join(docsDir, "zeppelin.md"), "# Zeppelin roadmap\n\nShort body without the query word.");
    await req(app, "PUT", "/api/spaces/meta/docs/richdoc", {
      content: [
        { type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Rich doc", styles: {} }] },
        { type: "paragraph", content: [{ type: "text", text: `${LONG_TAIL} the observatory dome rotates nightly ${LONG_TAIL}`, styles: {} }] },
      ],
    });
    invalidateSearchIndex();
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "tasks",
      name: "Launch Tasks",
      fields: { title: { type: "string", required: true } },
    });
    await req(app, "POST", "/api/spaces/meta/records/tasks", {
      data: { title: "Inspect the aqueduct", status: "open", notes: "the aqueduct span needs a survey" },
    });
    // Collection whose NAME is the only place a query term appears.
    await req(app, "POST", "/api/spaces/meta/records", {
      id: "audits",
      name: "Winter Surveys",
      fields: { title: { type: "string", required: true } },
    });
    await req(app, "POST", "/api/spaces/meta/records/audits", {
      data: { title: "Check the granary roof" },
    });
  });

  afterEach(() => {
    setSearchIndexRebuildHookForTests(null);
    recordIndex.stop();
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    invalidateSearchIndex();
    for (const dir of [workspaceDir, appDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a windowed excerpt around the matched term in a doc body", async () => {
    const results = await searchResults(app, "pairing");
    const hit = results.find((r) => r.path === "pairing-notes");
    expect(hit).toBeDefined();
    expect(hit!.excerpt).toContain("pairing lock prevents");
    // Match sits mid-document: the window is truncated on both sides.
    expect(hit!.excerpt!.startsWith("…")).toBe(true);
    expect(hit!.excerpt!.endsWith("…")).toBe(true);
    expect(hit!.excerpt!.length).toBeLessThan(200);
    // Markdown newlines are collapsed to plain text.
    expect(hit!.excerpt).not.toContain("\n");
  });

  it("locates the document term for prefix and fuzzy queries", async () => {
    for (const query of ["pair", "paring"]) {
      const results = await searchResults(app, query);
      const hit = results.find((r) => r.path === "pairing-notes");
      expect(hit?.excerpt).toContain("pairing lock");
    }
  });

  it("returns the whole short body without ellipses when the match is near the start", async () => {
    const results = await searchResults(app, "zeppelin");
    const hit = results.find((r) => r.path === "zeppelin");
    expect(hit).toBeDefined();
    // The title line is dropped from the excerpt body (it renders separately)
    // and markdown syntax never leaks into excerpts.
    expect(hit!.excerpt).toBe("Short body without the query word.");
  });

  it("strips markdown syntax from doc excerpts", async () => {
    const docsDir = join(workspaceDir, "spaces", "meta", "docs");
    writeFileSync(
      join(docsDir, "styleguide.md"),
      [
        "# Styleguide",
        "",
        "> Quoted **bold** and _underscored_ emphasis.",
        "- A [linked kraken](https://example.com/kraken) in a list",
        "- [ ] task with `inline code`",
        "",
        "See [[docs/other|the other doc]] and [[plain-target]].",
      ].join("\n"),
    );
    invalidateSearchIndex();

    const results = await searchResults(app, "kraken");
    const hit = results.find((r) => r.path === "styleguide");
    expect(hit).toBeDefined();
    const excerpt = hit!.excerpt!;
    // The window opens near the match, so assert on what sits around it.
    expect(excerpt).toContain("underscored emphasis.");
    expect(excerpt).toContain("A linked kraken in a list");
    expect(excerpt).toContain("task with inline code");
    expect(excerpt).toContain("the other doc");
    expect(excerpt).toContain("plain-target");
    for (const leak of ["#", "*", ">", "[", "](", "`", "https://example.com"]) {
      expect(excerpt).not.toContain(leak);
    }
  });

  it("still matches terms that only occur in link targets, without leaking them into the excerpt", async () => {
    // "voidberg" appears solely inside a link target: the raw markdown stays
    // indexed so the doc is found, while the displayed excerpt is built from
    // stripped text.
    const docsDir = join(workspaceDir, "spaces", "meta", "docs");
    writeFileSync(
      join(docsDir, "linked-doc.md"),
      "# Linked doc\n\nSetup steps live in the [guide](../voidberg-manual).",
    );
    invalidateSearchIndex();

    const results = await searchResults(app, "voidberg");
    const hit = results.find((r) => r.path === "linked-doc");
    expect(hit).toBeDefined();
    expect(hit!.excerpt).not.toContain("voidberg");
    expect(hit!.excerpt).not.toContain("](");
  });

  it("keeps blocks nested under the title heading in the index and excerpt", async () => {
    await req(app, "PUT", "/api/spaces/meta/docs/nested-doc", {
      content: [
        {
          type: "heading",
          props: { level: 1 },
          content: [{ type: "text", text: "Nested doc", styles: {} }],
          children: [
            { type: "paragraph", content: [{ type: "text", text: "The marmoset enclosure needs a new latch.", styles: {} }] },
          ],
        },
      ],
    });
    invalidateSearchIndex();

    const results = await searchResults(app, "marmoset");
    const hit = results.find((r) => r.path === "nested-doc");
    expect(hit).toBeDefined();
    expect(hit!.excerpt).toContain("marmoset enclosure");
    expect(hit!.excerpt).not.toContain("Nested doc");
  });

  it("does not open BlockNote excerpts with the title heading", async () => {
    await req(app, "PUT", "/api/spaces/meta/docs/tidal-report", {
      content: [
        { type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Tidal report", styles: {} }] },
        { type: "paragraph", content: [{ type: "text", text: "The tidal gauge readings were nominal.", styles: {} }] },
      ],
    });
    invalidateSearchIndex();

    const results = await searchResults(app, "tidal");
    const hit = results.find((r) => r.path === "tidal-report");
    expect(hit).toBeDefined();
    expect(hit!.title).toBe("Tidal report");
    expect(hit!.excerpt).toBe("The tidal gauge readings were nominal.");
  });

  it("extracts excerpts from BlockNote doc bodies", async () => {
    const results = await searchResults(app, "observatory");
    const hit = results.find((r) => r.path === "richdoc");
    expect(hit).toBeDefined();
    expect(hit!.excerpt).toContain("observatory dome rotates");
    expect(hit!.excerpt!.startsWith("…")).toBe(true);
  });


  it("keeps common search authorized, inert, and metadata-safe", async () => {
    const created = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "dashboards/lighthouse",
      name: "Lighthousebeacon status",
      html: [
        "<!doctype html><html><head><script>runtimephantom</script></head>",
        "<body><h1>Operations</h1>",
        "<p>The lighthousebeacon is visible to the team.</p>",
        "</body></html>",
      ].join(""),
    });
    expect(created.status).toBe(201);

    const docsDir = join(workspaceDir, "spaces", "meta", "docs");
    writeFileSync(join(docsDir, "same.md"), "# Markdown claim");
    writeFileSync(join(docsDir, "same.json"), "[]");
    writeFileSync(join(docsDir, "canvas.bin"), "opaque");
    writeFileSync(
      join(docsDir, "oversized.md"),
      `# Oversized reference\n\n${"x".repeat(600 * 1024)}`,
    );
    writeFileSync(
      join(docsDir, "legacy-visible.md"),
      "# Legacy visible\n\nThe lighthousebeacon appears in this Doc.",
    );
    await updateDocumentInventory("meta", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "future/canvas",
          format: { id: "future.canvas", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/canvas.bin" },
        },
      ],
    });

    const denied = await req(
      app,
      "GET",
      "/api/search?query=lighthousebeacon",
      undefined,
      ["documents:read"],
    );
    expect(denied.status).toBe(403);

    const legacy = await searchResults(app, "lighthousebeacon", {
      maxResults: 1,
    });
    expect(legacy).toEqual([
      expect.objectContaining({ path: "legacy-visible" }),
    ]);

    const commonWithoutDocuments = await req(
      app,
      "GET",
      "/api/search?query=lighthousebeacon&documentMode=common",
      undefined,
      ["search:read"],
    );
    expect(commonWithoutDocuments.status).toBe(403);

    const scopes = ["search:read", "documents:read"];
    const common = { scopes, documentMode: "common" as const };
    const visible = await searchResults(app, "lighthousebeacon", common);
    expect(visible).toContainEqual(
      expect.objectContaining({
        type: "doc",
        path: "dashboards/lighthouse",
        title: "Lighthousebeacon status",
        documentKind: "document",
        documentView: "html",
        format: { id: "worktable.html", sourceVersion: 1 },
        health: "supported",
        excerpt: expect.stringContaining("lighthousebeacon"),
      }),
    );
    expect(visible).toContainEqual(
      expect.objectContaining({
        type: "doc",
        path: "legacy-visible",
        documentKind: "document",
        documentView: "doc",
        format: { id: "worktable.markdown", sourceVersion: 1 },
        health: "supported",
      }),
    );
    expect(await searchResults(app, "runtimephantom", common)).toEqual([]);

    const unknown = await searchResults(app, "future/canvas", common);
    expect(unknown).toEqual([
      expect.objectContaining({
        path: "future/canvas",
        documentKind: "document",
        format: { id: "future.canvas", sourceVersion: 1 },
        health: "unsupported-format",
      }),
    ]);
    expect(unknown[0]).not.toHaveProperty("excerpt");

    const conflict = await searchResults(app, "same", common);
    expect(conflict).toEqual([
      expect.objectContaining({
        path: "same",
        documentKind: "conflict",
        health: "ambiguous",
      }),
    ]);
    expect(conflict[0]).not.toHaveProperty("excerpt");

    const oversized = await searchResults(app, "oversized", common);
    expect(oversized).toEqual([
      expect.objectContaining({
        path: "oversized",
        format: { id: "worktable.markdown", sourceVersion: 1 },
        health: "supported",
      }),
    ]);
    expect(oversized[0]).not.toHaveProperty("excerpt");

    const serialized = JSON.stringify([
      ...visible,
      ...unknown,
      ...conflict,
      ...oversized,
    ]);
    expect(serialized).not.toMatch(/documentId|relativePath|doc_[A-Za-z0-9_-]+/);

    const records = await searchResults(app, "aqueduct", common);
    expect(records.some((result) => result.type === "record")).toBe(true);
  });

  it("refreshes common search after document and Space lifecycle changes", async () => {
    const common = {
      scopes: ["search:read", "documents:read"],
      documentMode: "common" as const,
    };
    expect(await searchResults(app, "pairing", common)).toContainEqual(
      expect.objectContaining({ spaceId: "meta", path: "pairing-notes" }),
    );

    await recordDocAlias("meta", "pairing-notes", "richdoc", "exact");
    expect(await searchResults(app, "pairing", common)).not.toContainEqual(
      expect.objectContaining({ spaceId: "meta", path: "pairing-notes" }),
    );

    expect(await retireDocAlias("meta", "pairing-notes", "exact")).toBe(true);
    expect(await searchResults(app, "pairing", common)).toContainEqual(
      expect.objectContaining({ spaceId: "meta", path: "pairing-notes" }),
    );

    const docsDir = join(workspaceDir, "spaces", "meta", "docs");
    writeFileSync(join(docsDir, "future-live.bin"), "opaque future source");
    await updateDocumentInventory("meta", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "future/live-canvas",
          format: { id: "future.canvas", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/future-live.bin" },
        },
      ],
    });
    expect(await searchResults(app, "future/live-canvas", common)).toEqual([
      expect.objectContaining({
        spaceId: "meta",
        path: "future/live-canvas",
        health: "unsupported-format",
      }),
    ]);

    expect((await req(app, "POST", "/api/spaces/meta/archive", {})).status).toBe(
      200,
    );
    expect(await searchResults(app, "future/live-canvas", common)).toEqual([]);

    expect((await req(app, "POST", "/api/spaces/meta/restore", {})).status).toBe(
      200,
    );
    expect(await searchResults(app, "future/live-canvas", common)).toHaveLength(
      1,
    );

    expect((await req(app, "DELETE", "/api/spaces/meta")).status).toBe(204);
    expect(await searchResults(app, "future/live-canvas", common)).toEqual([]);
  });

  it("bounds aggregate text projection while retaining metadata discovery", async () => {
    const docsDir = join(workspaceDir, "spaces", "meta", "docs");
    for (
      let index = 0;
      index < COMMON_SEARCH_PROJECTION_BUDGET.maxDocuments;
      index += 1
    ) {
      writeFileSync(
        join(docsDir, `a-budget-${String(index).padStart(3, "0")}.md`),
        `# Budget ${index}\n\nProjected body ${index}.`,
      );
    }
    const created = await req(app, "POST", "/api/spaces", { name: "Zulu" });
    expect(created.status).toBe(201);
    writeFileSync(
      join(workspaceDir, "spaces", "zulu", "docs", "budget-sentinel.md"),
      "# Budget sentinel\n\nThis body is beyond the aggregate projection budget.",
    );

    const results = await searchResults(app, "budget-sentinel", {
      scopes: ["search:read", "documents:read"],
      documentMode: "common",
    });
    const sentinel = results.find(
      (result) =>
        result.spaceId === "zulu" && result.path === "budget-sentinel",
    );
    expect(sentinel).toMatchObject({
      documentKind: "document",
      documentView: "doc",
      title: "Budget Sentinel",
      format: { id: "worktable.markdown", sourceVersion: 1 },
      health: "supported",
    });
    expect(sentinel).not.toHaveProperty("excerpt");
  });

  it("builds readable record excerpts in both record-search modes", async () => {
    // File-scan mode (record index not started): records live in MiniSearch.
    const viaMiniSearch = await searchResults(app, "aqueduct");
    const msHit = viaMiniSearch.find((r) => r.type === "record");
    expect(msHit?.excerpt).toContain("aqueduct");
    expect(msHit?.excerpt).toContain("title: Inspect the aqueduct");
    // Readable key/value form, not raw JSON.
    expect(msHit?.excerpt).not.toContain("{");

    // Index mode: records come from SQLite FTS.
    recordIndex.start();
    await recordIndex.whenReady();
    invalidateSearchIndex();
    const viaFts = await searchResults(app, "aqueduct");
    const ftsHit = viaFts.find((r) => r.type === "record");
    expect(ftsHit?.excerpt).toContain("aqueduct");
    expect(ftsHit?.excerpt).not.toContain("{");
  });

  it("explains collection-name-only matches in the excerpt, in both modes", async () => {
    // "surveys" matches only the collection name, not any record field.
    const viaMiniSearch = await searchResults(app, "surveys");
    const msHit = viaMiniSearch.find((r) => r.type === "record");
    expect(msHit?.excerpt).toContain("Winter Surveys");

    recordIndex.start();
    await recordIndex.whenReady();
    invalidateSearchIndex();
    const viaFts = await searchResults(app, "surveys");
    const ftsHit = viaFts.find((r) => r.type === "record");
    expect(ftsHit?.excerpt).toContain("Winter Surveys");
  });

  it("discards an old-workspace rebuild that finishes after a reset", async () => {
    for (const documentAccess of ["legacy", "common"] as const) {
      const oldDocs = join(workspaceDir, "spaces", "meta", "docs");
      writeFileSync(
        join(oldDocs, "shared.md"),
        "# Shared title\n\nold workspace excerpt",
      );
      invalidateSearchIndex();

      let entered!: () => void;
      let release!: () => void;
      const rebuilding = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let blocked = false;
      setSearchIndexRebuildHookForTests(async () => {
        if (blocked) return;
        blocked = true;
        entered();
        await gate;
      });

      const inFlight = search("shared", { documentAccess });
      await rebuilding;

      const replacement = mkdtempSync(
        join(tmpdir(), "worktable-excerpt-replacement-"),
      );
      try {
        const replacementSpace = join(replacement, "spaces", "meta");
        mkdirSync(join(replacementSpace, "docs"), { recursive: true });
        writeFileSync(
          join(replacementSpace, "space.json"),
          readFileSync(
            join(workspaceDir, "spaces", "meta", "space.json"),
            "utf8",
          ),
        );
        writeFileSync(
          join(replacementSpace, "docs", "shared.md"),
          "# Shared title\n\nnew imported excerpt",
        );
        setWorkspaceRootOverride(replacement);
        invalidateSearchIndex();
        release();

        const result = await inFlight;
        expect(result[0]?.excerpt).toContain("new imported excerpt");
        expect(result[0]?.excerpt).not.toContain("old workspace excerpt");
      } finally {
        setWorkspaceRootOverride(workspaceDir);
        setSearchIndexRebuildHookForTests(null);
        invalidateSearchIndex();
        rmSync(replacement, { recursive: true, force: true });
      }
    }
  });
});

describe("makeExcerpt", () => {
  it("returns undefined for an empty body", () => {
    expect(makeExcerpt("", ["term"])).toBeUndefined();
    expect(makeExcerpt("   \n  ", ["term"])).toBeUndefined();
  });

  it("returns the whole short body without ellipses", () => {
    expect(makeExcerpt("a short body", ["short"])).toBe("a short body");
  });

  it("uses the earliest match across terms", () => {
    const body = `${LONG_TAIL} beta here ${LONG_TAIL} alpha there`;
    const excerpt = makeExcerpt(body, ["alpha", "beta"]);
    expect(excerpt).toContain("beta here");
  });

  it("matches case-insensitively", () => {
    const excerpt = makeExcerpt(`${LONG_TAIL} the PAIRING lock ${LONG_TAIL}`, ["pairing"]);
    expect(excerpt).toContain("PAIRING lock");
  });

  it("falls back to the body start when no term occurs in the body", () => {
    const excerpt = makeExcerpt(`${LONG_TAIL} ${LONG_TAIL}`, ["absent"]);
    expect(excerpt!.startsWith("filler0 filler1")).toBe(true);
    expect(excerpt!.endsWith(" …")).toBe(true);
  });
});
