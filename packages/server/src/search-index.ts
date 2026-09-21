// ============================================================
// MiniSearch-based full-text search index for Worktable
// Indexes documents and records. The common mode projects every authorized
// document format inertly; the legacy mode preserves the historical Doc-only
// result set for callers without documents:read.
// ============================================================

import MiniSearch from "minisearch";
import {
  getDocArchiveInfo,
  getSpaceArchiveInfo,
  listDocs,
  listSpaces,
  readDoc,
  readSpace,
} from "./store.ts";
import { listRecordCollections, listRecords, readRecord } from "./record-store.ts";
import { recordIndex, recordIndexEnabled } from "./record-index.ts";
import {
  createDocumentProjectionBudgetState,
  projectDocumentsForSearch,
} from "./document-query.ts";
import { onDocContentChanged } from "./content-events.ts";
import { onWorkspaceChange } from "./workspace-events.ts";
import {
  getMermaidSource,
  isCustomMermaidBlock,
  markdownPlainText,
  type DocumentFormatClaim,
  type DocumentHealth,
  type RecordFile,
  type SearchResult,
} from "@worktable/types";

export type DocumentSearchAccess = "legacy" | "common";

export const COMMON_SEARCH_PROJECTION_BUDGET = {
  maxDocuments: 128,
  maxOutputBytes: 4 * 1024 * 1024,
  timeoutMs: 2_000,
} as const;

interface DocEntry {
  id: string;
  spaceId: string;
  path: string;
  type: "doc";
  title: string;
  body: string;
  documentKind?: "document" | "conflict";
  documentView?: "doc" | "html";
  formatId?: string;
  sourceVersion?: number;
  health?: DocumentHealth;
}

interface RecordEntry {
  id: string;
  spaceId: string;
  path: string;
  type: "record";
  collectionId: string;
  recordId: string;
  title: string;
  body: string;
}

type IndexEntry = DocEntry | RecordEntry;

export function recordTitle(record: RecordFile, collectionName: string): string {
  const data = record.data as Record<string, unknown>;
  const candidate = data.title ?? data.name;
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  return `${collectionName}: ${record.id}`;
}

export function extractBlockNoteText(blocks: unknown[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;

    if (isCustomMermaidBlock(b)) {
      parts.push(getMermaidSource(b) ?? "");
    }

    if (Array.isArray(b.content)) {
      for (const inline of b.content) {
        if (inline && typeof inline === "object" && typeof (inline as Record<string, unknown>).text === "string") {
          parts.push((inline as Record<string, unknown>).text as string);
        }
      }
    }

    if (Array.isArray(b.children)) {
      parts.push(extractBlockNoteText(b.children));
    }
  }

  return parts.join(" ");
}

/**
 * Drop the first top-level heading block (the one extractTitle reads) so the
 * body — indexed alongside the separately-boosted title field, and shown as
 * the excerpt under the title — does not repeat the title text.
 */
function withoutTitleHeading(blocks: unknown[]): unknown[] {
  const at = blocks.findIndex((b) => {
    if (!b || typeof b !== "object") return false;
    const block = b as Record<string, unknown>;
    if (block.type !== "heading" || !Array.isArray(block.content)) return false;
    return block.content.some(
      (inline) =>
        inline &&
        typeof inline === "object" &&
        typeof (inline as Record<string, unknown>).text === "string" &&
        ((inline as Record<string, unknown>).text as string).length > 0
    );
  });
  if (at === -1) return blocks;
  // Only the heading's own text is the title — blocks nested under it are
  // body content and must stay indexed.
  const heading = blocks[at] as Record<string, unknown>;
  const children = Array.isArray(heading.children) ? heading.children : [];
  return [...blocks.slice(0, at), ...children, ...blocks.slice(at + 1)];
}

export function extractTitle(blocks: unknown[], fallbackPath: string): string {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "heading" && Array.isArray(b.content)) {
      const texts: string[] = [];
      for (const inline of b.content) {
        if (inline && typeof inline === "object" && typeof (inline as Record<string, unknown>).text === "string") {
          texts.push((inline as Record<string, unknown>).text as string);
        }
      }
      if (texts.length > 0) return texts.join(" ");
    }
  }

  const last = (fallbackPath.split("/").pop() ?? fallbackPath)
    .replace(/\.(json|md)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return last.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
}

