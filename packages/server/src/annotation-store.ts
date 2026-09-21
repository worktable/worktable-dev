import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import { dirname, join, relative } from "node:path";
import { nanoid } from "nanoid";
import type {
  Annotation,
  AnnotationAuthor,
  AnnotationCategory,
  AnnotationContext,
  AnnotationFile,
  AnnotationStatus,
  AnnotationTarget,
} from "@worktable/types";
import { AnnotationFileSchema, WidgetIdSchema } from "@worktable/types";
import { getSpacesBaseDir, readDoc } from "./store.ts";
import { readWidget, readWidgetHtml } from "./widget-store.ts";
import { withDocPathLock } from "./doc-path-lock.ts";
import { assertWorkspaceAvailable } from "./workspace-safety.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import {
  assertLegacyAnnotationStoreWritable,
  withLegacyAnnotationStoreLock,
} from "./legacy-annotation-lock.ts"
import {
  createLegacyCompatibleAnnotationV2,
  DocumentAnnotationError,
  listLegacyCompatibleAnnotationsV2,
  readLegacyCompatibleAnnotationV2,
  replyLegacyCompatibleAnnotationV2,
  resolveLegacyCompatibleAnnotationV2,
  updateLegacyCompatibleAnnotationV2,
} from "./document-annotation-service.ts"
import { readWorkspaceStorageLayoutAt } from "./workspace-storage-v2.ts"
import { BoundedFileReadError } from "./bounded-file.ts"

const ANNOTATION_FILE_TYPE = "worktable.annotations" as const;
const DEFAULT_AUTHOR: AnnotationAuthor = { type: "agent", id: "worktable", name: "Worktable" }
const annotationLocks = new Map<string, Promise<void>>()

async function usesDocumentDataV2(): Promise<boolean> {
  try {
    return (await readWorkspaceStorageLayoutAt(getWorkspaceRoot())).kind === "v2"
  } catch (error) {
    if (error instanceof BoundedFileReadError && error.reason === "missing") {
      return false
    }
    throw error
  }
}

