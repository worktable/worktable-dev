/**
 * Shared server-side BlockNote editor + canonicalization.
 *
 * One cached `ServerBlockNoteEditor` using the SAME custom schema the
 * collaborative runtime uses (custom code block + mermaid). Every server
 * path that parses, serializes, or normalizes blocks must go through this
 * module so there is a single canonical form — divergent editors (default
 * vs. custom schema) produce different normal forms and silently degrade
 * blocks the other doesn't know (e.g. mermaid → paragraph).
 *
 * `canonicalizeBlocks` round-trips blocks through the editor exactly the way
 * the browser collab path does (blocks → Y.Doc → blocks), assigning stable
 * IDs and filling default props. Two semantically-equal block arrays
 * canonicalize to byte-identical output, so `stableHash` can detect no-ops.
 */

import { BlockNoteSchema, createBlockSpec, createCodeBlockSpec, defaultProps } from "@blocknote/core";
import { codeBlockOptions } from "@blocknote/code-block";
import {
  MERMAID_BLOCK_TYPE,
  getMermaidSource,
  isMermaidLanguage,
  mermaidBlockPropSchema,
  normalizeMermaidBlocks,
} from "@worktable/types";

const worktableCodeBlockOptions = {
  ...codeBlockOptions,
  supportedLanguages: Object.fromEntries(
    Object.entries(codeBlockOptions.supportedLanguages ?? {}).filter(
      ([language]) => language !== "mermaid" && language !== "mmd"
    )
  ),
};

// Fragment name shared with the collaborative runtime (yjs-manager).
export const FRAGMENT_NAME = "document-store";

// ── Schema (matches the client editor) ───────────────────────

// Render-less mermaid spec sharing the client's block identity (see
// @worktable/types). The old vendored React spec (blocknote-mermaid)
// crashed under server-util's JSDOM and serialized mermaid blocks to
// nothing; this one exports a `mermaid` code fence, so markdown/HTML
// projections (copy-as-md, MCP read_doc, exports) carry the diagram
// source.
const serverMermaidSpec = createBlockSpec(
  {
    type: MERMAID_BLOCK_TYPE,
    propSchema: { ...defaultProps, ...mermaidBlockPropSchema },
    content: "none",
  },
  {
    render: (block) => {
      const dom = document.createElement("pre");
      const code = document.createElement("code");
      code.className = "language-mermaid";
      code.textContent = block.props.data;
      dom.appendChild(code);
      return { dom };
    },
    parse: (element) => {
      if (
        element.tagName !== "PRE" ||
        element.childElementCount !== 1 ||
        element.firstElementChild?.tagName !== "CODE"
      ) {
        return undefined;
      }
      const code = element.firstElementChild!;
      const language =
        code.getAttribute("data-language") ??
        code.className
          .split(" ")
          .find((name) => name.startsWith("language-"))
          ?.slice("language-".length);
      if (!isMermaidLanguage(language)) return undefined;
      return { data: code.textContent ?? "" };
    },
    runsBefore: ["codeBlock"],
  }
);

export const serverSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...BlockNoteSchema.create().blockSpecs,
    codeBlock: createCodeBlockSpec(worktableCodeBlockOptions),
    // 0.46.x createBlockSpec returns a factory; 0.51+ returns the spec
    // directly (drop the call when upgrading).
    mermaid: serverMermaidSpec(),
  },
});

// ── Cached ServerBlockNoteEditor ─────────────────────────────

let cachedEditor: any | null = null;

/**
 * Lazily create and cache the shared editor. `@blocknote/server-util`
 * pulls in JSDOM, so it is imported on first use rather than at module load.
 */
export async function getServerEditor(): Promise<any> {
  if (!cachedEditor) {
    const { ServerBlockNoteEditor } = await import("@blocknote/server-util");
    cachedEditor = ServerBlockNoteEditor.create({ schema: serverSchema });
  }
  return cachedEditor;
}

// ── Canonicalization ─────────────────────────────────────────

/**
 * Return the canonical form of a block array: the exact shape the editor
 * produces after a Y.Doc round-trip (stable IDs, default props, normalized
 * inline content). Equivalent inputs yield byte-identical output, which is
 * what makes semantic no-op detection possible on both write and persist.
 */
export async function canonicalizeBlocks(blocks: unknown[]): Promise<unknown[]> {
  const editor = await getServerEditor();
  const normalized = normalizeMermaidBlocks(blocks).blocks;
  const ydoc = editor.blocksToYDoc(
    normalized as Parameters<typeof editor.blocksToYDoc>[0],
    FRAGMENT_NAME
  );
  try {
    return editor.yDocToBlocks(ydoc, FRAGMENT_NAME);
  } finally {
    ydoc.destroy();
  }
}

// ── Block id inheritance ─────────────────────────────────────

/** Tolerant plain-text extraction: works on raw agent blocks and canonical ones. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((inline) =>
      inline && typeof inline === "object" && typeof (inline as Record<string, unknown>)["text"] === "string"
        ? ((inline as Record<string, unknown>)["text"] as string)
        : ""
    )
    .join("");
}

/** Identity key for donor matching: a block may only inherit an id from a block that reads the same. */
function blockKey(block: Record<string, unknown>): string {
  const content =
    block["type"] === MERMAID_BLOCK_TYPE
      ? (getMermaidSource(block) ?? "")
      : blockText(block["content"]);
  return `${String(block["type"] ?? "paragraph")}\u0000${content}`;
}

/**
 * Give id-less incoming blocks the id of an existing block with the SAME type
 * and text (consumed in document order), recursing into the children of each
 * match. Canonicalization mints a fresh id for a block without one, so without
 * inheritance a re-write of the same logical content would change every block
 * id — recording a phantom version and detaching block-id anchors
 * (annotations) on every idempotent write.
 *
 * Matching is by content, not position: an insert or delete shifts positions,
 * and positional inheritance would hand an annotated block's id to a NEW block
 * at its old index — silently re-attaching comments to unrelated text. With
 * content matching, unchanged blocks keep their ids wherever they moved, and a
 * changed block simply gets a fresh id (its annotations fall back to their
 * stored quote, the established recovery path). Ids already used by the
 * incoming array are never donated a second time.
 */
export function inheritBlockIds(blocks: unknown[], previous: unknown[]): unknown[] {
  blocks = normalizeMermaidBlocks(blocks).blocks;
  previous = normalizeMermaidBlocks(previous).blocks;
  const usedIds = new Set<string>();
  for (const block of blocks) {
    const id = (block as Record<string, unknown> | null)?.["id"];
    if (typeof id === "string") usedIds.add(id);
  }

  const donors = new Map<string, Record<string, unknown>[]>();
  for (const prev of previous) {
    if (!prev || typeof prev !== "object") continue;
    const candidate = prev as Record<string, unknown>;
    if (typeof candidate["id"] !== "string" || usedIds.has(candidate["id"])) continue;
    const key = blockKey(candidate);
    const queue = donors.get(key);
    if (queue) queue.push(candidate);
    else donors.set(key, [candidate]);
  }

  return blocks.map((block) => {
    if (!block || typeof block !== "object") return block;
    const incoming = block as Record<string, unknown>;
    if (incoming["id"] !== undefined) return block;

    const donor = donors.get(blockKey(incoming))?.shift();
    if (!donor) return block;

    const inherited: Record<string, unknown> = { ...incoming, id: donor["id"] };
    if (Array.isArray(inherited["children"]) && Array.isArray(donor["children"])) {
      inherited["children"] = inheritBlockIds(inherited["children"], donor["children"]);
    }
    return inherited;
  });
}
