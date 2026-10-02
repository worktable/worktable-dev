import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSpace } from "./store.ts";
import { validateDocConventions, type DocConventionIssue } from "./doc-conventions.ts";
import { dispatchOperation } from "./mcp/dispatcher.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import type { SpaceFile } from "@worktable/types";

const testDir = join(tmpdir(), `worktable-doc-conventions-test-${Date.now()}`);
const spacesDir = join(testDir, "spaces");
const SPACE = "doc-conventions-space";

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

const codes = (issues: DocConventionIssue[]) => issues.map((i) => i.code).sort();

describe("doc conventions", () => {
  describe("validateDocConventions (pure)", () => {
    it("hints at a missing H1 in markdown and BlockNote content", () => {
      expect(codes(validateDocConventions({ content: "no heading", links: [] }))).toEqual(["missing_h1"]);
      expect(
        codes(validateDocConventions({ content: [{ type: "paragraph", content: [] }], links: [] }))
      ).toEqual(["missing_h1"]);
    });

    it("flags broken outbound links with targets in the message", () => {
      const issues = validateDocConventions({
        content: "# D",
        links: [
          { target: "/gone", resolvedPath: "gone", resolved: false },
          { target: "/here", resolvedPath: "here", resolved: true },
        ],
      });
      const broken = issues.find((i) => i.code === "broken_outbound_link");
      expect(broken?.severity).toBe("warning");
      expect(broken?.message).toContain("/gone");
      expect(broken?.message).not.toContain("/here");
    });

    it("does not judge length or folder depth", () => {
      const long = ["# Long", ...Array.from({ length: 2_000 }, () => "line")].join("\n");
      expect(validateDocConventions({ content: long, links: [] })).toEqual([]);
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

    it("deep-path write succeeds and returns only the broken-link warning", async () => {
      const result = (await dispatchOperation("docs.write", { lifetime: "durable",
        spaceId: SPACE,
        docPath: "a/b/c/buried",
        content: "# Buried\n\n[gone](/never-written)",
      })) as { ok: boolean; warnings: DocConventionIssue[] };
      expect(result.ok).toBe(true);
      expect(codes(result.warnings)).toEqual(["broken_outbound_link"]);
    });

    it("clean write returns empty warnings; patch returns warnings on final state", async () => {
      const clean = (await dispatchOperation("docs.write", { lifetime: "durable",
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
  });
});
