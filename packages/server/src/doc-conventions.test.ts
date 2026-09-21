import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSpace } from "./store.ts";
import { validateDocConventions, type DocConventionIssue } from "./doc-conventions.ts";
import { WIKI_DEFAULTS } from "./wiki-config.ts";
import { dispatchOperation } from "./mcp/dispatcher.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import type { SpaceFile } from "@worktable/types";

const testDir = join(tmpdir(), `worktable-doc-conventions-test-${Date.now()}`);
const spacesDir = join(testDir, "spaces");
const SPACE = "doc-conventions-space";

function makeSpace(id: string, settings: SpaceFile["settings"] = {}): SpaceFile {
  const now = new Date().toISOString();
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings,
  };
}

const codes = (issues: DocConventionIssue[]) => issues.map((i) => i.code).sort();

describe("doc conventions", () => {
  describe("validateDocConventions (pure)", () => {
    const cfg = WIKI_DEFAULTS;

    it("flags deep paths as a warning, never blocking", () => {
      const issues = validateDocConventions({
        docPath: "a/b/c/doc",
        content: "# Ok",
        links: [],
        cfg,
      });
      const deep = issues.find((i) => i.code === "folder_too_deep");
      expect(deep?.severity).toBe("warning");
      expect(deep?.message).toContain("budget 2");
    });

    it("flags over-length markdown and missing H1", () => {
      const long = Array.from({ length: cfg.docLengthBudgetLines + 1 }, () => "line").join("\n");
      expect(codes(validateDocConventions({ docPath: "d", content: long, links: [], cfg }))).toEqual([
        "doc_over_length_budget",
        "missing_h1",
      ]);
    });

    it("flags broken outbound links with targets in the message", () => {
      const issues = validateDocConventions({
        docPath: "d",
        content: "# D",
        links: [
          { target: "/gone", resolvedPath: "gone", resolved: false },
          { target: "/here", resolvedPath: "here", resolved: true },
        ],
        cfg,
      });
      const broken = issues.find((i) => i.code === "broken_outbound_link");
      expect(broken?.severity).toBe("warning");
      expect(broken?.message).toContain("/gone");
      expect(broken?.message).not.toContain("/here");
    });

    it("clean doc yields no issues", () => {
      expect(
        validateDocConventions({ docPath: "notes/clean", content: "# Clean\n\nbody", links: [], cfg })
      ).toEqual([]);
    });
  });

  describe("MCP write integration", () => {
    beforeEach(async () => {
      mkdirSync(spacesDir, { recursive: true });
      setWorkspaceRootOverride(testDir);
      await writeSpace(makeSpace(SPACE));
    });

    afterEach(() => {
      setWorkspaceRootOverride(null);
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it("deep-path write SUCCEEDS and returns the warning", async () => {
      const result = (await dispatchOperation("docs.write", {
        spaceId: SPACE,
        docPath: "a/b/c/buried",
        content: "# Buried\n\n[gone](/never-written)",
      })) as { ok: boolean; warnings: DocConventionIssue[] };
      expect(result.ok).toBe(true);
      expect(codes(result.warnings)).toEqual(["broken_outbound_link", "folder_too_deep"]);
    });

    it("clean write returns empty warnings; patch returns warnings on final state", async () => {
      const clean = (await dispatchOperation("docs.write", {
        spaceId: SPACE,
        docPath: "notes",
        content: "# Notes\n\nfine",
      })) as { warnings: DocConventionIssue[] };
      expect(clean.warnings).toEqual([]);

      const patched = (await dispatchOperation("docs.patch", {
        spaceId: SPACE,
        docPath: "notes",
        operations: [{ action: "append", content: "See [missing](/not-yet-written)." }],
      })) as { ok: boolean; warnings: DocConventionIssue[] };
      expect(patched.ok).toBe(true);
      expect(codes(patched.warnings)).toEqual(["broken_outbound_link"]);
    });

    it("per-space budget override reaches the write path", async () => {
      await writeSpace(makeSpace(SPACE, { wiki: { folderDepthBudget: 5 } }));
      const result = (await dispatchOperation("docs.write", {
        spaceId: SPACE,
        docPath: "a/b/c/deepish",
        content: "# Ok",
      })) as { warnings: DocConventionIssue[] };
      expect(result.warnings).toEqual([]);
    });
  });
});
