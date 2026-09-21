/**
 * Markdown ↔ BlockNote conversion utilities.
 *
 * Uses @blocknote/server-util's ServerBlockNoteEditor for conversion.
 * The editor instance is created lazily and cached (JSDOM is expensive to init).
 */

import { canonicalizeBlocks, getServerEditor } from "./blocknote.ts";
import {
  DEFAULT_MERMAID_TITLE,
  isCustomMermaidBlock,
  isMermaidCodeBlock,
  normalizeMermaidBlocks,
} from "@worktable/types";

type Block = Record<string, unknown>;

// ── Shared ServerBlockNoteEditor ───────────────────────────
//
// Uses the shared custom-schema editor (see ./blocknote.ts) so markdown
// conversion knows the same block types as the collaborative runtime —
// notably mermaid and the custom code block, which the default schema
// would degrade to paragraphs.

const getEditor = getServerEditor;

// ── Lossiness Detection ────────────────────────────────────

/** Block types that convert cleanly to markdown */
const MARKDOWN_SAFE_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "codeBlock",
  "table",
  "image",
  "quote",
]);

/** Inline styles that survive markdown round-trip */
const MARKDOWN_SAFE_STYLES = new Set([
  "bold",
  "italic",
  "strikethrough",
  "code",
]);

const MARKDOWN_REPRESENTABLE_MERMAID_PROPS = new Set([
  "data",
  "title",
  "collapsed",
  "locked",
  "textColor",
  "backgroundColor",
  "textAlignment",
]);

export interface MarkdownSafetyResult {
  safe: boolean;
  lossyFields: string[];
}

/**
 * Inline content of a table cell across both on-disk shapes: BlockNote
 * ≤0.46 stored cells as plain inline arrays, 0.51+ as
 * `{ type: "tableCell", content, props }` objects. Stored docs contain
 * both forever, so every cell walker must go through this.
 */
function cellInlines(cell: unknown): unknown[] {
  if (Array.isArray(cell)) return cell;
  const content = (cell as Record<string, unknown> | null | undefined)?.content;
  return Array.isArray(content) ? content : [];
}

/** Cell-level props (0.51+ tableCell objects only; legacy array cells have none). */
function cellProps(cell: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(cell) || !cell || typeof cell !== "object") return undefined;
  const props = (cell as Record<string, unknown>)["props"];
  return props && typeof props === "object" ? (props as Record<string, unknown>) : undefined;
}

/**
 * Walk a block tree and determine if all content can be represented in markdown
 * without data loss.
 */
