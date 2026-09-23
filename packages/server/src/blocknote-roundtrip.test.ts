/**
 * BlockNote round-trip regression corpus.
 *
 * Tripwire for BlockNote upgrades (0.51 rewrote the markdown
 * parser/serializer): pins the CURRENT conversion behavior of every block
 * type the server schema supports, so an upgrade diff shows exactly which
 * conversions changed. Assertions marked "pins current behavior" capture
 * known-lossy output on purpose — do not "fix" them to an ideal.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blocksToMarkdown, markdownToBlocks } from "./markdown.ts";
import { canonicalizeBlocks } from "./blocknote.ts";
import { readDoc, writeDoc, writeSpace } from "./store.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import type { SpaceFile } from "@worktable/types";

// ── Helpers ──────────────────────────────────────────────

const text = (t: string, styles: Record<string, unknown> = {}) => [
  { type: "text", text: t, styles },
];

/** Plain text of a block's inline content, recursing into nested content (links). */
function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((inline: any) =>
      typeof inline?.text === "string" ? inline.text : inlineText(inline?.content)
    )
    .join("");
}

/** Table rows as string[][] regardless of cell shape (array vs tableCell object). */
function tableRows(block: any): string[][] {
  const rows = block?.content?.rows ?? [];
  return rows.map((row: any) =>
    (row.cells ?? []).map((cell: any) =>
      Array.isArray(cell) ? inlineText(cell) : inlineText(cell?.content)
    )
  );
}

async function roundTrip(blocks: unknown[]): Promise<{ md: string; back: any[] }> {
  const md = await blocksToMarkdown(blocks);
  const back = (await markdownToBlocks(md)) as any[];
  return { md, back };
}

// ── Fixture corpus: every block type the server schema supports ──

const paragraphWithStyles = {
  type: "paragraph",
  content: [
    { type: "text", text: "plain ", styles: {} },
    { type: "text", text: "bold", styles: { bold: true } },
    { type: "text", text: " ", styles: {} },
    { type: "text", text: "italic", styles: { italic: true } },
    { type: "text", text: " ", styles: {} },
    { type: "text", text: "mono", styles: { code: true } },
    { type: "text", text: " ", styles: {} },
    { type: "link", href: "https://example.com", content: text("a link") },
  ],
};
const heading1 = { type: "heading", props: { level: 1 }, content: text("Heading one") };
const heading2 = { type: "heading", props: { level: 2 }, content: text("Heading two") };
const heading3 = { type: "heading", props: { level: 3 }, content: text("Heading three") };
const bulletItem = { type: "bulletListItem", content: text("bullet item") };
const numberedItem = { type: "numberedListItem", content: text("numbered item") };
const checkedItem = { type: "checkListItem", props: { checked: true }, content: text("done task") };
const uncheckedItem = { type: "checkListItem", props: { checked: false }, content: text("open task") };
const quoteBlock = { type: "quote", content: text("quoted wisdom") };
const tableBlock = {
  type: "table",
  content: {
    type: "tableContent",
    rows: [
      { cells: [text("Name"), text("Role")] },
      { cells: [text("Ada"), text("Engineer")] },
    ],
  },
};
const imageBlock = {
  type: "image",
  props: { url: "https://example.com/pic.png", caption: "A picture" },
};
const codeBlock = {
  type: "codeBlock",
  props: { language: "typescript" },
  content: text("const x: number = 1;"),
};
// Mermaid block props (shared spec in @worktable/types): data / title /
// collapsed / locked — collapsed and locked are STRING booleans.
const mermaidBlock = {
  type: "mermaid",
  props: { data: "graph TD; A-->B", title: "Flow", collapsed: "true", locked: "false" },
};

const corpus = [
  paragraphWithStyles,
  heading1,
  heading2,
  heading3,
  bulletItem,
  numberedItem,
  checkedItem,
  uncheckedItem,
  quoteBlock,
  tableBlock,
  imageBlock,
  codeBlock,
  mermaidBlock,
];