/** Serialize annotation read-modify-write work for one Space. */
export async function withAnnotationStoreLock<T>(
  spaceId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = annotationLocks.get(spaceId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  annotationLocks.set(spaceId, tail)
  await previous
  try {
    assertWorkspaceAvailable()
    if (await usesDocumentDataV2()) return await operation()
    return await withLegacyAnnotationStoreLock(
      { workspaceRoot: getWorkspaceRoot(), spaceId },
      async () => {
        await assertLegacyAnnotationStoreWritable({
          workspaceRoot: getWorkspaceRoot(),
          spaceId,
        })
        return operation()
      }
    )
  } finally {
    release()
    if (annotationLocks.get(spaceId) === tail) annotationLocks.delete(spaceId)
  }
}

export interface AnnotationListFilters {
  target?: Partial<AnnotationTarget> & { docPath?: string; blockId?: string; widgetId?: string };
  status?: AnnotationStatus[];
  category?: AnnotationCategory[];
  createdBy?: string;
  labels?: string[];
  includeResolved?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateAnnotationInput {
  target: AnnotationTarget;
  category: AnnotationCategory;
  body: string;
  title?: string;
  author?: AnnotationAuthor;
  labels?: string[];
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateAnnotationPatch {
  title?: string;
  body?: string;
  status?: AnnotationStatus;
  labels?: string[];
  metadata?: Record<string, unknown>;
}

// Annotations are stored one file per annotated thing, under a per-kind root:
// annotations/docs/<doc-path>.annotations.json and
// annotations/widgets/<widget-id>.annotations.json. Separate roots on purpose —
// docs and widgets live in separate server namespaces, so a widget id may equal
// a doc path and the two must never share a storage key.
type AnnotationRoot = "docs" | "widgets";

interface AnnotationKey {
  root: AnnotationRoot;
  key: string;
}

function annotationsDir(spaceId: string, root: AnnotationRoot): string {
  return join(getSpacesBaseDir(), spaceId, "annotations", root);
}

function sanitizeDocPath(docPath: string): string {
  return docPath.replace(/\.\./g, "").replace(/^\/+/, "");
}

function storageKeyFromTarget(target: AnnotationTarget): AnnotationKey | null {
  if (target.type === "widget") {
    // Widget ids are strictly slash-joined canonical segments; anything else
    // (traversal, encoding artifacts) is rejected rather than sanitized.
    if (!WidgetIdSchema.safeParse(target.widgetId).success) return null;
    return { root: "widgets", key: target.widgetId };
  }
  if ("docPath" in target) return { root: "docs", key: sanitizeDocPath(target.docPath) };
  return null;
}

function annotationPath(spaceId: string, key: AnnotationKey): string {
  return join(annotationsDir(spaceId, key.root), `${key.key}.annotations.json`);
}

function revisionFor(file: Omit<AnnotationFile, "revision">): string {
  return crypto.createHash("sha256").update(JSON.stringify(file)).digest("hex");
}

function emptyFile(spaceId: string): AnnotationFile {
  const now = new Date().toISOString();
  const base = {
    type: ANNOTATION_FILE_TYPE,
    version: 1 as const,
    spaceId,
    updatedAt: now,
    annotations: [],
  };
  return { ...base, revision: revisionFor(base) };
}

async function readAnnotationFile(spaceId: string, key: AnnotationKey): Promise<AnnotationFile> {
  const path = annotationPath(spaceId, key);
  if (!existsSync(path)) return emptyFile(spaceId);
  const raw = await readFile(path, "utf8");
  const parsed = AnnotationFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid annotation file for ${key.root}/${key.key}: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function writeAnnotationFile(spaceId: string, key: AnnotationKey, file: AnnotationFile): Promise<AnnotationFile> {
  const now = new Date().toISOString();
  const base = {
    type: ANNOTATION_FILE_TYPE,
    version: 1 as const,
    spaceId,
    updatedAt: now,
    annotations: file.annotations,
  };
  const next: AnnotationFile = { ...base, revision: revisionFor(base) };
  const path = annotationPath(spaceId, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

async function listAnnotationKeys(spaceId: string, roots: AnnotationRoot[] = ["docs", "widgets"]): Promise<AnnotationKey[]> {
  const out: AnnotationKey[] = [];
  for (const root of roots) {
    const dir = annotationsDir(spaceId, root);
    if (!existsSync(dir)) continue;
    async function walk(current: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".annotations.json")) {
          const rel = relative(dir, full).replace(/\\/g, "/");
          out.push({ root, key: rel.slice(0, -".annotations.json".length) });
        }
      }
    }
    await walk(dir);
  }
  return out;
}

function matches(annotation: Annotation, filters: AnnotationListFilters): boolean {
  if (!filters.includeResolved && annotation.status === "resolved") return false;
  if (filters.status?.length && !filters.status.includes(annotation.status)) return false;
  if (filters.category?.length && !filters.category.includes(annotation.category)) return false;
  if (filters.createdBy && annotation.author.id !== filters.createdBy) return false;
  if (filters.labels?.length && !filters.labels.every((label) => annotation.labels.includes(label))) return false;
  const target = filters.target;
  if (!target) return true;
  if (target.type && annotation.target.type !== target.type) return false;
  if (target.docPath && (!("docPath" in annotation.target) || annotation.target.docPath !== target.docPath)) return false;
  if (target.widgetId && (!("widgetId" in annotation.target) || annotation.target.widgetId !== target.widgetId)) return false;
  if (target.blockId && (!("blockId" in annotation.target) || annotation.target.blockId !== target.blockId)) return false;
  return true;
}

export async function listAnnotations(spaceId: string, filters: AnnotationListFilters = {}): Promise<{ annotations: Annotation[]; total: number; nextOffset?: number }> {
  if (await usesDocumentDataV2()) {
    const requestedPath = filters.target?.docPath ?? filters.target?.widgetId
    let compatible: Annotation[]
    try {
      compatible = await listLegacyCompatibleAnnotationsV2(
        spaceId,
        requestedPath
      )
    } catch (error) {
      if (
        error instanceof DocumentAnnotationError &&
        (error.reason === "not-found" || error.reason === "conflict")
      ) {
        compatible = []
      } else {
        throw error
      }
    }
    const all = compatible
      .filter((annotation) => matches(annotation, filters))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const offset = filters.offset ?? 0
    const limit = filters.limit ?? 100
    const page = all.slice(offset, offset + limit)
    return {
      annotations: page,
      total: all.length,
      ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}),
    }
  }
  // A docPath/widgetId filter narrows the scan to that one file. The widgetId
  // comes straight from a query param / tool arg, so it gets the same
  // WidgetIdSchema gate as create/delete — a malformed value (e.g. `../`)
  // must never be joined into a storage path. Invalid id = no such widget =
  // empty result.
  if (filters.target?.widgetId && !WidgetIdSchema.safeParse(filters.target.widgetId).success) {
    return { annotations: [], total: 0 };
  }
  const keys: AnnotationKey[] = filters.target?.docPath
    ? [{ root: "docs", key: sanitizeDocPath(filters.target.docPath) }]
    : filters.target?.widgetId
      ? [{ root: "widgets", key: filters.target.widgetId }]
      : await listAnnotationKeys(spaceId);
  const all: Annotation[] = [];
  for (const key of keys) {
    const file = await readAnnotationFile(spaceId, key);
    all.push(...file.annotations.filter((annotation) => matches(annotation, filters)));
  }
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 100;
  const page = all.slice(offset, offset + limit);
  return { annotations: page, total: all.length, nextOffset: offset + limit < all.length ? offset + limit : undefined };
}

/** Returns every annotation attached to one doc without the paginated list API. */
export async function listDocAnnotations(
  spaceId: string,
  docPath: string
): Promise<Annotation[]> {
  if (await usesDocumentDataV2()) {
    return listLegacyCompatibleAnnotationsV2(spaceId, docPath)
  }
  const file = await readAnnotationFile(spaceId, {
    root: "docs",
    key: sanitizeDocPath(docPath),
  });
  return file.annotations;
}

async function findAnnotation(spaceId: string, annotationId: string): Promise<{ key: AnnotationKey; file: AnnotationFile; annotation: Annotation; index: number }> {
  for (const key of await listAnnotationKeys(spaceId)) {
    const file = await readAnnotationFile(spaceId, key);
    const index = file.annotations.findIndex((annotation) => annotation.id === annotationId);
    if (index >= 0) return { key, file, annotation: file.annotations[index]!, index };
  }
  throw new Error(`Annotation not found: ${annotationId}`);
}

export async function readAnnotation(spaceId: string, annotationId: string): Promise<Annotation> {
  if (await usesDocumentDataV2()) {
    return readLegacyCompatibleAnnotationV2(spaceId, annotationId)
  }
  return (await findAnnotation(spaceId, annotationId)).annotation;
}

export async function createAnnotation(spaceId: string, input: CreateAnnotationInput): Promise<{ annotation: Annotation; created: boolean }> {
  if (await usesDocumentDataV2()) {
    return createLegacyCompatibleAnnotationV2(spaceId, input)
  }
  const key = storageKeyFromTarget(input.target);
  if (!key) throw new Error("Only doc- and HTML-doc-backed annotations are supported in this release");
  const create = async () => {
    const file = await readAnnotationFile(spaceId, key);
    if (input.idempotencyKey) {
      const existing = file.annotations.find((annotation) => annotation.idempotencyKey === input.idempotencyKey);
      if (existing) return { annotation: existing, created: false };
    }
    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: `ann_${nanoid(12)}`,
      spaceId,
      target: input.target,
      category: input.category,
      status: "open",
      title: input.title,
      body: input.body,
      author: input.author ?? DEFAULT_AUTHOR,
      labels: input.labels ?? [],
      thread: [],
      createdAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata ?? {},
    };
    file.annotations.push(annotation);
    await writeAnnotationFile(spaceId, key, file);
    return { annotation, created: true };
  };
  return key.root === "docs" ? withDocPathLock(spaceId, () => withAnnotationStoreLock(spaceId, create))
    : withAnnotationStoreLock(spaceId, create);
}