export function extractMarkdownTitle(
  markdown: string,
  fallbackPath: string,
): string {
  return (
    markdown.match(/^#\s+(.+)/m)?.[1] ??
    fallbackPath.split("/").pop() ??
    fallbackPath
  );
}

/**
 * Readable one-line rendering of a record for excerpt display. The collection
 * name leads because it is part of the indexed body — a search can match on it
 * alone, and the excerpt must show why the record matched.
 */
function recordDisplayText(collectionName: string, data: unknown): string {
  let dataText: string;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    dataText = typeof data === "string" ? data : JSON.stringify(data) ?? "";
  } else {
    dataText = Object.entries(data as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" · ");
  }
  return dataText ? `${collectionName} · ${dataText}` : collectionName;
}

const EXCERPT_LENGTH = 160;
const EXCERPT_LEAD = 40;

/**
 * Plain-text window around the first occurrence of any matched term.
 * Title-only matches (no term in the body) fall back to the body's start.
 */
export function makeExcerpt(body: string, terms: string[]): string | undefined {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return undefined;

  const lower = text.toLowerCase();
  let matchAt = -1;
  for (const term of terms) {
    const needle = term.toLowerCase().trim();
    if (!needle) continue;
    const at = lower.indexOf(needle);
    if (at !== -1 && (matchAt === -1 || at < matchAt)) matchAt = at;
  }

  let start = matchAt <= EXCERPT_LEAD ? 0 : matchAt - EXCERPT_LEAD;
  if (start > 0) {
    // Open on a word boundary, but never push the start past the match itself.
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < matchAt) start = space + 1;
  }

  const end = Math.min(text.length, start + EXCERPT_LENGTH);
  let slice = text.slice(start, end);
  if (end < text.length) {
    // Close on a word boundary unless that would eat too much of the window.
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace > EXCERPT_LENGTH * 0.6) slice = slice.slice(0, lastSpace);
  }

  const head = start > 0 ? "… " : "";
  const tail = start + slice.length < text.length ? " …" : "";
  return `${head}${slice}${tail}`;
}

// Display bodies for excerpt extraction, keyed by index entry id, carried
// beside the MiniSearch instance they were built with: a search holds one
// IndexState across its async archive checks, so a concurrent rebuild (which
// creates a NEW state) can never swap excerpt bodies out from under it.
// MiniSearch does not store raw field text, and records index JSON while
// excerpts want readable "key: value" text, hence the separate map.
interface IndexState {
  idx: MiniSearch<IndexEntry>;
  displayBodies: Map<string, string>;
}

interface CommonIndexBuild {
  generation: number;
  includesRecords: boolean;
  promise: Promise<IndexState>;
}

let indexState: IndexState | null = null;
const commonIndexBuilds = new Map<string, CommonIndexBuild>();
let dirty = true;
let generation = 0;
// Whether the last rebuild put records into MiniSearch. When the record index
// serves record search, MiniSearch is docs-only; if that mode flips (index
// becomes ready, or the kill switch turns it off), the next getIndex() rebuilds
// so records are neither duplicated nor missing.
let builtWithRecords = true;

// Internal writes (REST PUT, Yjs persists) suppress their watcher events, so
// subscribe to the store's own change notifications to never serve stale hits.
onDocContentChanged(() => {
  invalidateSearchIndex();
});
onWorkspaceChange((event) => {
  if (
    event.type === "space" ||
    event.type === "docAliases" ||
    event.type === "documentCorpus" ||
    event.type === "workspaceReset"
  ) {
    invalidateSearchIndex();
  }
});

function recordSearchViaIndex(): boolean {
  return recordIndexEnabled() && recordIndex.isReady();
}

// Call after a record mutation instead of invalidateSearchIndex(): when the
// record index serves record search, records are not in MiniSearch, so a
// record write must not force a full MiniSearch rebuild.
export function noteRecordMutated(): void {
  if (recordSearchViaIndex()) {
    // Keep the active docs-only indexes, but retire record-bearing states that
    // can become active again if search falls back to the filesystem.
    if (builtWithRecords) dirty = true;
    for (const [key, build] of commonIndexBuilds) {
      if (build.includesRecords) commonIndexBuilds.delete(key);
    }
    return;
  }
  invalidateSearchIndex();
}

