import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDoc, writeSpace, createDocReviewCheckpoint } from "./store.ts";
import { evictFreshness } from "./freshness.ts";
import { dispatchOperation } from "./mcp/dispatcher.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import type { SpaceFile } from "@worktable/types";

const testDir = join(tmpdir(), `worktable-mcp-freshness-test-${Date.now()}`);
const spacesDir = join(testDir, "spaces");
const SPACE = "test-space";

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

describe("MCP freshness exposure", () => {
  beforeEach(async () => {
    mkdirSync(spacesDir, { recursive: true });
    setWorkspaceRootOverride(testDir);
    await writeSpace(makeSpace(SPACE));
    evictFreshness(SPACE);
  });

  afterEach(() => {
    setWorkspaceRootOverride(null);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("read_doc carries trust signals that flip with review state", async () => {
    await dispatchOperation("docs.write", {
      spaceId: SPACE,
      docPath: "notes",
      content: "# Notes\n\nAgent draft.",
    });

    const unreviewed = (await dispatchOperation("docs.read", {
      spaceId: SPACE,
      docPath: "notes",
    })) as { humanReviewed: boolean; lastHumanTouch: string | null; ageDays: number | null; stale: boolean };
    expect(unreviewed.humanReviewed).toBe(false);
    expect(unreviewed.lastHumanTouch).toBeNull();
    expect(unreviewed.ageDays).toBe(0);

    await createDocReviewCheckpoint(SPACE, "notes");
    const reviewed = (await dispatchOperation("docs.read", {
      spaceId: SPACE,
      docPath: "notes",
    })) as { humanReviewed: boolean };
    expect(reviewed.humanReviewed).toBe(true);
  });

  it("list_docs and state include freshness per doc", async () => {
    await dispatchOperation("docs.write", { spaceId: SPACE, docPath: "a", content: "# A" });

    const listed = (await dispatchOperation("docs.list", { spaceId: SPACE })) as {
      docs: { path: string; freshness?: { humanReviewed: boolean } }[];
    };
    expect(listed.docs[0]?.freshness?.humanReviewed).toBe(false);

    const state = (await dispatchOperation("workspace.state", { spaceId: SPACE })) as {
      docs: { freshness?: { humanReviewed: boolean } }[];
    };
    expect(state.docs[0]?.freshness).toBeDefined();
  });

  it("search doc hits carry humanReviewed", async () => {
    await dispatchOperation("docs.write", {
      spaceId: SPACE,
      docPath: "findable",
      content: "# Findable\n\nzebra unicorn content",
    });

    const { results } = (await dispatchOperation("workspace.search", { query: "zebra" })) as {
      results: { path?: string; humanReviewed?: boolean; lastHumanTouch?: string | null }[];
    };
    const hit = results.find((r) => r.path === "findable");
    expect(hit).toBeDefined();
    expect(hit?.humanReviewed).toBe(false);
    expect(hit?.lastHumanTouch).toBeNull();
  });
});