export function isMarkdownSafe(blocks: unknown[]): MarkdownSafetyResult {
  blocks = normalizeMermaidBlocks(blocks).blocks;
  const lossyFields = new Set<string>();

  function checkBlock(block: any): void {
    // Block type check
    const blockType: string = block?.type ?? "paragraph";
    if (blockType === "mermaid") {
      const mermaidProps = block?.props ?? {};
      for (const prop of Object.keys(mermaidProps)) {
        if (!MARKDOWN_REPRESENTABLE_MERMAID_PROPS.has(prop)) {
          lossyFields.add(`mermaid:prop:${prop}`);
        }
      }
      if (
        mermaidProps.title !== undefined &&
        mermaidProps.title !== DEFAULT_MERMAID_TITLE
      ) {
        lossyFields.add("mermaid:title");
      }
      if (
        mermaidProps.collapsed !== undefined &&
        mermaidProps.collapsed !== "false"
      ) {
        lossyFields.add("mermaid:collapsed");
      }
      if (
        mermaidProps.locked !== undefined &&
        mermaidProps.locked !== "false"
      ) {
        lossyFields.add("mermaid:locked");
      }
    } else if (!MARKDOWN_SAFE_BLOCK_TYPES.has(blockType)) {
      lossyFields.add(`block:${blockType}`);
    }

    // Property checks
    const props = block?.props;
    if (props) {
      if (props.textColor && props.textColor !== "default") {
        lossyFields.add("textColor");
      }
      if (props.backgroundColor && props.backgroundColor !== "default") {
        lossyFields.add("backgroundColor");
      }
      if (props.textAlignment && props.textAlignment !== "left") {
        lossyFields.add("textAlignment");
      }
    }

    // Inline style checks (for content array)
    const content = block?.content;
    if (Array.isArray(content)) {
      for (const inline of content) {
        if (inline?.styles) {
          for (const [style, value] of Object.entries(inline.styles)) {
            if (value && !MARKDOWN_SAFE_STYLES.has(style)) {
              lossyFields.add(`style:${style}`);
            }
          }
        }
      }
    }

    // Table content check (different structure)
    if (content?.type === "tableContent" && Array.isArray(content.rows)) {
      for (const row of content.rows) {
        if (Array.isArray(row.cells)) {
          for (const cell of row.cells) {
            for (const inline of cellInlines(cell) as any[]) {
              if (inline?.styles) {
                for (const [style, value] of Object.entries(inline.styles)) {
                  if (value && !MARKDOWN_SAFE_STYLES.has(style)) {
                    lossyFields.add(`style:${style}`);
                  }
                }
              }
            }
            const props = cellProps(cell);
            if (props) {
              if (props.textColor && props.textColor !== "default") {
                lossyFields.add("textColor");
              }
              if (props.backgroundColor && props.backgroundColor !== "default") {
                lossyFields.add("backgroundColor");
              }
              if (props.textAlignment && props.textAlignment !== "left") {
                lossyFields.add("textAlignment");
              }
            }
          }
        }
      }
    }

    // Recurse into children
    if (Array.isArray(block?.children)) {
      for (const child of block.children) {
        checkBlock(child);
      }
    }
  }

  for (const block of blocks) {
    checkBlock(block);
  }

  return {
    safe: lossyFields.size === 0,
    lossyFields: Array.from(lossyFields),
  };
}

// ── Conversion ─────────────────────────────────────────────

/**
 * Convert BlockNote blocks to markdown string.
 * Lossy: some block types and styles may not survive.
 * Throws on blocks the editor schema doesn't recognize — prefer
 * blocksToMarkdownSafe for anything read from disk, where foreign props
 * (written by other BlockNote versions or by agents) are a fact of life.
 */
export async function blocksToMarkdown(blocks: unknown[]): Promise<string> {
  const editor = await getEditor();
  return editor.blocksToMarkdownLossy(blocks);
}

export type MarkdownStorageConversion =
  | { safe: true; markdown: string; lossyFields: [] }
  | { safe: false; lossyFields: string[] };

/**
 * Prepare the exact representation used when rich storage is replaced by
 * Markdown. Unlike read projections, this never sanitizes foreign fields:
 * anything the converter cannot consume keeps the doc in rich storage.
 */
