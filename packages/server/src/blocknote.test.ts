import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { normalizeMermaidBlocks } from "@worktable/types";
import { canonicalizeBlocks, inheritBlockIds } from "./blocknote.ts";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const para = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
});

describe("canonicalizeBlocks", () => {
  it("does not mark an already-canonical mermaid block as changed", () => {
    const block = {
      id: "diagram",
      type: "mermaid",
      props: {
        data: "flowchart TD\nA-->B",
        title: "Untitled Diagram",
        collapsed: "false",
        locked: "false",
      },
      children: [],
    };
    const normalized = normalizeMermaidBlocks([block]);
    expect(normalized.changed).toBe(false);
    expect(normalized.blocks[0]).toBe(block);
  });

  it("preserves visual props when normalizing a legacy Mermaid code block", () => {
    const normalized = normalizeMermaidBlocks([
      {
        type: "codeBlock",
        props: {
          language: "mermaid",
          backgroundColor: "blue",
          textColor: "red",
          textAlignment: "center",
        },
        content: "flowchart TD\nA-->B",
      },
    ]);

    expect(normalized.blocks[0]).toMatchObject({
      type: "mermaid",
      props: {
        data: "flowchart TD\nA-->B",
        backgroundColor: "blue",
        textColor: "red",
        textAlignment: "center",
      },
    });
    expect((normalized.blocks[0] as any).props.language).toBeUndefined();
  });

  it("fills a partial block into full canonical shape (id, props, content)", async () => {
    const [block] = (await canonicalizeBlocks([
      { type: "paragraph", content: "hello" },
    ])) as any[];
    expect(block.type).toBe("paragraph");
    expect(typeof block.id).toBe("string");
    expect(block.props.textAlignment).toBe("left");
    expect(block.content).toEqual([{ type: "text", text: "hello", styles: {} }]);
  });

  it("is idempotent once ids are assigned", async () => {
    const once = await canonicalizeBlocks([para("stable")]);
    const twice = await canonicalizeBlocks(once);
    const thrice = await canonicalizeBlocks(twice);
    expect(hash(twice)).toBe(hash(once));
    expect(hash(thrice)).toBe(hash(once));
  });

  it("preserves caller-supplied block ids", async () => {
    const input = [{ id: "keep-me", ...para("x") }];
    const [block] = (await canonicalizeBlocks(input)) as any[];
    expect(block.id).toBe("keep-me");
  });

  it("keeps a mermaid block instead of degrading it to a paragraph", async () => {
    // The old default-schema editor did not know the mermaid block and would
    // flatten it. The shared custom-schema editor must preserve it.
    const [block] = (await canonicalizeBlocks([
      { type: "mermaid", props: { code: "graph TD; A-->B" } },
    ])) as any[];
    expect(block.type).toBe("mermaid");
  });

  it("preserves every Worktable mermaid prop through canonicalization", async () => {
    // The client's WorktableMermaidBlock stores diagram state in these four
    // props; the server schema (shared spec from @worktable/types) must keep
    // carrying all of them, or agent/REST writes of mermaid docs would
    // silently lose state.
    // Pins the prop contract so a divergence fails a test instead of eating
    // diagrams in production.
    const props = {
      data: "graph TD; X-->Y",
      title: "My Diagram",
      collapsed: "true",
      locked: "true",
    };
    const [block] = (await canonicalizeBlocks([
      { type: "mermaid", props },
    ])) as any[];
    expect(block.props).toMatchObject(props);
  });

  it("inheritBlockIds matches by content, so an insert cannot steal an existing block's id", async () => {
    const previous = [
      { id: "id-a", type: "paragraph", content: [{ type: "text", text: "alpha", styles: {} }], children: [] },
      { id: "id-b", type: "paragraph", content: [{ type: "text", text: "beta", styles: {} }], children: [] },
    ];
    // Same-type paragraph inserted at the top; the unchanged blocks shift down.
    const incoming = [
      { type: "paragraph", content: [{ type: "text", text: "new first", styles: {} }] },
      { type: "paragraph", content: [{ type: "text", text: "alpha", styles: {} }] },
      { type: "paragraph", content: [{ type: "text", text: "beta", styles: {} }] },
    ];

    const result = inheritBlockIds(incoming, previous) as any[];
    // The insert gets NO donated id (a positional scheme would hand it "id-a",
    // re-attaching alpha's annotations to unrelated text).
    expect(result[0].id).toBeUndefined();
    // The moved-but-unchanged blocks keep their ids wherever they landed.
    expect(result[1].id).toBe("id-a");
    expect(result[2].id).toBe("id-b");
  });

  it("inheritBlockIds never donates an id the incoming array already uses", async () => {
    const previous = [
      { id: "id-a", type: "paragraph", content: [{ type: "text", text: "same", styles: {} }], children: [] },
    ];
    const incoming = [
      { id: "id-a", type: "heading", content: [{ type: "text", text: "kept", styles: {} }] },
      { type: "paragraph", content: [{ type: "text", text: "same", styles: {} }] },
    ];
    const result = inheritBlockIds(incoming, previous) as any[];
    expect(result[0].id).toBe("id-a");
    // The paragraph matches id-a's content but may not duplicate its id.
    expect(result[1].id).toBeUndefined();
  });

  it("inheritBlockIds matches Mermaid blocks by diagram source", () => {
    const previous = [
      {
        id: "diagram-id",
        type: "mermaid",
        props: {
          data: "flowchart TD\nA-->B",
          title: "Untitled Diagram",
          collapsed: "false",
          locked: "false",
        },
      },
    ];

    const unchanged = inheritBlockIds(
      [
        {
          type: "mermaid",
          props: {
            data: "flowchart TD\nA-->B",
            title: "Untitled Diagram",
            collapsed: "false",
            locked: "false",
          },
        },
      ],
      previous
    ) as any[];
    const changed = inheritBlockIds(
      [
        {
          type: "mermaid",
          props: {
            data: "flowchart TD\nA-->C",
            title: "Untitled Diagram",
            collapsed: "false",
            locked: "false",
          },
        },
      ],
      previous
    ) as any[];

    expect(unchanged[0].id).toBe("diagram-id");
    expect(changed[0].id).toBeUndefined();
  });

  it("round-trips already-canonical content without changing its hash", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 1, maxLength: 5 }),
        async (texts) => {
          const canonical = await canonicalizeBlocks(texts.map(para));
          const again = await canonicalizeBlocks(canonical);
          return hash(again) === hash(canonical);
        }
      ),
      { numRuns: 20 }
    );
  });
});
