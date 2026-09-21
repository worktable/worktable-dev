import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDoc, writeSpace, setDocArchived, slugifyDocPath } from "./store.ts";
import { buildSpaceIndex } from "./space-index.ts";
import { dispatchOperation } from "./mcp/dispatcher.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import type { SpaceFile } from "@worktable/types";

const testDir = join(tmpdir(), `worktable-space-index-test-${Date.now()}`);
const spacesDir = join(testDir, "spaces");
// Unique space id: immune to stray writes leaking from other test files.
const SPACE = "space-index-space";

function makeSpace(id: string): SpaceFile {
  const now = new Date().toISOString();
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: `Space ${id}`,
    description: "An indexed space",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  };
}

const write = (path: string, md: string, human = false) =>
  writeDoc(SPACE, path, md, human
    ? { updatedBy: "user", source: "browser-yjs" }
    : { updatedBy: "worktable-agent", source: "mcp" });

describe("space index", () => {
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

  it("groups docs by top-level folder with root first", async () => {
    await write("readme", "# Readme");
    await write("guides/setup", "# Setup Guide");
    await write("guides/usage", "# Usage");
    await write("reference/api", "# API");

    const index = await buildSpaceIndex(SPACE);
    expect(index?.name).toBe(`Space ${SPACE}`);
    expect(index?.docCount).toBe(4);
    expect(index?.groups.map((g) => g.folder)).toEqual(["", "guides", "reference"]);
    expect(index?.groups[0]?.label).toBe("Overview");
    expect(index?.groups[1]?.label).toBe("Guides");
    expect(index?.groups[1]?.docs.map((d) => d.path)).toEqual(["guides/setup", "guides/usage"]);
  });

  it("derives titles from H1 with humanized-slug fallback", async () => {
    await write("titled", "# A Proper Title\n\nbody");
    await write("guides/no-heading-here", "just prose, no heading");

    const index = await buildSpaceIndex(SPACE);
    const all = index!.groups.flatMap((g) => g.docs);
    expect(all.find((d) => d.path === "titled")?.title).toBe("A Proper Title");
    expect(all.find((d) => d.path === "guides/no-heading-here")?.title).toBe("No Heading Here");
  });

  it("excludes archived docs and carries freshness + backlink counts", async () => {
    await write("hub", "# Hub\n\n[a](/a)", true);
    await write("a", "# A");
    await write("old", "# Old");
    await setDocArchived(SPACE, "old", true);

    const index = await buildSpaceIndex(SPACE);
    const all = index!.groups.flatMap((g) => g.docs);
    expect(all.map((d) => d.path).sort()).toEqual(["a", "hub"]);
    const a = all.find((d) => d.path === "a");
    expect(a?.backlinkCount).toBe(1);
    expect(a?.freshness?.humanReviewed).toBe(false);
    expect(all.find((d) => d.path === "hub")?.freshness?.humanReviewed).toBe(true);
  });

  it("returns null for a missing space", async () => {
    expect(await buildSpaceIndex("nope")).toBeNull();
  });

  it("MCP workspace.space_index returns the same shape and throws on missing space", async () => {
    await write("readme", "# Readme");
    const { index } = (await dispatchOperation("workspace.space_index", { spaceId: SPACE })) as {
      index: { spaceId: string; groups: { docs: { path: string }[] }[] };
    };
    expect(index.spaceId).toBe(SPACE);
    expect(index.groups[0]?.docs[0]?.path).toBe("readme");

    expect(dispatchOperation("workspace.space_index", { spaceId: "nope" })).rejects.toThrow(/not found/i);
  });

  it("property: every doc appears in exactly one group", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.stringMatching(/^[a-z]{1,8}(\/[a-z]{1,8}){0,2}$/),
          { minLength: 1, maxLength: 12, selector: (p) => slugifyDocPath(p) }
        ),
        async (paths) => {
          const spaceId = `prop-${Math.random().toString(36).slice(2, 10)}`;
          await writeSpace(makeSpace(spaceId));
          const written = new Set<string>();
          for (const path of paths) {
            const result = await writeDoc(spaceId, path, `# Doc`, { updatedBy: "t", source: "rest-api" });
            if (result.ok) written.add(slugifyDocPath(path));
          }
          const index = await buildSpaceIndex(spaceId);
          const seen = index!.groups.flatMap((g) => g.docs.map((d) => d.path));
          return seen.length === new Set(seen).size && seen.length === written.size;
        }
      ),
      { numRuns: 10 }
    );
  }, 15_000);
});