export async function prepareMarkdownStorageConversion(
  blocks: unknown[]
): Promise<MarkdownStorageConversion> {
  const normalizedBlocks = normalizeMermaidBlocks(blocks).blocks;
  const safety = isMarkdownSafe(normalizedBlocks);
  if (!safety.safe) {
    return { safe: false, lossyFields: safety.lossyFields };
  }

  try {
    const editor = await getEditor();
    const schema = editor?.editor?.schema ?? editor?.schema ?? {};
    const blockSchema = schema.blockSchema ?? {};
    const schemaLosses = new Set<string>();
    const tableCellProps = new Set([
      "backgroundColor",
      "textColor",
      "textAlignment",
      "colspan",
      "rowspan",
    ]);

    const validateSchemaFields = (block: any): void => {
      const type = typeof block?.type === "string" ? block.type : "paragraph";
      const propSchema = blockSchema[type]?.propSchema ?? {};
      for (const prop of Object.keys(block?.props ?? {})) {
        if (!(prop in propSchema)) schemaLosses.add(`${type}:prop:${prop}`);
      }

      const content = block?.content;
      if (content?.type === "tableContent" && Array.isArray(content.rows)) {
        for (const row of content.rows) {
          for (const cell of Array.isArray(row?.cells) ? row.cells : []) {
            if (!Array.isArray(cell) && cell && typeof cell === "object") {
              for (const prop of Object.keys(cell.props ?? {})) {
                if (!tableCellProps.has(prop)) {
                  schemaLosses.add(`tableCell:prop:${prop}`);
                }
              }
            }
          }
        }
      }
      for (const child of Array.isArray(block?.children) ? block.children : []) {
        validateSchemaFields(child);
      }
    };
    for (const block of normalizedBlocks) validateSchemaFields(block);
    if (schemaLosses.size > 0) {
      return { safe: false, lossyFields: [...schemaLosses] };
    }

    const canonicalBlocks = await canonicalizeBlocks(normalizedBlocks);
    const markdown = await blocksToMarkdown(canonicalBlocks);
    if (canonicalBlocks.length === 0 && markdown.trim() === "") {
      return { safe: true, markdown, lossyFields: [] };
    }
    const parsedBlocks = await markdownToBlocks(markdown);
    const roundTripped = await canonicalizeBlocks(parsedBlocks);
    const withoutBlockIds = (values: unknown[]): unknown[] =>
      values.map((value) => {
        if (!value || typeof value !== "object") return value;
        const { id: _id, children, ...block } = value as Record<string, unknown>;
        return {
          ...block,
          children: Array.isArray(children) ? withoutBlockIds(children) : [],
        };
      });
    if (
      JSON.stringify(withoutBlockIds(roundTripped)) !==
      JSON.stringify(withoutBlockIds(canonicalBlocks))
    ) {
      return { safe: false, lossyFields: ["markdown-round-trip"] };
    }

    return {
      safe: true,
      markdown,
      lossyFields: [],
    };
  } catch {
    return { safe: false, lossyFields: ["unsupported-formatting"] };
  }
}

/**
 * Strip anything the editor schema doesn't know: unknown props on known
 * block types, unknown inline styles, and unknown block types (degraded
 * to paragraphs that keep their text). The converter crashes on all
 * three; real workspaces contain all three.
 */
export function sanitizeBlocksForConversion(blocks: unknown[], editor: any): unknown[] {
  // ServerBlockNoteEditor wraps the real editor; schema lives one level in.
  const schema = editor?.editor?.schema ?? editor?.schema ?? {};
  const blockSchema = schema.blockSchema ?? {};
  const styleSchema = schema.styleSchema ?? {};

  function sanitizeInlines(content: unknown): unknown {
    if (!Array.isArray(content)) return content;
    return content.map((inline: any) => {
      if (inline && typeof inline === "object" && inline.styles && typeof inline.styles === "object") {
        const styles = Object.fromEntries(
          Object.entries(inline.styles).filter(([key]) => key in styleSchema)
        );
        return { ...inline, styles };
      }
      return inline;
    });
  }

  function sanitizeBlock(block: any): any {
    if (!block || typeof block !== "object") return block;

    const knownType = typeof block.type === "string" && block.type in blockSchema;
    const type = knownType ? block.type : "paragraph";
    const propSchema = blockSchema[type]?.propSchema ?? {};
    const props = Object.fromEntries(
      Object.entries(block.props ?? {}).filter(([key]) => key in propSchema)
    );

    let content = block.content;
    if (!knownType) {
      // Foreign block: keep whatever inline text it carried.
      const text = inlineTextPreview(block.content);
      content = text ? [{ type: "text", text, styles: {} }] : [];
    } else if (Array.isArray(content)) {
      content = sanitizeInlines(content);
    } else if (content?.type === "tableContent" && Array.isArray(content.rows)) {
      content = {
        ...content,
        rows: content.rows.map((row: any) => ({
          ...row,
          cells: Array.isArray(row?.cells)
            ? row.cells.map((cell: any) => {
                if (Array.isArray(cell)) return sanitizeInlines(cell);
                // 0.51+ tableCell object: sanitize its inline content in place.
                if (cell && typeof cell === "object" && Array.isArray(cell.content)) {
                  return { ...cell, content: sanitizeInlines(cell.content) };
                }
                return cell;
              })
            : row?.cells,
        })),
      };
    }

    return {
      ...block,
      type,
      props,
      content,
      children: Array.isArray(block.children)
        ? block.children.map(sanitizeBlock)
        : [],
    };
  }

  return blocks.map(sanitizeBlock);
}

