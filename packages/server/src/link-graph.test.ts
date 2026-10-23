import { writeManagedFixtureDoc as writeDoc } from "./fixtures/managed-content.ts"
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSpace, renameDoc, deleteDoc, listDocsDetailed } from "./store.ts";
import {
  extractDocLinks,
  extractDocLinkTargets,
  peekDocBacklinks,
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
import { pathMovesFor } from "./doc-aliases.ts";
import { notifyWorkspaceChange } from "./workspace-events.ts";
import { noteAllSpacesChanged } from "./workspace-read-model.ts";
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
    it("extracts markdown links and embeds, but not code or links in fences", () => {
      const md = [
        "# Doc",
        "See [other](/notes/other) and [rel](../sibling).",
        "![diagram](/assets/pic.png)",
        '<img data-alt="x" title=\'use src="old.png"\' alt="Error" data-src="lazy.png" src="shots/error.png">',
        '<img alt="A &amp; B" src="shots/a&amp;b.png">',
        "`[not a link](/code-span)`",
        "```",
        "[fenced](/inside-fence)",
        "```",
        "~~~html",
        '<img src="example.png"> [tilde](/inside-tilde-fence)',
        "~~~",
        "[external](https://example.com) [mail](mailto:x@y.z) [anchor](#section)",
      ].join("\n");
      expect(extractDocLinkTargets(md)).toEqual([
        "/notes/other",
        "../sibling",
        "/assets/pic.png",
        "https://example.com",
        "mailto:x@y.z",
        "#section",
        "shots/error.png",
        "shots/a&b.png",
      ]);
      expect(
        extractDocLinks(md).flatMap((link) =>
          link.embed ? [[link.target, link.context]] : []
        )
      ).toEqual([
        ["/assets/pic.png", "diagram"],
        ["shots/error.png", "Error"],
        ["shots/a&b.png", "A & B"],
      ]);
    });

    it("extracts BlockNote links, media blocks and table links, including nested children", () => {
      const blocks = [
        {
          type: "paragraph",
          content: [{ type: "link", href: "/target-doc", content: [{ type: "text", text: "t" }] }],
          children: [
            { type: "paragraph", content: [{ type: "link", href: "nested", content: [] }] },
          ],
        },
        {
          type: "image",
          props: { url: "spec/error.png", caption: "Signup error", name: "error.png" },
          children: [],
        },
        { type: "file", props: { url: "", name: "empty" }, children: [] },
        {
          type: "table",
          content: {
            type: "tableContent",
            rows: [
              {
                cells: [
                  {
                    type: "tableCell",
                    content: [{ type: "link", href: "in-table", content: [] }],
                  },
                ],
              },
            ],
          },
          children: [],
        },
      ];
      expect(extractDocLinkTargets(blocks)).toEqual([
        "/target-doc",
        "nested",
        "spec/error.png",
        "in-table",
      ]);
      expect(extractDocLinks(blocks)[2]).toMatchObject({
        target: "spec/error.png",
        context: "Signup error",
        embed: true,
      });
    });
  });

  describe("extractDocLinks", () => {
    it("keeps the sentence each link sits in, with the link's words marked", () => {
      const longSentence = `This one sentence ${"keeps going ".repeat(16)}until [far](/far) appears and then ${"carries on ".repeat(10)}to the end.`;
      const md = [
        "- See the [plan](/plans/arrival) for **dates** and `invitations@example.com`.",
        "```",
        "[fenced](/inside-fence)",
        "```",
        "An opening sentence. A link whose text [wraps",
        "onto a new line](/wrapped) still counts. A closing sentence.",
        "",
        longSentence,
        "## The [roadmap](/roadmap)",
        "A paragraph right under the heading.",
      ].join("\n");
      const links = extractDocLinks(md);
      expect(links).toHaveLength(4);
      // A heading is its own block, even with no blank line after it.
      expect(links[3]).toEqual({
        target: "/roadmap",
        context: "The roadmap",
        mark: { start: 4, length: 7 },
      });
      expect(links[0]).toEqual({
        target: "/plans/arrival",
        context: "See the plan for dates and invitations@example.com.",
        mark: { start: 8, length: 4 },
      });
      // Only the sentence, though the paragraph spans two lines and three sentences.
      expect(links[1]).toEqual({
        target: "/wrapped",
        context: "A link whose text wraps onto a new line still counts.",
        mark: { start: 18, length: 21 },
      });
      const far = links[2]!;
      expect(far.context.startsWith("…")).toBe(true);
      expect(far.context.length).toBeLessThanOrEqual(162);
      expect(far.context.slice(far.mark!.start, far.mark!.start + far.mark!.length)).toBe("far");

      const blocks = [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Builds on " },
            { type: "link", href: "/research/mocks", content: [{ type: "text", text: "the mockups" }] },
            { type: "text", text: ". Then something else." },
          ],
        },
      ];
      expect(extractDocLinks(blocks)).toEqual([
        {
          target: "/research/mocks",
          context: "Builds on the mockups.",
          mark: { start: 10, length: 11 },
        },
      ]);
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

    it("counts a Doc's embeds as uses of the file, once files are on", async () => {
      const shots = join(spacesDir, SPACE, "docs", "spec");
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, "error.png"), "png");
      await write("spec", "# Spec\n\n![Signup error](spec/error.png)\n\n![Gone](spec/gone.png)");
      await write("bug", "# Bug\n\n![Same screen](/spec/error.png)");

      const previous = process.env["WORKTABLE_FILES_PREVIEW"];
      try {
        process.env["WORKTABLE_FILES_PREVIEW"] = "0";
        noteAllSpacesChanged();
        invalidateLinkGraph();
        let graph = await getSpaceLinkGraph(SPACE);
        expect(graph.inbound.get("spec/error.png")).toBeUndefined();
        expect(graph.broken).toEqual([]);

        process.env["WORKTABLE_FILES_PREVIEW"] = "1";
        noteAllSpacesChanged();
        invalidateLinkGraph();
        graph = await getSpaceLinkGraph(SPACE);
        expect(graph.inbound.get("spec/error.png")?.sort()).toEqual(["bug", "spec"]);
        expect(graph.inboundContext.get("spec/error.png")?.get("spec")?.context).toBe(
          "Signup error"
        );
        // A missing file shows as a broken embed, as a missing Doc does.
        expect(graph.broken).toEqual([
          { docPath: "spec", target: "spec/gone.png", resolvedPath: "spec/gone.png" },
        ]);
      } finally {
        if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"];
        else process.env["WORKTABLE_FILES_PREVIEW"] = previous;
      }
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

      // A Doc written outside the store is picked up from a catalog event.
      writeFileSync(join(spacesDir, SPACE, "docs", "c.md"), "# C\n\n[a](/a)");
      notifyWorkspaceChange({ type: "documentCorpus", spaceId: SPACE });
      links = await getDocLinks(SPACE, "a");
      expect(links.backlinks).toEqual(["c"]);
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

  it("peekDocBacklinks answers from the last build and refreshes in the background", async () => {
    await write("target", "Target");
    await write("first", "Read [the target](target) first.");
    // A Space never built has no answer yet; asking starts a build without waiting.
    expect(peekDocBacklinks("never-built", "target")).toBeNull();
    await getSpaceLinkGraph(SPACE);
    const first = {
      path: "first",
      context: "Read the target first.",
      mark: { start: 5, length: 10 },
      count: 1,
    };
    expect(peekDocBacklinks(SPACE, "target")).toEqual([first]);

    await write("second", "Also [target](/target). And [again](/target).");
    // The graph is out of date: the last answer stands while it rebuilds.
    expect(peekDocBacklinks(SPACE, "target")).toEqual([first]);
    await getSpaceLinkGraph(SPACE);
    expect(peekDocBacklinks(SPACE, "target")?.find((link) => link.path === "second")).toEqual({
      path: "second",
      context: "Also target.",
      mark: { start: 5, length: 6 },
      count: 2,
    });

    // Until the rebuild after a move lands, the old paths name the moved docs.
    const moved = pathMovesFor({
      exact: { target: "renamed", first: "notes/first" },
      prefixes: {},
    });
    expect(peekDocBacklinks(SPACE, "renamed", moved)?.map((link) => link.path).sort()).toEqual([
      "notes/first",
      "second",
    ]);
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
