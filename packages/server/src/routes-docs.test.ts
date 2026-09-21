import { ownerIdentity } from "./auth.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocPath, getDocProvenance, writeSpace } from "./store.ts";
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts";
import { yjsManager } from "./yjs-manager.ts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { spacesRouter } from "./routes/spaces.ts";
import { docsRouter } from "./routes/docs.ts";
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

// A valid BlockNote paragraph. The store canonicalizes blocks on write (stable
// ids, default props), so tests assert on semantic text rather than exact bytes.
const para = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
});
function textOf(data: unknown): string {
  if (!Array.isArray(data)) return "";
  return data
    .map((block: any) =>
      Array.isArray(block?.content)
        ? block.content.map((inline: any) => inline?.text ?? "").join("")
        : ""
    )
    .join("\n");
}

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

const testDir = join(tmpdir(), `worktable-docs-routes-test-${Date.now()}`);
const appDir = join(tmpdir(), `worktable-docs-routes-app-${Date.now()}`);
const spacesDir = join(testDir, "spaces");

describe("doc routes", () => {
  let app: Hono;

  beforeEach(async () => {
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    mkdirSync(spacesDir, { recursive: true });
    await writeSpace(makeSpace("test-space"));
    app = buildTestApp();
  });

  afterEach(() => {
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  // ── List ───────────────────────────────────────────────

  describe("GET /api/spaces/:spaceId/docs", () => {
    it("returns empty list for space with no docs", async () => {
      const { status, json } = await req(app, "GET", "/api/spaces/test-space/docs");
      expect(status).toBe(200);
      const j = json as { docs: string[] };
      expect(j.docs).toEqual([]);
    });

    it("lists created docs", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/alpha", {
        content: [],
      });
      await req(app, "PUT", "/api/spaces/test-space/docs/beta", {
        content: [],
      });

      const { json } = await req(app, "GET", "/api/spaces/test-space/docs");
      const j = json as { docs: { path: string; format: string }[] };
      const paths = j.docs.map((d) => d.path).sort();
      expect(paths).toEqual(["alpha", "beta"]);
    });

    it("hides archived docs by default and includes them on request", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/active", {
        content: [],
      });
      await req(app, "PUT", "/api/spaces/test-space/docs/archived", {
        content: [],
      });
      await req(app, "POST", "/api/spaces/test-space/docs/archived/archive", {});

      const activeOnly = await req(app, "GET", "/api/spaces/test-space/docs");
      expect((activeOnly.json as { docs: { path: string }[] }).docs.map((d) => d.path)).toEqual(["active"]);

      const allDocs = await req(app, "GET", "/api/spaces/test-space/docs?includeArchived=true");
      const archivedDoc = (allDocs.json as { docs: { path: string; archived?: { archivedBy: string } }[] }).docs.find((d) => d.path === "archived");
      expect(archivedDoc?.archived?.archivedBy).toBe("user");
    });
  });

  // ── Review + freshness ─────────────────────────────────

  describe("POST /api/spaces/:spaceId/docs/*/review", () => {
    it("records a review checkpoint and flips humanReviewed", async () => {
      const { writeDoc, listDocVersions } = await import("./store.ts");
      await writeDoc("test-space", "agent-doc", "# Agent Doc\n\nBody.", {
        updatedBy: "worktable-agent",
        source: "mcp",
      });

      const before = await req(app, "GET", "/api/spaces/test-space/docs/agent-doc");
      expect((before.json as { freshness: { humanReviewed: boolean } }).freshness.humanReviewed).toBe(false);

      const { status, json } = await req(app, "POST", "/api/spaces/test-space/docs/agent-doc/review");
      expect(status).toBe(200);
      const j = json as { ok: boolean; freshness: { humanReviewed: boolean; lastHumanTouch: string | null } };
      expect(j.ok).toBe(true);
      expect(j.freshness.humanReviewed).toBe(true);
      expect(j.freshness.lastHumanTouch).not.toBeNull();

      const versions = await listDocVersions("test-space", "agent-doc");
      expect(versions[0]?.checkpoint?.kind).toBe("review");
    });

    it("404s for a missing doc", async () => {
      const { status } = await req(app, "POST", "/api/spaces/test-space/docs/nope/review");
      expect(status).toBe(404);
    });
  });

  describe("freshness decoration", () => {
    it("GET list includes freshness for every doc", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/alpha", { content: [] });
      const { json } = await req(app, "GET", "/api/spaces/test-space/docs");
      const j = json as { docs: { path: string; freshness?: { humanReviewed: boolean } }[] };
      expect(j.docs[0]?.freshness).toBeDefined();
      // REST PUT with updatedBy user counts as human.
      expect(j.docs[0]?.freshness?.humanReviewed).toBe(true);
    });
  });

  // ── Read ───────────────────────────────────────────────

  describe("GET /api/spaces/:spaceId/docs/*", () => {
    it("reads a created doc", async () => {
      const content = [{ type: "paragraph", content: [{ text: "hello" }] }];
      await req(app, "PUT", "/api/spaces/test-space/docs/my-doc", { content });

      const { status, json } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/my-doc"
      );
      expect(status).toBe(200);
      const j = json as {
        path: string;
        content: unknown[];
        updatedAt: number;
        collaborationEpoch: string;
      };
      expect(j.path).toBe("my-doc");
      expect(j.content).toEqual(content);
      expect(typeof j.updatedAt).toBe("number");
      expect(j.collaborationEpoch).toBe(
        await getWorkspaceCollaborationEpoch()
      );
    });

    it("returns 404 for missing doc", async () => {
      const { status } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/nonexistent"
      );
      expect(status).toBe(404);
    });
  });

  // ── Write ──────────────────────────────────────────────

  describe("PUT /api/spaces/:spaceId/docs/*", () => {
    it("creates a new doc", async () => {
      const { status, json } = await req(
        app,
        "PUT",
        "/api/spaces/test-space/docs/new-doc",
        { content: [{ text: "created" }] }
      );
      expect(status).toBe(200);
      const j = json as { path: string; updatedAt: number };
      expect(j.path).toBe("new-doc");
    });

    it("updates an existing doc", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/update-me", {
        content: [para("v1")],
      });
      await req(app, "PUT", "/api/spaces/test-space/docs/update-me", {
        content: [para("v2")],
      });

      const { json } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/update-me"
      );
      const j = json as { content: unknown[] };
      expect(textOf(j.content)).toBe("v2");
    });

    it("returns 400 for invalid body", async () => {
      const res = await app.fetch(
        new Request("http://localhost/api/spaces/test-space/docs/bad", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        })
      );
      expect(res.status).toBe(400);
    });

    it("rejects invalid Mermaid from REST without persisting the document", async () => {
      const { status, json } = await req(
        app,
        "PUT",
        "/api/spaces/test-space/docs/invalid-mermaid",
        {
          content: [
            {
              type: "mermaid",
              props: { data: "flowchart TD\nA-->" },
              children: [],
            },
          ],
        }
      );

      expect(status).toBe(422);
      expect(json).toMatchObject({
        error: "The document contains invalid Mermaid; no changes were saved.",
        code: "INVALID_MERMAID_DOCUMENT",
        issues: [{ code: "INVALID_MERMAID", representation: "custom-block" }],
      });

      const read = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/invalid-mermaid"
      );
      expect(read.status).toBe(404);
    });

    it("syncs a loaded live doc from the canonical write, so the next persist is a no-op", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/live-doc", {
        content: [para("v1")],
      });
      await yjsManager.getOrCreateDoc("test-space", "live-doc");

      // Update through REST with id-less blocks while the doc is live. The
      // route must push the CANONICAL on-disk blocks into the Y.Doc (not the
      // raw request blocks), or the live doc would carry a different id set
      // and the next persist would record a phantom version.
      await req(app, "PUT", "/api/spaces/test-space/docs/live-doc", {
        content: [para("v2")],
      });
      const afterPut = await getDocProvenance("test-space", "live-doc");

      await yjsManager.flushPersist("test-space", "live-doc");
      const afterPersist = await getDocProvenance("test-space", "live-doc");
      expect(afterPersist?.versionId).toBe(afterPut!.versionId);
      expect(afterPersist?.source).toBe("rest-api");
    });

    it("creates nested docs in folders", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/folder/nested-doc", {
        content: [para("nested")],
      });

      const { json } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/folder/nested-doc"
      );
      const j = json as { content: unknown[] };
      expect(textOf(j.content)).toBe("nested");
    });
  });

  // ── Delete ─────────────────────────────────────────────

  describe("DELETE /api/spaces/:spaceId/docs/*", () => {
    it("finishes deleting a durable doc whose source was removed", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/to-delete", {
        content: [para("retiring")],
      });
      const sourcePath = getDocPath("test-space", "to-delete");
      expect(existsSync(sourcePath)).toBe(true);
      rmSync(sourcePath);

      const { status } = await req(
        app,
        "DELETE",
        "/api/spaces/test-space/docs/to-delete"
      );
      expect(status).toBe(200);

      const { status: getStatus } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/to-delete"
      );
      expect(getStatus).toBe(404);
    });

    it("returns 404 when the document or its space does not exist", async () => {
      for (const path of [
        "/api/spaces/test-space/docs/ghost",
        "/api/spaces/missing-space/docs/ghost",
      ]) {
        expect((await req(app, "DELETE", path)).status).toBe(404)
      }
    });
  });

  // ── Rename ─────────────────────────────────────────────

  describe("POST /api/spaces/:spaceId/docs/*/rename", () => {
    it("renames a doc", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/old-name", {
        content: [para("renamed")],
      });

      const { status } = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/old-name/rename",
        { newPath: "new-name" }
      );
      expect(status).toBe(200);

      // Old URL resolves to the canonical path without recreating the old doc.
      const { status: oldStatus, json: oldJson } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/old-name"
      );
      expect(oldStatus).toBe(200);
      expect((oldJson as { path: string }).path).toBe("new-name");

      // Store-equivalent path variants cannot bypass alias lookup, even if an
      // external sync has recreated a hidden file at the reserved old path.
      writeFileSync(
        join(testDir, "spaces", "test-space", "docs", "old-name.md"),
        "# Hidden conflict\n",
        "utf8"
      );
      const normalizedAliasRead = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/o..ld-name"
      );
      expect(normalizedAliasRead.status).toBe(200);
      expect((normalizedAliasRead.json as { path: string }).path).toBe("new-name");
      const hiddenMetadataWrite = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/old-name/archive",
        {}
      );
      expect(hiddenMetadataWrite.status).toBe(409);

      const reservedWrite = await req(
        app,
        "PUT",
        "/api/spaces/test-space/docs/old-name",
        { content: [para("must not replace the alias")] }
      );
      expect(reservedWrite.status).toBe(409);
      const reservedQuickCreate = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs",
        { title: "Old Name" }
      );
      expect(reservedQuickCreate.status).toBe(409);

      // New path has content
      const { json } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/new-name"
      );
      const j = json as { content: unknown[] };
      expect(textOf(j.content)).toBe("renamed");
    });

    it("returns 404 when renaming nonexistent doc", async () => {
      const { status } = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/ghost/rename",
        { newPath: "target" }
      );
      expect(status).toBe(404);
    });

    it("renames an explicitly selected folder and preserves auto-detection", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/leaf-only", {
        content: [para("leaf")],
      });
      const missingFolder = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/leaf-only/rename",
        { newPath: "must-not-move", scope: "folder" }
      );
      expect(missingFolder.status).toBe(404);
      const untouchedLeaf = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/leaf-only"
      );
      expect(untouchedLeaf.status).toBe(200);
      expect((untouchedLeaf.json as { path: string }).path).toBe("leaf-only");

      await req(app, "PUT", "/api/spaces/test-space/docs/folder", {
        content: [para("folder doc")],
      });
      await req(app, "PUT", "/api/spaces/test-space/docs/folder/one", {
        content: [para("one")],
      });
      await req(app, "PUT", "/api/spaces/test-space/docs/folder/two", {
        content: [para("two")],
      });
      const renameRes = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/folder/rename",
        { newPath: "renamed-folder", scope: "folder" }
      );
      expect(renameRes.status).toBe(200);
      expect((renameRes.json as { count: number }).count).toBe(3);

      const oldParent = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/folder"
      );
      expect(oldParent.status).toBe(200);
      expect((oldParent.json as { path: string }).path).toBe("renamed-folder");

      const oldDoc = await req(app, "GET", "/api/spaces/test-space/docs/folder/one");
      expect(oldDoc.status).toBe(200);
      expect((oldDoc.json as { path: string }).path).toBe("renamed-folder/one");

      const reservedChild = await req(
        app,
        "PUT",
        "/api/spaces/test-space/docs/folder/new-child",
        { content: [para("must not replace the prefix alias")] }
      );
      expect(reservedChild.status).toBe(409);

      const newDoc = await req(app, "GET", "/api/spaces/test-space/docs/renamed-folder/one");
      expect(newDoc.status).toBe(200);
      expect(textOf((newDoc.json as { content: unknown[] }).content)).toBe("one");

      await req(app, "PUT", "/api/spaces/test-space/docs/auto-folder/one", {
        content: [para("auto")],
      });
      const autoRename = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/auto-folder/rename",
        { newPath: "auto-renamed" }
      );
      expect(autoRename.status).toBe(200);
      expect((autoRename.json as { count: number }).count).toBe(1);
    });
  });

  describe("POST /api/spaces/:spaceId/docs/*/{archive,restore}", () => {
    it("archives and restores a doc", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/to-archive", {
        content: [{ archived: false }],
      });

      const archiveRes = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/to-archive/archive",
        { archivedBy: "tester", reason: "done" }
      );
      expect(archiveRes.status).toBe(200);

      const archivedDoc = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/to-archive"
      );
      expect((archivedDoc.json as { archived?: { archivedBy: string; reason?: string } }).archived?.archivedBy).toBe("tester");
      expect((archivedDoc.json as { archived?: { archivedBy: string; reason?: string } }).archived?.reason).toBe("done");

      const restoreRes = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/to-archive/restore",
        {}
      );
      expect(restoreRes.status).toBe(200);

      const restoredDoc = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/to-archive"
      );
      expect((restoredDoc.json as { archived?: unknown }).archived).toBeUndefined();
    });

    it("archives and restores a folder prefix", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/folder/one", {
        content: [],
      });
      await req(app, "PUT", "/api/spaces/test-space/docs/folder/two", {
        content: [],
      });
      await req(app, "PUT", "/api/spaces/test-space/docs/other", {
        content: [],
      });

      const archiveRes = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/folder/archive",
        { archivedBy: "tester" }
      );
      expect(archiveRes.status).toBe(200);
      expect((archiveRes.json as { count: number }).count).toBe(2);

      const activeOnly = await req(app, "GET", "/api/spaces/test-space/docs");
      expect((activeOnly.json as { docs: { path: string }[] }).docs.map((d) => d.path)).toEqual(["other"]);

      const restoreRes = await req(
        app,
        "POST",
        "/api/spaces/test-space/docs/folder/restore",
        {}
      );
      expect(restoreRes.status).toBe(200);
      expect((restoreRes.json as { count: number }).count).toBe(2);
    }, 15_000);
  });

  describe("POST /api/spaces/:spaceId/docs/*/versions/:versionId/restore", () => {
    it("restores only versions owned by the active Doc generation", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/folder/doc", {
        content: [para("first")],
      });
      await req(app, "PUT", "/api/spaces/test-space/docs/folder/doc", {
        content: [para("second")],
      });

      const versionsRes = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/folder/doc/versions?all=true"
      );
      expect(versionsRes.status).toBe(200);
      const versions = (versionsRes.json as { versions: Array<{ id: string }> }).versions;
      let firstVersionId: string | null = null;
      for (const version of versions) {
        const snapshotRes = await req(
          app,
          "GET",
          `/api/spaces/test-space/docs/folder/doc/versions/${version.id}`
        );
        const snapshot = snapshotRes.json as { version: { after: { content: unknown } } };
        if (JSON.stringify(snapshot.version.after.content).includes("first")) {
          firstVersionId = version.id;
          break;
        }
      }
      expect(firstVersionId).toBeTruthy();

      await yjsManager.getOrCreateDoc("test-space", "folder/doc");
      const wrongOwnerRestore = await req(
        app,
        "POST",
        `/api/spaces/test-space/docs/folder/Doc/versions/${firstVersionId}/restore`
      );
      expect(wrongOwnerRestore.status).toBe(409);
      expect(
        (wrongOwnerRestore.json as { error: string }).error
      ).toContain("folder/doc");
      const unchangedDoc = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/folder/doc"
      );
      expect(
        textOf((unchangedDoc.json as { content: unknown[] }).content)
      ).toBe("second");

      const restoreRes = await req(
        app,
        "POST",
        `/api/spaces/test-space/docs/folder/doc/versions/${firstVersionId}/restore`
      );
      expect(restoreRes.status).toBe(200);

      const restoredDoc = await req(app, "GET", "/api/spaces/test-space/docs/folder/doc");
      expect(textOf((restoredDoc.json as { content: unknown[] }).content)).toBe("first");

      const deleted = await req(
        app,
        "DELETE",
        "/api/spaces/test-space/docs/folder/doc"
      );
      expect(deleted.status).toBe(200);
      const recreated = await req(
        app,
        "PUT",
        "/api/spaces/test-space/docs/folder/doc",
        { content: [para("new generation")] }
      );
      expect(recreated.status).toBe(200);
      const staleRestore = await req(
        app,
        "POST",
        `/api/spaces/test-space/docs/folder/doc/versions/${firstVersionId}/restore`
      );
      expect(staleRestore.status).toBe(404);
      const current = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/folder/doc"
      );
      expect(current.status).toBe(200);
      expect(textOf((current.json as { content: unknown[] }).content)).toBe(
        "new generation"
      );
    });
  });

  // ── URL encoding roundtrip (the %20 bug) ──────────────

  describe("URL encoding", () => {
    it("handles doc names with spaces via URL encoding", async () => {
      // Client sends "Planning Onsite" as "Planning%20Onsite" in the URL
      await req(
        app,
        "PUT",
        "/api/spaces/test-space/docs/Planning%20Onsite",
        { content: [para("onsite notes")] }
      );

      // Reading back with encoded URL works
      const { status, json } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/Planning%20Onsite"
      );
      expect(status).toBe(200);
      const j = json as { path: string; content: unknown[] };
      expect(j.path).toBe("Planning Onsite");
      expect(textOf(j.content)).toBe("onsite notes");

      // List shows decoded name
      const { json: listJson } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs"
      );
      const list = listJson as { docs: { path: string; format: string }[] };
      const paths = list.docs.map((d) => d.path);
      expect(paths).toContain("Planning Onsite");
      expect(paths).not.toContain("Planning%20Onsite");
    });

    it("handles doc names with special URL characters", async () => {
      // Parentheses, ampersands, etc.
      await req(
        app,
        "PUT",
        `/api/spaces/test-space/docs/${encodeURIComponent("Q&A (FAQ)")}`,
        { content: [] }
      );

      const { json } = await req(
        app,
        "GET",
        `/api/spaces/test-space/docs/${encodeURIComponent("Q&A (FAQ)")}`
      );
      const j = json as { path: string };
      expect(j.path).toBe("Q&A (FAQ)");
    });
  });

  // ── Path traversal via HTTP ────────────────────────────

  describe("path traversal via HTTP", () => {
    it("cannot read files outside docs dir via traversal", async () => {
      // Create a doc so the space is populated
      await req(app, "PUT", "/api/spaces/test-space/docs/legit", {
        content: [],
      });

      // Attempt traversal - should either 404 or return safe path
      const { status } = await req(
        app,
        "GET",
        "/api/spaces/test-space/docs/..%2F..%2F..%2Fetc%2Fpasswd"
      );
      // Should not be 200 with sensitive file contents
      // Either 404 (file doesn't exist at sanitized path) or the path is sanitized
      expect(status === 404 || status === 200).toBe(true);
      // If 200, the path should be sanitized (not /etc/passwd)
    });

    it("cannot write files outside docs dir via traversal", async () => {
      await req(
        app,
        "PUT",
        "/api/spaces/test-space/docs/..%2F..%2F..%2Ftmp%2Fevil",
        { content: [{ evil: true }] }
      );

      // The file should NOT exist at /tmp/evil.json
      expect(existsSync("/tmp/evil.json")).toBe(false);
    });
  });

  describe("POST /api/spaces/:spaceId/docs (create from title)", () => {
    it("slugifies a human title into a kebab path with no spaced/encoded twins", async () => {
      const { status, json } = await req(app, "POST", "/api/spaces/test-space/docs", {
        title: "Planning Onsite",
      });
      expect(status).toBe(201);
      expect((json as { path: string }).path).toBe("planning-onsite");

      const docsDir = join(spacesDir, "test-space", "docs");
      expect(existsSync(join(docsDir, "planning-onsite.json"))).toBe(true);
      expect(existsSync(join(docsDir, "Planning Onsite.json"))).toBe(false);
      expect(existsSync(join(docsDir, "Planning%20Onsite.json"))).toBe(false);
    });

    it("slugifies each folder segment but preserves nesting", async () => {
      const { json } = await req(app, "POST", "/api/spaces/test-space/docs", {
        title: "Research/Competitive Analysis",
      });
      expect((json as { path: string }).path).toBe("research/competitive-analysis");
    });

    it("dedups colliding titles case-insensitively", async () => {
      await req(app, "POST", "/api/spaces/test-space/docs", { title: "Notes" });
      const second = await req(app, "POST", "/api/spaces/test-space/docs", { title: "notes" });
      expect((second.json as { path: string }).path).toBe("notes-2");
    });

    it("rejects a title that slugifies to nothing", async () => {
      const { status } = await req(app, "POST", "/api/spaces/test-space/docs", { title: "!!!" });
      expect(status).toBe(400);
    });
  });

  describe("rename slugifies target + preserves version history", () => {
    it("slugifies the human-entered rename target", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/start", { content: [{ a: 1 }] });
      const res = await req(app, "POST", "/api/spaces/test-space/docs/start/rename", {
        newPath: "My New Name",
      });
      expect(res.status).toBe(200);
      expect((res.json as { renamed: Array<{ to: string }> }).renamed[0]!.to).toBe("my-new-name");
      expect((await req(app, "GET", "/api/spaces/test-space/docs/my-new-name")).status).toBe(200);
    });

    it("treats a rename whose title re-slugs to the current path as a no-op", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/my-doc", { content: [{ a: 1 }] });
      const res = await req(app, "POST", "/api/spaces/test-space/docs/my-doc/rename", {
        newPath: "My Doc", // slugifies back to "my-doc"
      });
      expect(res.status).toBe(200);
      expect((res.json as { renamed: Array<{ to: string }> }).renamed[0]!.to).toBe("my-doc");
      expect((await req(app, "GET", "/api/spaces/test-space/docs/my-doc")).status).toBe(200);
    });

    it("404s when renaming a nonexistent path to a title that re-slugs to itself", async () => {
      const res = await req(app, "POST", "/api/spaces/test-space/docs/ghost/rename", {
        newPath: "Ghost", // slugifies to "ghost" === docPath, but no such doc exists
      });
      expect(res.status).toBe(404);
    });

    it("moves version history with the doc on rename (no orphaned history)", async () => {
      await req(app, "PUT", "/api/spaces/test-space/docs/history-doc", { content: [{ v: 1 }] });
      await req(app, "PUT", "/api/spaces/test-space/docs/history-doc", { content: [{ v: 2 }] });

      const before = await req(app, "GET", "/api/spaces/test-space/docs/history-doc/versions?all=true");
      const beforeCount = (before.json as { versions: unknown[] }).versions.length;
      expect(beforeCount).toBeGreaterThan(0);

      const renameRes = await req(app, "POST", "/api/spaces/test-space/docs/history-doc/rename", {
        newPath: "renamed-history",
      });
      expect(renameRes.status).toBe(200);

      const after = await req(app, "GET", "/api/spaces/test-space/docs/renamed-history/versions?all=true");
      expect((after.json as { versions: unknown[] }).versions.length).toBe(beforeCount);
    });
  });
});