/**
 * Convert blocks to markdown without ever throwing: tries the blocks
 * as-is, retries with schema-sanitized blocks, returns null if even
 * that fails. Callers fall back to returning raw blocks.
 */
export async function blocksToMarkdownSafe(blocks: unknown[]): Promise<string | null> {
  const editor = await getEditor();
  const normalized = normalizeMermaidBlocks(blocks).blocks;
  try {
    return await editor.blocksToMarkdownLossy(normalized);
  } catch {
    // fall through to sanitized retry
  }
  try {
    return await editor.blocksToMarkdownLossy(
      sanitizeBlocksForConversion(normalized, editor)
    );
  } catch {
    return null;
  }
}

/**
 * Convert markdown string to BlockNote blocks.
 */
export async function markdownToBlocks(markdown: string): Promise<Block[]> {
  const editor = await getEditor();
  const parsed = await editor.tryParseMarkdownToBlocks(markdown);
  return normalizeMermaidBlocks(parsed).blocks as Block[];
}

// ── Content Format Detection ───────────────────────────────

export type ContentFormat = "markdown" | "blocknote";

export interface BlockSummaryEntry {
  index: number;
  id?: string;
  type: string;
  text?: string;
  preview?: string;
}

/**
 * Detect whether MCP content is a markdown string or BlockNote block array.
 */
export function detectContentFormat(content: unknown): ContentFormat {
  if (typeof content === "string") return "markdown";
  if (Array.isArray(content)) return "blocknote";
  return "blocknote"; // fallback
}

// ── Heading Extraction ─────────────────────────────────────

/**
 * Extract heading texts from a block array for metadata.
 */
export function extractHeadings(blocks: unknown[]): string[] {
  const headings: string[] = [];

  function walk(block: any): void {
    if (block?.type === "heading" && Array.isArray(block.content)) {
      const text = block.content
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text ?? "")
        .join("");
      if (text) headings.push(text);
    }
    if (Array.isArray(block?.children)) {
      for (const child of block.children) walk(child);
    }
  }

  for (const block of blocks) walk(block);
  return headings;
}