export async function replyAnnotation(spaceId: string, annotationId: string, body: string, author: AnnotationAuthor = DEFAULT_AUTHOR): Promise<{ annotation: Annotation; replyId: string }> {
  if (await usesDocumentDataV2()) {
    return replyLegacyCompatibleAnnotationV2(
      spaceId,
      annotationId,
      body,
      author
    )
  }
  return withAnnotationStoreLock(spaceId, async () => {
    const found = await findAnnotation(spaceId, annotationId);
  const now = new Date().toISOString();
  const replyId = `msg_${nanoid(12)}`;
  const annotation: Annotation = {
    ...found.annotation,
    thread: [...found.annotation.thread, { id: replyId, author, body, createdAt: now }],
    updatedAt: now,
    updatedBy: author.id,
  };
  found.file.annotations[found.index] = annotation;
  await writeAnnotationFile(spaceId, found.key, found.file);
  return { annotation, replyId };
})
}

export async function updateAnnotation(spaceId: string, annotationId: string, patch: UpdateAnnotationPatch, updatedBy = "worktable"): Promise<Annotation> {
  if (await usesDocumentDataV2()) {
    return updateLegacyCompatibleAnnotationV2(
      spaceId,
      annotationId,
      patch,
      updatedBy
    )
  }
  return withAnnotationStoreLock(spaceId, async () => {
    const found = await findAnnotation(spaceId, annotationId);
  const now = new Date().toISOString();
  const annotation: Annotation = {
    ...found.annotation,
    ...patch,
    metadata: patch.metadata ? { ...found.annotation.metadata, ...patch.metadata } : found.annotation.metadata,
    updatedAt: now,
    updatedBy,
  };
  found.file.annotations[found.index] = annotation;
  await writeAnnotationFile(spaceId, found.key, found.file);
  return annotation;
})
}

