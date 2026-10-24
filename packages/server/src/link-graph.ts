// ============================================================
// Doc link graph: outbound links + backlinks per space
// ============================================================
//
// Extracts doc→doc references from markdown bodies and BlockNote
// inline links, resolves them against the space's docs root, and
// caches each Doc's links and the resulting graph, refreshing only
// the Docs that changed. The graph is derived, in-memory, and
// rebuildable — never written to the workspace.
//
// Link semantics: a leading `/` resolves from the space docs root
// (the recommended, rename-stable form); anything else resolves
// relative to the linking doc's folder. External targets (URLs,
// mailto:, anchors) are ignored. Broken links are legal — they may
// simply be not-yet-written docs — and are reported, not rejected.

import { Parser } from "htmlparser2";
import { docStat, listDocs, readDoc } from "./store.ts";
import { onDocContentChanged } from "./content-events.ts";
import { LINK_CLOSE, LINK_OPEN, sentenceContext } from "./link-context.ts";
import { resolveDocLink, type DocListEntry } from "@worktable/types";
import {
  NO_DOC_PATH_MOVES,
  readDocAliases,
  resolveDocAliasIn,
  type DocAliases,
  type DocPathMoves,
} from "./doc-aliases.ts";
import { onWorkspaceChange } from "./workspace-events.ts";
import { canReuseDerived, type DerivedRevision } from "./derived-revision.ts";
import { readDocumentCatalogSnapshot } from "./document-query.ts";
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts";
import { filesPreviewEnabled } from "./files-preview.ts";

export { resolveDocLink } from "@worktable/types";

export interface DocLink {
  /** Raw link target as written in the doc. */
  target: string;
  /** Canonical doc path the target resolves to. */
  resolvedPath: string;
  /** Whether a doc exists at the resolved path. */
  resolved: boolean;
}

export interface SpaceLinkGraph {
  /** Outbound doc links per doc path. */
  outbound: Map<string, DocLink[]>;
  /** Doc paths linking to the keyed doc (resolved links only). */
  inbound: Map<string, string[]>;
  /** Docs with no inbound links from any other doc. */
  orphans: string[];
  /** Outbound links whose target doc does not exist. */
  broken: Array<{ docPath: string; target: string; resolvedPath: string }>;
  /** For each linked doc, its first link from each source doc and how many there are. */
  inboundContext: Map<string, Map<string, InboundLinks>>;
}

/** A source doc's links to one doc: the first one's sentence, and the count. */
export interface InboundLinks {
  context: string;
  mark?: { start: number; length: number };
  count: number;
}

/** A doc that links to another, with the sentence around its first link. */
export interface DocBacklink extends InboundLinks {
  path: string;
}

// ── Extraction ────────────────────────────────────────────────

/** A link target and the sentence it sits in. */
export interface ExtractedDocLink {
  target: string;
  /** An image, video, audio or file the doc shows, rather than links to. */
  embed?: true;
  /** The sentence holding the link, as plain text, trimmed to fit a row. */
  context: string;
  /** Where the link's words sit in `context`. */
  mark?: { start: number; length: number };
}

function linkWithContext(target: string, marked: string): ExtractedDocLink {
  const { text, mark } = sentenceContext(marked);
  return { target, context: text, ...(mark ? { mark } : {}) };
}

/** An embedded file, described by its alt text, caption or name. */
function embedWithContext(target: string, label: string): ExtractedDocLink {
  return { ...linkWithContext(target, label.trim()), embed: true };
}

/** Media tags a Markdown Doc may write as HTML. */
const HTML_MEDIA_TAGS = new Set(["img", "video", "audio", "source"]);
const HTML_MEDIA_HINT = /<(?:img|video|audio|source)\b/i;

/**
 * The files a Doc's HTML media tags show, read as a browser reads them:
 * whole attributes, outside other attributes' values, entities decoded.
 */