export function extractMarkdownHeadings(markdown: string): string[] {
  const headingMatches = markdown.match(/^#{1,6}\s+.+$/gm) ?? [];
  return headingMatches.map((heading) => heading.replace(/^#{1,6}\s+/, ""));
}

function inlineTextPreview(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => item.text ?? "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function blockPreview(block: any): string {
  const type = typeof block?.type === "string" ? block.type : "unknown";

  if (type === "mermaid") {
    const data = typeof block?.props?.data === "string" ? block.props.data : "";
    return data.split(/\r?\n/).find((line: string) => line.trim().length > 0)?.trim() ?? "";
  }

  if (type === "table" && block?.content?.type === "tableContent") {
    const firstRow = block.content.rows?.[0];
    const firstCell = firstRow?.cells?.[0];
    const text = inlineTextPreview(cellInlines(firstCell));
    return text ? `table: ${text}` : "table";
  }

  if (type === "codeBlock") {
    const text = inlineTextPreview(block?.content);
    return text.slice(0, 120);
  }

  return inlineTextPreview(block?.content).slice(0, 160);
}

export function summarizeBlocks(blocks: unknown[], limit = 50): BlockSummaryEntry[] {
  return blocks.slice(0, limit).map((rawBlock, index) => {
    const block = rawBlock as Record<string, unknown> | null | undefined;
    const type = typeof block?.type === "string" ? block.type : "unknown";
    const preview = blockPreview(block);
    const summary: BlockSummaryEntry = {
      index,
      type,
    };

    if (typeof block?.id === "string") {
      summary.id = block.id;
    }

    if (preview) {
      if (type === "heading" || type === "paragraph" || type.endsWith("ListItem")) {
        summary.text = preview;
      } else {
        summary.preview = preview;
      }
    }

    return summary;
  });
}

export function getRichBlockTypes(blocks: unknown[]): string[] {
  const richTypes = new Set<string>();

  function walk(block: any): void {
    const blockType = typeof block?.type === "string" ? block.type : "paragraph";
    if (!MARKDOWN_SAFE_BLOCK_TYPES.has(blockType)) {
      richTypes.add(blockType);
    }

    if (Array.isArray(block?.children)) {
      for (const child of block.children) walk(child);
    }
  }

  for (const block of blocks) walk(block);
  return Array.from(richTypes).sort();
}

export function containsMermaidBlock(blocks: unknown[]): boolean {
  let found = false;
  const walk = (values: unknown[]) => {
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      if (isCustomMermaidBlock(value) || isMermaidCodeBlock(value)) {
        found = true;
        return;
      }
      const children = (value as Record<string, unknown>).children;
      if (Array.isArray(children)) walk(children);
      if (found) return;
    }
  };
  walk(blocks);
  return found;
}

// ── Patch Operations ───────────────────────────────────────

export interface PatchTarget {
  blockId?: string;
  heading?: string;
  index?: number;
  search?: string;
}

export interface PatchOperation {
  action: "replace" | "insert_after" | "insert_before" | "delete" | "append";
  target?: PatchTarget;
  content?: unknown[] | string;
}

export interface PatchSkip {
  index: number;
  action: PatchOperation["action"];
  reason: string;
  target?: PatchTarget;
}

interface ResolvedRange {
  start: number;
  end: number; // exclusive
}

function describeTarget(target?: PatchTarget): string {
  if (!target) return "(no target provided)";
  if (target.blockId) return `blockId=${JSON.stringify(target.blockId)}`;
  if (target.heading) return `heading=${JSON.stringify(target.heading)}`;
  if (target.index !== undefined) return `index=${target.index}`;
  if (target.search) return `search=${JSON.stringify(target.search)}`;
  return "(empty target)";
}

/**
 * Resolve a target to a block index range within a block array.
 */
function resolveTarget(blocks: any[], target: PatchTarget): ResolvedRange | null {
  // By block ID
  if (target.blockId) {
    const idx = blocks.findIndex((b: any) => b.id === target.blockId);
    if (idx === -1) return null;
    return { start: idx, end: idx + 1 };
  }

  // By heading text (section: heading through next same-or-higher-level heading)
  if (target.heading) {
    const searchText = target.heading.toLowerCase();
    let startIdx = -1;
    let headingLevel = 0;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block?.type === "heading") {
        const text = (block.content ?? [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text ?? "")
          .join("")
          .toLowerCase();

        if (startIdx === -1) {
          // Looking for the start heading
          if (text.includes(searchText)) {
            startIdx = i;
            headingLevel = block.props?.level ?? 1;
          }
        } else {
          // Looking for end of section (same or higher level heading)
          const level = block.props?.level ?? 1;
          if (level <= headingLevel) {
            return { start: startIdx, end: i };
          }
        }
      }
    }

    // If we found the heading but reached end of doc
    if (startIdx !== -1) {
      return { start: startIdx, end: blocks.length };
    }
    return null;
  }

  // By index
  if (target.index !== undefined) {
    if (target.index < 0 || target.index >= blocks.length) return null;
    return { start: target.index, end: target.index + 1 };
  }

  // By text search
  if (target.search) {
    const searchText = target.search.toLowerCase();
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const content = block?.content;
      let blockText = "";

      if (Array.isArray(content)) {
        blockText = content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text ?? "")
          .join("");
      } else if (content?.type === "tableContent") {
        // Search through table cells
        for (const row of content.rows ?? []) {
          for (const cell of row.cells ?? []) {
            blockText += (cellInlines(cell) as any[])
              .filter((c: any) => c?.type === "text")
              .map((c: any) => c.text ?? "")
              .join("");
          }
        }
      }

      if (block?.type === "mermaid" && typeof block?.props?.data === "string") {
        blockText += block.props.data;
      }

      if (blockText.toLowerCase().includes(searchText)) {
        return { start: i, end: i + 1 };
      }
    }
    return null;
  }

  return null;
}