// Hand-written markdown exercising the same constructs as the corpus.
const markdownFixture = [
  "# Heading one",
  "",
  "Some **bold**, *italic*, `mono`, and [a link](https://example.com).",
  "",
  "## Heading two",
  "",
  "### Heading three",
  "",
  "* bullet item",
  "",
  "1. numbered item",
  "",
  "* [x] done task",
  "* [ ] open task",
  "",
  "> quoted wisdom",
  "",
  "| Name | Role     |",
  "| ---- | -------- |",
  "| Ada  | Engineer |",
  "",
  "![A picture](https://example.com/pic.png)",
  "",
  "```typescript",
  "const x: number = 1;",
  "```",
  "",
  "```mermaid",
  "graph TD; A-->B",
  "```",
  "",
].join("\n");

// ── 1. blocks → markdown → blocks ────────────────────────

describe("blocks → markdown → blocks", () => {
  it("paragraph keeps bold, italic, code, and link inline content", async () => {
    const { back } = await roundTrip([paragraphWithStyles]);
    expect(back.length).toBe(1);
    const [para] = back;
    expect(para.type).toBe("paragraph");

    const bySlice = (styles: Record<string, unknown>) =>
      para.content.find(
        (inline: any) =>
          inline.type === "text" &&
          Object.keys(styles).every((key) => inline.styles?.[key] === styles[key])
      );
    expect(bySlice({ bold: true })?.text).toBe("bold");
    expect(bySlice({ italic: true })?.text).toBe("italic");
    expect(bySlice({ code: true })?.text).toBe("mono");

    const link = para.content.find((inline: any) => inline.type === "link");
    expect(link?.href).toBe("https://example.com");
    expect(inlineText(link?.content)).toBe("a link");
  });

  it("headings keep their level (1-3)", async () => {
    const { back } = await roundTrip([heading1, heading2, heading3]);
    expect(back.map((b) => b.type)).toEqual(["heading", "heading", "heading"]);
    expect(back.map((b) => b.props.level)).toEqual([1, 2, 3]);
    expect(back.map((b) => inlineText(b.content))).toEqual([
      "Heading one",
      "Heading two",
      "Heading three",
    ]);
  });

  it("bullet and numbered list items keep type and text", async () => {
    const { back } = await roundTrip([bulletItem, numberedItem]);
    expect(back.map((b) => b.type)).toEqual(["bulletListItem", "numberedListItem"]);
    expect(back.map((b) => inlineText(b.content))).toEqual(["bullet item", "numbered item"]);
  });

  it("check list items keep their checked state", async () => {
    const { back } = await roundTrip([checkedItem, uncheckedItem]);
    expect(back.map((b) => b.type)).toEqual(["checkListItem", "checkListItem"]);
    expect(back[0].props.checked).toBe(true);
    expect(back[1].props.checked).toBe(false);
    expect(back.map((b) => inlineText(b.content))).toEqual(["done task", "open task"]);
  });

  it("quote keeps type and text", async () => {
    const { md, back } = await roundTrip([quoteBlock]);
    expect(md).toContain("> quoted wisdom");
    expect(back.length).toBe(1);
    expect(back[0].type).toBe("quote");
    expect(inlineText(back[0].content)).toBe("quoted wisdom");
  });

  it("a header-less table serializes with an empty header row that reparse drops", async () => {
    // Markdown tables require a header row, so a table block authored
    // WITHOUT header metadata serializes with an all-empty one (cell text
    // lands in the body). Since 0.51 the parser drops that empty header on
    // the way back in, so the row set round-trips cleanly.
    const { md, back } = await roundTrip([tableBlock]);
    expect(md.split("\n")[0]).toBe("|            |            |");

    const table = back.find((b) => b.type === "table");
    expect(table).toBeDefined();
    expect(table.content.headerRows).toBeUndefined();
    expect(tableRows(table)).toEqual([
      ["Name", "Role"],
      ["Ada", "Engineer"],
    ]);
  });

  it("captioned image round-trips losslessly via <figure> HTML", async () => {
    // 0.51 serializes captioned images as <figure><img><figcaption> HTML
    // (markdown passthrough), and the parser reads it back into a single
    // image block with the caption intact — strictly less lossy than the
    // pre-0.51 `![caption](url)` + trailing-paragraph form.
    const { md, back } = await roundTrip([imageBlock]);
    expect(md).toContain('<figure><img src="https://example.com/pic.png">');
    expect(md).toContain("<figcaption>A picture</figcaption>");

    expect(back.map((b) => b.type)).toEqual(["image"]);
    const [image] = back;
    expect(image.props.url).toBe("https://example.com/pic.png");
    expect(image.props.caption).toBe("A picture");
  });

  it("code block keeps language and code text", async () => {
    const { md, back } = await roundTrip([codeBlock]);
    expect(md).toContain("```typescript");
    expect(back.length).toBe(1);
    expect(back[0].type).toBe("codeBlock");
    expect(back[0].props.language).toBe("typescript");
    expect(inlineText(back[0].content)).toBe("const x: number = 1;");
  });

  it("mermaid block serializes to a ```mermaid fence carrying the diagram source", async () => {
    // The first-party server mermaid spec (blocknote.ts) exports
    // <pre><code class="language-mermaid"> so markdown projections carry the
    // diagram source as a mermaid fence. (The old vendored React spec
    // crashed under server-util's JSDOM and the block vanished entirely.)
    const mermaid = {
      type: "mermaid",
      props: { data: "graph TD; A-->B", title: "Flow", collapsed: "false", locked: "false" },
    };
    const alone = await blocksToMarkdown([mermaid]);
    expect(alone).toBe("```mermaid\ngraph TD; A-->B\n```\n");

    const withNeighbors = await blocksToMarkdown([
      { type: "paragraph", content: [{ type: "text", text: "before", styles: {} }] },
      mermaid,
      { type: "paragraph", content: [{ type: "text", text: "after", styles: {} }] },
    ]);
    expect(withNeighbors).toBe("before\n\n```mermaid\ngraph TD; A-->B\n```\n\nafter\n");
  });

  it("a ```mermaid fence parses directly to the canonical mermaid block", async () => {
    const back = (await markdownToBlocks("```mermaid\ngraph TD; A-->B\n```\n")) as any[];
    expect(back.length).toBe(1);
    expect(back[0].type).toBe("mermaid");
    expect(back[0].props.data).toBe("graph TD; A-->B");
  });

  it("an mmd alias fence also parses to the canonical mermaid block", async () => {
    const back = (await markdownToBlocks("```mmd\ngraph TD; A-->B\n```\n")) as any[];
    expect(back[0].type).toBe("mermaid");
    expect(back[0].props.data).toBe("graph TD; A-->B");
  });
});

