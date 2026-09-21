import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isMarkdownSafe,
  extractHeadings,
  extractMarkdownHeadings,
  detectContentFormat,
  containsMermaidBlock,
  getRichBlockTypes,
  summarizeBlocks,
  applyPatchOperations,
  blocksToMarkdownSafe,
} from "./markdown.ts";
import { dispatchOperation } from "./mcp/dispatcher.ts";

import {
  readDoc,
  writeDoc,
  docExists,
  docStat,
  listDocs,
  deleteDoc,
  renameDoc,
  writeSpace,
} from "./store.ts";
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts";
import { setAppDirOverride } from "./app-storage.ts";
import type { SpaceFile } from "@worktable/types";

// ── Test Setup ───────────────────────────────────────────

const testDir = join(tmpdir(), `worktable-md-test-${Date.now()}`);
const appDir = join(tmpdir(), `worktable-md-app-${Date.now()}`);
const spacesDir = join(testDir, "spaces");

function makeSpace(id: string): SpaceFile {
  const now = new Date().toISOString();
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: `Test Space ${id}`,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  };
}

describe("markdown support", () => {
  beforeEach(async () => {
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    mkdirSync(spacesDir, { recursive: true });
    await writeSpace(makeSpace("test-space"));
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

  // ── isMarkdownSafe ─────────────────────────────────────

  describe("isMarkdownSafe", () => {
    it("returns safe for standard blocks", () => {
      const blocks = [
        { type: "paragraph", props: {}, content: [{ type: "text", text: "hello", styles: {} }], children: [] },
        { type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Title", styles: {} }], children: [] },
        { type: "bulletListItem", props: {}, content: [{ type: "text", text: "item", styles: {} }], children: [] },
        { type: "codeBlock", props: { language: "js" }, content: [{ type: "text", text: "code", styles: {} }], children: [] },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(true);
      expect(result.lossyFields).toEqual([]);
    });

    it("treats a default mermaid block as markdown-safe", () => {
      const blocks = [
        { type: "paragraph", props: {}, content: [], children: [] },
        { type: "mermaid", props: { data: "graph TD" }, content: [], children: [] },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(true);
      expect(result.lossyFields).toEqual([]);
    });

    it("normalizes legacy Mermaid source before markdown serialization", async () => {
      const blocks = [
        {
          type: "mermaid",
          props: { code: "flowchart TD\nLegacy-->Preserved" },
          children: [],
        },
      ];

      expect(isMarkdownSafe(blocks).safe).toBe(true);
      const markdown = await blocksToMarkdownSafe(blocks);
      expect(markdown).toContain("```mermaid");
      expect(markdown).toContain("flowchart TD\nLegacy-->Preserved");
    });

    it("detects mermaid UI state that a fence cannot preserve", () => {
      const result = isMarkdownSafe([
        {
          type: "mermaid",
          props: { data: "graph TD", title: "Named flow", locked: "true" },
          content: [],
          children: [],
        },
      ]);
      expect(result.safe).toBe(false);
      expect(result.lossyFields).toContain("mermaid:title");
      expect(result.lossyFields).toContain("mermaid:locked");
    });

    it("treats unknown Mermaid props as lossy forward-compatible metadata", () => {
      const result = isMarkdownSafe([
        {
          type: "mermaid",
          props: { data: "graph TD", futureLayout: "elk-v2" },
          content: [],
          children: [],
        },
      ]);

      expect(result.safe).toBe(false);
      expect(result.lossyFields).toContain("mermaid:prop:futureLayout");
    });

    it("detects textColor as lossy", () => {
      const blocks = [
        { type: "paragraph", props: { textColor: "red" }, content: [], children: [] },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(false);
      expect(result.lossyFields).toContain("textColor");
    });

    it("detects backgroundColor as lossy", () => {
      const blocks = [
        { type: "paragraph", props: { backgroundColor: "blue" }, content: [], children: [] },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(false);
      expect(result.lossyFields).toContain("backgroundColor");
    });

    it("detects textAlignment as lossy", () => {
      const blocks = [
        { type: "paragraph", props: { textAlignment: "center" }, content: [], children: [] },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(false);
      expect(result.lossyFields).toContain("textAlignment");
    });

    it("detects underline inline style as lossy", () => {
      const blocks = [
        { type: "paragraph", props: {}, content: [{ type: "text", text: "underlined", styles: { underline: true } }], children: [] },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(false);
      expect(result.lossyFields).toContain("style:underline");
    });

    it("detects lossy styles inside legacy array-shaped table cells", () => {
      const blocks = [
        {
          type: "table",
          props: {},
          content: {
            type: "tableContent",
            rows: [{ cells: [[{ type: "text", text: "u", styles: { underline: true } }]] }],
          },
          children: [],
        },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(false);
      expect(result.lossyFields).toContain("style:underline");
    });

    it("detects lossy styles and colored props inside 0.51 tableCell-object cells", () => {
      const cell = (inline: unknown[], props: Record<string, unknown>) => ({
        type: "tableCell",
        content: inline,
        props: { backgroundColor: "default", textColor: "default", textAlignment: "left", ...props },
      });
      const blocks = [
        {
          type: "table",
          props: {},
          content: {
            type: "tableContent",
            rows: [
              { cells: [cell([{ type: "text", text: "u", styles: { underline: true } }], {})] },
              { cells: [cell([{ type: "text", text: "x", styles: {} }], { backgroundColor: "red" })] },
            ],
          },
          children: [],
        },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(false);
      expect(result.lossyFields).toContain("style:underline");
      expect(result.lossyFields).toContain("backgroundColor");
    });

    it("treats default props as safe", () => {
      const blocks = [
        { type: "paragraph", props: { textColor: "default", backgroundColor: "default", textAlignment: "left" }, content: [], children: [] },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(true);
    });

    it("checks nested children", () => {
      const blocks = [
        {
          type: "bulletListItem", props: {}, content: [],
          children: [
            {
              type: "mermaid",
              props: { collapsed: "true" },
              content: [],
              children: [],
            },
          ],
        },
      ];
      const result = isMarkdownSafe(blocks);
      expect(result.safe).toBe(false);
      expect(result.lossyFields).toContain("mermaid:collapsed");
    });

    it("PBT: never crashes on arbitrary input", () => {
      fc.assert(
        fc.property(fc.array(fc.anything(), { maxLength: 20 }), (input) => {
          const result = isMarkdownSafe(input);
          return typeof result.safe === "boolean" && Array.isArray(result.lossyFields);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ── extractHeadings ────────────────────────────────────

  describe("extractHeadings", () => {
    it("extracts heading texts", () => {
      const blocks = [
        { type: "heading", content: [{ type: "text", text: "First" }], children: [] },
        { type: "paragraph", content: [{ type: "text", text: "body" }], children: [] },
        { type: "heading", content: [{ type: "text", text: "Second" }], children: [] },
      ];
      expect(extractHeadings(blocks)).toEqual(["First", "Second"]);
    });

    it("returns empty for no headings", () => {
      const blocks = [
        { type: "paragraph", content: [{ type: "text", text: "just text" }], children: [] },
      ];
      expect(extractHeadings(blocks)).toEqual([]);
    });

    it("concatenates multi-part heading content", () => {
      const blocks = [
        {
          type: "heading",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "World" },
          ],
          children: [],
        },
      ];
      expect(extractHeadings(blocks)).toEqual(["Hello World"]);
    });
  });

  describe("extractMarkdownHeadings", () => {
    it("extracts headings from markdown text", () => {
      expect(extractMarkdownHeadings("# Top\n\n## Child\nBody")).toEqual(["Top", "Child"]);
    });
  });

  describe("rich block discovery", () => {
    it("detects mermaid presence and rich block types", () => {
      const blocks = [
        { type: "paragraph", props: {}, content: [{ type: "text", text: "hello", styles: {} }], children: [] },
        { type: "mermaid", props: { data: "flowchart TD\nA-->B" }, content: [], children: [] },
      ];

      expect(containsMermaidBlock(blocks)).toBe(true);
      expect(getRichBlockTypes(blocks)).toEqual(["mermaid"]);
    });

    it("summarizes blocknote blocks for agent discovery", () => {
      const blocks = [
        { id: "h1", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Atlas", styles: {} }], children: [] },
        { id: "m1", type: "mermaid", props: { data: "flowchart TD\nA-->B" }, content: [], children: [] },
      ];

      expect(summarizeBlocks(blocks)).toEqual([
        { index: 0, id: "h1", type: "heading", text: "Atlas" },
        { index: 1, id: "m1", type: "mermaid", preview: "flowchart TD" },
      ]);
    });
  });

  // ── detectContentFormat ────────────────────────────────

  describe("detectContentFormat", () => {
    it("detects strings as markdown", () => {
      expect(detectContentFormat("# Hello")).toBe("markdown");
    });

    it("detects arrays as blocknote", () => {
      expect(detectContentFormat([{ type: "paragraph" }])).toBe("blocknote");
    });

    it("detects empty array as blocknote", () => {
      expect(detectContentFormat([])).toBe("blocknote");
    });

    it("detects empty string as markdown", () => {
      expect(detectContentFormat("")).toBe("markdown");
    });
  });

  // ── Dual-format store operations ───────────────────────

  describe("markdown doc CRUD", () => {
    it("writes and reads a markdown doc", async () => {
      const md = "# Test\n\nHello world.";
      await writeDoc("test-space", "md-doc", md);

      const result = await readDoc("test-space", "md-doc");
      expect(result.error).toBeNull();
      expect(result.format).toBe("markdown");
      expect(result.storedAs).toBe("md");
      expect(result.data).toBe(md);
    });

    it("markdown doc exists and has stats", async () => {
      await writeDoc("test-space", "md-doc", "# Hello");
      expect(await docExists("test-space", "md-doc")).toBe(true);
      const stat = await docStat("test-space", "md-doc");
      expect(stat).not.toBeNull();
      expect(stat!.format).toBe("md");
    });

    it("lists markdown docs alongside json docs", async () => {
      await writeDoc("test-space", "json-doc", [{ type: "paragraph" }]);
      await writeDoc("test-space", "md-doc", "# Markdown");

      const docs = await listDocs("test-space");
      expect(docs.sort()).toEqual(["json-doc", "md-doc"]);
    });

    it("json doc takes priority over md with same name", async () => {
      // Write md first, then json
      await writeDoc("test-space", "priority-doc", "# Markdown version");
      await writeDoc("test-space", "priority-doc", [{ type: "paragraph" }]);

      const result = await readDoc("test-space", "priority-doc");
      expect(result.storedAs).toBe("json");
    });

    it("deletes markdown doc", async () => {
      await writeDoc("test-space", "delete-me", "# Gone");
      await deleteDoc("test-space", "delete-me");
      expect(await docExists("test-space", "delete-me")).toBe(false);
    });

    it("renames markdown doc preserving format", async () => {
      await writeDoc("test-space", "old-name", "# Old");
      const { error } = await renameDoc("test-space", "old-name", "new-name");
      expect(error).toBeNull();

      const result = await readDoc("test-space", "new-name");
      expect(result.storedAs).toBe("md");
      expect(result.data).toBe("# Old");
    });
  });

  // ── Force protection ───────────────────────────────────

  describe("force protection", () => {
    it("rejects markdown write to lossy json doc without force", async () => {
      // Write a json doc with lossy content
      await writeDoc("test-space", "rich-doc", [
        { type: "paragraph", props: { textColor: "red" }, content: [{ type: "text", text: "colored", styles: {} }], children: [] },
      ]);

      const result = await writeDoc("test-space", "rich-doc", "# Overwrite attempt");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("rich formatting");
      expect(result.lossyFields).toContain("textColor");
    });

    it("allows markdown write to lossy json doc with force", async () => {
      await writeDoc("test-space", "rich-doc", [
        { type: "paragraph", props: { textColor: "red" }, content: [], children: [] },
      ]);

      const result = await writeDoc("test-space", "rich-doc", "# Forced overwrite", { force: true });
      expect(result.ok).toBe(true);
    });

    it("allows markdown write to safe json doc without force", async () => {
      await writeDoc("test-space", "safe-doc", [
        { type: "paragraph", props: {}, content: [{ type: "text", text: "plain", styles: {} }], children: [] },
      ]);

      const result = await writeDoc("test-space", "safe-doc", "# Safe overwrite");
      expect(result.ok).toBe(true);
    });
  });

  // ── Patch operations ───────────────────────────────────

  describe("applyPatchOperations", () => {
    const makeBlocks = () => [
      { id: "h1", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Overview" }], children: [] },
      { id: "p1", type: "paragraph", props: {}, content: [{ type: "text", text: "Intro text." }], children: [] },
      { id: "h2", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Status" }], children: [] },
      { id: "p2", type: "paragraph", props: {}, content: [{ type: "text", text: "All good." }], children: [] },
      { id: "h3", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Next Steps" }], children: [] },
      { id: "p3", type: "paragraph", props: {}, content: [{ type: "text", text: "Do things." }], children: [] },
    ];

    it("appends content", async () => {
      const blocks = makeBlocks();
      const result = await applyPatchOperations(blocks, [
        { action: "append", content: [{ id: "new", type: "paragraph", content: [{ type: "text", text: "Appended" }] }] },
      ]);
      expect(result.operationsApplied).toBe(1);
      expect(result.blocks.length).toBe(7);
      expect(result.blocks[6].id).toBe("new");
    });

    it("deletes by block ID", async () => {
      const blocks = makeBlocks();
      const result = await applyPatchOperations(blocks, [
        { action: "delete", target: { blockId: "p2" } },
      ]);
      expect(result.operationsApplied).toBe(1);
      expect(result.blocks.length).toBe(5);
      expect(result.blocks.find((b: any) => b.id === "p2")).toBeUndefined();
    });

    it("replaces by heading (full section)", async () => {
      const blocks = makeBlocks();
      const result = await applyPatchOperations(blocks, [
        {
          action: "replace",
          target: { heading: "Status" },
          content: [
            { id: "new-h", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Status" }], children: [] },
            { id: "new-p", type: "paragraph", props: {}, content: [{ type: "text", text: "Updated!" }], children: [] },
          ],
        },
      ]);
      expect(result.operationsApplied).toBe(1);
      // Status section (h2 + p2) replaced with new h + p. Total: 6 -> 6
      expect(result.blocks.length).toBe(6);
      expect(result.blocks[2].id).toBe("new-h");
      expect(result.blocks[3].id).toBe("new-p");
    });

    it("inserts after heading section", async () => {
      const blocks = makeBlocks();
      const result = await applyPatchOperations(blocks, [
        {
          action: "insert_after",
          target: { heading: "Status" },
          content: [{ id: "inserted", type: "paragraph", content: [{ type: "text", text: "Inserted!" }] }],
        },
      ]);
      expect(result.operationsApplied).toBe(1);
      expect(result.blocks.length).toBe(7);
      // Inserted after Status section (which ends before "Next Steps")
      expect(result.blocks[4].id).toBe("inserted");
    });

    it("deletes by text search", async () => {
      const blocks = makeBlocks();
      const result = await applyPatchOperations(blocks, [
        { action: "delete", target: { search: "All good" } },
      ]);
      expect(result.operationsApplied).toBe(1);
      expect(result.blocks.length).toBe(5);
    });

    it("skips operations with invalid targets", async () => {
      const blocks = makeBlocks();
      const result = await applyPatchOperations(blocks, [
        { action: "delete", target: { heading: "Nonexistent" } },
      ]);
      expect(result.operationsApplied).toBe(0);
      expect(result.blocks.length).toBe(6);
      expect(result.skipped).toEqual([
        {
          index: 0,
          action: "delete",
          target: { heading: "Nonexistent" },
          reason: 'target not found: heading="Nonexistent"',
        },
      ]);
    });

    it("rejects malformed compatibility content before spreading it", async () => {
      await expect(
        applyPatchOperations(
          [
            {
              type: "paragraph",
              content: [{ type: "text", text: "existing", styles: {} }],
              children: [],
            },
          ],
          [
          { action: "append", content: null as never },
          ]
        )
      ).rejects.toThrow(
        "Patch operation 1 content must be a Markdown string or block array"
      );
    });
  });

  // Real workspaces contain blocks written by other BlockNote versions
  // and by agents: unknown props, unknown styles, unknown types. The
  // converter crashes on all three; reads must not.
  describe("crash-resistant markdown conversion", () => {
    const text = (t: string) => [{ type: "text", text: t, styles: {} }];

    it("converts blocks with unknown props by stripping them", async () => {
      const md = await blocksToMarkdownSafe([
        { id: "a", type: "paragraph", props: { foreignProp: "x" }, content: text("hello"), children: [] },
      ]);
      expect(md).toContain("hello");
    });

    it("converts blocks with unknown inline styles by stripping them", async () => {
      const md = await blocksToMarkdownSafe([
        { id: "a", type: "paragraph", props: {}, content: [{ type: "text", text: "hi", styles: { sparkle: true } }], children: [] },
      ]);
      expect(md).toContain("hi");
    });

    it("degrades unknown block types to paragraphs, keeping their text", async () => {
      const md = await blocksToMarkdownSafe([
        { id: "a", type: "alienBlock", props: { data: "zap" }, content: text("survives"), children: [] },
        { id: "b", type: "paragraph", props: {}, content: text("after"), children: [] },
      ]);
      expect(md).toContain("survives");
      expect(md).toContain("after");
    });

    it("sanitizes nested children and table cells", async () => {
      const md = await blocksToMarkdownSafe([
        {
          id: "a",
          type: "bulletListItem",
          props: {},
          content: text("parent"),
          children: [
            { id: "b", type: "paragraph", props: { weird: 1 }, content: text("child"), children: [] },
          ],
        },
        {
          id: "t",
          type: "table",
          props: {},
          content: {
            type: "tableContent",
            rows: [{ cells: [[{ type: "text", text: "cell", styles: { glow: true } }]] }],
          },
          children: [],
        },
      ]);
      expect(md).toContain("parent");
      expect(md).toContain("child");
      expect(md).toContain("cell");
    });

    it("read_doc returns markdown for a stored doc with foreign props instead of crashing", async () => {
      // The exact shape that crashed production reads: markdown-safe
      // types carrying props the server-side schema doesn't know.
      await writeDoc("test-space", "foreign-props-doc", [
        { id: "h1", type: "heading", props: { level: 1, isToggleable: true }, content: text("Title"), children: [] },
        { id: "p1", type: "paragraph", props: { foreignProp: "x" }, content: text("Body text"), children: [] },
      ]);

      const result = (await dispatchOperation("docs.read", {
        spaceId: "test-space",
        docPath: "foreign-props-doc",
      })) as { format: string; content: string };

      expect(result.format).toBe("markdown");
      expect(result.content).toContain("Title");
      expect(result.content).toContain("Body text");
    });

    it("read_doc preserves source from a legacy Mermaid custom block", async () => {
      writeFileSync(
        join(spacesDir, "test-space", "docs", "legacy-mermaid.json"),
        JSON.stringify([
          {
            id: "legacy-diagram",
            type: "mermaid",
            props: { code: "flowchart TD\nLegacy-->Preserved" },
            children: [],
          },
        ])
      );

      const result = (await dispatchOperation("docs.read", {
        spaceId: "test-space",
        docPath: "legacy-mermaid",
      })) as { format: string; content: string; containsMermaid: boolean };

      expect(result.format).toBe("markdown");
      expect(result.containsMermaid).toBe(true);
      expect(result.content).toContain("flowchart TD\nLegacy-->Preserved");
    });

    it("read_doc returns directly stored escaped Mermaid syntax verbatim", async () => {
      const source =
        "# Mermaid syntax example\n\n\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n";
      writeFileSync(
        join(spacesDir, "test-space", "docs", "literal-mermaid.md"),
        source
      );

      const result = (await dispatchOperation("docs.read", {
        spaceId: "test-space",
        docPath: "literal-mermaid",
      })) as { content: string; containsMermaid: boolean };

      expect(result.content).toBe(source);
      expect(result.containsMermaid).toBe(false);
    });

    it("read_doc never crashes even on unconvertible inline content", async () => {
      await writeDoc("test-space", "unconvertible-doc", [
        { id: "x", type: "paragraph", props: {}, content: [{ type: "alienInline", payload: { deep: true } }], children: [] },
      ]);

      const result = (await dispatchOperation("docs.read", {
        spaceId: "test-space",
        docPath: "unconvertible-doc",
      })) as { format: string; content: unknown };

      expect(result.content).toBeDefined();
      expect(["markdown", "blocknote"]).toContain(result.format);
    });
  });
});