/**
 * Apply a series of patch operations to a block array.
 * Returns the modified blocks and metadata.
 */
export async function applyPatchOperations(
  blocks: any[],
  operations: PatchOperation[],
  options?: {
    prepareContent?: (
      content: string | unknown[],
      operation: PatchOperation,
      index: number
    ) => Promise<string | unknown[]>;
  }
): Promise<{ blocks: any[]; operationsApplied: number; skipped: PatchSkip[] }> {
  let result = [...blocks];
  let applied = 0;
  const skipped: PatchSkip[] = [];

  for (const [index, op] of operations.entries()) {
    // Preparation may reject malformed input. Run it only after the operation's
    // other preconditions and target resolve, so skipped content cannot abort a
    // patch that has valid operations after it.
    const contentBlocks = async (): Promise<any[] | undefined> => {
      if (op.content === undefined) return undefined;
      if (typeof op.content !== "string" && !Array.isArray(op.content)) {
        throw new Error(
          `Patch operation ${index + 1} content must be a Markdown string or block array`
        );
      }
      const content = options?.prepareContent
        ? await options.prepareContent(op.content, op, index)
        : op.content;
      return typeof content === "string"
        ? await markdownToBlocks(content)
        : content;
    };

    switch (op.action) {
      case "append": {
        if (op.content === undefined) {
          skipped.push({ index, action: op.action, target: op.target, reason: "append requires content" });
          break;
        }
        result = [...result, ...(await contentBlocks())!];
        applied++;
        break;
      }

      case "delete": {
        if (!op.target) {
          skipped.push({ index, action: op.action, reason: "delete requires a target" });
          break;
        }
        const range = resolveTarget(result, op.target);
        if (!range) {
          skipped.push({ index, action: op.action, target: op.target, reason: `target not found: ${describeTarget(op.target)}` });
          break;
        }
        result.splice(range.start, range.end - range.start);
        applied++;
        break;
      }

      case "replace": {
        if (!op.target) {
          skipped.push({ index, action: op.action, reason: "replace requires a target" });
          break;
        }
        if (op.content === undefined) {
          skipped.push({ index, action: op.action, target: op.target, reason: "replace requires content" });
          break;
        }
        const range = resolveTarget(result, op.target);
        if (!range) {
          skipped.push({ index, action: op.action, target: op.target, reason: `target not found: ${describeTarget(op.target)}` });
          break;
        }
        result.splice(range.start, range.end - range.start, ...(await contentBlocks())!);
        applied++;
        break;
      }

      case "insert_after": {
        if (!op.target) {
          skipped.push({ index, action: op.action, reason: "insert_after requires a target" });
          break;
        }
        if (op.content === undefined) {
          skipped.push({ index, action: op.action, target: op.target, reason: "insert_after requires content" });
          break;
        }
        const range = resolveTarget(result, op.target);
        if (!range) {
          skipped.push({ index, action: op.action, target: op.target, reason: `target not found: ${describeTarget(op.target)}` });
          break;
        }
        result.splice(range.end, 0, ...(await contentBlocks())!);
        applied++;
        break;
      }

      case "insert_before": {
        if (!op.target) {
          skipped.push({ index, action: op.action, reason: "insert_before requires a target" });
          break;
        }
        if (op.content === undefined) {
          skipped.push({ index, action: op.action, target: op.target, reason: "insert_before requires content" });
          break;
        }
        const range = resolveTarget(result, op.target);
        if (!range) {
          skipped.push({ index, action: op.action, target: op.target, reason: `target not found: ${describeTarget(op.target)}` });
          break;
        }
        result.splice(range.start, 0, ...(await contentBlocks())!);
        applied++;
        break;
      }
    }
  }

  return { blocks: result, operationsApplied: applied, skipped };
}
