import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { buildTree, flattenTreeOrder, humanizeSegment } from "./tree";
import type { TreeNode } from "./tree";
import { searchResultDocumentView } from "./document-views";
import type { SearchResult } from "@worktable/types";

/** Collect all node names at any level */
function collectAllNodes(nodes: TreeNode[]): TreeNode[] {
  const all: TreeNode[] = [];
  for (const node of nodes) {
    all.push(node);
    all.push(...collectAllNodes(node.children));
  }
  return all;
}

describe("buildTree", () => {
  it("sorts folders before files at each level", () => {
    const tree = buildTree(["zebra", "folder/nested", "alpha"]);
    // folder should come first
    expect(tree[0]!.isFolder).toBe(true);
    expect(tree[0]!.name).toBe("folder");
    // then files alphabetically
    expect(tree[1]!.name).toBe("alpha");
    expect(tree[2]!.name).toBe("zebra");
  });

  // ── Display label (B+ model) ───────────────────────────

  it("humanizes the slug for the display label, keeping name structural", () => {
    const tree = buildTree([{ path: "planning-onsite" }]);
    expect(tree[0]!.name).toBe("planning-onsite"); // structural key unchanged
    expect(tree[0]!.label).toBe("Planning Onsite"); // title-cased for display
  });

  it("prefers a doc's first heading (H1) as the label over the slug", () => {
    const tree = buildTree([{ path: "q3-okrs", headings: ["Q3 OKRs", "Sub heading"] }]);
    expect(tree[0]!.label).toBe("Q3 OKRs");
  });

  it("humanizes folder segments and falls back to the slug for heading-less docs", () => {
    const tree = buildTree([{ path: "research-notes/raw-dump" }]);
    expect(tree[0]!.label).toBe("Research Notes"); // folder
    expect(tree[0]!.children[0]!.label).toBe("Raw Dump"); // heading-less leaf
  });

  it("keeps a doc's H1 label when the path is also a folder (doc-first order)", () => {
    const tree = buildTree([
      { path: "notes", headings: ["My Notes"] },
      { path: "notes/sub" },
    ]);
    const notes = tree.find((n) => n.name === "notes")!;
    expect(notes.isFolder).toBe(true);
    expect(notes.label).toBe("My Notes"); // H1 not wiped by promotion
  });

  it("applies a doc's H1 label when the node already existed (folder-first order)", () => {
    const tree = buildTree([
      { path: "notes/sub" },
      { path: "notes", headings: ["My Notes"] },
    ]);
    const notes = tree.find((n) => n.name === "notes")!;
    expect(notes.label).toBe("My Notes");
  });

  // ── Open document namespace ───────────────────────────

  it("defaults leaves to documents and creates implicit folders", () => {
    const tree = buildTree(["alpha", "folder/child"]);
    const alpha = tree.find((n) => n.name === "alpha")!;
    expect(alpha.kind).toBe("document");
    const folder = tree.find((n) => n.name === "folder")!;
    expect(folder.kind).toBe("folder");
    expect(folder.children[0]!.kind).toBe("document");
  });

  it("nests documents without branching on their open format id", () => {
    const tree = buildTree([
      {
        path: "plans/q3",
        title: "Q3 Plan",
        format: { id: "worktable.html", sourceVersion: 1 },
        health: "supported",
      },
      {
        path: "plans/canvas",
        title: "Canvas",
        format: { id: "future.diagram", sourceVersion: 3 },
        health: "unsupported-format",
      },
    ]);
    expect(tree.length).toBe(1);
    const folder = tree[0]!;
    expect(folder.name).toBe("plans");
    expect(folder.isFolder).toBe(true);
    expect(folder.kind).toBe("folder");
    expect(folder.children.map((node) => node.format?.id)).toEqual([
      "future.diagram",
      "worktable.html",
    ]);
    expect(folder.children.every((node) => node.kind === "document")).toBe(true);
  });

  it("keeps one node when a document path also has descendants", () => {
    const tree = buildTree([
      { path: "plans/q3/notes", title: "Notes" },
      {
        path: "plans/q3",
        title: "Q3 Plan",
        format: { id: "worktable.html", sourceVersion: 1 },
        health: "supported",
      },
    ]);
    const plans = tree.find((n) => n.name === "plans")!;
    const q3 = plans.children[0]!;
    expect(q3.path).toBe("plans/q3");
    expect(q3.kind).toBe("document");
    expect(q3.isFolder).toBe(true);
    expect(q3.label).toBe("Q3 Plan");
    expect(q3.children.map((node) => node.path)).toEqual(["plans/q3/notes"]);
  });

  it("keeps catalog conflicts as one inert namespace entry", () => {
    const tree = buildTree([
      {
        path: "dashboard",
        kind: "conflict",
        health: "ambiguous",
      },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      path: "dashboard",
      kind: "conflict",
      health: "ambiguous",
    });
  });

  it("humanizeSegment: dashes/underscores to title case", () => {
    expect(humanizeSegment("planning-onsite")).toBe("Planning Onsite");
    expect(humanizeSegment("weekly_sync_notes")).toBe("Weekly Sync Notes");
    expect(humanizeSegment("overview")).toBe("Overview");
  });

  // ── Property-based ─────────────────────────────────────

  it("builds one coherent namespace for every input path independent of insertion order", () => {
    const segment = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);
    const paths = fc.uniqueArray(fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/")), { maxLength: 20 });
    fc.assert(fc.property(paths, (input) => {
      const expected = new Set(input.flatMap((path) => path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
      for (const ordered of [input, [...input].reverse()]) {
        const nodes = collectAllNodes(buildTree(ordered));
        expect(nodes.length).toBe(expected.size);
        expect(new Set(nodes.map((node) => node.path))).toEqual(expected);
        for (const node of nodes) {
          expect(node.name).toBe(node.path.split("/").at(-1)!);
          const children = [...expected].filter((path) => path.slice(0, path.lastIndexOf("/")) === node.path && path.includes("/"));
          expect(new Set(node.children.map((child) => child.path))).toEqual(new Set(children));
          expect(node.isFolder).toBe(children.length > 0);
          expect(node.kind).toBe(input.includes(node.path) ? "document" : "folder");
        }
      }
    }), { numRuns: 200, examples: [[[]], [["-", "-/-", "0"]], [["a/b/c/d", "a/b/other", "standalone"]]] });
  });

  it("propagates freshness to doc leaves but not folders", () => {
    const freshness = { lastHumanTouch: null, ageDays: 45, humanReviewed: false, stale: true };
    const tree = buildTree([
      { path: "notes/stale-doc", freshness },
      { path: "notes/plain-doc" },
    ]);
    const folder = tree.find((n) => n.name === "notes");
    expect(folder?.isFolder).toBe(true);
    expect(folder?.freshness).toBeUndefined();
    const staleDoc = folder?.children.find((n) => n.name === "stale-doc");
    expect(staleDoc?.freshness).toEqual(freshness);
    const plainDoc = folder?.children.find((n) => n.name === "plain-doc");
    expect(plainDoc?.freshness).toBeUndefined();
  });

  it("keeps a doc's freshness when the path is later promoted to a folder", () => {
    const freshness = { lastHumanTouch: null, ageDays: 10, humanReviewed: false, stale: true };
    const tree = buildTree([
      { path: "guide", freshness },
      { path: "guide/child" },
    ]);
    const promoted = tree.find((n) => n.name === "guide");
    expect(promoted?.isFolder).toBe(true);
    expect(promoted?.freshness).toEqual(freshness);
  });

});

describe("document navigation policy", () => {
  it("opens only supported formats with an existing specialized view", () => {
    const base: SearchResult = {
      spaceId: "space",
      type: "doc",
      path: "item",
      title: "Item",
      score: 1,
    };
    const cases: Array<[SearchResult, "doc" | "html" | null]> = [
      [base, "doc"],
      [
        {
          ...base,
          documentKind: "document",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          health: "supported",
          documentView: "doc",
        },
        "doc",
      ],
      [
        {
          ...base,
          documentKind: "document",
          format: { id: "worktable.html", sourceVersion: 1 },
          health: "supported",
          documentView: "html",
        },
        "html",
      ],
      [
        {
          ...base,
          documentKind: "document",
          format: { id: "future.diagram", sourceVersion: 1 },
          health: "supported",
        },
        null,
      ],
      [
        {
          ...base,
          documentKind: "document",
          format: { id: "worktable.html", sourceVersion: 2 },
          health: "unsupported-version",
          documentView: "html",
        },
        null,
      ],
      [
        {
          ...base,
          documentKind: "conflict",
          health: "ambiguous",
        },
        null,
      ],
      [
        {
          spaceId: "space",
          type: "record",
          title: "Record",
          score: 1,
        },
        null,
      ],
    ];

    expect(
      cases.map(([result]) => searchResultDocumentView(result))
    ).toEqual(cases.map(([, expected]) => expected));
  });
});

describe("buildTree sorting", () => {
  it("orders siblings by docOrder, listed before unlisted", () => {
    const tree = buildTree(
      [{ path: "alpha" }, { path: "beta" }, { path: "gamma" }],
      { order: ["gamma", "alpha"] }
    );
    expect(tree.map((n) => n.path)).toEqual(["gamma", "alpha", "beta"]);
  });

  it("keeps folders grouped before docs regardless of order", () => {
    const tree = buildTree(
      [
        { path: "zzz-doc" },
        { path: "projected-folder" },
        { path: "folder/child" },
      ],
      { order: ["zzz-doc", "projected-folder", "folder"] },
      { folderPaths: new Set(["projected-folder"]) }
    );
    expect(tree.map((n) => n.path)).toEqual([
      "projected-folder",
      "folder",
      "zzz-doc",
    ]);
  });

  it("orders nested siblings inside a folder", () => {
    const tree = buildTree(
      [{ path: "f/one" }, { path: "f/two" }, { path: "f/three" }],
      { order: ["f/three", "f/one", "f/two"] }
    );
    const folder = tree[0];
    expect(folder.children.map((n) => n.path)).toEqual([
      "f/three",
      "f/one",
      "f/two",
    ]);
  });

  it("falls back to alphabetical without an order", () => {
    const tree = buildTree([{ path: "b" }, { path: "a" }]);
    expect(tree.map((n) => n.path)).toEqual(["a", "b"]);
  });

  it("alphabetical mode ignores the manual order", () => {
    const tree = buildTree(
      [{ path: "alpha" }, { path: "beta" }, { path: "gamma" }],
      { mode: "alphabetical", order: ["gamma", "alpha"] }
    );
    expect(tree.map((n) => n.path)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("updated mode sorts newest first; folders carry newest descendant", () => {
    const tree = buildTree(
      [
        { path: "old", updatedAt: "2026-01-01T00:00:00Z" },
        { path: "new", updatedAt: "2026-06-01T00:00:00Z" },
        { path: "f/stale", updatedAt: "2026-02-01T00:00:00Z" },
        { path: "f/fresh", updatedAt: "2026-07-01T00:00:00Z" },
      ],
      { mode: "updated" }
    );
    // Folder first (grouping), then docs newest-first.
    expect(tree.map((n) => n.path)).toEqual(["f", "new", "old"]);
    expect(tree[0].updatedAt).toBe(Date.parse("2026-07-01T00:00:00Z"));
    expect(tree[0].children.map((n) => n.path)).toEqual(["f/fresh", "f/stale"]);
  });

  it("docs without a timestamp sort last in updated mode", () => {
    const tree = buildTree(
      [{ path: "untimed" }, { path: "timed", updatedAt: "2026-06-01T00:00:00Z" }],
      { mode: "updated" }
    );
    expect(tree.map((n) => n.path)).toEqual(["timed", "untimed"]);
  });

  it("flattenTreeOrder captures display order and round-trips", () => {
    const tree = buildTree(
      [{ path: "b" }, { path: "a" }, { path: "f/y" }, { path: "f/x" }],
      { order: ["f/y", "f/x", "b", "a"] }
    );
    const order = flattenTreeOrder(tree);
    expect(order).toEqual(["f", "f/y", "f/x", "b", "a"]);
    // Rebuilding with the captured order reproduces the same display order.
    const rebuilt = buildTree(
      [{ path: "b" }, { path: "a" }, { path: "f/y" }, { path: "f/x" }],
      { order }
    );
    expect(flattenTreeOrder(rebuilt)).toEqual(order);
  });
});