// ── 2. markdown → blocks → markdown ──────────────────────

describe("markdown → blocks → markdown stability", () => {
  it("second-generation markdown equals first-generation markdown", async () => {
    const blocks1 = await markdownToBlocks(markdownFixture);
    const gen1 = await blocksToMarkdown(blocks1);
    const blocks2 = await markdownToBlocks(gen1);
    const gen2 = await blocksToMarkdown(blocks2);
    expect(gen2).toBe(gen1);
  });
});

// ── 3. canonicalizeBlocks equivalence ────────────────────

describe("canonicalizeBlocks on the full corpus", () => {
  it("canonicalizing twice yields deeply-equal output", async () => {
    const once = await canonicalizeBlocks(corpus);
    const twice = await canonicalizeBlocks(once);
    expect(twice).toEqual(once);
  });

  it("preserves block types and order for every corpus entry", async () => {
    const canonical = (await canonicalizeBlocks(corpus)) as any[];
    expect(canonical.map((b) => b.type)).toEqual([
      "paragraph",
      "heading",
      "heading",
      "heading",
      "bulletListItem",
      "numberedListItem",
      "checkListItem",
      "checkListItem",
      "quote",
      "table",
      "image",
      "codeBlock",
      "mermaid",
    ]);
  });

  it("preserves essential props: heading levels, checked, language, image url, mermaid state", async () => {
    const canonical = (await canonicalizeBlocks(corpus)) as any[];
    const headings = canonical.filter((b) => b.type === "heading");
    expect(headings.map((b) => b.props.level)).toEqual([1, 2, 3]);

    const checks = canonical.filter((b) => b.type === "checkListItem");
    expect(checks.map((b) => b.props.checked)).toEqual([true, false]);

    const code = canonical.find((b) => b.type === "codeBlock");
    expect(code.props.language).toBe("typescript");
    expect(inlineText(code.content)).toBe("const x: number = 1;");

    const image = canonical.find((b) => b.type === "image");
    expect(image.props.url).toBe("https://example.com/pic.png");
    expect(image.props.caption).toBe("A picture");

    const mermaid = canonical.find((b) => b.type === "mermaid");
    expect(mermaid.props).toMatchObject({
      data: "graph TD; A-->B",
      title: "Flow",
      collapsed: "true",
      locked: "false",
    });

    const table = canonical.find((b) => b.type === "table");
    expect(tableRows(table)).toEqual([
      ["Name", "Role"],
      ["Ada", "Engineer"],
    ]);
  });
});

