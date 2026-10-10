// ============================================================
// MiniSearch-based full-text search index for Worktable
// Indexes documents and records. The common mode projects every authorized
// document format inertly; the legacy mode preserves the historical Doc-only
// result set for callers without documents:read.
// ============================================================

import MiniSearch from "minisearch";
import {
  docStat,
  getDocArchiveInfo,
  getSpaceArchiveInfo,
  listDocs,
  listSpaces,
  readDoc,
  readSpace,
  type DocReadResult,
} from "./store.ts";
import { listRecordCollections, listRecords, readRecord } from "./record-store.ts";
import { recordIndex, recordIndexEnabled } from "./record-index.ts";
import {
  DocumentSpaceNotFoundError,
  projectDocumentsForSearch,
  type DocumentReadWithView,
} from "./document-query.ts";
import { analyzeDocumentPath } from "./document-path.ts";
import { canReuseDerived, type DerivedRevision } from "./derived-revision.ts";
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
  archiveOn?: string;
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

// ── Incremental index ────────────────────────────────────────
//
// One MiniSearch per variant: document access mode, archive visibility, and
// whether records live in MiniSearch. Each variant is divided into Space
// segments. Change events mark a segment dirty, and document events also name
// the document. The next search that covers the Space re-checks its catalog
// and re-reads only documents whose revision changed or that an event named,
// replacing their entries in place. Space-scoped searches use the same index,
// filtered to the Space, and sync only that Space.

/** How long one sync holds a Space's lock while projecting. */
const PROJECTION_SLICE_MS = 250;
/** Sync rounds one search runs before serving the latest index. */
const MAX_SYNC_ROUNDS = 3;

interface IndexedDocument extends DerivedRevision {
  id: string;
}

interface SpaceSegment {
  /** Indexed documents by path key. */
  documents: Map<string, IndexedDocument>;
  recordIds: string[];
  built: boolean;
  dirty: boolean;
  recordsDirty: boolean;
  /** Document keys to re-read even when their revision looks unchanged. */
  forced: Set<string>;
  syncing: Promise<void> | null;
}

interface IndexVariant {
  documentAccess: DocumentSearchAccess;
  includeArchived: boolean;
  includesRecords: boolean;
  idx: MiniSearch<IndexEntry>;
  // Display bodies for excerpt extraction, keyed by index entry id.
  // MiniSearch does not store raw field text, and records index JSON while
  // excerpts want readable "key: value" text, hence the separate map.
  displayBodies: Map<string, string>;
  segments: Map<string, SpaceSegment>;
  spacesListed: boolean;
  listing: Promise<void> | null;
}

const variants = new Map<string, IndexVariant>();
let resetEpoch = 0;

