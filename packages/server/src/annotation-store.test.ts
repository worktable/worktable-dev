import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeDoc } from "./store.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import {
  createAnnotation,
  getAnnotationContext,
  listAnnotations,
  readAnnotation,
  renameAnnotationDocPath,
  replyAnnotation,
  resolveAnnotation,
} from "./annotation-store.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "worktable-annotations-"));
  setWorkspaceRootOverride(dir);
});

afterEach(async () => {
  setWorkspaceRootOverride(null);
  await rm(dir, { recursive: true, force: true });
});

const block = {
  id: "block-a",
  type: "paragraph",
  props: {},
  content: [{ type: "text", text: "Hello annotated world", styles: {} }],
  children: [],
};

describe("annotation store", () => {
  it("creates, lists, replies, resolves, and reads context", async () => {
    await writeDoc("space", "doc", [block]);

    const created = await createAnnotation("space", {
      target: { type: "block", docPath: "doc", blockId: "block-a" },
      category: "instruction",
      body: "Tighten this section.",
      author: { type: "user", id: "user", name: "User" },
    });

    expect(created.created).toBe(true);
    const listed = await listAnnotations("space", { target: { docPath: "doc" } });
    expect(listed.total).toBe(1);
    expect(listed.annotations[0]?.category).toBe("instruction");

    const reply = await replyAnnotation("space", created.annotation.id, "Done", { type: "agent", id: "agent-1" });
    expect(reply.annotation.thread).toHaveLength(1);

    const context = await getAnnotationContext("space", created.annotation.id);
    expect(context.targetExists).toBe(true);
    expect(context.selectorMatch).toBe("exact");
    expect(context.excerpt).toContain("annotated world");

    const resolved = await resolveAnnotation("space", created.annotation.id, "Applied", "agent-1");
    expect(resolved.status).toBe("resolved");
    expect((await listAnnotations("space", { target: { docPath: "doc" } })).total).toBe(0);
    expect((await listAnnotations("space", { target: { docPath: "doc" }, includeResolved: true })).total).toBe(1);
  });

  it("re-anchors to the block by quote when the blockId drifts", async () => {
    await writeDoc("space", "doc", [block]);

    const created = await createAnnotation("space", {
      target: { type: "block", docPath: "doc", blockId: "block-a", quote: "annotated world" },
      category: "comment",
      body: "Anchor me.",
      author: { type: "user", id: "user" },
    });

    // Simulate a markdown reparse: same text, fresh block id.
    await writeDoc("space", "doc", [{ ...block, id: "fresh-id-123" }]);

    const context = await getAnnotationContext("space", created.annotation.id);
    expect(context.targetExists).toBe(true);
    expect(context.selectorMatch).toBe("fuzzy");
    expect((context.block as { id: string }).id).toBe("fresh-id-123");
    expect(context.excerpt).toContain("annotated world");
  });

  it("reports stale when the quoted text no longer exists", async () => {
    await writeDoc("space", "doc", [block]);

    const created = await createAnnotation("space", {
      target: { type: "block", docPath: "doc", blockId: "block-a", quote: "annotated world" },
      category: "comment",
      body: "Anchor me.",
    });

    await writeDoc("space", "doc", [
      { ...block, id: "fresh-id-123", content: [{ type: "text", text: "totally different text", styles: {} }] },
    ]);

    const context = await getAnnotationContext("space", created.annotation.id);
    expect(context.targetExists).toBe(false);
    expect(context.selectorMatch).toBe("stale");
  });

  it("reports missing when the blockId drifts and no quote was stored", async () => {
    await writeDoc("space", "doc", [block]);

    const created = await createAnnotation("space", {
      target: { type: "block", docPath: "doc", blockId: "block-a" },
      category: "comment",
      body: "No quote.",
    });

    await writeDoc("space", "doc", [{ ...block, id: "fresh-id-123" }]);

    const context = await getAnnotationContext("space", created.annotation.id);
    expect(context.targetExists).toBe(false);
    expect(context.selectorMatch).toBe("missing");
  });

  it("moves annotation sidecars when a doc is renamed", async () => {
    await createAnnotation("space", {
      target: { type: "block", docPath: "old", blockId: "block-a" },
      category: "comment",
      body: "Move with me.",
    });

    await renameAnnotationDocPath("space", "old", "folder/new");
    const listed = await listAnnotations("space", { target: { docPath: "folder/new" }, includeResolved: true });
    expect(listed.total).toBe(1);
    const annotation = await readAnnotation("space", listed.annotations[0]!.id);
    expect("docPath" in annotation.target && annotation.target.docPath).toBe("folder/new");
  });
});