export async function resolveAnnotation(spaceId: string, annotationId: string, reason?: string, resolvedBy = "worktable"): Promise<Annotation> {
  if (await usesDocumentDataV2()) {
    return resolveLegacyCompatibleAnnotationV2(
      spaceId,
      annotationId,
      reason,
      resolvedBy
    )
  }
  return withAnnotationStoreLock(spaceId, async () => {
    const found = await findAnnotation(spaceId, annotationId)
    const now = new Date().toISOString()
    const annotation: Annotation = {
      ...found.annotation,
      status: "resolved",
      updatedAt: now,
      updatedBy: resolvedBy,
    resolution: { resolvedAt: now, resolvedBy, reason, status: "resolved",
      },
  }
    found.file.annotations[found.index] = annotation;
    await writeAnnotationFile(spaceId, found.key, found.file);
    return annotation;
  });
}

function textFromInline(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (!item || typeof item !== "object") return "";
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    return textFromInline(record.content);
  }).join("");
}

function flattenBlocks(blocks: unknown[], out: Array<{ block: Record<string, unknown>; text: string }> = []): Array<{ block: Record<string, unknown>; text: string }> {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    out.push({ block: record, text: textFromInline(record.content) });
    if (Array.isArray(record.children)) flattenBlocks(record.children, out);
  }
  return out;
}