function htmlMediaEmbeds(markdown: string): ExtractedDocLink[] {
  if (!HTML_MEDIA_HINT.test(markdown)) return [];
  const embeds: ExtractedDocLink[] = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      if (!HTML_MEDIA_TAGS.has(name) || !attributes.src) return;
      embeds.push(embedWithContext(attributes.src, attributes.alt ?? ""));
    },
  });
  parser.write(markdown);
  parser.end();
  return embeds;
}

/** Fenced code, with backticks or tildes, which never holds links. */
export const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;

/** Lines that start a block of their own rather than continue a paragraph. */
const BLOCK_START = /^\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/;

/** An ATX heading is a block of one line. */
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;

/** The bounds of the paragraph, list item or other block around `at`. */
function blockAround(text: string, at: number, length: number): [number, number] {
  const lineAt = (from: number) => {
    const end = text.indexOf("\n", from);
    return text.slice(from, end === -1 ? undefined : end);
  };
  let start = text.lastIndexOf("\n", at - 1) + 1;
  if (HEADING.test(lineAt(start))) {
    const end = text.indexOf("\n", at + length);
    return [start, end === -1 ? text.length : end];
  }
  while (start > 0) {
    const previousStart = text.lastIndexOf("\n", start - 2) + 1;
    const previous = text.slice(previousStart, start - 1);
    if (
      previous.trim() === "" ||
      HEADING.test(previous) ||
      BLOCK_START.test(lineAt(start))
    ) {
      break;
    }
    start = previousStart;
  }
  let end = text.indexOf("\n", at + length);
  while (end !== -1) {
    const next = lineAt(end + 1);
    if (next.trim() === "" || BLOCK_START.test(next)) break;
    end = text.indexOf("\n", end + 1);
  }
  return [start, end === -1 ? text.length : end];
}

/** A Markdown line as people read it: links become their text, markers go. */
function markdownLineText(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, "$2")
    .replace(/\|/g, " ");
}