function recordSearchViaIndex(): boolean {
  return recordIndexEnabled() && recordIndex.isReady();
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

function variantKey(
  documentAccess: DocumentSearchAccess,
  includeArchived: boolean,
  includesRecords: boolean,
): string {
  return JSON.stringify([documentAccess, includeArchived, includesRecords]);
}

function variantFor(
  documentAccess: DocumentSearchAccess,
  includeArchivedOption: boolean,
  includesRecords: boolean,
): IndexVariant {
  // Legacy search keeps archived content and filters it per query.
  const includeArchived = documentAccess === "common" && includeArchivedOption;
  const key = variantKey(documentAccess, includeArchived, includesRecords);
  let variant = variants.get(key);
  if (!variant) {
    // Records move to the record index once it is ready (or back, through its
    // kill switch). Keep one copy of the documents, not one per record mode.
    variants.delete(variantKey(documentAccess, includeArchived, !includesRecords));
    variant = {
      documentAccess,
      includeArchived,
      includesRecords,
      idx: createIndex(),
      displayBodies: new Map(),
      segments: new Map(),
      spacesListed: false,
      listing: null,
    };
    variants.set(key, variant);
  }
  return variant;
}

function documentKey(variant: IndexVariant, path: string): string {
  // Common candidates are keyed like the catalog groups them.
  return variant.documentAccess === "common"
    ? (analyzeDocumentPath(path).comparisonKey ?? path)
    : path;
}

function markSpace(spaceId: string, documentPath?: string): void {
  for (const variant of variants.values()) {
    const segment = variant.segments.get(spaceId);
    if (!segment) {
      variant.spacesListed = false;
      continue;
    }
    segment.dirty = true;
    if (documentPath !== undefined) {
      segment.forced.add(documentKey(variant, documentPath));
    }
  }
}

function markRecords(spaceId?: string): void {
  for (const variant of variants.values()) {
    if (!variant.includesRecords) continue;
    if (spaceId === undefined) {
      for (const segment of variant.segments.values()) segment.recordsDirty = true;
      continue;
    }
    const segment = variant.segments.get(spaceId);
    if (segment) segment.recordsDirty = true;
    else variant.spacesListed = false;
  }
}

/**
 * Mark search content as changed. With a scope, only that Space is re-checked,
 * and a path names the document that changed. Without one, every Space is
 * re-checked. Either way, only documents whose revision changed are re-read.
 */
export function invalidateSearchIndex(scope?: {
  spaceId: string;
  path?: string;
}): void {
  if (scope) {
    markSpace(scope.spaceId, scope.path);
    return;
  }
  for (const variant of variants.values()) {
    variant.spacesListed = false;
    for (const segment of variant.segments.values()) {
      segment.dirty = true;
      segment.recordsDirty = variant.includesRecords;
    }
  }
}

// Call after a record mutation instead of invalidateSearchIndex(): when the
// record index serves record search, records are not in MiniSearch, so a
// record write must not re-check documents.
export function noteRecordMutated(): void {
  markRecords();
}

// Internal writes (REST PUT, Yjs persists) suppress their watcher events, so
// subscribe to the store's own change notifications as well as to workspace
// events, which carry external edits.
onDocContentChanged((spaceId, docPath) => {
  markSpace(spaceId, docPath);
});
onWorkspaceChange((event) => {
  switch (event.type) {
    case "doc":
      markSpace(event.spaceId, event.docPath);
      break;
    case "widget":
      markSpace(event.spaceId, event.widgetId);
      break;
    case "space":
      for (const variant of variants.values()) variant.spacesListed = false;
      markSpace(event.spaceId);
      break;
    case "docAliases":
    case "documentCorpus":
      markSpace(event.spaceId);
      break;
    case "record":
    case "recordCollection":
    case "recordCollectionReconcile":
      markRecords(event.spaceId);
      break;
    case "workspaceReset":
      resetEpoch += 1;
      variants.clear();
      break;
  }
});

type SyncHook = (sync: { spaceId: string; documents: number }) => Promise<void>;
let rebuildHookForTests: SyncHook | null = null;

/** Observe each Space sync and how many documents it re-read. */
export function setSearchIndexRebuildHookForTests(hook: SyncHook | null): void {
  rebuildHookForTests = hook;
}

function putEntry(variant: IndexVariant, entry: IndexEntry, displayBody: string): void {
  if (variant.idx.has(entry.id)) variant.idx.replace(entry);
  else variant.idx.add(entry);
  variant.displayBodies.set(entry.id, displayBody);
}

function dropEntry(variant: IndexVariant, id: string): void {
  if (variant.idx.has(id)) variant.idx.discard(id);
  variant.displayBodies.delete(id);
}

function retireSegment(variant: IndexVariant, spaceId: string, segment: SpaceSegment): void {
  variant.segments.delete(spaceId);
  for (const document of segment.documents.values()) dropEntry(variant, document.id);
  for (const id of segment.recordIds) dropEntry(variant, id);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

function legacyEntry(
  spaceId: string,
  docPath: string,
  result: DocReadResult,
): { entry: DocEntry; displayBody: string } | null {
  if (result.error || result.data === null) return null;

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
    return null;
  }

  return {
    entry: { id: `doc:${spaceId}:${docPath}`, spaceId, path: docPath, type: "doc", title, body },
    displayBody,
  };
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

function commonEntry(
  spaceId: string,
  { result, documentView }: DocumentReadWithView,
): { entry: DocEntry; displayBody: string; transient: boolean } {
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
  return {
    entry: {
      id: `doc:${spaceId}:${path}`,
      spaceId,
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
      ...(result.kind === "document" && result.document.archiveOn
        ? { archiveOn: result.document.archiveOn }
        : {}),
    },
    displayBody:
      format?.id === "worktable.markdown"
        ? markdownPlainText(bodyText)
        : bodyText,
    // A projection that timed out or could not read its source is retried at
    // the next sync instead of being trusted until the document changes.
    transient:
      result.kind === "document" &&
      result.projection.kind === "metadata-only" &&
      result.projection.reason === "temporarily-unavailable",
  };
}

async function syncCommonDocuments(
  variant: IndexVariant,
  spaceId: string,
  segment: SpaceSegment,
  forced: ReadonlySet<string>,
): Promise<number> {
  // Revisions this sync projected. Each document is projected at most once
  // per sync, so continuous edits cannot keep a sync running.
  const projected = new Map<string, string>();
  for (;;) {
    const readAt = Date.now();
    const pass = await projectDocumentsForSearch({
      spaceId,
      includeArchived: variant.includeArchived,
      projectionMs: PROJECTION_SLICE_MS,
      shouldProject: (candidate) =>
        !projected.has(candidate.key) &&
        (forced.has(candidate.key) ||
          !canReuseDerived(
            segment.documents.get(candidate.key),
            candidate.revision,
            candidate.updatedAt === undefined
              ? undefined
              : Date.parse(candidate.updatedAt),
          )),
    });
    if (variant.segments.get(spaceId) !== segment) return projected.size;
    for (const candidate of pass.candidates) {
      if (candidate.read === undefined) continue;
      projected.set(candidate.key, candidate.revision);
      const previous = segment.documents.get(candidate.key);
      if (candidate.read === null) {
        if (previous) dropEntry(variant, previous.id);
        segment.documents.delete(candidate.key);
        continue;
      }
      const { entry, displayBody, transient } = commonEntry(spaceId, candidate.read);
      if (previous && previous.id !== entry.id) dropEntry(variant, previous.id);
      putEntry(variant, entry, displayBody);
      segment.documents.set(candidate.key, {
        id: entry.id,
        revision: transient ? "" : candidate.revision,
        readAt,
      });
    }
    if (!pass.complete) {
      await yieldToEventLoop();
      continue;
    }

    const current = new Set<string>();
    for (const candidate of pass.candidates) {
      current.add(candidate.key);
      const revision = projected.get(candidate.key);
      if (revision !== undefined && revision !== candidate.revision) {
        // Changed again after an earlier slice projected it.
        segment.forced.add(candidate.key);
        segment.dirty = true;
      }
    }
    for (const [key, document] of segment.documents) {
      if (current.has(key)) continue;
      dropEntry(variant, document.id);
      segment.documents.delete(key);
    }
    return projected.size;
  }
}

async function syncLegacyDocuments(
  variant: IndexVariant,
  spaceId: string,
  segment: SpaceSegment,
  forced: ReadonlySet<string>,
): Promise<number> {
  const paths = await listDocs(spaceId);
  let reread = 0;
  for (const docPath of paths) {
    const readAt = Date.now();
    const stat = await docStat(spaceId, docPath);
    const revision = stat ? `${stat.format}:${stat.updatedAt}` : "";
    const previous = segment.documents.get(docPath);
    if (!forced.has(docPath) && canReuseDerived(previous, revision, stat?.updatedAt)) {
      continue;
    }
    reread += 1;
    const indexed = legacyEntry(spaceId, docPath, await readDoc(spaceId, docPath));
    if (variant.segments.get(spaceId) !== segment) return reread;
    if (!indexed) {
      if (previous) dropEntry(variant, previous.id);
      segment.documents.delete(docPath);
      continue;
    }
    putEntry(variant, indexed.entry, indexed.displayBody);
    segment.documents.set(docPath, { id: indexed.entry.id, revision, readAt });
  }
  if (variant.segments.get(spaceId) !== segment) return reread;
  const current = new Set(paths);
  for (const [key, document] of segment.documents) {
    if (current.has(key)) continue;
    dropEntry(variant, document.id);
    segment.documents.delete(key);
  }
  return reread;
}

async function syncSegmentRecords(
  variant: IndexVariant,
  spaceId: string,
  segment: SpaceSegment,
): Promise<void> {
  const entries: IndexEntry[] = [];
  const displayBodies = new Map<string, string>();
  await addRecordsToIndex(spaceId, entries, displayBodies);
  if (variant.segments.get(spaceId) !== segment) return;
  for (const id of segment.recordIds) dropEntry(variant, id);
  for (const entry of entries) {
    putEntry(variant, entry, displayBodies.get(entry.id) ?? "");
  }
  segment.recordIds = entries.map((entry) => entry.id);
}

async function runSegmentSync(
  variant: IndexVariant,
  spaceId: string,
  segment: SpaceSegment,
): Promise<void> {
  const syncDocuments = segment.dirty || !segment.built;
  const syncRecords =
    variant.includesRecords && (segment.recordsDirty || !segment.built);
  const forced = segment.forced;
  // Marks made while this sync runs stay for the next one.
  segment.forced = new Set();
  segment.dirty = false;
  segment.recordsDirty = false;
  try {
    let documents = 0;
    if (syncDocuments) {
      documents =
        variant.documentAccess === "common"
          ? await syncCommonDocuments(variant, spaceId, segment, forced)
          : await syncLegacyDocuments(variant, spaceId, segment, forced);
    }
    if (syncRecords) await syncSegmentRecords(variant, spaceId, segment);
    segment.built = true;
    await rebuildHookForTests?.({ spaceId, documents });
  } catch (error) {
    segment.dirty ||= syncDocuments;
    segment.recordsDirty ||= syncRecords;
    for (const key of forced) segment.forced.add(key);
    if (error instanceof DocumentSpaceNotFoundError) {
      // Deleted while syncing: the next listing retires the segment.
      variant.spacesListed = false;
      return;
    }
    throw error;
  }
}

function syncSegment(
  variant: IndexVariant,
  spaceId: string,
  segment: SpaceSegment,
): Promise<void> {
  if (!segment.syncing) {
    const syncing = runSegmentSync(variant, spaceId, segment);
    segment.syncing = syncing;
    void syncing
      .finally(() => {
        if (segment.syncing === syncing) segment.syncing = null;
      })
      .catch(() => undefined);
  }
  return segment.syncing;
}

function listVariantSpaces(variant: IndexVariant): Promise<void> {
  if (!variant.listing) {
    const listing = (async () => {
      // A Space event during the listing clears this again.
      variant.spacesListed = true;
      try {
        const listed = (await listSpaces()).filter(
          (space) =>
            variant.documentAccess === "legacy" ||
            variant.includeArchived ||
            !getSpaceArchiveInfo(space),
        );
        const ids = new Set(listed.map((space) => space.id));
        for (const [spaceId, segment] of variant.segments) {
          if (!ids.has(spaceId)) retireSegment(variant, spaceId, segment);
        }
        for (const spaceId of [...ids].sort()) {
          if (variant.segments.has(spaceId)) continue;
          variant.segments.set(spaceId, {
            documents: new Map(),
            recordIds: [],
            built: false,
            dirty: true,
            recordsDirty: variant.includesRecords,
            forced: new Set(),
            syncing: null,
          });
        }
      } catch (error) {
        variant.spacesListed = false;
        throw error;
      }
    })();
    variant.listing = listing;
    void listing
      .finally(() => {
        if (variant.listing === listing) variant.listing = null;
      })
      .catch(() => undefined);
  }
  return variant.listing;
}

function segmentNeedsSync(segment: SpaceSegment): boolean {
  return (
    !segment.built ||
    segment.dirty ||
    segment.recordsDirty ||
    segment.syncing !== null
  );
}

function segmentsInScope(
  variant: IndexVariant,
  spaceId: string | undefined,
): Array<[string, SpaceSegment]> {
  if (spaceId === undefined) return [...variant.segments];
  const segment = variant.segments.get(spaceId);
  return segment ? [[spaceId, segment]] : [];
}

async function freshVariant(
  documentAccess: DocumentSearchAccess,
  includeArchived: boolean,
  includesRecords: boolean,
  spaceId: string | undefined,
): Promise<IndexVariant> {
  for (let round = 1; ; round += 1) {
    const epoch = resetEpoch;
    const variant = variantFor(documentAccess, includeArchived, includesRecords);
    if (!variant.spacesListed) await listVariantSpaces(variant);
    for (const [id, segment] of segmentsInScope(variant, spaceId)) {
      if (segmentNeedsSync(segment)) await syncSegment(variant, id, segment);
    }
    // A workspace reset retired this index: never answer from another
    // workspace's content.
    if (resetEpoch !== epoch) continue;
    const pending =
      !variant.spacesListed ||
      segmentsInScope(variant, spaceId).some(([, segment]) =>
        segmentNeedsSync(segment),
      );
    if (!pending) return variant;
    // Continuous edits must not hold a search hostage: after a few rounds,
    // answer from the index as of the latest sync.
    if (round >= MAX_SYNC_ROUNDS) return variant;
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
  const { idx, displayBodies } = await freshVariant(
    documentAccess,
    includeArchived,
    !recordsViaIndex,
    opts?.spaceId,
  );

  // Take each hit's display body now: later syncs update the index in place
  // while the archive checks below await.
  const hits = idx
    .search(query, {
      filter: (result) => {
        const entry = result as unknown as IndexEntry;
        if (opts?.spaceId && entry.spaceId !== opts.spaceId) return false;
        return true;
      },
    })
    .map((result) => ({
      result,
      displayBody: displayBodies.get(String(result.id)) ?? "",
    }));

  const filtered: typeof hits = [];
  for (const hit of hits) {
    if (includeArchived) {
      filtered.push(hit);
      continue;
    }

    const entry = hit.result as unknown as IndexEntry;
    if (entry.type === "doc" && documentAccess === "common") {
      // Common candidates were filtered before projection and ranking.
      filtered.push(hit);
      continue;
    }
    const { data: space } = await readSpace(entry.spaceId);
    if (!space || getSpaceArchiveInfo(space)) continue;

    if (entry.type === "record") {
      // Re-check live state at query time — the index can be stale — so records
      // archived or deleted since the last rebuild don't linger in results. This
      // mirrors the doc archive re-check below.
      const { data: record } = await readRecord(entry.spaceId, entry.collectionId, entry.recordId);
      if (record && !record.archive) filtered.push(hit);
      continue;
    }

    const archived = await getDocArchiveInfo(entry.spaceId, entry.path);
    if (!archived) filtered.push(hit);
  }

  const results: SearchResult[] = filtered.slice(0, maxResults).map(({ result: r, displayBody }) => {
    const entry = r as unknown as IndexEntry;
    // r.terms holds the document-side matched terms (prefix/fuzzy already
    // expanded, e.g. query "pair" → term "pairing"), so they locate in the body.
    const excerpt = makeExcerpt(displayBody, r.terms);
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
            ...(entry.archiveOn ? { archiveOn: entry.archiveOn } : {}),
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
