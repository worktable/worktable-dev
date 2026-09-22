import { ownerIdentity } from "./auth.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSpace,
  writeDoc,
  readDoc,
  readSpace,
  setDocArchived,
} from "./store.ts";
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { spacesRouter } from "./routes/spaces.ts";
import { docsRouter } from "./routes/docs.ts";
import { dispatchOperation } from "./mcp/dispatcher.ts";
import { yjsManager } from "./yjs-manager.ts";
import { createAnnotation } from "./annotation-store.ts";
import { buildDocumentCatalog } from "./document-catalog.ts";
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts";
import type { SpaceFile } from "@worktable/types";

function makeSpace(id: string): SpaceFile {
  const now = new Date().toISOString();
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  };
}

function buildTestApp() {
  const app = new Hono();
  // Route behavior fixtures enter after the production identity boundary.
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity());
    await next();
  });
  app.use("*", cors());
  app.onError((err, c) =>
    c.json({ error: err.message, code: "INTERNAL_ERROR" }, 500)
  );
  app.route("/api/spaces", spacesRouter);
  app.route("/api/spaces/:spaceId/docs", docsRouter);
  return app;
}

const para = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
});

async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const opts: RequestInit = {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await app.fetch(new Request(`http://localhost${path}`, opts));
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const testDir = join(tmpdir(), `worktable-doc-ux-test-${Date.now()}`);
const spacesDir = join(testDir, "spaces");

describe("doc UX routes", () => {
  let app: Hono;

  beforeEach(async () => {
    mkdirSync(testDir, { recursive: true });
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(join(testDir, "app"));
    ensureWorkspaceManifest();
    mkdirSync(spacesDir, { recursive: true });
    await writeSpace(makeSpace("doc-ux-space"));
    app = buildTestApp();
  });

  afterEach(() => {
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ── Markdown export (?format=markdown) ─────────────────

  it("returns directly stored markdown without repairing escaped Mermaid fences", async () => {
    const source =
      "# Mermaid syntax example\n\n\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n";
    writeFileSync(
      join(spacesDir, "doc-ux-space", "docs", "literal-mermaid.md"),
      source
    );

    const { status, json } = await req(
      app,
      "GET",
      "/api/spaces/doc-ux-space/docs/literal-mermaid"
    );

    expect(status).toBe(200);
    expect((json as { content: string }).content).toBe(source);
  });

  describe("GET /api/spaces/:spaceId/docs/*?format=markdown", () => {
    it("returns a markdown doc's content verbatim", async () => {
      const source =
        "# Mermaid syntax example\n\n\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n";
      writeFileSync(join(spacesDir, "doc-ux-space", "docs", "notes.md"), source);

      const { status, json } = await req(
        app,
        "GET",
        "/api/spaces/doc-ux-space/docs/notes?format=markdown"
      );
      expect(status).toBe(200);
      const j = json as { path: string; markdown: string };
      expect(j.path).toBe("notes");
      expect(j.markdown).toBe(source);
    });

    it("converts a BlockNote doc to markdown", async () => {
      await req(app, "PUT", "/api/spaces/doc-ux-space/docs/block-doc", {
        content: [para("Hello from blocks")],
      });

      const { status, json } = await req(
        app,
        "GET",
        "/api/spaces/doc-ux-space/docs/block-doc?format=markdown"
      );
      expect(status).toBe(200);
      const j = json as { markdown: string };
      expect(j.markdown).toContain("Hello from blocks");
    });

    it("404s for a missing doc", async () => {
      const { status } = await req(
        app,
        "GET",
        "/api/spaces/doc-ux-space/docs/nope?format=markdown"
      );
      expect(status).toBe(404);
    });
  });

  describe("POST /api/spaces/:spaceId/docs/*/convert-to-markdown", () => {
    it("replaces a compatible rich doc with Markdown", async () => {
      await writeDoc("doc-ux-space", "safe-rich", [
        {
          type: "heading",
          props: { level: 1 },
          content: [{ type: "text", text: "Safe rich doc", styles: {} }],
          children: [],
        },
        para("Body copy"),
      ]);
      const documentId = mintDocumentId();
      await updateDocumentInventory("doc-ux-space", {
        upsert: [{
          documentId,
          path: "safe-rich",
          format: { id: "worktable.rich-text", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/safe-rich.json" },
        }],
      });
      const expectDurableClaim = async (formatId: string, relativePath: string) => {
        const catalog = await buildDocumentCatalog({
          workspaceRoot: testDir,
          spaceId: "doc-ux-space",
        });
        expect(catalog.entries.find((entry) =>
          entry.kind === "document" && entry.descriptor.documentId === documentId
        )).toMatchObject({
          descriptor: { documentId, path: "safe-rich", format: { id: formatId } },
          handle: { identity: "durable", source: { relativePath } },
        });
      };

      const before = await req(app, "GET", "/api/spaces/doc-ux-space/docs/safe-rich");
      expect(before.status).toBe(200);
      const beforeMeta = before.json as {
        markdownCompatible: boolean;
        collaborationCacheEpoch: string;
      };
      expect(beforeMeta.markdownCompatible).toBe(true);
      const fastRead = await req(
        app,
        "GET",
        "/api/spaces/doc-ux-space/docs/safe-rich?conversionCheck=skip"
      );
      expect(fastRead.status).toBe(200);
      expect(fastRead.json).toEqual({
        ...(before.json as object),
        markdownCompatible: null,
      });

      const converted = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/safe-rich/convert-to-markdown"
      );
      expect(converted.status).toBe(200);
      expect(converted.json).toMatchObject({
        ok: true,
        format: "markdown",
        storedAs: "md",
      });

      const stored = await readDoc("doc-ux-space", "safe-rich");
      expect(stored.storedAs).toBe("md");
      expect(stored.data).toContain("# Safe rich doc");
      expect(stored.data).toContain("Body copy");
      expect(existsSync(join(spacesDir, "doc-ux-space", "docs", "safe-rich.json"))).toBe(false);
      await expectDurableClaim("worktable.markdown", "docs/safe-rich.md");

      const editableAgain = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/safe-rich/convert"
      );
      expect(editableAgain.status).toBe(200);
      await expectDurableClaim("worktable.rich-text", "docs/safe-rich.json");
      const after = await req(app, "GET", "/api/spaces/doc-ux-space/docs/safe-rich");
      const afterMeta = after.json as {
        collaborationCacheEpoch: string;
        collaborationCacheEpochHistory: string[];
      };
      expect(afterMeta.collaborationCacheEpoch).not.toBe(
        beforeMeta.collaborationCacheEpoch
      );
      expect(afterMeta.collaborationCacheEpochHistory).toContain(
        beforeMeta.collaborationCacheEpoch
      );

      const savedAgain = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/safe-rich/convert-to-markdown"
      );
      expect(savedAgain.status).toBe(200);
      const editedAgain = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/safe-rich/convert"
      );
      expect(editedAgain.status).toBe(200);
      const afterSecondCycle = await req(
        app,
        "GET",
        "/api/spaces/doc-ux-space/docs/safe-rich"
      );
      const secondCycleMeta = afterSecondCycle.json as {
        collaborationCacheEpochHistory: string[];
      };
      expect(secondCycleMeta.collaborationCacheEpochHistory).toEqual(
        expect.arrayContaining([
          beforeMeta.collaborationCacheEpoch,
          afterMeta.collaborationCacheEpoch,
        ])
      );
    });

    it("rejects formatting Markdown cannot preserve without changing the doc", async () => {
      const blocks = [
        {
          type: "paragraph",
          props: { textColor: "red" },
          content: [{ type: "text", text: "Keep the color", styles: {} }],
          children: [],
        },
      ];
      await writeDoc("doc-ux-space", "rich-formatting", blocks);
      const storedBefore = await readDoc("doc-ux-space", "rich-formatting");

      const before = await req(app, "GET", "/api/spaces/doc-ux-space/docs/rich-formatting");
      expect((before.json as { markdownCompatible: boolean }).markdownCompatible).toBe(false);

      const converted = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/rich-formatting/convert-to-markdown"
      );
      expect(converted.status).toBe(422);
      expect(converted.json).toMatchObject({ code: "MARKDOWN_INCOMPATIBLE" });

      const stored = await readDoc("doc-ux-space", "rich-formatting");
      expect(stored.storedAs).toBe("json");
      expect(stored.data).toEqual(storedBefore.data);
    });

    it("keeps the action unavailable for schema-foreign rich props", async () => {
      const blockProps = [
        {
          type: "paragraph",
          props: { foreignProp: "keep-me" },
          content: [{ type: "text", text: "Foreign data", styles: {} }],
          children: [],
        },
      ];
      const tableCellProps = [
        {
          type: "table",
          props: { textColor: "default" },
          content: {
            type: "tableContent",
            rows: [
              {
                cells: [
                  {
                    type: "tableCell",
                    props: { foreignProp: "keep-me" },
                    content: [
                      { type: "text", text: "Foreign data", styles: {} },
                    ],
                  },
                ],
              },
            ],
          },
          children: [],
        },
      ];
      writeFileSync(
        join(spacesDir, "doc-ux-space", "docs", "foreign-block-props.json"),
        JSON.stringify(blockProps)
      );
      writeFileSync(
        join(spacesDir, "doc-ux-space", "docs", "foreign-cell-props.json"),
        JSON.stringify(tableCellProps)
      );

      for (const docPath of ["foreign-block-props", "foreign-cell-props"]) {
        const before = await req(
          app,
          "GET",
          `/api/spaces/doc-ux-space/docs/${docPath}`
        );
        expect(
          (before.json as { markdownCompatible: boolean }).markdownCompatible
        ).toBe(false);

        const converted = await req(
          app,
          "POST",
          `/api/spaces/doc-ux-space/docs/${docPath}/convert-to-markdown`
        );
        expect(converted.status).toBe(422);
        expect(converted.json).toMatchObject({ code: "MARKDOWN_INCOMPATIBLE" });
        expect((await readDoc("doc-ux-space", docPath)).storedAs).toBe("json");
      }
    });

    it("keeps the action unavailable for block-only annotation anchors", async () => {
      await writeDoc("doc-ux-space", "annotated-rich", [
        para("Keep this annotation anchored"),
      ]);
      const stored = await readDoc("doc-ux-space", "annotated-rich");
      const blockId = (stored.data as Array<{ id: string }>)[0]!.id;
      await createAnnotation("doc-ux-space", {
        target: {
          type: "block",
          docPath: "annotated-rich",
          blockId,
        },
        category: "comment",
        body: "Block comment",
      });

      const before = await req(
        app,
        "GET",
        "/api/spaces/doc-ux-space/docs/annotated-rich"
      );
      expect(
        (before.json as { markdownCompatible: boolean }).markdownCompatible
      ).toBe(false);

      const converted = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/annotated-rich/convert-to-markdown"
      );
      expect(converted.status).toBe(422);
      expect((await readDoc("doc-ux-space", "annotated-rich")).storedAs).toBe(
        "json"
      );
    });

    it("keeps the action unavailable when an annotation quote is ambiguous", async () => {
      await writeDoc("doc-ux-space", "duplicate-quote-rich", [
        para("Repeated sentence"),
        para("Repeated sentence"),
      ]);
      const stored = await readDoc("doc-ux-space", "duplicate-quote-rich");
      const blockId = (stored.data as Array<{ id: string }>)[1]!.id;
      await createAnnotation("doc-ux-space", {
        target: {
          type: "block",
          docPath: "duplicate-quote-rich",
          blockId,
          quote: "Repeated sentence",
        },
        category: "comment",
        body: "Keep this on the second paragraph",
      });

      const before = await req(
        app,
        "GET",
        "/api/spaces/doc-ux-space/docs/duplicate-quote-rich"
      );
      expect(
        (before.json as { markdownCompatible: boolean }).markdownCompatible
      ).toBe(false);

      const converted = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/duplicate-quote-rich/convert-to-markdown"
      );
      expect(converted.status).toBe(422);
      expect(
        (await readDoc("doc-ux-space", "duplicate-quote-rich")).storedAs
      ).toBe("json");
    });

    it("returns stable errors when the doc cannot be converted", async () => {
      await writeDoc("doc-ux-space", "archived-rich", [para("Archived")]);
      await setDocArchived("doc-ux-space", "archived-rich", true);
      await writeDoc("doc-ux-space", "already-markdown", "# Markdown");

      const archived = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/archived-rich/convert-to-markdown"
      );
      const alreadyMarkdown = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/already-markdown/convert-to-markdown"
      );
      const missing = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/missing/convert-to-markdown"
      );

      expect(archived.status).toBe(409);
      expect(archived.json).toMatchObject({ code: "ARCHIVED" });
      expect(alreadyMarkdown.status).toBe(409);
      expect(alreadyMarkdown.json).toMatchObject({ code: "CONFLICT" });
      expect(missing.status).toBe(404);
      expect(missing.json).toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns a conflict while the doc is already changing format", async () => {
      await writeDoc("doc-ux-space", "transitioning", [para("Waiting")]);
      let reportTransition!: () => void;
      let releaseTransition!: () => void;
      const transitionEntered = new Promise<void>((resolve) => {
        reportTransition = resolve;
      });
      const transitionHeld = new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      const activeTransition = yjsManager.withDocFormatTransition(
        "doc-ux-space",
        "transitioning",
        async () => {
          reportTransition();
          await transitionHeld;
        }
      );
      await transitionEntered;

      const duplicate = await req(
        app,
        "POST",
        "/api/spaces/doc-ux-space/docs/transitioning/convert-to-markdown"
      );
      releaseTransition();
      await activeTransition;

      expect(duplicate.status).toBe(409);
      expect(duplicate.json).toMatchObject({ code: "CONFLICT" });
    });
  });

  // ── Untitled quick-create ──────────────────────────────

  describe("POST /api/spaces/:spaceId/docs with Untitled", () => {
    it("dedupes repeated Untitled creates", async () => {
      const first = await req(app, "POST", "/api/spaces/doc-ux-space/docs", {
        title: "Untitled",
      });
      const second = await req(app, "POST", "/api/spaces/doc-ux-space/docs", {
        title: "Untitled",
      });
      const third = await req(app, "POST", "/api/spaces/doc-ux-space/docs", {
        title: "Untitled",
      });

      expect(first.status).toBe(201);
      expect((first.json as { path: string }).path).toBe("untitled");
      expect((second.json as { path: string }).path).toBe("untitled-2");
      expect((third.json as { path: string }).path).toBe("untitled-3");
    });

    it("dedupes Untitled inside a folder", async () => {
      const first = await req(app, "POST", "/api/spaces/doc-ux-space/docs", {
        title: "projects/Untitled",
      });
      const second = await req(app, "POST", "/api/spaces/doc-ux-space/docs", {
        title: "projects/Untitled",
      });

      expect((first.json as { path: string }).path).toBe("projects/untitled");
      expect((second.json as { path: string }).path).toBe("projects/untitled-2");
    });
  });

  // ── Manual doc order ───────────────────────────────────

  describe("PUT /api/spaces/:spaceId/doc-order", () => {
    it("persists the order into space settings", async () => {
      const { status, json } = await req(
        app,
        "PUT",
        "/api/spaces/doc-ux-space/doc-order",
        { order: ["beta", "alpha", "folder/nested"] }
      );
      expect(status).toBe(200);
      const returned = (json as { space: SpaceFile }).space;
      expect(returned.settings["docOrder"]).toEqual([
        "beta",
        "alpha",
        "folder/nested",
      ]);

      const onDisk = await readSpace("doc-ux-space");
      expect(onDisk.data?.settings["docOrder"]).toEqual([
        "beta",
        "alpha",
        "folder/nested",
      ]);
    });

    it("survives an unrelated space metadata update", async () => {
      await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {
        order: ["b", "a"],
      });
      await req(app, "PUT", "/api/spaces/doc-ux-space", { name: "Renamed" });

      const onDisk = await readSpace("doc-ux-space");
      expect(onDisk.data?.name).toBe("Renamed");
      expect(onDisk.data?.settings["docOrder"]).toEqual(["b", "a"]);
    });

    it("persists the sort mode, independently of the order", async () => {
      await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {
        order: ["b", "a"],
      });
      const { status, json } = await req(
        app,
        "PUT",
        "/api/spaces/doc-ux-space/doc-order",
        { sort: "updated" }
      );
      expect(status).toBe(200);
      const space = (json as { space: SpaceFile }).space;
      expect(space.settings["docSort"]).toBe("updated");
      // Changing the sort must not clobber the saved manual order.
      expect(space.settings["docOrder"]).toEqual(["b", "a"]);
    });

    it("rejects an unknown sort mode and an empty body", async () => {
      const badSort = await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {
        sort: "created",
      });
      expect(badSort.status).toBe(400);

      const empty = await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {});
      expect(empty.status).toBe(400);
    });

    it("rejects invalid payloads", async () => {
      const notArray = await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {
        order: "beta",
      });
      expect(notArray.status).toBe(400);

      const nonStrings = await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {
        order: [1, 2],
      });
      expect(nonStrings.status).toBe(400);

      const noBody = await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order");
      expect(noBody.status).toBe(400);
    });

    it("404s for a missing space", async () => {
      const { status } = await req(app, "PUT", "/api/spaces/nope/doc-order", {
        order: ["a"],
      });
      expect(status).toBe(404);
    });

    it("rename migrates the doc's manual-order entry", async () => {
      await req(app, "PUT", "/api/spaces/doc-ux-space/docs/alpha", { content: [] });
      await req(app, "PUT", "/api/spaces/doc-ux-space/docs/beta", { content: [] });
      await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {
        order: ["beta", "alpha"],
      });

      await req(app, "POST", "/api/spaces/doc-ux-space/docs/beta/rename", {
        newPath: "gamma",
      });

      const onDisk = await readSpace("doc-ux-space");
      expect(onDisk.data?.settings["docOrder"]).toEqual(["gamma", "alpha"]);
    });

    it("exact doc rename leaves a same-named folder's children untouched", async () => {
      // "guide" is BOTH a doc and a folder; renaming the doc must not
      // rewrite order entries for guide/* (those files do not move).
      await req(app, "PUT", "/api/spaces/doc-ux-space/docs/guide", { content: [] });
      await req(app, "PUT", "/api/spaces/doc-ux-space/docs/guide/intro", { content: [] });
      await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {
        order: ["guide", "guide/intro"],
      });

      await req(app, "POST", "/api/spaces/doc-ux-space/docs/guide/rename", {
        newPath: "manual",
        scope: "document",
      });

      const onDisk = await readSpace("doc-ux-space");
      expect(onDisk.data?.settings["docOrder"]).toEqual(["manual", "guide/intro"]);
    });

    it("MCP rename migrates order through the shared lifecycle", async () => {
      await req(app, "PUT", "/api/spaces/doc-ux-space/docs/alpha2", { content: [] });
      await req(app, "PUT", "/api/spaces/doc-ux-space/docs/beta2", { content: [] });
      await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {
        order: ["beta2", "alpha2"],
      });

      await dispatchOperation("docs.rename", {
        spaceId: "doc-ux-space",
        oldPath: "beta2",
        newPath: "gamma2",
      });

      const onDisk = await readSpace("doc-ux-space");
      expect(onDisk.data?.settings["docOrder"]).toEqual(["gamma2", "alpha2"]);
    });

    it("folder rename migrates nested and folder order entries", async () => {
      await req(app, "PUT", "/api/spaces/doc-ux-space/docs/proj/one", { content: [] });
      await req(app, "PUT", "/api/spaces/doc-ux-space/docs/proj/two", { content: [] });
      await req(app, "PUT", "/api/spaces/doc-ux-space/doc-order", {
        order: ["proj", "proj/two", "proj/one"],
      });

      await req(app, "POST", "/api/spaces/doc-ux-space/docs/proj/rename", {
        newPath: "work",
      });

      const onDisk = await readSpace("doc-ux-space");
      expect(onDisk.data?.settings["docOrder"]).toEqual([
        "work",
        "work/two",
        "work/one",
      ]);
    });
  });

  // ── Doc list carries a last-updated fallback ───────────

  it("list entries include file mtime as updatedAt", async () => {
    await req(app, "PUT", "/api/spaces/doc-ux-space/docs/timed", { content: [] });
    const { json } = await req(app, "GET", "/api/spaces/doc-ux-space/docs");
    const doc = (json as { docs: { path: string; updatedAt?: number }[] }).docs.find(
      (d) => d.path === "timed"
    );
    expect(typeof doc?.updatedAt).toBe("number");
    expect(doc!.updatedAt!).toBeGreaterThan(Date.now() - 60_000);
  });
});
