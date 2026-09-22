import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDoc, writeSpace, renameDoc, deleteDoc, listDocsDetailed } from "./store.ts";
import {
  extractDocLinkTargets,
  resolveDocLink,
  getSpaceLinkGraph,
  getDocLinks,
  decorateDocsWithBacklinkCounts,
  invalidateLinkGraph,
  setLinkGraphRebuildHookForTests,
} from "./link-graph.ts";
import { renameDocAndSync } from "./doc-rename.ts";
import {
  ensureWorkspaceManifest,
  getDocAliasesPath,
  setWorkspaceRootOverride,
} from "./workspace.ts";
import { setAppDirOverride } from "./app-storage.ts";
import type { SpaceFile } from "@worktable/types";

const testDir = join(tmpdir(), `worktable-link-graph-test-${Date.now()}`);
const appDir = join(tmpdir(), `worktable-link-graph-app-${Date.now()}`);
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

const write = (path: string, md: string) =>
  writeDoc(SPACE, path, md, { updatedBy: "test", source: "rest-api" });

describe("link graph", () => {
  it("shares a graph rebuild across concurrent readers", async () => {
    await write("source", "[target](target)")
    await write("target", "Target")
    let builds = 0
    setLinkGraphRebuildHookForTests(async () => {
      builds += 1
    })
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => getSpaceLinkGraph(SPACE))
      )
      expect(builds).toBe(1)
      expect(results.every((result) => result === results[0])).toBe(true)
      expect(results[0]!.inbound.get("target")).toEqual(["source"])
    } finally {
      setLinkGraphRebuildHookForTests(null)
    }
  })

  beforeEach(async () => {
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    mkdirSync(spacesDir, { recursive: true });
    await writeSpace(makeSpace(SPACE));
    invalidateLinkGraph();
  });

  afterEach(() => {
    setLinkGraphRebuildHookForTests(null);
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  describe("extractDocLinkTargets", () => {
    it("extracts markdown links but not images, code, or autolinks in fences", () => {
      const md = [
        "# Doc",
        "See [other](/notes/other) and [rel](../sibling).",
        "![diagram](/assets/pic.png)",
        "`[not a link](/code-span)`",
        "```",
        "[fenced](/inside-fence)",
        "```",
        "[external](https://example.com) [mail](mailto:x@y.z) [anchor](#section)",
      ].join("\n");
      expect(extractDocLinkTargets(md)).toEqual([
        "/notes/other",
        "../sibling",
        "https://example.com",
        "mailto:x@y.z",
        "#section",
      ]);
    });

    it("extracts BlockNote inline links including nested children", () => {
      const blocks = [
        {
          type: "paragraph",
          content: [{ type: "link", href: "/target-doc", content: [{ type: "text", text: "t" }] }],
          children: [
            { type: "paragraph", content: [{ type: "link", href: "nested", content: [] }] },
          ],
        },
      ];
      expect(extractDocLinkTargets(blocks)).toEqual(["/target-doc", "nested"]);
    });
  });

  describe("resolveDocLink", () => {
    it("resolves the matrix of link forms", () => {
      expect(resolveDocLink("planning/agenda", "/architecture")).toBe("architecture");
      expect(resolveDocLink("planning/agenda", "budget")).toBe("planning/budget");
      expect(resolveDocLink("planning/agenda", "./budget")).toBe("planning/budget");
      expect(resolveDocLink("planning/agenda", "../architecture")).toBe("architecture");
      expect(resolveDocLink("planning/agenda", "/notes/other.md")).toBe("notes/other");
      expect(resolveDocLink("planning/agenda", "/notes/other.json")).toBe("notes/other");
      expect(resolveDocLink("planning/agenda", "/notes/other#heading")).toBe("notes/other");
      expect(resolveDocLink("planning/agenda", "/notes/spaced%20name")).toBe("notes/spaced name");
    });

    it("returns null for external, anchor, and empty targets", () => {
      expect(resolveDocLink("a", "https://example.com/x")).toBeNull();
      expect(resolveDocLink("a", "mailto:x@y.z")).toBeNull();
      expect(resolveDocLink("a", "#anchor")).toBeNull();
      expect(resolveDocLink("a", "//cdn.example.com/x")).toBeNull();
      expect(resolveDocLink("a", "")).toBeNull();
      expect(resolveDocLink("a", "?query=only")).toBeNull();
    });

    it("clamps .. at the docs root instead of escaping", () => {
      expect(resolveDocLink("a", "../../../etc/passwd")).toBe("etc/passwd");
      expect(resolveDocLink("deep/nested/doc", "../../../../up")).toBe("up");
    });

    it("property: resolved paths never contain .. and never start with /", () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (from, target) => {
          const resolved = resolveDocLink(from, target);
          if (resolved === null) return true;
          return (
            !resolved.split("/").includes("..") &&
            !resolved.startsWith("/") &&
            resolved.length > 0
          );
        }),
        { numRuns: 500 }
      );
    });
  });

  describe("space graph", () => {
    it("builds outbound, inbound, orphans, and broken links", async () => {
      await write("hub", "# Hub\n\nSee [alpha](/alpha) and [missing](/never-written).");
      await write("alpha", "# Alpha\n\nBack to [hub](/hub).");
      await write("loner", "# Loner\n\nNo links here.");

      const graph = await getSpaceLinkGraph(SPACE);
      expect(graph.outbound.get("hub")?.map((l) => l.resolvedPath).sort()).toEqual([
        "alpha",
        "never-written",
      ]);
      expect(graph.inbound.get("alpha")).toEqual(["hub"]);
      expect(graph.inbound.get("hub")).toEqual(["alpha"]);
      expect(graph.orphans.sort()).toEqual(["loner", "never-written"].filter((p) => p === "loner"));
      expect(graph.broken).toEqual([
        { docPath: "hub", target: "/never-written", resolvedPath: "never-written" },
      ]);
    });

    it("backlinks are symmetric with outbound resolved links", async () => {
      await write("a", "# A\n\n[b](/b)");
      await write("b", "# B\n\n[c](/c)");
      await write("c", "# C\n\n[a](/a)");

      const graph = await getSpaceLinkGraph(SPACE);
      for (const [source, links] of graph.outbound) {
        for (const link of links) {
          if (!link.resolved) continue;
          expect(graph.inbound.get(link.resolvedPath)).toContain(source);
        }
      }
    });

    it("invalidates on writes without explicit invalidation calls", async () => {
      await write("a", "# A\n\nno links");
      let links = await getDocLinks(SPACE, "a");
      expect(links.links).toEqual([]);

      await write("a", "# A\n\n[b](/b)");
      links = await getDocLinks(SPACE, "a");
      expect(links.links.map((l) => l.resolvedPath)).toEqual(["b"]);
    });

    it("discards an old-workspace build that finishes after a reset", async () => {
      await write("hub", "# Hub\n\n[old](/old)");
      await write("old", "# Old");

      let entered!: () => void;
      let release!: () => void;
      const rebuilding = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let blocked = false;
      setLinkGraphRebuildHookForTests(async () => {
        if (blocked) return;
        blocked = true;
        entered();
        await gate;
      });

      invalidateLinkGraph();
      const inFlight = getSpaceLinkGraph(SPACE);
      await rebuilding;

      const replacement = mkdtempSync(join(tmpdir(), "worktable-link-replacement-"));
      try {
        setWorkspaceRootOverride(replacement);
        await writeSpace(makeSpace(SPACE));
        await write("hub", "# Hub\n\n[new](/new)");
        await write("new", "# New");
        release();

        const graph = await inFlight;
        expect(graph.outbound.get("hub")?.map((link) => link.resolvedPath)).toEqual([
          "new",
        ]);
        expect(graph.inbound.get("new")).toEqual(["hub"]);
        expect(graph.inbound.has("old")).toBe(false);
      } finally {
        setWorkspaceRootOverride(testDir);
        rmSync(replacement, { recursive: true, force: true });
      }
    });

    it("rename leaves the old target reported as broken", async () => {
      await write("hub", "# Hub\n\n[alpha](/alpha)");
      await write("alpha", "# Alpha");
      expect((await getDocLinks(SPACE, "hub")).links[0]?.resolved).toBe(true);

      await renameDoc(SPACE, "alpha", "renamed-alpha");
      const after = await getDocLinks(SPACE, "hub");
      expect(after.links[0]?.resolved).toBe(false);
      const graph = await getSpaceLinkGraph(SPACE);
      expect(graph.broken.map((b) => b.resolvedPath)).toEqual(["alpha"]);
    });

    it("managed rename keeps old authored targets resolved through aliases", async () => {
      await write("hub", "# Hub\n\n[alpha](/alpha)");
      await write("alpha", "# Alpha");

      expect((await renameDocAndSync(SPACE, "alpha", "renamed-alpha")).error).toBeNull();
      const after = await getDocLinks(SPACE, "hub");
      expect(after.links).toEqual([
        { target: "/alpha", resolvedPath: "renamed-alpha", resolved: true },
      ]);
      expect((await getSpaceLinkGraph(SPACE)).broken).toEqual([]);
    });

    it("fails closed when the portable alias state is corrupt", async () => {
      await write("source", "See [target](/old-target).\n");
      writeFileSync(getDocAliasesPath(SPACE), "{not-json", "utf8");
      invalidateLinkGraph();

      await expect(getSpaceLinkGraph(SPACE)).rejects.toThrow(
        "Corrupt document alias file"
      );
    });

    it("fails closed when a valid alias file contains a cycle", async () => {
      await write("source", "See [target](/a).\n");
      writeFileSync(
        getDocAliasesPath(SPACE),
        JSON.stringify({
          type: "worktable.doc-aliases",
          version: 1,
          exact: { a: "b", b: "a" },
          prefixes: {},
        }),
        "utf8"
      );
      invalidateLinkGraph();

      await expect(getSpaceLinkGraph(SPACE)).rejects.toThrow(
        "cycle or hop limit"
      );
    });

    it("delete removes the doc from the graph", async () => {
      await write("a", "# A\n\n[b](/b)");
      await write("b", "# B");
      await deleteDoc(SPACE, "b");
      const graph = await getSpaceLinkGraph(SPACE);
      expect(graph.broken.map((b) => b.resolvedPath)).toEqual(["b"]);
      expect(graph.inbound.has("b")).toBe(false);
    });

    it("self-links and duplicate targets are ignored/deduped", async () => {
      await write("a", "# A\n\n[self](/a) [b](/b) [b again](/b)");
      await write("b", "# B");
      const { links } = await getDocLinks(SPACE, "a");
      expect(links.map((l) => l.resolvedPath)).toEqual(["b"]);
      const graph = await getSpaceLinkGraph(SPACE);
      expect(graph.inbound.get("b")).toEqual(["a"]);
    });
  });

  it("decorateDocsWithBacklinkCounts annotates lists", async () => {
    await write("hub", "# Hub\n\n[a](/a) [b](/b)");
    await write("a", "# A\n\n[b](/b)");
    await write("b", "# B");

    const docs = await decorateDocsWithBacklinkCounts(SPACE, await listDocsDetailed(SPACE));
    const counts = Object.fromEntries(docs.map((d) => [d.path, d.backlinkCount]));
    expect(counts).toEqual({ hub: 0, a: 1, b: 2 });
  });
});