function createIndex(): MiniSearch<IndexEntry> {
  return new MiniSearch<IndexEntry>({
    fields: ["title", "body"],
    storeFields: [
      "spaceId",
      "path",
      "type",
      "title",
      "collectionId",
      "recordId",
      "documentKind",
      "documentView",
      "formatId",
      "sourceVersion",
      "health",
    ],
    searchOptions: {
      boost: { title: 3 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
}

export function invalidateSearchIndex(): void {
  generation += 1;
  dirty = true;
  commonIndexBuilds.clear();
}

let rebuildHookForTests: (() => Promise<void>) | null = null;

export function setSearchIndexRebuildHookForTests(
  hook: (() => Promise<void>) | null,
): void {
  rebuildHookForTests = hook;
}

async function addRecordsToIndex(
  spaceId: string,
  entries: IndexEntry[],
  displayBodies: Map<string, string>,
): Promise<void> {
  for (const collection of await listRecordCollections(spaceId)) {
    for (const record of await listRecords(spaceId, collection.id, { includeArchived: false })) {
      const id = `record:${spaceId}:${collection.id}:${record.id}`;
      entries.push({
        id,
        spaceId,
        path: `${collection.id}/${record.id}`,
        type: "record",
        collectionId: collection.id,
        recordId: record.id,
        title: recordTitle(record, collection.name),
        body: `${collection.name} ${JSON.stringify(record.data)}`,
      });
      displayBodies.set(id, recordDisplayText(collection.name, record.data));
    }
  }
}

async function rebuildLegacyIndex(includeRecords: boolean): Promise<IndexState> {
  const idx = createIndex();
  const displayBodies = new Map<string, string>();
  const entries: IndexEntry[] = [];
  for (const space of await listSpaces()) {
    for (const docPath of await listDocs(space.id)) {
      const result = await readDoc(space.id, docPath);
      if (result.error || result.data === null) continue;

      let title: string;
      let body: string;
      let displayBody: string;

      if (result.storedAs === "md" && typeof result.data === "string") {
        const headingMatch = result.data.match(/^#\s+(.+)$/m);
        title = extractMarkdownTitle(result.data, docPath);
        // The title line renders separately in results; drop it from the body
        // so excerpts don't open by repeating it. The raw markdown stays the
        // INDEXED body — link/wiki-link targets must remain searchable — while
        // excerpts render from the stripped plain text.
        const bodyMd = headingMatch ? result.data.replace(/^#\s+.+$/m, "") : result.data;
        body = bodyMd;
        displayBody = markdownPlainText(bodyMd);
      } else if (Array.isArray(result.data)) {
        title = extractTitle(result.data, docPath);
        body = extractBlockNoteText(withoutTitleHeading(result.data));
        displayBody = body;
      } else {
        continue;
      }

      const id = `doc:${space.id}:${docPath}`;
      entries.push({
        id,
        spaceId: space.id,
        path: docPath,
        type: "doc",
        title,
        body,
      });
      displayBodies.set(id, displayBody);
    }

    if (includeRecords) {
      await addRecordsToIndex(space.id, entries, displayBodies);
    }
  }

  idx.addAll(entries);
  await rebuildHookForTests?.();
  return { idx, displayBodies };
}

async function getLegacyIndex(recordsViaIndex: boolean): Promise<IndexState> {
  for (;;) {
    if (indexState && !dirty && builtWithRecords === !recordsViaIndex) {
      return indexState;
    }
    const expectedGeneration = generation;
    const includeRecords = !recordsViaIndex;
    const rebuilt = await rebuildLegacyIndex(includeRecords);
    if (generation !== expectedGeneration) {
      continue;
    }
    indexState = rebuilt;
    builtWithRecords = includeRecords;
    dirty = false;
    return rebuilt;
  }
}

function commonProjectedBody(
  formatId: string | undefined,
  projectedText: string,
  title: string,
): string {
  if (formatId === "worktable.markdown") {
    return projectedText.replace(/^#\s+.+$/m, "");
  }
  if (formatId === "worktable.rich-text") {
    const paragraphs = projectedText.split("\n\n");
    const titleAt = paragraphs.findIndex((paragraph) => paragraph.trim() === title);
    if (titleAt !== -1) paragraphs.splice(titleAt, 1);
    return paragraphs.join("\n\n");
  }
  return projectedText;
}

async function rebuildCommonIndex(
  includeRecords: boolean,
  options: { spaceId?: string; includeArchived: boolean },
): Promise<IndexState> {
  const idx = createIndex();
  const displayBodies = new Map<string, string>();
  const entries: IndexEntry[] = [];
  const spaces = (await listSpaces())
    .filter(
      (space) =>
        (!options.spaceId || space.id === options.spaceId) &&
        (options.includeArchived || !getSpaceArchiveInfo(space)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const projectionBudget = createDocumentProjectionBudgetState(
    COMMON_SEARCH_PROJECTION_BUDGET,
  );

  for (const space of spaces) {
    for (const candidate of await projectDocumentsForSearch({
      spaceId: space.id,
      includeArchived: options.includeArchived,
      projectionBudget,
    })) {
      const { result, documentView } = candidate;
      const document =
        result.kind === "document" ? result.document : result.conflict;
      const path =
        result.kind === "document"
          ? result.document.path
          : result.conflict.pathKey;
      const projection =
        result.kind === "document" && result.projection.kind === "text"
          ? result.projection
          : null;
      const format =
        result.kind === "document" ? result.document.format : undefined;
      const projectedTitle =
        format?.id === "worktable.markdown"
          ? projection
            ? extractMarkdownTitle(projection.text, path)
            : undefined
          : format?.id !== "worktable.html"
            ? projection?.headings[0]?.trim()
            : undefined;
      const title =
        projectedTitle ||
        (result.kind === "document"
          ? result.document.title
          : extractTitle([], path));
      const bodyText = commonProjectedBody(
        format?.id,
        projection?.text ?? "",
        title,
      );
      const id = `doc:${space.id}:${path}`;
      entries.push({
        id,
        spaceId: space.id,
        path,
        type: "doc",
        title,
        // Logical path remains searchable for metadata-only and conflict
        // entries. Content reaches the index only through bounded inert text
        // projectors, never through raw HTML or format-specific runtimes.
        body: `${path}\n${bodyText}`,
        documentKind: document.kind,
        ...(documentView ? { documentView } : {}),
        ...(format
          ? {
              formatId: format.id,
              sourceVersion: format.sourceVersion,
            }
          : {}),
        health: document.health,
      });
      displayBodies.set(
        id,
        format?.id === "worktable.markdown"
          ? markdownPlainText(bodyText)
          : bodyText,
      );
    }

    if (includeRecords) {
      await addRecordsToIndex(space.id, entries, displayBodies);
    }
  }

  idx.addAll(entries);
  await rebuildHookForTests?.();
  return { idx, displayBodies };
}

async function getCommonIndex(
  recordsViaIndex: boolean,
  options: { spaceId?: string; includeArchived: boolean },
): Promise<IndexState> {
  // Scoped IDs come from a request query and may not name a real Space. Build
  // them on demand instead of retaining caller-controlled cache keys. The web
  // and Company Knowledge paths use the workspace-wide cache below.
  if (options.spaceId) {
    for (;;) {
      const expectedGeneration = generation;
      const rebuilt = await rebuildCommonIndex(!recordsViaIndex, options);
      if (generation === expectedGeneration) return rebuilt;
    }
  }
  const key = JSON.stringify([
    recordsViaIndex,
    options.includeArchived,
  ]);
  for (;;) {
    const expectedGeneration = generation;
    let build = commonIndexBuilds.get(key);
    if (!build || build.generation !== expectedGeneration) {
      build = {
        generation: expectedGeneration,
        includesRecords: !recordsViaIndex,
        promise: rebuildCommonIndex(!recordsViaIndex, options),
      };
      commonIndexBuilds.set(key, build);
    }
    try {
      const rebuilt = await build.promise;
      if (generation === build.generation) return rebuilt;
    } catch (error) {
      if (commonIndexBuilds.get(key) === build) {
        commonIndexBuilds.delete(key);
      }
      throw error;
    }
  }
}

export async function search(
  query: string,
  opts?: {
    spaceId?: string;
    searchBlocks?: boolean;
    maxResults?: number;
    includeArchived?: boolean;
    /** Select only after caller authorization; common projection needs documents:read. */
    documentAccess?: DocumentSearchAccess;
  }
): Promise<SearchResult[]> {
  // Snapshot the record-search mode once per call: MiniSearch is built for
  // this mode and the record-hit append below uses the same decision, so a
  // mode flip mid-call (record index becoming ready) can't serve records
  // from both engines in one response.
  const recordsViaIndex = recordSearchViaIndex();
  const maxResults = opts?.maxResults ?? 50;
  const includeArchived = opts?.includeArchived ?? false;
  const documentAccess = opts?.documentAccess ?? "legacy";
  const { idx, displayBodies } =
    documentAccess === "common"
      ? await getCommonIndex(recordsViaIndex, {
          spaceId: opts?.spaceId,
          includeArchived,
        })
      : await getLegacyIndex(recordsViaIndex);

  const raw = idx.search(query, {
    filter: (result) => {
      const entry = result as unknown as IndexEntry;
      if (opts?.spaceId && entry.spaceId !== opts.spaceId) return false;
      return true;
    },
  });

  const filtered: typeof raw = [];
  for (const result of raw) {
    if (includeArchived) {
      filtered.push(result);
      continue;
    }

    const entry = result as unknown as IndexEntry;
    if (entry.type === "doc" && documentAccess === "common") {
      // Common candidates were filtered before projection and ranking.
      filtered.push(result);
      continue;
    }
    const { data: space } = await readSpace(entry.spaceId);
    if (!space || getSpaceArchiveInfo(space)) continue;

    if (entry.type === "record") {
      // Re-check live state at query time — the index can be stale — so records
      // archived or deleted since the last rebuild don't linger in results. This
      // mirrors the doc archive re-check below.
      const { data: record } = await readRecord(entry.spaceId, entry.collectionId, entry.recordId);
      if (record && !record.archive) filtered.push(result);
      continue;
    }

    const archived = await getDocArchiveInfo(entry.spaceId, entry.path);
    if (!archived) filtered.push(result);
  }

  const results: SearchResult[] = filtered.slice(0, maxResults).map((r) => {
    const entry = r as unknown as IndexEntry;
    // r.terms holds the document-side matched terms (prefix/fuzzy already
    // expanded, e.g. query "pair" → term "pairing"), so they locate in the body.
    const excerpt = makeExcerpt(displayBodies.get(String(r.id)) ?? "", r.terms);
    return {
      spaceId: entry.spaceId,
      type: entry.type,
      path: entry.path,
      title: r.title as string,
      score: r.score,
      ...(entry.type === "doc" && entry.documentKind
        ? {
            documentKind: entry.documentKind,
            ...(entry.documentView
              ? { documentView: entry.documentView }
              : {}),
            ...(entry.formatId && entry.sourceVersion
              ? {
                  format: {
                    id: entry.formatId,
                    sourceVersion: entry.sourceVersion,
                  } as DocumentFormatClaim,
                }
              : {}),
            ...(entry.health ? { health: entry.health } : {}),
          }
        : {}),
      ...(excerpt !== undefined ? { excerpt } : {}),
      ...(entry.type === "record" ? { collectionId: entry.collectionId, recordId: entry.recordId } : {}),
    };
  });

  // Record hits come from the record index (FTS5) when it is active; MiniSearch
  // holds docs only in that mode. Appended after doc hits with positional
  // scores — record and doc relevance scores are not comparable across engines.
  if (recordsViaIndex) {
    // The space scope is applied inside the query (before its LIMIT), so a
    // scoped search can't lose in-space hits to other spaces' matches.
    const hits = recordIndex.searchRecords(query, maxResults, opts?.spaceId) ?? [];
    // FTS matches on query-token prefixes, so the raw tokens locate in the text.
    const queryTerms = query.trim().split(/\s+/);
    for (const [i, hit] of hits.entries()) {
      if (results.length >= maxResults) break;
      if (!includeArchived) {
        const { data: space } = await readSpace(hit.spaceId);
        if (!space || getSpaceArchiveInfo(space)) continue;
      }
      const excerpt = makeExcerpt(recordDisplayText(hit.collectionName, hit.data), queryTerms);
      results.push({
        spaceId: hit.spaceId,
        type: "record",
        path: `${hit.collectionId}/${hit.recordId}`,
        title: hit.title,
        score: Math.max(hits.length - i, 1),
        collectionId: hit.collectionId,
        recordId: hit.recordId,
        ...(excerpt !== undefined ? { excerpt } : {}),
      });
    }
  }

  return results;
}
