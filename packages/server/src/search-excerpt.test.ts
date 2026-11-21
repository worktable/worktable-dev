import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { recordIndex } from "./record-index.ts";
import {
  invalidateSearchIndex,
  makeExcerpt,
  search,
  searchWithStatus,
  setSearchIndexRebuildHookForTests,
  setSearchWaitForTests,
  warmSearchIndex,
} from "./search-index.ts";
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts";
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
import { notifyWorkspaceChange } from "./workspace-events.ts";
import { keepSearchIndexOnDisk } from "./search-store.ts";
import * as storeModule from "./store.ts";

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

function ageDocuments(dir: string): void {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) ageDocuments(path);
    else if (entry.isFile()) utimesSync(path, hourAgo, hourAgo);
  }
}

let workspaceDir: string;
let appDir: string;
let app: Hono;

const LONG_TAIL = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(" ");

describe("search excerpts", () => {
  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worktable-excerpt-ws-"));
    appDir = mkdtempSync(join(tmpdir(), "worktable-excerpt-app-"));
    setWorkspaceRootOverride(workspaceDir);
    const manifest = ensureWorkspaceManifest();
    writeFileSync(join(workspaceDir, "worktable.workspace.json"), JSON.stringify({ ...manifest, version: 1 }));
    mkdirSync(join(workspaceDir, "spaces"), { recursive: true });
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
    setSearchWaitForTests(null);
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


  it.each([1, 2] as const)("keeps V%s common search authorized, inert, and metadata-safe", async (storageVersion) => {
    const manifest = ensureWorkspaceManifest();
    writeFileSync(join(workspaceDir, "worktable.workspace.json"), JSON.stringify({ ...manifest, version: storageVersion }));
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

  it("finds archived documents from the same index, marked and after the rest when asked", async () => {
    // Every answer here comes from a finished index, however slow the machine.
    setSearchWaitForTests(60_000);
    const find = async (query: string, extra = "") => {
      const res = await req(
        app,
        "GET",
        `/api/search?query=${encodeURIComponent(query)}&documentMode=common${extra}`,
      );
      expect(res.status).toBe(200);
      return res.json.results as SearchResult[];
    };
    const docsDir = join(workspaceDir, "spaces", "meta", "docs");
    writeFileSync(join(docsDir, "pairing-today.md"), "# Pairing today\n\nPairing rota for this week.");
    expect((await req(app, "POST", "/api/spaces", { name: "Zulu" })).status).toBe(201);
    writeFileSync(
      join(workspaceDir, "spaces", "zulu", "docs", "pairing-old.md"),
      "# Pairing, last year\n\nPairing notes from a shelved project.",
    );
    // A Record in the Space about to be archived that matches better than
    // any current one.
    await req(app, "POST", "/api/spaces/zulu/records", {
      id: "rota",
      name: "Pairing Rota",
      fields: { title: { type: "string", required: true } },
    });
    await req(app, "POST", "/api/spaces/zulu/records/rota", {
      data: { title: "Pairing pairing pairing" },
    });
    ageDocuments(join(workspaceDir, "spaces"));
    invalidateSearchIndex();
    expect(
      (await req(app, "POST", "/api/spaces/meta/docs/pairing-notes/archive", {})).status,
    ).toBe(200);
    expect((await req(app, "POST", "/api/spaces/zulu/archive", {})).status).toBe(200);

    // A search without archived work finds neither the archived Doc nor the
    // archived Space's.
    expect((await find("pairing")).map((result) => result.path)).toEqual(["pairing-today"]);

    // One with it reads no document again: both searches share one index.
    let reread = 0;
    setSearchIndexRebuildHookForTests(async ({ documents }) => {
      reread += documents;
    });
    const all = await find("pairing", "&includeArchived=true&archivedLast=true");
    expect(reread).toBe(0);
    // The current Doc leads; everything after it is archived work, whether
    // archived itself or in an archived Space.
    expect(all[0]).toEqual(expect.objectContaining({ path: "pairing-today" }));
    expect(all[0]?.archived).toBeUndefined();
    expect(all.slice(1).every((result) => result.archived === true)).toBe(true);
    expect(
      all
        .slice(1)
        .filter((result) => result.type === "doc")
        .map((result) => result.path)
        .sort(),
    ).toEqual(["pairing-notes", "pairing-old"]);

    // Current work keeps its place when the limit is short.
    expect(
      (await find("pairing", "&includeArchived=true&archivedLast=true&maxResults=1")).map(
        (result) => result.path,
      ),
    ).toEqual(["pairing-today"]);

    // Nor do archived Docs crowd out a current Record.
    recordIndex.start();
    await recordIndex.whenReady();
    await req(app, "POST", "/api/spaces/meta/records/tasks", {
      data: { title: "Pairing checklist" },
    });
    const withRecord = await find("pairing", "&includeArchived=true&archivedLast=true&maxResults=2");
    expect(withRecord.map((result) => [result.type, result.archived])).toEqual([
      ["doc", undefined],
      ["record", undefined],
    ]);
    // A better match in an archived Space doesn't take a current Record's
    // place, whether archived work is wanted last or not at all.
    for (const extra of ["&includeArchived=true&archivedLast=true", ""]) {
      expect(
        (await find("pairing", `&kinds=record&maxResults=1${extra}`)).map(
          (result) => result.spaceId,
        ),
      ).toEqual(["meta"]);
    }

    // Without the app's order, results say nothing more than before.
    const plain = await find("pairing", "&includeArchived=true");
    expect(plain).toHaveLength(5);
    expect(plain.every((result) => result.archived === undefined)).toBe(true);

    // A current Doc whose name differs from the archived one's only by case
    // shares its path: it is itself to a search without archived work, and
    // one of two claims to a search with it.
    writeFileSync(join(docsDir, "Pairing-Notes.md"), "# Pairing, again\n\nPairing afresh.");
    invalidateSearchIndex({ spaceId: "meta" });
    expect(await find("afresh")).toEqual([
      expect.objectContaining({ path: "Pairing-Notes", documentKind: "document" }),
    ]);
    expect(await find("pairing-notes", "&includeArchived=true&archivedLast=true")).toContainEqual(
      expect.objectContaining({ documentKind: "conflict" }),
    );
    expect(await find("afresh", "&includeArchived=true")).toEqual([]);
    rmSync(join(docsDir, "Pairing-Notes.md"));
    invalidateSearchIndex({ spaceId: "meta" });

    // Restored, the Doc is current again.
    expect(
      (await req(app, "POST", "/api/spaces/meta/docs/pairing-notes/restore", {})).status,
    ).toBe(200);
    expect(
      (await find("pairing"))
        .filter((result) => result.type === "doc")
        .map((result) => result.path)
        .sort(),
    ).toEqual(["pairing-notes", "pairing-today"]);
  });

  it("narrows a search to the kinds asked for", async () => {
    setSearchWaitForTests(60_000);
    const find = async (query: string, kinds: string) =>
      req(app, "GET", `/api/search?query=${query}&documentMode=common&kinds=${kinds}`);
    const created = await req(app, "POST", "/api/spaces/meta/widgets", {
      name: "Aqueduct map",
      html: "<h1>Aqueduct map</h1><p>Every aqueduct span, drawn.</p>",
    });
    expect(created.status).toBeLessThan(300);
    writeFileSync(
      join(workspaceDir, "spaces", "meta", "docs", "aqueduct-notes.md"),
      "# Aqueduct notes\n\nThe aqueduct needs paint.",
    );
    invalidateSearchIndex();

    const kindsOf = async (kinds: string) =>
      ((await find("aqueduct", kinds)).json.results as SearchResult[]).map((result) =>
        result.type === "record" ? "record" : (result.format?.id ?? "doc"),
      );
    expect((await kindsOf("record")).every((kind) => kind === "record")).toBe(true);
    expect(await kindsOf("record")).not.toHaveLength(0);
    expect(await kindsOf("doc")).toEqual(["worktable.markdown"]);
    expect(await kindsOf("html")).toEqual(["worktable.html"]);
    expect((await kindsOf("doc,html")).sort()).toEqual(["worktable.html", "worktable.markdown"]);
    expect((await find("aqueduct", "poem")).status).toBe(400);
  });

  it("indexes every document's content and re-reads only what changed", async () => {
    const docsDir = join(workspaceDir, "spaces", "meta", "docs");
    // More documents than the 128 whose content search once indexed.
    for (let index = 0; index < 140; index += 1) {
      writeFileSync(
        join(docsDir, `a-bulk-${String(index).padStart(3, "0")}.md`),
        `# Bulk ${index}\n\nProjected body ${index}.`,
      );
    }
    const created = await req(app, "POST", "/api/spaces", { name: "Zulu" });
    expect(created.status).toBe(201);
    writeFileSync(
      join(workspaceDir, "spaces", "zulu", "docs", "late-sentinel.md"),
      "# Late sentinel\n\nThe quetzalcoatl survey sits after every other document.",
    );
    // Documents modified moments before a read are read again at each sync
    // until their timestamps settle. Age them so unchanged ones are trusted.
    ageDocuments(join(workspaceDir, "spaces"));
    const reread = new Map<string, number>();
    setSearchIndexRebuildHookForTests(async ({ spaceId, documents }) => {
      reread.set(spaceId, (reread.get(spaceId) ?? 0) + documents);
    });
    const common = {
      scopes: ["search:read", "documents:read"],
      documentMode: "common" as const,
    };

    expect(await searchResults(app, "quetzalcoatl", common)).toEqual([
      expect.objectContaining({
        spaceId: "zulu",
        path: "late-sentinel",
        title: "Late sentinel",
        documentKind: "document",
        documentView: "doc",
        format: { id: "worktable.markdown", sourceVersion: 1 },
        health: "supported",
        excerpt: expect.stringContaining("quetzalcoatl survey"),
      }),
    ]);
    expect(reread.get("meta")).toBeGreaterThan(140);

    const { revision } = (await req(app, "GET", "/api/spaces/meta/docs/richdoc")).json as { revision: string };
    reread.clear();
    const edited = await req(app, "PUT", "/api/spaces/meta/docs/richdoc", {
      expectedRevision: revision,
      content: [
        { type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Rich doc", styles: {} }] },
        { type: "paragraph", content: [{ type: "text", text: "The narwhal census is complete.", styles: {} }] },
      ],
    });
    expect(edited.status).toBe(200);
    expect(await searchResults(app, "narwhal", common)).toEqual([
      expect.objectContaining({ spaceId: "meta", path: "richdoc" }),
    ]);
    expect(await searchResults(app, "observatory", common)).toEqual([]);
    expect(Object.fromEntries(reread)).toEqual({ meta: 1 });
  });

  it("finds a current Doc behind more archived matches than the index is first asked for", async () => {
    setSearchWaitForTests(60_000);
    const docsDir = join(workspaceDir, "spaces", "meta", "docs");
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(join(docsDir, `kumquat-${index}.md`), `# Kumquat ${index}\n\nKumquat kumquat kumquat.`);
    }
    writeFileSync(join(docsDir, "orchard.md"), "# Orchard\n\nOne kumquat tree, and many other trees besides.");
    for (let index = 0; index < 30; index += 1) {
      expect((await req(app, "POST", `/api/spaces/meta/docs/kumquat-${index}/archive`, {})).status).toBe(200);
    }
    // A search without documents:read leaves archived Docs out after ranking.
    expect((await searchResults(app, "kumquat", { maxResults: 1 })).map((result) => result.path)).toEqual([
      "orchard",
    ]);
  });

  it.skipIf(process.env["WORKTABLE_SEARCH_INDEX"] === "minisearch")(
    "searches a misspelled word as the nearest words the index holds, and nothing else", async () => {
    const common = { scopes: ["search:read", "documents:read"], documentMode: "common" as const };
    const answer = async (query: string, kinds?: string) => {
      const params = new URLSearchParams({ query, documentMode: "common" });
      if (kinds) params.set("kinds", kinds);
      const res = await req(app, "GET", `/api/search?${params}`, undefined, common.scopes);
      expect(res.status).toBe(200);
      return res.json as { results: SearchResult[]; corrected?: string[] };
    };

    // Two letters swapped, and one missing from the last word while typing.
    for (const query of ["observatroy", "the obsrvat"]) {
      const found = await answer(query);
      expect(found.results.map((result) => result.path)).toEqual(["richdoc"]);
      expect(found.results[0]!.excerpt).toContain("observatory dome");
      expect(found.corrected?.some((word) => "observatory".startsWith(word))).toBe(true);
    }
    // Every other word still has to match.
    expect((await answer("pairing locck")).results.map((result) => result.path)).toEqual(["pairing-notes"]);
    expect((await answer("zeppelin locck")).results).toEqual([]);

    // A word that matches as typed is never changed.
    expect(await answer("zeppelin")).toEqual({ results: [expect.objectContaining({ path: "zeppelin" })] });
    // Short words, numbers and IDs are never corrected.
    for (const query of ["dme", "pairing2", "observ_atroy"]) {
      expect(await answer(query)).toEqual({ results: [] });
    }
    // Words are named only as results show them.
    expect(await answer("observatroy", "record")).toEqual({ results: [] });
  });

  it.skipIf(process.env["WORKTABLE_SEARCH_INDEX"] === "minisearch")(
    "keeps its index on disk, so a restart re-reads only what changed", async () => {
    keepSearchIndexOnDisk(true);
    try {
      const docsDir = join(workspaceDir, "spaces", "meta", "docs");
      writeFileSync(join(docsDir, "gone-soon.md"), "# Gone soon\n\nThe marmoset enclosure.");
      ageDocuments(join(workspaceDir, "spaces"));
      const common = { scopes: ["search:read", "documents:read"], documentMode: "common" as const };
      expect(await searchResults(app, "zeppelin", common)).toEqual([
        expect.objectContaining({ path: "zeppelin" }),
      ]);
      const derived = join(appDir, "derived");
      expect(readdirSync(derived).some((key) => existsSync(join(derived, key, "search.sqlite")))).toBe(true);

      // While the server is down, one document changes and one is deleted.
      keepSearchIndexOnDisk(false);
      writeFileSync(join(docsDir, "zeppelin.md"), "# Zeppelin roadmap\n\nThe dirigible hangar opens.");
      rmSync(join(docsDir, "gone-soon.md"));
      invalidateSearchIndex();
      keepSearchIndexOnDisk(true);

      const reread = new Map<string, number>();
      setSearchIndexRebuildHookForTests(async ({ spaceId, documents }) => {
        if (documents > 0) reread.set(spaceId, (reread.get(spaceId) ?? 0) + documents);
      });
      expect(await searchResults(app, "dirigible", common)).toEqual([
        expect.objectContaining({ path: "zeppelin", excerpt: "The dirigible hangar opens." }),
      ]);
      expect(Object.fromEntries(reread)).toEqual({ meta: 1 });
      expect(await searchResults(app, "marmoset", common)).toEqual([]);
      expect(await searchResults(app, "observatory", common)).toEqual([
        expect.objectContaining({ path: "richdoc" }),
      ]);

      // A Space archived while the server is down stays out of a search
      // that answers before the Spaces are listed again.
      expect((await req(app, "POST", "/api/spaces", { name: "Zulu" })).status).toBe(201);
      writeFileSync(join(workspaceDir, "spaces", "zulu", "docs", "kiwi.md"), "# Kiwi\n\nThe kiwi orchard.");
      ageDocuments(join(workspaceDir, "spaces"));
      invalidateSearchIndex();
      expect((await searchResults(app, "kiwi", common)).map((result) => result.path)).toEqual(["kiwi"]);
      keepSearchIndexOnDisk(false);
      expect((await req(app, "POST", "/api/spaces/zulu/archive", {})).status).toBe(200);
      keepSearchIndexOnDisk(true);
      const listing = spyOn(storeModule, "listSpaces").mockReturnValue(new Promise(() => {}));
      try {
        setSearchWaitForTests(200);
        expect(await searchResults(app, "kiwi", common)).toEqual([]);
      } finally {
        listing.mockRestore();
      }
    } finally {
      keepSearchIndexOnDisk(false);
    }
  });

  it("sees an outside edit to a legacy HTML page from a catalog event alone", async () => {
    const created = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "board",
      name: "Board",
      html: "<p>The ocelot board.</p>",
    });
    expect(created.status).toBe(201);
    const bundle = join(workspaceDir, "spaces", "meta", "widgets", "board");
    const metadata = join(bundle, "widget.yaml");
    writeFileSync(
      metadata,
      readFileSync(metadata, "utf8").replace(/^updatedAt: .*$/m, "updatedAt: 2026-01-01T00:00:00.000Z"),
    );
    ageDocuments(join(workspaceDir, "spaces"));
    const common = {
      scopes: ["search:read", "documents:read"],
      documentMode: "common" as const,
    };
    expect(await searchResults(app, "ocelot", common)).toContainEqual(
      expect.objectContaining({ path: "board" }),
    );

    // An editor rewrites the page; the watcher's precise event was lost.
    writeFileSync(join(bundle, "index.html"), "<p>The tapir board.</p>");
    notifyWorkspaceChange({ type: "documentCorpus", spaceId: "meta" });
    expect(await searchResults(app, "tapir", common)).toContainEqual(
      expect.objectContaining({ path: "board" }),
    );
  });

  it("answers within its time budget while the index builds, then completes", async () => {
    expect((await req(app, "POST", "/api/spaces", { name: "Zulu" })).status).toBe(201);
    await req(app, "PUT", "/api/spaces/zulu/docs/kestrel", {
      content: [{ type: "paragraph", content: [{ type: "text", text: "The kestrel nests here.", styles: {} }] }],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The first Space's sync stalls; the second is not indexed yet.
    setSearchIndexRebuildHookForTests(async ({ spaceId }) => {
      if (spaceId === "meta") await held;
    });
    setSearchWaitForTests(200);

    const partial = await req(app, "GET", "/api/search?query=kestrel&documentMode=common");
    expect(partial.status).toBe(200);
    expect(partial.json).toEqual({ results: [], indexing: true });

    release();
    setSearchWaitForTests(null);
    expect(await searchWithStatus("kestrel", { documentAccess: "common" })).toEqual({
      results: [expect.objectContaining({ spaceId: "zulu", path: "kestrel" })],
      complete: true,
      corrected: [],
    });

    // Deleted while a sync before its Space's stalls: the answer comes from
    // the older index, without the deleted Doc or its excerpt.
    expect((await req(app, "DELETE", "/api/spaces/zulu/docs/kestrel")).status).toBeLessThan(300);
    invalidateSearchIndex({ spaceId: "meta" });
    let releaseAgain!: () => void;
    const heldAgain = new Promise<void>((resolve) => {
      releaseAgain = resolve;
    });
    setSearchIndexRebuildHookForTests(async ({ spaceId }) => {
      if (spaceId === "meta") await heldAgain;
    });
    setSearchWaitForTests(200);
    for (const includeArchived of [false, true]) {
      expect(
        await searchWithStatus("kestrel", { documentAccess: "common", includeArchived }),
      ).toEqual({ results: [], complete: false, corrected: [] });
    }
    releaseAgain();
  });

  it("leaves records out while the record index builds, instead of reading their files", async () => {
    recordIndex.start();
    await recordIndex.whenReady();
    const building = [
      spyOn(recordIndex, "isReady").mockReturnValue(false),
      spyOn(recordIndex, "whenReady").mockReturnValue(new Promise<void>(() => {})),
    ];
    try {
      for (const documentAccess of ["legacy", "common"] as const) {
        expect(await searchWithStatus("aqueduct", { documentAccess })).toEqual({
          results: [],
          complete: false,
          corrected: [],
        });
      }
    } finally {
      for (const spy of building) spy.mockRestore();
    }

    const ready = await searchWithStatus("aqueduct", { documentAccess: "common" });
    expect(ready.complete).toBe(true);
    expect(ready.results).toContainEqual(expect.objectContaining({ type: "record" }));
  });

  it("warms the index so the first search reads nothing", async () => {
    let syncs = 0;
    let created = false;
    setSearchIndexRebuildHookForTests(async () => {
      syncs += 1;
      // A Space created while the warm-up runs is warmed too.
      if (created) return;
      created = true;
      expect((await req(app, "POST", "/api/spaces", { name: "Yonder" })).status).toBe(201);
      await req(app, "PUT", "/api/spaces/yonder/docs/heron", {
        content: [{ type: "paragraph", content: [{ type: "text", text: "Lighthouse keeper", styles: {} }] }],
      });
    });
    await warmSearchIndex();
    expect(syncs).toBeGreaterThan(0);

    syncs = 0;
    expect(await searchResults(app, "observatory", {
      scopes: ["search:read", "documents:read"],
      documentMode: "common",
    })).toContainEqual(expect.objectContaining({ path: "richdoc" }));
    expect(await searchResults(app, "lighthouse", {
      scopes: ["search:read", "documents:read"],
      documentMode: "common",
    })).toContainEqual(expect.objectContaining({ spaceId: "yonder", path: "heron" }));
    expect(syncs).toBe(0);
  });

  it("answers concurrent searches while a new Space is being listed", async () => {
    expect((await req(app, "POST", "/api/spaces", { name: "Zulu" })).status).toBe(201);
    await req(app, "PUT", "/api/spaces/zulu/docs/kestrel", {
      content: [{ type: "paragraph", content: [{ type: "text", text: "The kestrel nests here.", styles: {} }] }],
    });
    const results = await Promise.all([
      search("kestrel", { documentAccess: "common" }),
      search("kestrel", { documentAccess: "common" }),
    ]);
    for (const hits of results) {
      expect(hits).toContainEqual(
        expect.objectContaining({ spaceId: "zulu", path: "kestrel" }),
      );
    }
  });

  it("answers while edits keep arriving", async () => {
    for (const documentAccess of ["legacy", "common"] as const) {
      let syncs = 0;
      setSearchIndexRebuildHookForTests(async ({ spaceId }) => {
        if (spaceId !== "meta") return;
        syncs += 1;
        // Another save lands during every sync.
        invalidateSearchIndex({ spaceId: "meta", path: "zeppelin" });
      });
      const results = await search("zeppelin", { documentAccess });
      expect(results).toContainEqual(
        expect.objectContaining({ spaceId: "meta", path: "zeppelin" }),
      );
      expect(syncs).toBeLessThanOrEqual(3);
    }
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

    // A deleted Space's records match nothing, archived ones included.
    expect((await req(app, "DELETE", "/api/spaces/meta")).status).toBe(204);
    const afterDelete = await searchWithStatus("aqueduct", { includeArchived: true });
    expect(afterDelete.results.filter((r) => r.type === "record")).toEqual([]);
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