function extractMarkdownLinks(markdown: string): ExtractedDocLink[] {
  const links: ExtractedDocLink[] = [];
  // Inline links [text](target "title"), excluding images ![alt](src).
  const linkRe = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const withoutFences = markdown.replace(FENCED_CODE, "");
  // Code spans never register as links; blanking them keeps offsets, so a
  // link whose text wraps onto the next line still matches.
  const scanned = withoutFences.replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(scanned)) !== null) {
    if (match[1] === "!") {
      links.push(embedWithContext(match[3]!, match[2] ?? ""));
      continue;
    }
    // The block the link sits in, with this link's words marked; code spans
    // read as their text.
    const [start, end] = blockAround(withoutFences, match.index, match[0].length);
    const offset = match.index - start;
    const block = withoutFences.slice(start, end);
    const lines = (
      block.slice(0, offset) +
      `${LINK_OPEN}${match[2] ?? ""}${LINK_CLOSE}` +
      block.slice(offset + match[0].length)
    )
      .replace(/`([^`\n]*)`/g, "$1")
      // Links first: their text may wrap across the lines.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .split("\n")
      .map(markdownLineText)
      .join(" ");
    links.push(linkWithContext(match[3]!, lines));
  }
  links.push(...htmlMediaEmbeds(scanned));
  return links;
}

/** The readable text of a BlockNote inline run; `marked`'s words are marked. */
function inlineText(content: unknown[], marked?: unknown): string {
  let text = "";
  for (const inline of content) {
    if (!inline || typeof inline !== "object") continue;
    const node = inline as Record<string, unknown>;
    let part = "";
    if (typeof node.text === "string") part = node.text;
    else if (Array.isArray(node.content)) part = inlineText(node.content);
    text += inline === marked ? `${LINK_OPEN}${part}${LINK_CLOSE}` : part;
  }
  return text;
}

/** Rich-text blocks that show a file at their `url`. */
const MEDIA_BLOCKS = new Set(["image", "video", "audio", "file"]);

function extractInlineLinks(content: unknown[], links: ExtractedDocLink[]): void {
  for (const inline of content) {
    if (!inline || typeof inline !== "object") continue;
    const node = inline as Record<string, unknown>;
    if (node.type === "link" && typeof node.href === "string") {
      links.push(linkWithContext(node.href, inlineText(content, inline)));
    }
  }
}

/** A table's cells, each an inline run, whichever shape the cell has. */
function tableCellRuns(content: Record<string, unknown>): unknown[][] {
  const rows = Array.isArray(content.rows) ? content.rows : [];
  return rows.flatMap((row) => {
    const cells = (row as Record<string, unknown> | null)?.cells;
    if (!Array.isArray(cells)) return [];
    return cells.flatMap((cell) => {
      if (Array.isArray(cell)) return [cell];
      const inner = (cell as Record<string, unknown> | null)?.content;
      return Array.isArray(inner) ? [inner] : [];
    });
  });
}

function extractBlockNoteLinks(
  blocks: unknown[],
  links: ExtractedDocLink[] = []
): ExtractedDocLink[] {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (Array.isArray(b.content)) {
      extractInlineLinks(b.content, links);
    } else if (
      b.content &&
      typeof b.content === "object" &&
      (b.content as Record<string, unknown>).type === "tableContent"
    ) {
      for (const run of tableCellRuns(b.content as Record<string, unknown>)) {
        extractInlineLinks(run, links);
      }
    }
    const props = b.props as Record<string, unknown> | undefined;
    if (
      typeof b.type === "string" &&
      MEDIA_BLOCKS.has(b.type) &&
      typeof props?.url === "string" &&
      props.url
    ) {
      const label =
        typeof props.caption === "string" && props.caption
          ? props.caption
          : typeof props.name === "string"
            ? props.name
            : "";
      links.push(embedWithContext(props.url, label));
    }
    if (Array.isArray(b.children)) {
      extractBlockNoteLinks(b.children, links);
    }
  }
  return links;
}

/** Link targets from a doc body (markdown string or BlockNote blocks), with their context. */
export function extractDocLinks(content: string | unknown[]): ExtractedDocLink[] {
  if (typeof content === "string") return extractMarkdownLinks(content);
  if (Array.isArray(content)) return extractBlockNoteLinks(content);
  return [];
}

/** Raw link targets from a doc body (markdown string or BlockNote blocks). */
export function extractDocLinkTargets(content: string | unknown[]): string[] {
  return extractDocLinks(content).map((link) => link.target);
}

// ── Graph cache ─────────────────────────────────────────────
//
// Per Space: each Doc's raw link targets with the source revision they were
// read from, and the graph resolved from them. Change events mark the Space
// dirty and name the Docs that changed. The next read re-lists the Space,
// re-reads only Docs whose revision changed or that an event named, and
// re-resolves the graph, which needs no reads.

/** Rebuilds one read waits for before answering with the latest graph. */
const MAX_REBUILD_ROUNDS = 3;

interface DocTargets extends DerivedRevision {
  links: ExtractedDocLink[];
}

interface SpaceLinks {
  docs: Map<string, DocTargets>;
  graph: SpaceLinkGraph | null;
  dirty: boolean;
  /** Doc paths to re-read even when their revision looks unchanged. */
  forced: Set<string>;
  building: Promise<void> | null;
}

const spaces = new Map<string, SpaceLinks>();
let resetEpoch = 0;

function markSpace(spaceId: string, docPath?: string): void {
  const space = spaces.get(spaceId);
  if (!space) return;
  space.dirty = true;
  if (docPath !== undefined) space.forced.add(docPath);
}

/** Re-check every Space at its next read; unchanged Docs are not re-read. */
export function invalidateLinkGraph(): void {
  for (const space of spaces.values()) space.dirty = true;
}

// Store-level change notifications cover internal writes whose watcher
// events are suppressed (REST PUT, MCP writes, Yjs persists); workspace
// events carry external edits and catalog changes.
onDocContentChanged((spaceId, docPath) => {
  markSpace(spaceId, docPath);
});
onWorkspaceChange((event) => {
  switch (event.type) {
    case "doc":
      markSpace(event.spaceId, event.docPath);
      break;
    case "space":
    case "docAliases":
    case "documentCorpus":
      markSpace(event.spaceId);
      break;
    case "workspaceReset":
      resetEpoch += 1;
      spaces.clear();
      break;
  }
});

let rebuildHookForTests: (() => Promise<void>) | null = null;

export function setLinkGraphRebuildHookForTests(
  hook: (() => Promise<void>) | null,
): void {
  rebuildHookForTests = hook;
}

function resolveSpaceLinkGraph(
  docPaths: string[],
  docs: ReadonlyMap<string, DocTargets>,
  aliases: DocAliases,
  filePaths: ReadonlySet<string> | null,
): SpaceLinkGraph {
  // Embeds count only once files are part of the Space; until then a doc's
  // images are none of the graph's business.
  const docSet = new Set([...docPaths, ...(filePaths ?? [])]);
  const outbound = new Map<string, DocLink[]>();
  const inbound = new Map<string, string[]>();
  const broken: SpaceLinkGraph["broken"] = [];
  const inboundContext: SpaceLinkGraph["inboundContext"] = new Map();

  for (const docPath of docPaths) {
    const extracted = docs.get(docPath)?.links;
    if (!extracted) continue;

    const links: DocLink[] = [];
    const seen = new Set<string>();
    for (const { target, context, mark, embed } of extracted) {
      if (embed && !filePaths) continue;
      const lexicalPath = resolveDocLink(docPath, target);
      if (lexicalPath === null) continue;
      const resolvedPath = resolveDocAliasIn(aliases, lexicalPath);
      if (resolvedPath === null) {
        throw new Error(`Document alias cycle or hop limit exceeded for ${lexicalPath}`);
      }
      if (resolvedPath === docPath) continue;
      if (seen.has(resolvedPath)) {
        const known = inboundContext.get(resolvedPath)?.get(docPath);
        if (known) known.count += 1;
        continue;
      }
      seen.add(resolvedPath);

      const resolved = docSet.has(resolvedPath);
      links.push({ target, resolvedPath, resolved });
      if (resolved) {
        const sources = inbound.get(resolvedPath) ?? [];
        sources.push(docPath);
        inbound.set(resolvedPath, sources);
        const contexts = inboundContext.get(resolvedPath) ?? new Map<string, InboundLinks>();
        contexts.set(docPath, { context, ...(mark ? { mark } : {}), count: 1 });
        inboundContext.set(resolvedPath, contexts);
      } else {
        broken.push({ docPath, target, resolvedPath });
      }
    }
    if (links.length > 0) outbound.set(docPath, links);
  }

  const orphans = docPaths.filter((path) => !inbound.has(path));
  return { outbound, inbound, orphans, broken, inboundContext };
}

/** The Space's files, from the catalog snapshot rather than its folder. */
async function spaceFilePaths(spaceId: string): Promise<Set<string>> {
  const catalog = await readDocumentCatalogSnapshot(spaceId);
  return new Set(
    catalog.entries.flatMap((entry) =>
      entry.kind === "document" &&
      entry.descriptor.format.id === BUILTIN_DOCUMENT_FORMATS.file
        ? [entry.descriptor.path]
        : [],
    ),
  );
}

async function buildSpaceLinks(spaceId: string, space: SpaceLinks): Promise<void> {
  const forced = space.forced;
  // Marks made while this build runs stay for the next one.
  space.forced = new Set();
  space.dirty = false;
  try {
    const docPaths = await listDocs(spaceId);
    const { aliases, error: aliasError } = await readDocAliases(spaceId);
    if (!aliases) {
      throw new Error(aliasError ?? "Document aliases are unavailable");
    }

    const docs = new Map<string, DocTargets>();
    for (const docPath of docPaths) {
      const readAt = Date.now();
      const stat = await docStat(spaceId, docPath);
      const revision = stat ? `${stat.format}:${stat.updatedAt}` : "";
      const cached = space.docs.get(docPath);
      if (
        cached &&
        !forced.has(docPath) &&
        canReuseDerived(cached, revision, stat?.updatedAt)
      ) {
        docs.set(docPath, cached);
        continue;
      }
      const result = await readDoc(spaceId, docPath);
      if (result.error || result.data === null) continue;
      docs.set(docPath, {
        revision,
        readAt,
        links: extractDocLinks(result.data as string | unknown[]),
      });
    }

    const graph = resolveSpaceLinkGraph(
      docPaths,
      docs,
      aliases,
      filesPreviewEnabled() ? await spaceFilePaths(spaceId) : null,
    );
    await rebuildHookForTests?.();
    space.docs = docs;
    space.graph = graph;
  } catch (error) {
    space.dirty = true;
    for (const docPath of forced) space.forced.add(docPath);
    throw error;
  }
}

function rebuildSpaceLinks(spaceId: string, space: SpaceLinks): Promise<void> {
  if (!space.building) {
    const building = buildSpaceLinks(spaceId, space);
    space.building = building;
    void building
      .finally(() => {
        if (space.building === building) space.building = null;
      })
      .catch(() => undefined);
  }
  return space.building;
}

export async function getSpaceLinkGraph(spaceId: string): Promise<SpaceLinkGraph> {
  for (let round = 1; ; round += 1) {
    const epoch = resetEpoch;
    let space = spaces.get(spaceId);
    if (!space) {
      space = { docs: new Map(), graph: null, dirty: true, forced: new Set(), building: null };
      spaces.set(spaceId, space);
    }
    if (space.graph && !space.dirty && !space.building) return space.graph;
    await rebuildSpaceLinks(spaceId, space);
    // A workspace reset retired this cache: never answer from another
    // workspace's Docs.
    if (resetEpoch !== epoch) continue;
    // Continuous edits must not hold a reader hostage: after a few rounds,
    // answer with the graph as of the latest rebuild.
    if (space.graph && (!space.dirty || round >= MAX_REBUILD_ROUNDS)) {
      return space.graph;
    }
  }
}

export async function getDocLinks(
  spaceId: string,
  docPath: string
): Promise<{ links: DocLink[]; backlinks: string[] }> {
  const graph = await getSpaceLinkGraph(spaceId);
  return {
    links: graph.outbound.get(docPath) ?? [],
    backlinks: graph.inbound.get(docPath) ?? [],
  };
}

/**
 * The docs linking to one doc, from the graph as last built, without waiting.
 * A Space whose graph is out of date is rebuilt in the background, and one
 * never built answers null until its first build lands. Page reads use this so
 * opening a doc never waits on re-reading the Space.
 */
export function peekDocBacklinks(
  spaceId: string,
  docPath: string,
  moves: DocPathMoves = NO_DOC_PATH_MOVES
): DocBacklink[] | null {
  const space = spaces.get(spaceId);
  if (!space?.graph || space.dirty) warmLinkGraph(spaceId);
  const graph = space?.graph;
  if (!graph) return null;
  // A graph built before a move still names the old paths: `moves` maps
  // them to where those docs are now, until the rebuild lands.
  const backlinks = new Map<string, InboundLinks>();
  for (const target of moves.keysFor(graph.inbound, docPath)) {
    const sources = graph.inbound.get(target) ?? [];
    const contexts = graph.inboundContext.get(target);
    for (const source of sources) {
      const path = moves.current(source);
      // A doc that now links to itself is not a backlink.
      if (path === docPath || backlinks.has(path)) continue;
      backlinks.set(path, contexts?.get(source) ?? { context: "", count: 1 });
    }
  }
  return [...backlinks].map(([path, links]) => ({ path, ...links }));
}

/** Start building a Space's graph in the background if it is missing or out of date. */
export function warmLinkGraph(spaceId: string): void {
  void getSpaceLinkGraph(spaceId).catch(() => undefined);
}

/** Annotate a doc list with backlink counts from one graph build. */
export async function decorateDocsWithBacklinkCounts(
  spaceId: string,
  docs: DocListEntry[]
): Promise<DocListEntry[]> {
  const graph = await getSpaceLinkGraph(spaceId);
  return docs.map((doc) => ({
    ...doc,
    backlinkCount: graph.inbound.get(doc.path)?.length ?? 0,
  }));
}