// ── 4. Storage round-trip through the real store ──────────

const testDir = join(tmpdir(), `worktable-roundtrip-test-${Date.now()}`);
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

describe("storage round-trip through the real store", () => {
  beforeEach(async () => {
    mkdirSync(spacesDir, { recursive: true });
    setWorkspaceRootOverride(testDir);
    await writeSpace(makeSpace("test-space"));
  });

  afterEach(() => {
    setWorkspaceRootOverride(null);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("corpus written via the canonical JSON path reads back with types, order, and props intact", async () => {
    const result = await writeDoc("test-space", "corpus-doc", corpus);
    expect(result.ok).toBe(true);

    const { data, error, storedAs } = await readDoc("test-space", "corpus-doc");
    expect(error).toBeNull();
    expect(storedAs).toBe("json");

    const blocks = data as any[];
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "heading",
      "heading",
      "heading",
      "bulletListItem",
      "numberedListItem",
      "checkListItem",
      "checkListItem",
      "quote",
      "table",
      "image",
      "codeBlock",
      "mermaid",
    ]);
    // writeDoc canonicalizes: every block gets a stable id.
    expect(blocks.every((b) => typeof b.id === "string")).toBe(true);

    const mermaid = blocks.find((b) => b.type === "mermaid");
    expect(mermaid.props).toMatchObject({
      data: "graph TD; A-->B",
      title: "Flow",
      collapsed: "true",
      locked: "false",
    });
    const checks = blocks.filter((b) => b.type === "checkListItem");
    expect(checks.map((b) => b.props.checked)).toEqual([true, false]);
    expect(blocks.find((b) => b.type === "codeBlock").props.language).toBe("typescript");
    expect(inlineText(blocks.find((b) => b.type === "paragraph").content)).toBe(
      "plain bold italic mono a link"
    );
  });

  it("a .md doc file on disk reads as markdown and converts to the expected blocks", async () => {
    const docsDir = join(spacesDir, "test-space", "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "corpus-md-doc.md"), markdownFixture);

    const { data, error, format, storedAs } = await readDoc("test-space", "corpus-md-doc");
    expect(error).toBeNull();
    expect(format).toBe("markdown");
    expect(storedAs).toBe("md");
    expect(data).toBe(markdownFixture);

    const blocks = (await markdownToBlocks(data as string)) as any[];
    const types = blocks.map((b) => b.type);
    expect(types).toContain("heading");
    expect(types).toContain("bulletListItem");
    expect(types).toContain("numberedListItem");
    expect(types).toContain("checkListItem");
    expect(types).toContain("quote");
    expect(types).toContain("table");
    expect(tableRows(blocks.find((block) => block.type === "table"))).toEqual([
      ["Name", "Role"], ["Ada", "Engineer"],
    ]);
    expect(types).toContain("image");
    expect(blocks.filter((b) => b.type === "codeBlock").length).toBe(1);
    expect(types).toContain("mermaid");
    expect(blocks.find((b) => b.type === "mermaid")?.props.data).toContain(
      "graph TD"
    );
  });

  it("preserves escaped Mermaid fences as literal syntax during conversion", async () => {
    const blocks = (await markdownToBlocks(
      "\\`\\`\\`mermaid\nflowchart TD\nA-->B\n\\`\\`\\`\n"
    )) as any[];

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(inlineText(blocks[0].content)).toContain("```mermaid");
  });
});
