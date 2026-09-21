import { describe, it, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeDoc,
  writeSpace,
  createDocReviewCheckpoint,
  createManualDocCheckpoint,
  getDocProvenance,
  listDocVersions,
} from "./store.ts";
import { getDocFreshness, decorateDocsWithFreshness, evictFreshness } from "./freshness.ts";
import {
  getFreshnessCacheEntry,
  getFreshnessCacheGeneration,
  setFreshnessCacheEntryIfCurrent,
} from "./freshness-cache.ts";
import { listDocsDetailed } from "./store.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts";
import type { SpaceFile } from "@worktable/types";

const testDir = join(tmpdir(), `worktable-freshness-test-${Date.now()}`);
const spacesDir = join(testDir, "spaces");
const SPACE = "test-space";

function makeSpace(id: string, settings: SpaceFile["settings"] = {}): SpaceFile {
  const now = new Date().toISOString();
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: `Test Space ${id}`,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings,
  };
}

const agentWrite = { updatedBy: "worktable-agent", source: "mcp" } as const;
const humanWrite = { updatedBy: "user", source: "browser-yjs" } as const;

describe("doc freshness", () => {
  beforeEach(async () => {
    mkdirSync(spacesDir, { recursive: true });
    setWorkspaceRootOverride(testDir);
    await writeSpace(makeSpace(SPACE));
    evictFreshness(SPACE);
  });

  afterEach(() => {
    setSystemTime();
    setWorkspaceRootOverride(null);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("agent-written doc is not human reviewed and has no human touch", async () => {
    await writeDoc(SPACE, "agent-doc", "# Agent Doc\n\nBody.", agentWrite);
    const freshness = await getDocFreshness(SPACE, "agent-doc");
    expect(freshness.humanReviewed).toBe(false);
    expect(freshness.lastHumanTouch).toBeNull();
    expect(freshness.ageDays).toBe(0);
    expect(freshness.stale).toBe(false);
  });

  it("human edit counts as human touch and review", async () => {
    await writeDoc(SPACE, "human-doc", "# Human Doc", humanWrite);
    const freshness = await getDocFreshness(SPACE, "human-doc");
    expect(freshness.humanReviewed).toBe(true);
    expect(freshness.lastHumanTouch).not.toBeNull();
  });

  it("review checkpoint after an agent write marks the doc reviewed", async () => {
    // The production failure happened when both snapshots landed in one
    // millisecond. Keep that interleave deterministic: newest-first ordering
    // must use the version-id sequence, not filesystem enumeration order.
    setSystemTime(new Date("2026-07-13T14:17:32.773Z"));
    await writeDoc(SPACE, "doc", "# Doc\n\nAgent content.", agentWrite);
    const provenance = await createDocReviewCheckpoint(SPACE, "doc");
    expect(provenance).toBeDefined();
    evictFreshness(SPACE, "doc");

    const freshness = await getDocFreshness(SPACE, "doc");
    expect(freshness.humanReviewed).toBe(true);
    expect(freshness.lastHumanTouch).not.toBeNull();

    const versions = await listDocVersions(SPACE, "doc");
    expect(versions[0]?.id).toBe(provenance!.versionId);
    expect(versions[0]?.createdAt).toBe(versions[1]?.createdAt);
    expect(versions[0]?.checkpoint?.kind).toBe("review");
    expect(versions[0]?.checkpoint?.label).toBe("Reviewed");
  });

  it("agent write after a review honestly flips humanReviewed back to false", async () => {
    await writeDoc(SPACE, "doc", "# Doc\n\nv1", agentWrite);
    await createDocReviewCheckpoint(SPACE, "doc");
    await writeDoc(SPACE, "doc", "# Doc\n\nv2 tampered", agentWrite);

    const freshness = await getDocFreshness(SPACE, "doc");
    expect(freshness.humanReviewed).toBe(false);
    // The review still counts as the last human touch.
    expect(freshness.lastHumanTouch).not.toBeNull();
  });

  it("human manual checkpoint counts as a human touch", async () => {
    await writeDoc(SPACE, "doc", "# Doc", agentWrite);
    await createManualDocCheckpoint(SPACE, "doc", "Before big change", "user");
    const freshness = await getDocFreshness(SPACE, "doc");
    expect(freshness.humanReviewed).toBe(true);
  });

  it("cache follows every writer transition without explicit eviction", async () => {
    setSystemTime(new Date("2026-07-13T14:17:32.773Z"));
    // Cover agent→human, human→human, human→agent, and agent→agent with
    // a warm cache after every write, including same-millisecond versions.
    const writers = [false, true, true, false, false, true];
    for (const [revision, isHuman] of writers.entries()) {
      await writeDoc(
        SPACE, "doc", `# Doc\n\nv${revision}`,
        isHuman ? humanWrite : agentWrite,
      );
      expect((await getDocFreshness(SPACE, "doc")).humanReviewed).toBe(isHuman);
    }
  });

  it("does not cache freshness computed before an eviction", () => {
    const generation = getFreshnessCacheGeneration();
    evictFreshness(SPACE, "doc");

    const stored = setFreshnessCacheEntryIfCurrent(
      SPACE,
      "doc",
      {
        provenanceVersionId: "v1",
        lastHumanTouch: "2026-01-01T00:00:00.000Z",
        humanReviewed: true,
      },
      generation,
    );

    expect(stored).toBe(false);
    expect(getFreshnessCacheEntry(SPACE, "doc")).toBeUndefined();
  });

  it("clears cached freshness through the provider-neutral workspace reset event", async () => {
    const generation = getFreshnessCacheGeneration();
    expect(
      setFreshnessCacheEntryIfCurrent(
        SPACE,
        "doc",
        {
          provenanceVersionId: "v1",
          lastHumanTouch: null,
          humanReviewed: false,
        },
        generation,
      ),
    ).toBe(true);

    await notifyWorkspaceChangeAndWait({ type: "workspaceReset" });

    expect(getFreshnessCacheEntry(SPACE, "doc")).toBeUndefined();
    expect(getFreshnessCacheGeneration()).toBeGreaterThan(generation);
  });

  it("doc with no version history returns nulls and is not reviewed", async () => {
    // Simulate a file that appeared without going through writeDoc by
    // querying a path that has no versions or provenance.
    const freshness = await getDocFreshness(SPACE, "never-written");
    expect(freshness.lastHumanTouch).toBeNull();
    expect(freshness.ageDays).toBeNull();
    expect(freshness.humanReviewed).toBe(false);
    expect(freshness.stale).toBe(false);
  });

  it("decorateDocsWithFreshness attaches freshness to every listed doc", async () => {
    await writeDoc(SPACE, "a", "# A", agentWrite);
    await writeDoc(SPACE, "b", "# B", humanWrite);
    const docs = await decorateDocsWithFreshness(SPACE, await listDocsDetailed(SPACE));
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      expect(doc.freshness).toBeDefined();
    }
    const byPath = Object.fromEntries(docs.map((d) => [d.path, d.freshness]));
    expect(byPath["a"]?.humanReviewed).toBe(false);
    expect(byPath["b"]?.humanReviewed).toBe(true);
  });

  it("stale respects the staleAgeDays threshold against lastHumanTouch", async () => {
    await writeDoc(SPACE, "doc", "# Doc", humanWrite);
    const provenance = await getDocProvenance(SPACE, "doc");
    const fresh = await getDocFreshness(SPACE, "doc", { provenance, staleAgeDays: 30 });
    expect(fresh.stale).toBe(false);
    // A zero-day threshold makes anything older than "today" stale; a doc
    // touched moments ago is still within day zero.
    const strict = await getDocFreshness(SPACE, "doc", { provenance, staleAgeDays: 0.0001 });
    expect(strict.stale).toBe(false);
  });
});