// Block-level re-anchoring: when a stored blockId no longer resolves (e.g. a doc
// was rewritten as markdown and BlockNote minted fresh block ids), locate the
// block by its quoted text instead. Keep this normalization + first-match rule
// identical to the client's resolver in apps/web editor.tsx so both agree.
function normalizeQuote(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findBlockIndexByQuote(
  flattened: Array<{ block: Record<string, unknown>; text: string }>,
  quote: string | undefined
): number {
  const needle = quote ? normalizeQuote(quote) : "";
  if (!needle) return -1;
  return flattened.findIndex((entry) => normalizeQuote(entry.text).includes(needle));
}

function blockContext(
  flattened: Array<{ block: Record<string, unknown>; text: string }>,
  idx: number,
  docPath: string,
  selectorMatch: AnnotationContext["selectorMatch"]
): AnnotationContext {
  return {
    targetExists: true,
    selectorMatch,
    docPath,
    block: flattened[idx]!.block,
    beforeBlocks: flattened.slice(Math.max(0, idx - 2), idx).map((entry) => entry.block),
    afterBlocks: flattened.slice(idx + 1, idx + 3).map((entry) => entry.block),
    excerpt: flattened[idx]!.text,
  };
}

export async function getAnnotationContext(spaceId: string, annotationOrTarget: string | AnnotationTarget): Promise<AnnotationContext> {
  const target = typeof annotationOrTarget === "string" ? (await readAnnotation(spaceId, annotationOrTarget)).target : annotationOrTarget;
  if (target.type === "widget") {
    // Doc-level context only (no block anchoring inside the sandboxed iframe):
    // name + description + a truncated slice of the authored HTML. Agents that
    // need the full source, read it through worktable_html_read.
    const { data: widget } = await readWidget(spaceId, target.widgetId);
    if (!widget) return { targetExists: false, selectorMatch: "missing" };
    const { data: html } = await readWidgetHtml(spaceId, target.widgetId);
    const excerpt = [widget.name, widget.description, (html ?? "").slice(0, 4000)]
      .filter(Boolean)
      .join("\n");
    return { targetExists: true, selectorMatch: "exact", excerpt };
  }
  if (!("docPath" in target)) return { targetExists: true, selectorMatch: "exact" };
  const doc = await readDoc(spaceId, target.docPath);
  if (doc.error || doc.data === null) return { targetExists: false, selectorMatch: "missing", docPath: target.docPath };
  if (typeof doc.data === "string") {
    return { targetExists: true, selectorMatch: "exact", docPath: target.docPath, excerpt: doc.data.slice(0, 2000) };
  }
  const flattened = flattenBlocks(Array.isArray(doc.data) ? doc.data : []);
  if (target.type === "doc") {
    return { targetExists: true, selectorMatch: "exact", docPath: target.docPath, excerpt: flattened.map((b) => b.text).filter(Boolean).join("\n").slice(0, 2000) };
  }
  const idx = flattened.findIndex((entry) => entry.block.id === target.blockId);
  if (idx >= 0) {
    return blockContext(flattened, idx, target.docPath, "exact");
  }
  // blockId drifted — fall back to locating the block by its stored quote.
  const quote = "quote" in target ? target.quote : undefined;
  if (quote) {
    const fuzzyIdx = findBlockIndexByQuote(flattened, quote);
    if (fuzzyIdx >= 0) {
      return blockContext(flattened, fuzzyIdx, target.docPath, "fuzzy");
    }
    // The quote no longer appears anywhere — the anchored text is gone.
    return { targetExists: false, selectorMatch: "stale", docPath: target.docPath };
  }
  return { targetExists: false, selectorMatch: "missing", docPath: target.docPath };
}

export class AnnotationPathMoveConflictError extends Error {}

async function renameAnnotationDocPathLocked(
  spaceId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  const oldKey: AnnotationKey = {
    root: "docs",
    key: sanitizeDocPath(oldPath),
  };
  const newKey: AnnotationKey = {
    root: "docs",
    key: sanitizeDocPath(newPath),
  };
  const oldFilePath = annotationPath(spaceId, oldKey);
  if (!existsSync(oldFilePath)) return;
  const newFilePath = annotationPath(spaceId, newKey);
  if (existsSync(newFilePath)) {
    throw new Error(`Target annotation state already exists: ${newPath}`);
  }
  await mkdir(dirname(newFilePath), { recursive: true });
  await rename(oldFilePath, newFilePath);
  const file = await readAnnotationFile(spaceId, newKey);
  file.annotations = file.annotations.map((annotation) => {
    if (!("docPath" in annotation.target)) return annotation;
    return {
      ...annotation,
      target: { ...annotation.target, docPath: newPath },
      updatedAt: new Date().toISOString(),
    };
  });
  await writeAnnotationFile(spaceId, newKey, file);
}

/** Reject a legacy move that would overwrite independently-owned annotations. */
export async function validateAnnotationDocPathMoves(
  spaceId: string,
  moves: Array<{ from: string; to: string }>
): Promise<void> {
  await withAnnotationStoreLock(spaceId, async () => {
    const prepared = moves.map(({ from, to }) => ({
      from,
      to,
      fromKey: {
        root: "docs" as const,
        key: sanitizeDocPath(from),
      },
      fromFile: annotationPath(spaceId, {
        root: "docs",
        key: sanitizeDocPath(from),
      }),
      toFile: annotationPath(spaceId, {
        root: "docs",
        key: sanitizeDocPath(to),
      }),
    }));
    for (const move of prepared) {
      if (move.fromFile !== move.toFile && existsSync(move.fromFile)) {
        await readAnnotationFile(spaceId, move.fromKey);
      }
    }
    for (const move of prepared) {
      if (move.fromFile !== move.toFile && existsSync(move.toFile)) {
        throw new AnnotationPathMoveConflictError(
          `Target annotation state already exists: ${move.to}`
        );
      }
    }
  });
}

export async function renameAnnotationDocPath(
  spaceId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  await withAnnotationStoreLock(spaceId, () =>
    renameAnnotationDocPathLocked(spaceId, oldPath, newPath)
  );
}

export async function deleteAnnotationDocPath(
  spaceId: string,
  docPath: string
): Promise<void> {
  await withAnnotationStoreLock(spaceId, async () => {
    const path = annotationPath(spaceId, {
      root: "docs",
      key: sanitizeDocPath(docPath),
    });
    if (existsSync(path)) await rm(path, { force: true });
  });
}

// Widget ids are immutable (rename only changes display metadata), so unlike
// docs there is no rename cascade — only the delete cascade.
export async function deleteAnnotationWidgetId(
  spaceId: string,
  widgetId: string
): Promise<void> {
  if (!WidgetIdSchema.safeParse(widgetId).success) return;
  await withAnnotationStoreLock(spaceId, async () => {
    const path = annotationPath(spaceId, {
      root: "widgets",
      key: widgetId,
    });
    if (existsSync(path)) await rm(path, { force: true });
  });
}
