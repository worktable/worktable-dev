import { copyFile, link, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { constants, existsSync, lstatSync } from "node:fs";
import crypto from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import type { ArchiveInfo, DocListEntry, DocSourceCategory, DocumentId, SpaceFile } from "@worktable/types";
import { SpaceFileSchema, sourceCategory } from "@worktable/types";
import { assertWorkspaceAvailable } from "./workspace-safety.ts";

// Moved to @worktable/types so the web UI shares the same categorization;
// re-exported to keep this module the server-side home of the concept.
export { sourceCategory };
export type { DocSourceCategory };
import {
  containsMermaidBlock,
  extractHeadings,
  extractMarkdownHeadings,
  getRichBlockTypes,
  isMarkdownSafe,
  prepareMarkdownStorageConversion,
} from "./markdown.ts";
import { canonicalizeBlocks, inheritBlockIds } from "./blocknote.ts";
import { extractMarkdownMermaid } from "./mermaid-document.ts";

import { getSpacesDir } from "./workspace.ts";
import {
  automaticCheckpointLabel,
  listVersionEntries,
  markVersionCheckpoint,
  mintVersionId,
  readVersionSnapshot,
  versionKeyDir,
  withVersionKeyLock,
  writeVersionSnapshot,
} from "./version-store.ts";
import {
  noteDocProvenanceChanged,
  pruneDocKeyForCount,
} from "./version-retention.ts";
import { notifyDocContentChanged } from "./content-events.ts";
import {
  docAliasReservationError,
  readDocAliases,
  reservedByAliasIn,
} from "./doc-aliases.ts";
import { withDocPathLock } from "./doc-path-lock.ts";
import { withDocGenerationLock } from "./doc-generation-lock.ts";
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts";
import { analyzeDocumentPath } from "./document-path.ts";
import { DOCUMENT_STORAGE_PROFILE_IDS } from "./document-storage-profile.ts";
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts";
import {
  invalidateHostedDocumentShares,
  invalidateHostedDocumentSharesForSpace,
} from "./share-lifecycle.ts";

// ============================================================
// Paths
// ============================================================

export function getSpacesBaseDir(): string {
  return getSpacesDir();
}

function baseDir(): string {
  return getSpacesBaseDir();
}

function spaceDir(spaceId: string): string {
  return join(baseDir(), spaceId);
}

function spacePath(spaceId: string): string {
  return join(spaceDir(spaceId), "space.json");
}


function docsDir(spaceId: string): string {
  return join(spaceDir(spaceId), "docs");
}

function docMetaPath(spaceId: string): string {
  return join(spaceDir(spaceId), "docs.meta.json");
}

// Doc version snapshots live in the shared version store (version-store.ts,
// kind "docs") — same disk layout as always: versions/<space>/docs/<path>/.

export function sanitizeDocPath(docPath: string): string {
  return docPath.replace(/\.\./g, "").replace(/^\/+/, "");
}

function generationMutationPathError(docPath: string): string | null {
  return sanitizeDocPath(docPath) === docPath &&
    analyzeDocumentPath(docPath).safe
    ? null
    : `Document path is not canonical: ${docPath}`;
}

function managedDocPathError(docPath: string): string | null {
  return sanitizeDocPath(docPath) === docPath
    ? null
    : `Document path cannot be created here: ${docPath}`;
}

/** File format on disk for a doc path */
export type DocFileFormat = "json" | "md";

interface DocMetaEntry {
  archived?: ArchiveInfo;
  provenance?: DocProvenance;
  collaborationCacheEpoch?: string;
  collaborationCacheEpochHistory?: string[];
}

interface DocMetaFile {
  version: 1;
  docs: Record<string, DocMetaEntry>;
}

export interface DocProvenance {
  updatedAt: string;
  updatedBy: string;
  source: string;
  versionId: string;
  contentHash: string;
}

export type DocCheckpointKind = "manual" | "source-transition" | "restore" | "system" | "review";

export interface DocVersionCheckpoint {
  meaningful: boolean;
  kind: DocCheckpointKind;
  label?: string;
  sourceCategory: DocSourceCategory;
  transition?: { from: DocSourceCategory; to: DocSourceCategory };
}

export interface DocVersionContext {
  updatedBy?: string;
  source?: string;
  reason?: string;
  checkpointLabel?: string;
  checkpoint?: boolean;
}

export interface DocVersionEntry {
  id: string;
  createdAt: string;
  createdBy: string;
  source: string;
  reason?: string;
  operation: "create" | "update" | "checkpoint";
  before?: { format: string | null; storedAs: string | null; contentHash: string | null } | null;
  after: { format: string | null; storedAs: string | null; contentHash: string; content?: unknown };
  checkpoint?: DocVersionCheckpoint;
}

export interface DocVersionSnapshot extends DocVersionEntry {
  type: "worktable.doc-version";
  version: 1;
  spaceId: string;
  docPath: string;
  before: { format: string | null; storedAs: string | null; contentHash: string | null; content: unknown } | null;
  after: { format: string | null; storedAs: string | null; contentHash: string; content: unknown };
}

const EMPTY_DOC_META: DocMetaFile = {
  version: 1,
  docs: {},
};

function normalizeArchiveInfo(value: unknown): ArchiveInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["archivedAt"] !== "string" ||
    typeof candidate["archivedBy"] !== "string"
  ) {
    return undefined;
  }
  const reason = typeof candidate["reason"] === "string"
    ? candidate["reason"]
    : undefined;
  return {
    archivedAt: candidate["archivedAt"],
    archivedBy: candidate["archivedBy"],
    reason,
  };
}

function normalizeDocProvenance(value: unknown): DocProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["updatedAt"] !== "string" ||
    typeof candidate["updatedBy"] !== "string" ||
    typeof candidate["source"] !== "string" ||
    typeof candidate["versionId"] !== "string" ||
    typeof candidate["contentHash"] !== "string"
  ) {
    return undefined;
  }
  return {
    updatedAt: candidate["updatedAt"],
    updatedBy: candidate["updatedBy"],
    source: candidate["source"],
    versionId: candidate["versionId"],
    contentHash: candidate["contentHash"],
  };
}

export function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// versionFilePath / read / write / markCheckpoint / automaticCheckpointLabel
// moved to version-store.ts (shared with widget versions).

/**
 * Resolve a doc path to its actual file on disk.
 * Tries .json first, then .md. Returns null if neither exists.
 */
function resolveDocFile(
  spaceId: string,
  docPath: string
): { path: string; format: DocFileFormat } | null {
  const sanitized = sanitizeDocPath(docPath);
  const jsonPath = join(docsDir(spaceId), `${sanitized}.json`);
  if (existsSync(jsonPath)) return { path: jsonPath, format: "json" };
  const mdPath = join(docsDir(spaceId), `${sanitized}.md`);
  if (existsSync(mdPath)) return { path: mdPath, format: "md" };
  return null;
}

/** Get the .json path for a doc (used for BlockNote writes) */
function docFilePathJson(spaceId: string, docPath: string): string {
  const sanitized = sanitizeDocPath(docPath);
  return join(docsDir(spaceId), `${sanitized}.json`);
}

/** Get the .md path for a doc (used for markdown writes) */
function docFilePathMd(spaceId: string, docPath: string): string {
  const sanitized = sanitizeDocPath(docPath);
  return join(docsDir(spaceId), `${sanitized}.md`);
}

export function getDocPath(spaceId: string, docPath: string): string {
  const resolved = resolveDocFile(spaceId, docPath);
  return resolved?.path ?? docFilePathJson(spaceId, docPath);
}

// ============================================================
// Watcher suppression: skip watcher events for internal writes
// ============================================================

interface SuppressedDocReplay {
  spaceId: string;
  docPath: string;
}

type SuppressedDocReplaySource =
  | SuppressedDocReplay
  | (() => SuppressedDocReplay | null);

interface SuppressedPathState {
  count: number;
  observed: boolean;
  docReplay?: SuppressedDocReplaySource;
  pathReplay?: () => Promise<void> | void;
}

interface PendingDocReplay {
  spaceId: string;
  docPath: string;
}

const suppressedPaths = new Map<string, SuppressedPathState>();
const pendingDocReplays = new Map<string, PendingDocReplay>();

export function suppressPath(filePath: string): void {
  const state = suppressedPaths.get(filePath);
  if (state) state.count += 1;
  else suppressedPaths.set(filePath, { count: 1, observed: false });
}

export function unsuppressPath(filePath: string): void {
  const state = suppressedPaths.get(filePath);
  if (!state) return;
  state.count -= 1;
  if (state.count > 0) return;
  suppressedPaths.delete(filePath);
  if (state.observed && state.docReplay) {
    const replay =
      typeof state.docReplay === "function"
        ? state.docReplay()
        : state.docReplay;
    if (replay) queueSuppressedDocReplay(replay);
  } else if (state.observed && state.pathReplay) {
    void Promise.resolve()
      .then(state.pathReplay)
      .catch((err) => {
        console.error("[store] replay suppressed path change failed:", err);
      });
  }
}

export function isPathSuppressed(filePath: string): boolean {
  return (suppressedPaths.get(filePath)?.count ?? 0) > 0;
}

/** Record that the watcher saw an event which an internal write suppressed. */
export function notePathEventIfSuppressed(filePath: string): boolean {
  const state = suppressedPaths.get(filePath);
  if (!state || state.count <= 0) return false;
  state.observed = true;
  return true;
}

export function prepareSuppressedDocReplay(
  filePath: string,
  replay: SuppressedDocReplaySource
): void {
  const state = suppressedPaths.get(filePath);
  if (state) state.docReplay = replay;
}

export function prepareSuppressedPathReplay(
  filePath: string,
  replay: () => Promise<void> | void
): void {
  const state = suppressedPaths.get(filePath);
  if (state) state.pathReplay = replay;
}

function queueSuppressedDocReplay(replay: SuppressedDocReplay): void {
  const key = `${replay.spaceId}\0${replay.docPath}`;
  if (pendingDocReplays.has(key)) return;
  const batch: PendingDocReplay = {
    spaceId: replay.spaceId,
    docPath: replay.docPath,
  };
  pendingDocReplays.set(key, batch);
  void replaySuppressedDocChange(key, batch);
}

async function replaySuppressedDocChange(
  key: string,
  replay: PendingDocReplay
): Promise<void> {
  try {
    await withDocPathLock(replay.spaceId, async () => {
      // Both storage extensions and any internal write queued ahead of this
      // replay share one logical-document batch. Reading under the namespace
      // lock prevents a newer write's file from being compared with its old
      // provenance.
      if (pendingDocReplays.get(key) !== replay) return;
      pendingDocReplays.delete(key);
      const [current, provenance] = await Promise.all([
        readDoc(replay.spaceId, replay.docPath),
        getDocProvenance(replay.spaceId, replay.docPath),
      ]);
      const currentHash =
        current.data === null || current.error
          ? undefined
          : stableHash(current.data);
      // The namespace lock guarantees that current provenance belongs to the
      // latest completed internal write. Older expected hashes are unsafe:
      // an external editor can legitimately restore one while a newer write
      // is suppressed.
      if (currentHash && currentHash === provenance?.contentHash) {
        return;
      }
      await notifyWorkspaceChangeAndWait({
        type: "doc",
        spaceId: replay.spaceId,
        docPath: replay.docPath,
      });
    });
  } catch (err) {
    console.error("[store] replay suppressed doc change failed:", err);
  }
}

// ============================================================
// Write lock: one concurrent write per file path
// ============================================================

const writeLocks = new Map<string, Promise<void>>();

export async function withStoreWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const current = writeLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  writeLocks.set(filePath, next);
  await current;
  try {
    assertWorkspaceAvailable();
    return await fn();
  } finally {
    release();
    if (writeLocks.get(filePath) === next) {
      writeLocks.delete(filePath);
    }
  }
}

/** Acquire several store-file locks in canonical order for one transaction. */
export async function withStoreWriteLocks<T>(
  filePaths: string[],
  fn: () => Promise<T>
): Promise<T> {
  const ordered = [...new Set(filePaths)].sort((a, b) => a.localeCompare(b))
  const acquire = (index: number): Promise<T> => {
    const path = ordered[index]
    if (!path) return fn()
    return withStoreWriteLock(path, () => acquire(index + 1))
  }
  return acquire(0)
}

async function withWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  return withStoreWriteLock(filePath, fn);
}

// ============================================================
// Atomic write helper
// ============================================================

async function atomicWrite(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);
  await writeFile(tmpPath, json, "utf8");
  await rename(tmpPath, filePath);
}

async function atomicWriteAfterValidation(
  filePath: string,
  data: unknown,
  validateBeforePublish: () => Promise<boolean>
): Promise<boolean> {
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);
  let published = false;
  try {
    await writeFile(tmpPath, json, "utf8");
    if (!(await validateBeforePublish())) return false;
    await rename(tmpPath, filePath);
    published = true;
    return true;
  } finally {
    if (!published) await rm(tmpPath, { force: true });
  }
}

export async function atomicWriteText(filePath: string, text: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, text, "utf8");
  await rename(tmpPath, filePath);
}

/**
 * Canonicalize a BlockNote block array for a .json write. Every block write
 * funnels through here so on-disk content is in one normal form (stable
 * IDs, default props) regardless of caller — agent MCP writes, REST, restore,
 * and patch. This makes content hashes reflect meaning rather than incidental
 * shape, so a semantic no-op (e.g. the browser's initial editor sync) produces
 * an identical hash and records no version. Falls back to the raw blocks if
 * canonicalization throws, so a write never fails on unexpected content.
 *
 * Returns `skipped: true` — nothing written — when the incoming content is
 * semantically identical to the existing blocks. The comparison canonicalizes
 * BOTH sides (the existing blocks adopt the incoming ids for matching
 * content), so it also holds for legacy id-less files: without that, an
 * idempotent rewrite of a legacy doc would mint fresh ids, hash differently,
 * and record a phantom version that flips provenance.
 */
async function prepareBlocksCanonical(
  blocks: unknown[],
  previousBlocks?: unknown[]
): Promise<{ skipped: boolean; content: unknown[] }> {
  let canonical: unknown[];
  try {
    const withIds = Array.isArray(previousBlocks)
      ? inheritBlockIds(blocks, previousBlocks)
      : blocks;
    canonical = await canonicalizeBlocks(withIds);

    if (Array.isArray(previousBlocks)) {
      const previousCanonicalHash = stableHash(
        await canonicalizeBlocks(inheritBlockIds(previousBlocks, canonical))
      );
      if (previousCanonicalHash === stableHash(canonical)) {
        return { skipped: true, content: canonical };
      }
    }
  } catch (err) {
    console.error("[store] canonicalizeBlocks failed, writing raw blocks:", err);
    canonical = blocks;
  }
  return { skipped: false, content: canonical };
}

export async function ensureSpaceDirectories(spaceId: string): Promise<void> {
  await ensureSpaceDirs(spaceId);
}

// ============================================================
// Directory setup
// ============================================================

async function ensureSpaceDirs(spaceId: string): Promise<void> {
  await mkdir(spaceDir(spaceId), { recursive: true });
  await mkdir(docsDir(spaceId), { recursive: true });
}

// ============================================================
// Slug helpers
// ============================================================

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/**
 * Slugify a doc path one segment at a time, preserving "/" folder boundaries
 * (the plain slugify would collapse the slashes). Empty segments are dropped.
 */
export function slugifyDocPath(docPath: string): string {
  return docPath
    .split("/")
    .map((segment) => slugify(segment))
    .filter((segment) => segment.length > 0)
    .join("/");
}

export async function deduplicateSlug(
  base: string,
  existingSlugs: string[]
): Promise<string> {
  // Compare case-insensitively so we don't hand back a slug that collides on
  // case-insensitive filesystems (macOS) with an existing one.
  const taken = new Set(existingSlugs.map((slug) => slug.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`.toLowerCase())) i++;
  return `${base}-${i}`;
}

// ============================================================
// Space operations
// ============================================================

export async function listSpaces(): Promise<SpaceFile[]> {
  const base = baseDir();
  if (!existsSync(base)) return [];

  const entries = await readdir(base, { withFileTypes: true });
  const spaces: SpaceFile[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const result = await readSpace(entry.name);
    // The directory name is the portable space identity. Ignore mismatched
    // metadata so a prepared directory can carry its final manifest without
    // becoming visible before its atomic rename publishes it.
    if (result.data?.id === entry.name) spaces.push(result.data);
  }

  return spaces;
}

export async function readSpace(
  spaceId: string
): Promise<{ data: SpaceFile | null; error: string | null }> {
  const path = spacePath(spaceId);
  if (!existsSync(path)) {
    return { data: null, error: `Space not found: ${spaceId}` };
  }

  try {
    const raw = await Bun.file(path).json();
    const data = SpaceFileSchema.parse(raw);
    return { data, error: null };
  } catch (err) {
    return {
      data: null,
      error: `Failed to parse space: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function writeSpace(space: SpaceFile): Promise<void> {
  const path = spacePath(space.id);
  await ensureSpaceDirs(space.id);
  await withWriteLock(path, () => atomicWrite(path, space));
}

/** Read and replace one existing Space while holding its file write lock. */
export async function mutateSpace(
  spaceId: string,
  mutation: (space: SpaceFile) => SpaceFile | null
): Promise<{ data: SpaceFile | null; error: string | null }> {
  const path = spacePath(spaceId);
  return withWriteLock(path, async () => {
    const current = await readSpace(spaceId);
    if (!current.data || current.error) return current;

    const candidate = mutation(current.data);
    if (!candidate) return current;
    if (candidate.id !== spaceId) {
      throw new Error("Space mutation changed its identity");
    }
    const updated = SpaceFileSchema.parse(candidate);
    await atomicWrite(path, updated);
    return { data: updated, error: null };
  });
}

export const PREPARED_SPACE_MARKER = ".worktable-internal-seed";

/** Mark a uniquely owned directory so filesystem observers can ignore it. */
export async function markPreparedSpace(preparedId: string): Promise<void> {
  await writeFile(join(spaceDir(preparedId), PREPARED_SPACE_MARKER), preparedId, {
    flag: "wx",
  });
}

/** Write final metadata inside an unpublished, uniquely owned directory. */
export async function writePreparedSpace(
  preparedId: string,
  space: SpaceFile
): Promise<void> {
  const path = spacePath(preparedId);
  await ensureSpaceDirs(preparedId);
  await withWriteLock(path, () => atomicWrite(path, space));
}

interface PreparedFileSnapshot {
  relativePath: string;
  dev: number;
  ino: number;
  content: Buffer;
}

interface PreparedDirectorySnapshot {
  relativePath: string;
  dev: number;
  ino: number;
}

let preparedSpaceBeforeManifestHookForTests:
  | (() => void | Promise<void>)
  | null = null;

export function setPreparedSpaceBeforeManifestHookForTests(
  hook: (() => void | Promise<void>) | null
): void {
  preparedSpaceBeforeManifestHookForTests = hook;
}

async function snapshotPreparedPayload(source: string): Promise<{
  files: PreparedFileSnapshot[];
  directories: PreparedDirectorySnapshot[];
}> {
  const files: PreparedFileSnapshot[] = [];
  const directories: PreparedDirectorySnapshot[] = [];
  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = join(source, relativeDirectory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = join(relativeDirectory, entry.name);
      if (
        !relativeDirectory &&
        (entry.name === "space.json" || entry.name === PREPARED_SPACE_MARKER)
      ) {
        continue;
      }
      const path = join(source, relativePath);
      const details = await stat(path);
      if (entry.isDirectory()) {
        directories.push({
          relativePath,
          dev: details.dev,
          ino: details.ino,
        });
        await visit(relativePath);
      } else if (entry.isFile()) {
        files.push({
          relativePath,
          dev: details.dev,
          ino: details.ino,
          content: await readFile(path),
        });
      } else {
        throw new Error(`Prepared space contains an unsupported entry: ${path}`);
      }
    }
  };
  await visit("");
  return { files, directories };
}

async function removeUnchangedPreparedPayload(
  destination: string,
  destinationIdentity: { dev: number; ino: number },
  payload: {
    files: PreparedFileSnapshot[];
    directories: PreparedDirectorySnapshot[];
  }
): Promise<void> {
  for (const file of payload.files) {
    const path = join(destination, file.relativePath);
    try {
      const details = await stat(path);
      if (
        !details.isFile() ||
        details.dev !== file.dev ||
        details.ino !== file.ino
      ) {
        continue;
      }
      const current = await readFile(path);
      if (current.equals(file.content)) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const deepestFirst = [...payload.directories].sort(
    (a, b) => b.relativePath.length - a.relativePath.length
  );
  for (const directory of deepestFirst) {
    const path = join(destination, directory.relativePath);
    try {
      const details = await stat(path);
      if (
        !details.isDirectory() ||
        details.dev !== directory.dev ||
        details.ino !== directory.ino
      ) {
        continue;
      }
      await rmdir(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        throw error;
      }
    }
  }

  try {
    const details = await stat(destination);
    if (
      details.isDirectory() &&
      details.dev === destinationIdentity.dev &&
      details.ino === destinationIdentity.ino
    ) {
      await rmdir(destination);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Claim a final space id without replacing any directory an external writer
 * created first. Payload directories move under that exclusive claim, while
 * space.json moves last so supported readers cannot observe a partial space.
 */
export async function publishPreparedSpace(
  preparedId: string,
  finalId: string
): Promise<boolean> {
  const source = spaceDir(preparedId);
  const destination = spaceDir(finalId);
  const payload = await snapshotPreparedPayload(source);
  try {
    await mkdir(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  const destinationIdentity = await stat(destination);

  try {
    const entries = (await readdir(source, { withFileTypes: true })).map(
      (entry) => entry.name
    );
    if (!entries.includes("space.json")) {
      throw new Error(`Prepared space is missing space.json: ${preparedId}`);
    }
    for (const entry of entries) {
      if (entry === "space.json" || entry === PREPARED_SPACE_MARKER) continue;
      await rename(join(source, entry), join(destination, entry));
    }
    await preparedSpaceBeforeManifestHookForTests?.();
    // A hard link publishes the complete manifest atomically and, unlike
    // rename(), never replaces a manifest another filesystem writer created.
    // Some portable/network filesystems reject hard links, so fall back to an
    // exclusive copy with the same no-overwrite contract.
    const sourceManifest = join(source, "space.json");
    const destinationManifest = join(destination, "space.json");
    try {
      await link(sourceManifest, destinationManifest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw error;
      await copyFile(sourceManifest, destinationManifest, constants.COPYFILE_EXCL);
    }
    // The link is the publication commit point: every payload is already in
    // place and the manifest is complete. Cleanup is best effort so a failure
    // cannot roll back directories while leaving a now-visible manifest.
    try {
      await unlink(sourceManifest);
      await unlink(join(source, PREPARED_SPACE_MARKER));
      await rmdir(source);
    } catch {
      // A leftover prepared directory carries a mismatched manifest id and is
      // therefore ignored by listSpaces; a later maintenance pass can remove it.
    }
    return true;
  } catch (error) {
    // A concurrent writer may have published a manifest or added content after
    // our directory claim. Remove only paths that are still the exact inode and
    // bytes prepared by this seed; modified or independently replaced content
    // is user-owned and remains in place.
    await removeUnchangedPreparedPayload(
      destination,
      destinationIdentity,
      payload
    );
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
}

/** Permanently remove an unpublished internal staging directory. */
export async function discardPreparedSpace(preparedId: string): Promise<void> {
  await rm(spaceDir(preparedId), { recursive: true, force: true });
}

/**
 * Remap manual sidebar order entries (settings.docOrder) after a rename so
 * docs keep their dragged position. Exact from->to mappings cover docs; the
 * prefix rule covers folder entries (the order array lists folder paths too).
 */
export async function migrateDocOrderPaths(
  spaceId: string,
  renamed: Array<{ from: string; to: string }>,
  prefix?: { from: string; to: string }
): Promise<void> {
  const map = new Map(renamed.map((r) => [r.from, r.to]));
  await mutateSpace(spaceId, (space) => {
    const order = space.settings["docOrder"];
    if (!Array.isArray(order)) return null;
    let changed = false;
    const next = order.map((entry) => {
      if (typeof entry !== "string") return entry;
      const direct = map.get(entry);
      if (direct !== undefined) {
        changed = changed || direct !== entry;
        return direct;
      }
      if (
        prefix &&
        (entry === prefix.from || entry.startsWith(prefix.from + "/"))
      ) {
        changed = true;
        return prefix.to + entry.slice(prefix.from.length);
      }
      return entry;
    });
    if (!changed) return null;
    return {
      ...space,
      settings: { ...space.settings, docOrder: next },
      updatedAt: new Date().toISOString(),
    };
  });
}

export function getSpaceArchiveInfo(space: SpaceFile): ArchiveInfo | undefined {
  return normalizeArchiveInfo(space.settings["archive"]);
}

export async function setSpaceArchived(
  spaceId: string,
  archived: boolean,
  archivedBy = "user",
  reason?: string
): Promise<{ space: SpaceFile | null; error: string | null }> {
  const { data: updated, error } = await mutateSpace(spaceId, (space) => {
    const settings = { ...space.settings };
    if (archived) {
      settings["archive"] = {
        archivedAt: new Date().toISOString(),
        archivedBy,
        ...(reason ? { reason } : {}),
      };
    } else {
      delete settings["archive"];
    }
    return {
      ...space,
      settings,
      updatedAt: new Date().toISOString(),
    };
  });
  if (error || !updated) {
    return { space: null, error: error ?? `Space not found: ${spaceId}` };
  }
  if (archived) {
    await invalidateHostedDocumentSharesForSpace(spaceId);
  }
  await notifyWorkspaceChangeAndWait({ type: "space", spaceId });
  return { space: updated, error: null };
}

export async function deleteSpace(spaceId: string): Promise<void> {
  await withDocPathLock(spaceId, async () => {
    await withWriteLock(spacePath(spaceId), async () => {
      const dir = spaceDir(spaceId);
      const trashBase = join(baseDir(), ".trash");
      await mkdir(trashBase, { recursive: true });
      const trashDest = join(trashBase, `${spaceId}-${Date.now()}`);
      try {
        await rename(dir, trashDest);
      } catch {
        // rename fails across devices; fall back to hard delete
        await rm(dir, { recursive: true, force: true });
      }
      await invalidateHostedDocumentSharesForSpace(spaceId);
      await notifyWorkspaceChangeAndWait({ type: "space", spaceId });
    });
  });
}

async function readDocMetaFile(spaceId: string): Promise<DocMetaFile> {
  const path = docMetaPath(spaceId);
  if (!existsSync(path)) return { ...EMPTY_DOC_META, docs: {} };

  try {
    const raw = await Bun.file(path).json();
    if (!raw || typeof raw !== "object") return { ...EMPTY_DOC_META, docs: {} };
    const data = raw as { version?: unknown; docs?: unknown };
    const docs: Record<string, DocMetaEntry> = {};

    if (data.docs && typeof data.docs === "object") {
      for (const [docPath, value] of Object.entries(data.docs as Record<string, unknown>)) {
        const entry = value as Record<string, unknown>;
        const archived = normalizeArchiveInfo(entry?.["archived"]);
        const provenance = normalizeDocProvenance(entry?.["provenance"]);
        const collaborationCacheEpoch =
          typeof entry?.["collaborationCacheEpoch"] === "string" &&
          entry["collaborationCacheEpoch"].length > 0
            ? entry["collaborationCacheEpoch"]
            : undefined;
        const legacyPreviousEpoch =
          typeof entry?.["previousCollaborationCacheEpoch"] === "string"
            ? entry["previousCollaborationCacheEpoch"]
            : undefined;
        const collaborationCacheEpochHistory = [
          ...(Array.isArray(entry?.["collaborationCacheEpochHistory"])
            ? entry["collaborationCacheEpochHistory"].filter(
                (value): value is string =>
                  typeof value === "string" && value.length > 0
              )
            : []),
          ...(legacyPreviousEpoch ? [legacyPreviousEpoch] : []),
        ].filter((value, index, values) => values.indexOf(value) === index);
        if (archived) {
          docs[docPath] = { ...(docs[docPath] ?? {}), archived };
        }
        if (provenance) {
          docs[docPath] = { ...(docs[docPath] ?? {}), provenance };
        }
        if (collaborationCacheEpoch) {
          docs[docPath] = {
            ...(docs[docPath] ?? {}),
            collaborationCacheEpoch,
          };
        }
        if (collaborationCacheEpochHistory.length > 0) {
          docs[docPath] = {
            ...(docs[docPath] ?? {}),
            collaborationCacheEpochHistory,
          };
        }
      }
    }

    return { version: 1, docs };
  } catch {
    return { ...EMPTY_DOC_META, docs: {} };
  }
}

async function writeDocMetaFileUnlocked(spaceId: string, meta: DocMetaFile): Promise<void> {
  const path = docMetaPath(spaceId);
  const cleanedDocs = Object.fromEntries(
    Object.entries(meta.docs).filter(
      ([, entry]) =>
        entry.archived ||
        entry.provenance ||
        entry.collaborationCacheEpoch ||
        entry.collaborationCacheEpochHistory?.length
    )
  );

  if (Object.keys(cleanedDocs).length === 0) {
    if (existsSync(path)) {
      await unlink(path).catch(() => undefined);
    }
    return;
  }

  await ensureSpaceDirs(spaceId);
  await atomicWrite(path, { version: 1, docs: cleanedDocs });
}

async function mutateDocMetaFile<T>(
  spaceId: string,
  mutate: (meta: DocMetaFile) => T | Promise<T>
): Promise<T> {
  return withWriteLock(docMetaPath(spaceId), async () => {
    const meta = await readDocMetaFile(spaceId);
    const result = await mutate(meta);
    await writeDocMetaFileUnlocked(spaceId, meta);
    return result;
  });
}

export async function getDocArchiveInfo(spaceId: string, docPath: string): Promise<ArchiveInfo | undefined> {
  const meta = await readDocMetaFile(spaceId);
  return meta.docs[sanitizeDocPath(docPath)]?.archived;
}

/** Read archive metadata once for a bounded set of document paths. */
export async function getDocArchiveInfoMap(spaceId: string, docPaths: Iterable<string>): Promise<Map<string, ArchiveInfo>> {
  const meta = await readDocMetaFile(spaceId);
  const result = new Map<string, ArchiveInfo>();
  for (const rawPath of docPaths) {
    const path = sanitizeDocPath(rawPath);
    const archived = meta.docs[path]?.archived;
    if (archived) result.set(path, archived);
  }
  return result;
}

export async function getDocProvenance(spaceId: string, docPath: string): Promise<DocProvenance | undefined> {
  const meta = await readDocMetaFile(spaceId);
  return meta.docs[sanitizeDocPath(docPath)]?.provenance;
}

export async function getDocCollaborationCacheEpoch(
  spaceId: string,
  docPath: string
): Promise<string> {
  const meta = await readDocMetaFile(spaceId);
  return meta.docs[sanitizeDocPath(docPath)]?.collaborationCacheEpoch ?? "legacy";
}

export async function getDocCollaborationCacheEpochHistory(
  spaceId: string,
  docPath: string
): Promise<string[]> {
  const meta = await readDocMetaFile(spaceId);
  return (
    meta.docs[sanitizeDocPath(docPath)]?.collaborationCacheEpochHistory ?? []
  );
}

async function rotateDocCollaborationCacheEpoch(
  spaceId: string,
  docPath: string
): Promise<string> {
  const sanitized = sanitizeDocPath(docPath);
  return mutateDocMetaFile(spaceId, (meta) => {
    const collaborationCacheEpoch = crypto.randomUUID();
    const previousCollaborationCacheEpoch =
      meta.docs[sanitized]?.collaborationCacheEpoch ?? "legacy";
    const collaborationCacheEpochHistory = [
      ...(meta.docs[sanitized]?.collaborationCacheEpochHistory ?? []),
      previousCollaborationCacheEpoch,
    ].filter((value, index, values) => values.indexOf(value) === index);
    meta.docs[sanitized] = {
      ...(meta.docs[sanitized] ?? {}),
      collaborationCacheEpoch,
      collaborationCacheEpochHistory,
    };
    return collaborationCacheEpoch;
  });
}

export async function setDocArchived(
  spaceId: string,
  docPath: string,
  archived: boolean,
  archivedBy = "user",
  reason?: string
): Promise<{ archived?: ArchiveInfo; error: string | null }> {
  return withDocPathLock(spaceId, async () => {
    const sanitized = sanitizeDocPath(docPath);
    const exists = await docExists(spaceId, sanitized);
    if (!exists) {
      return { error: `Doc not found: ${sanitized}` };
    }

    const archiveInfo = await mutateDocMetaFile(spaceId, (meta) => {
      if (archived) {
        meta.docs[sanitized] = {
          ...(meta.docs[sanitized] ?? {}),
          archived: {
            archivedAt: new Date().toISOString(),
            archivedBy,
            ...(reason ? { reason } : {}),
          },
        };
      } else {
        if (
          meta.docs[sanitized]?.provenance ||
          meta.docs[sanitized]?.collaborationCacheEpoch ||
          meta.docs[sanitized]?.collaborationCacheEpochHistory?.length
        ) {
          delete meta.docs[sanitized]!.archived;
        } else {
          delete meta.docs[sanitized];
        }
      }
      return meta.docs[sanitized]?.archived;
    });
    if (archived) {
      await invalidateHostedDocumentShares([
        { kind: "doc", spaceId, artifactKey: sanitized },
      ]);
    }
    // Archive state changes what derived consumers (lint, indexes) should see,
    // even though the doc file itself is untouched.
    notifyDocContentChanged(spaceId, sanitized);
    return { archived: archiveInfo, error: null };
  });
}

export async function setDocsArchivedByPrefix(
  spaceId: string,
  prefix: string,
  archived: boolean,
  archivedBy = "user",
  reason?: string
): Promise<{ count: number; paths: string[]; error: string | null }> {
  return withDocPathLock(spaceId, async () => {
    const sanitizedPrefix = sanitizeDocPath(prefix);
    const paths = (await listDocs(spaceId)).filter(
      (path) =>
        path === sanitizedPrefix || path.startsWith(`${sanitizedPrefix}/`)
    );

    if (paths.length === 0) {
      return {
        count: 0,
        paths: [],
        error: `No docs found for prefix: ${sanitizedPrefix}`,
      };
    }

    await mutateDocMetaFile(spaceId, (meta) => {
      for (const path of paths) {
        if (archived) {
          meta.docs[path] = {
            ...(meta.docs[path] ?? {}),
            archived: {
              archivedAt: new Date().toISOString(),
              archivedBy,
              ...(reason ? { reason } : {}),
            },
          };
        } else {
          if (
            meta.docs[path]?.provenance ||
            meta.docs[path]?.collaborationCacheEpoch ||
            meta.docs[path]?.collaborationCacheEpochHistory?.length
          ) {
            delete meta.docs[path]!.archived;
          } else {
            delete meta.docs[path];
          }
        }
      }
    });
    if (archived) {
      await invalidateHostedDocumentShares(
        paths.map((path) => ({
          kind: "doc" as const,
          spaceId,
          artifactKey: path,
        }))
      );
    }
    for (const path of paths) {
      notifyDocContentChanged(spaceId, path);
    }
    return { count: paths.length, paths, error: null };
  });
}

// ============================================================

// ============================================================
// Doc operations
// ============================================================

async function walkDir(dir: string, basePath: string, paths: string[]): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Track seen paths to avoid duplicates if both .json and .md exist (prefer .json)
    const seen = new Set<string>();
    // Process .json first (takes priority)
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath, basePath, paths);
      } else if (entry.name.endsWith(".json")) {
        const relPath = relative(basePath, fullPath).replace(/\.json$/, "");
        if (!seen.has(relPath)) {
          seen.add(relPath);
          paths.push(relPath);
        }
      }
    }
    // Then .md files (only if no .json for same path)
    for (const entry of entries) {
      if (!entry.isDirectory() && entry.name.endsWith(".md")) {
        const relPath = relative(basePath, join(dir, entry.name)).replace(/\.md$/, "");
        if (!seen.has(relPath)) {
          seen.add(relPath);
          paths.push(relPath);
        }
      }
    }
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (error.code !== "ENOENT") throw err;
  }
}

export async function listDocs(spaceId: string): Promise<string[]> {
  const dir = docsDir(spaceId);
  const paths: string[] = [];
  await walkDir(dir, dir, paths);
  const { aliases, error } = await readDocAliases(spaceId);
  if (!aliases) throw new Error(error ?? "Document aliases are unavailable");
  // A sync may recreate a physical file at a reserved old path. Keep that
  // conflict hidden from every enumeration consumer until the alias is
  // explicitly retired; reads still resolve to the canonical document.
  return paths.filter((path) => reservedByAliasIn(aliases, path) === null);
}

async function updateDocProvenance(
  spaceId: string,
  docPath: string,
  provenance: DocProvenance
): Promise<void> {
  const sanitized = sanitizeDocPath(docPath);
  await mutateDocMetaFile(spaceId, (meta) => {
    meta.docs[sanitized] = {
      ...(meta.docs[sanitized] ?? {}),
      provenance,
    };
  });
  noteDocProvenanceChanged();
}

/**
 * Project one already-committed common document generation into the released
 * Doc compatibility surface without recording a second version. The common
 * writer owns V2 history; this adapter keeps legacy freshness, watcher dedup,
 * derived state, and live rich-text rooms aligned with that same generation.
 */
export async function publishManagedDocGenerationProjection(
  spaceId: string,
  docPath: string,
  input: Omit<DocProvenance, "contentHash"> & { contentChanged: boolean }
): Promise<void> {
  const after = await readDoc(spaceId, docPath);
  if (after.error || after.data === null) {
    throw new Error(after.error ?? `Doc not found: ${docPath}`);
  }
  await updateDocProvenance(spaceId, docPath, {
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
    source: input.source,
    versionId: input.versionId,
    contentHash: stableHash(after.data),
  });
  if (!input.contentChanged) return;
  notifyDocContentChanged(spaceId, docPath);
  if (Array.isArray(after.data)) {
    const { yjsManager } = await import("./yjs-manager.ts");
    await yjsManager.replaceContent(spaceId, docPath, after.data);
  }
}

async function recordDocVersionUnderKeyLock(
  spaceId: string,
  docPath: string,
  before: DocReadResult | null,
  after: DocReadResult,
  context?: DocVersionContext,
  opts?: { force?: boolean; operation?: "create" | "update" | "checkpoint"; checkpoint?: DocVersionCheckpoint }
): Promise<DocProvenance | undefined> {
  if (after.error || after.data === null) return undefined;

  const previousProvenance = await getDocProvenance(spaceId, docPath);
  const beforeHash = before?.data === null || before?.error ? null : before ? stableHash(before.data) : null;
  const afterHash = stableHash(after.data);
  if (!opts?.force && beforeHash && beforeHash === afterHash) {
    return undefined;
  }

  const now = new Date().toISOString();
  const versionId = mintVersionId(now);
  const provenance: DocProvenance = {
    updatedAt: now,
    updatedBy: context?.updatedBy ?? "unknown",
    source: context?.source ?? "unknown",
    versionId,
    contentHash: afterHash,
  };

  const currentCategory = sourceCategory(provenance.source, provenance.updatedBy);
  const checkpoint = opts?.checkpoint ?? (context?.checkpoint
    ? {
        meaningful: true,
        kind: "system" as const,
        label: context.checkpointLabel,
        sourceCategory: currentCategory,
      }
    : undefined);

  const snapshot: DocVersionSnapshot = {
    type: "worktable.doc-version",
    version: 1,
    id: versionId,
    spaceId,
    docPath: sanitizeDocPath(docPath),
    operation: opts?.operation ?? (before?.data == null ? "create" : "update"),
    createdAt: now,
    createdBy: provenance.updatedBy,
    source: provenance.source,
    reason: context?.reason,
    checkpoint,
    before: before?.data == null ? null : {
      format: before.format,
      storedAs: before.storedAs,
      contentHash: beforeHash,
      content: before.data,
    },
    after: {
      format: after.format,
      storedAs: after.storedAs,
      contentHash: afterHash,
      content: after.data,
    },
  };

  await writeVersionSnapshot(spaceId, "docs", docPath, snapshot);

  if (previousProvenance && previousProvenance.contentHash !== afterHash) {
    const previousCategory = sourceCategory(previousProvenance.source, previousProvenance.updatedBy);
    if (previousCategory !== currentCategory) {
      await markVersionCheckpoint(spaceId, "docs", docPath, previousProvenance.versionId, {
        meaningful: true,
        kind: previousCategory === "restore" || currentCategory === "restore" ? "restore" : "source-transition",
        label: automaticCheckpointLabel(previousCategory, currentCategory),
        sourceCategory: previousCategory,
        transition: { from: previousCategory, to: currentCategory },
      });
    }
  }

  await updateDocProvenance(spaceId, docPath, provenance);
  return provenance;
}

async function pruneRecordedDocVersion(
  spaceId: string,
  docPath: string,
  provenance: DocProvenance
): Promise<void> {
  // Count-mode retention: a fresh version may push the oldest past the per-doc
  // limit. Cheap single-doc check (no-op unless the policy is `count`); runs
  // AFTER the snapshot-write lock above is released, since it re-acquires the
  // same per-doc-key lock. History maintenance only — emits no change event,
  // and is BEST-EFFORT: the content write already succeeded, so a retention
  // hiccup (unreadable versions dir, racing rename) must not fail the write or
  // suppress change notification. The just-written version is explicitly
  // protected — with same-millisecond version ids the timestamp tiebreak alone
  // can't distinguish it from its sibling.
  try {
    await pruneDocKeyForCount(spaceId, docPath, {
      protectVersionId: provenance.versionId,
    });
  } catch (err) {
    console.warn(
      `[version-retention] post-write prune failed for ${spaceId}/${docPath}:`,
      err,
    );
  }
}

async function recordDocVersion(
  spaceId: string,
  docPath: string,
  before: DocReadResult | null,
  after: DocReadResult,
  context?: DocVersionContext,
  opts?: {
    force?: boolean;
    operation?: "create" | "update" | "checkpoint";
    checkpoint?: DocVersionCheckpoint;
    documentId?: DocumentId;
    sourceBytes?: {
      before?: Uint8Array;
      after?: Uint8Array;
    };
  }
): Promise<DocProvenance | undefined> {
  const {
    recordLegacyDocVersionV2,
    usesDocumentVersionStoreV2,
  } = await import("./document-version-compatibility-v2.ts");
  if (await usesDocumentVersionStoreV2()) {
    if (after.error || after.data === null) return undefined;
    const beforeHash =
      before?.data === null || before?.error
        ? null
        : before
          ? stableHash(before.data)
          : null;
    const afterHash = stableHash(after.data);
    if (!opts?.force && beforeHash && beforeHash === afterHash) {
      return undefined;
    }
    const previousProvenance = await getDocProvenance(spaceId, docPath);
    const v2Options = {
      ...opts,
      ...(context?.checkpoint && !opts?.checkpoint
        ? {
            operation: "checkpoint" as const,
            checkpoint: {
              meaningful: true,
              kind:
                context.source === "version-restore"
                  ? ("restore" as const)
                  : ("system" as const),
              ...(context.checkpointLabel
                ? { label: context.checkpointLabel }
                : {}),
              sourceCategory: sourceCategory(
                context.source,
                context.updatedBy
              ),
            },
          }
        : {}),
    };
    const provenance = await recordLegacyDocVersionV2({
      spaceId,
      path: docPath,
      before,
      after,
      updatedBy: context?.updatedBy ?? "unknown",
      source: context?.source ?? "unknown",
      ...(context?.reason ? { reason: context.reason } : {}),
      options: v2Options,
      contentHash: afterHash,
      baselineRequired: Boolean(
        beforeHash && previousProvenance?.contentHash !== beforeHash
      ),
      beforeBytes: opts?.sourceBytes?.before,
      afterBytes: opts?.sourceBytes?.after,
      previousProvenance,
    });
    if (provenance) await updateDocProvenance(spaceId, docPath, provenance);
    return provenance;
  }
  // Hold the per-doc-key lock across every provenance read, the snapshot
  // write, the checkpoint rewrite, and the provenance update. A queued sweep
  // must not observe a snapshot before docs.meta.json points at it.
  const provenance = await withVersionKeyLock(
    spaceId,
    "docs",
    docPath,
    () => recordDocVersionUnderKeyLock(
      spaceId,
      docPath,
      before,
      after,
      context,
      opts
    )
  );
  if (provenance) {
    await pruneRecordedDocVersion(spaceId, docPath, provenance);
  }
  return provenance;
}

export async function recordExternalDocChange(
  spaceId: string,
  docPath: string,
  context?: DocVersionContext
): Promise<DocProvenance | undefined> {
  const { usesDocumentVersionStoreV2 } = await import(
    "./document-version-compatibility-v2.ts"
  );
  if (await usesDocumentVersionStoreV2()) {
    return withVersionKeyLock(spaceId, "docs", docPath, async () => {
      const snapshot = await readDocSourceSnapshot(spaceId, docPath);
      const after = snapshot.result;
      const currentHash =
        after.data === null || after.error ? null : stableHash(after.data);
      const previous = await getDocProvenance(spaceId, docPath);
      if (!currentHash || previous?.contentHash === currentHash) return undefined;
      return recordDocVersion(
        spaceId,
        docPath,
        null,
        after,
        {
          updatedBy: context?.updatedBy ?? "external",
          source: context?.source ?? "filesystem",
          reason: context?.reason ?? "Detected by file watcher",
        },
        { sourceBytes: { after: snapshot.bytes! } }
      );
    });
  }
  // Lifecycle moves hold both endpoint version-key locks. Starting the
  // external read inside this lock means a watcher task queued before a move
  // re-reads the final endpoint instead of publishing stale old-path state.
  const provenance = await withVersionKeyLock(
    spaceId,
    "docs",
    docPath,
    async () => {
      const after = await readDoc(spaceId, docPath);
      const currentHash =
        after.data === null || after.error ? null : stableHash(after.data);
      const previous = await getDocProvenance(spaceId, docPath);
      if (!currentHash || previous?.contentHash === currentHash) {
        return undefined;
      }
      return recordDocVersionUnderKeyLock(spaceId, docPath, null, after, {
        updatedBy: context?.updatedBy ?? "external",
        source: context?.source ?? "filesystem",
        reason: context?.reason ?? "Detected by file watcher",
      });
    }
  );
  if (provenance) {
    await pruneRecordedDocVersion(spaceId, docPath, provenance);
  }
  return provenance;
}

export async function recordRecoveredDocFormatTransition(
  spaceId: string,
  docPath: string,
  beforeFormatId: string,
  beforeBytes: Uint8Array | null,
  afterFormatId: string,
  afterBytes: Uint8Array,
  context: DocVersionContext
): Promise<DocProvenance | undefined> {
  const parseCaptured = (
    formatId: string,
    bytes: Uint8Array,
    role: "parked" | "target"
  ): DocReadResult => {
    if (formatId === "worktable.markdown") {
      return {
        data: Buffer.from(bytes).toString("utf8"),
        format: "markdown",
        storedAs: "md",
        error: null,
      };
    }
    if (formatId === "worktable.rich-text") {
      let data: unknown;
      try {
        data = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        throw new Error(`${role} rich-text document is invalid JSON`);
      }
      if (!Array.isArray(data)) {
        throw new Error(`${role} rich-text document is not a block array`);
      }
      return {
        data,
        format: "blocknote",
        storedAs: "json",
        error: null,
      };
    }
    throw new Error(`unsupported recovered Doc format: ${formatId}`);
  };

  const after = parseCaptured(afterFormatId, afterBytes, "target");

  const afterHash = stableHash(after.data);
  const previous = await getDocProvenance(spaceId, docPath);
  if (beforeBytes === null) {
    if (previous?.contentHash === afterHash) return undefined;
    throw new Error(
      "document format source is missing before conversion history was recorded"
    );
  }

  const before = parseCaptured(beforeFormatId, beforeBytes, "parked");

  if (previous?.contentHash === afterHash) {
    const snapshot = await getDocVersion(
      spaceId,
      docPath,
      previous.versionId
    );
    if (
      snapshot?.after.contentHash === afterHash &&
      snapshot.before?.contentHash === stableHash(before.data)
    ) {
      return undefined;
    }
  }

  return recordDocVersion(spaceId, docPath, before, after, context, {
    sourceBytes: {
      before: beforeBytes,
      after: afterBytes,
    },
  });
}

export async function listDocsDetailed(
  spaceId: string,
  opts?: { includeArchived?: boolean }
): Promise<DocListEntry[]> {
  const includeArchived = opts?.includeArchived ?? true;
  const paths = await listDocs(spaceId);
  const meta = await readDocMetaFile(spaceId);
  const docs = await Promise.all(paths.map(async (path) => {
    const statResult = await docStat(spaceId, path);
    const readResult = await readDoc(spaceId, path);
    const storedAs = statResult?.format;
    let headings: string[] = [];
    let blockCount: number | null = null;
    let containsMermaid = false;
    let richBlockTypes: string[] = [];
    let readFormatHint: "blocknote" | "markdown" = storedAs === "md" ? "markdown" : "blocknote";

    if (Array.isArray(readResult.data)) {
      headings = extractHeadings(readResult.data);
      blockCount = readResult.data.length;
      containsMermaid = containsMermaidBlock(readResult.data);
      richBlockTypes = getRichBlockTypes(readResult.data);
      readFormatHint = isMarkdownSafe(readResult.data).safe ? "markdown" : "blocknote";
    } else if (typeof readResult.data === "string") {
      headings = extractMarkdownHeadings(readResult.data);
      blockCount = null;
      containsMermaid = extractMarkdownMermaid(readResult.data).length > 0;
      richBlockTypes = [];
      readFormatHint = "markdown";
    }

    return {
      path,
      format: statResult?.format === "md" ? "markdown" as const : "blocknote" as const,
      storedAs,
      readFormatHint,
      // File mtime (ms) — the "last updated" fallback for docs that predate
      // provenance tracking.
      updatedAt: statResult?.updatedAt,
      headings,
      blockCount,
      containsMermaid,
      richBlockTypes,
      archived: meta.docs[path]?.archived,
      provenance: meta.docs[path]?.provenance,
    };
  }));

  return docs.filter((doc) => includeArchived || !doc.archived);
}

export async function listDocsByPrefix(spaceId: string, prefix: string): Promise<string[]> {
  const sanitizedPrefix = sanitizeDocPath(prefix);
  return (await listDocs(spaceId)).filter(
    (path) => path === sanitizedPrefix || path.startsWith(`${sanitizedPrefix}/`)
  );
}

export interface DocReadResult {
  data: unknown[] | string | null;
  format: "blocknote" | "markdown" | null;
  storedAs: DocFileFormat | null;
  error: string | null;
}

export interface DocSourceRevision {
  relativePath: string;
  size: number;
  sha256: string;
}

export interface DocSourceSnapshot {
  result: DocReadResult;
  revision?: DocSourceRevision;
  /** Exact authored bytes parsed into result. */
  bytes?: Uint8Array;
}

function sameDocSourceRevision(
  left: DocSourceRevision | undefined,
  right: DocSourceRevision | undefined
): boolean {
  return Boolean(
    left &&
      right &&
      left.relativePath === right.relativePath &&
      left.size === right.size &&
      left.sha256 === right.sha256
  );
}

async function docSourceRevisionIsCurrent(
  spaceId: string,
  docPath: string,
  expected: DocSourceRevision
): Promise<boolean> {
  const current = await readDocSourceSnapshot(spaceId, docPath);
  return sameDocSourceRevision(current.revision, expected);
}

/** Read and parse one exact set of source bytes for derived operations. */
export async function readDocSourceSnapshot(
  spaceId: string,
  docPath: string
): Promise<DocSourceSnapshot> {
  const resolved = resolveDocFile(spaceId, docPath);
  if (!resolved) {
    return {
      result: {
        data: null,
        format: null,
        storedAs: null,
        error: `Doc not found: ${docPath}`,
      },
    };
  }

  try {
    const bytes = await readFile(resolved.path);
    const revision = {
      relativePath: relative(spaceDir(spaceId), resolved.path)
        .split(sep)
        .join("/"),
      size: bytes.byteLength,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
    const content = bytes.toString("utf8");
    if (resolved.format === "md") {
      return {
        result: {
          data: content,
          format: "markdown",
          storedAs: "md",
          error: null,
        },
        revision,
        bytes: new Uint8Array(bytes),
      };
    }

    const blocks = JSON.parse(content);
    if (!Array.isArray(blocks)) {
      return {
        result: {
          data: null,
          format: null,
          storedAs: "json",
          error: "Invalid document format: expected array",
        },
        revision,
        bytes: new Uint8Array(bytes),
      };
    }
    return {
      result: {
        data: blocks,
        format: "blocknote",
        storedAs: "json",
        error: null,
      },
      revision,
      bytes: new Uint8Array(bytes),
    };
  } catch (err) {
    return {
      result: {
        data: null,
        format: null,
        storedAs: resolved.format,
        error: `Failed to read doc: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    };
  }
}

/**
 * Read a doc from disk. Returns raw content and format metadata.
 * .json files return BlockNote block array.
 * .md files return markdown string.
 */
export async function readDoc(
  spaceId: string,
  docPath: string
): Promise<DocReadResult> {
  return (await readDocSourceSnapshot(spaceId, docPath)).result;
}

export async function listDocVersions(
  spaceId: string,
  docPath: string,
  opts?: { checkpointsOnly?: boolean }
): Promise<DocVersionEntry[]> {
  const {
    listLegacyDocVersionsV2,
    usesDocumentVersionStoreV2,
  } = await import("./document-version-compatibility-v2.ts");
  if (await usesDocumentVersionStoreV2()) {
    return (await listLegacyDocVersionsV2(
      spaceId,
      docPath,
      opts
    )) as DocVersionEntry[];
  }
  return (await listVersionEntries(spaceId, "docs", docPath, opts)) as DocVersionEntry[];
}

export async function getDocVersion(
  spaceId: string,
  docPath: string,
  versionId: string
): Promise<DocVersionSnapshot | null> {
  const {
    readLegacyDocVersionV2,
    usesDocumentVersionStoreV2,
  } = await import("./document-version-compatibility-v2.ts");
  if (await usesDocumentVersionStoreV2()) {
    return (await readLegacyDocVersionV2(
      spaceId,
      docPath,
      versionId
    )) as DocVersionSnapshot | null;
  }
  return readVersionSnapshot<DocVersionSnapshot>(spaceId, "docs", docPath, versionId);
}

export async function createManualDocCheckpoint(
  spaceId: string,
  docPath: string,
  label?: string,
  updatedBy = "user"
): Promise<DocProvenance | undefined> {
  return withDocPathLock(spaceId, async () => {
    const snapshot = await readDocSourceSnapshot(spaceId, docPath);
    const current = snapshot.result;
    if (current.error || current.data === null) return undefined;
    const category = sourceCategory("manual-checkpoint", updatedBy);
    return recordDocVersion(spaceId, docPath, current, current, {
      updatedBy,
      source: "manual-checkpoint",
      reason: label || "Manual checkpoint",
    }, {
      force: true,
      operation: "checkpoint",
      checkpoint: {
        meaningful: true,
        kind: "manual",
        label: label || "Manual Checkpoint",
        sourceCategory: category === "system" ? "human" : category,
      },
      sourceBytes: snapshot.bytes
        ? { before: snapshot.bytes, after: snapshot.bytes }
        : undefined,
    });
  });
}

export async function createDocReviewCheckpoint(
  spaceId: string,
  docPath: string,
  reviewedBy = "user"
): Promise<DocProvenance | undefined> {
  return withDocPathLock(spaceId, async () => {
    const snapshot = await readDocSourceSnapshot(spaceId, docPath);
    const current = snapshot.result;
    if (current.error || current.data === null) return undefined;
    return recordDocVersion(spaceId, docPath, current, current, {
      updatedBy: reviewedBy,
      source: "manual-checkpoint",
      reason: "Reviewed",
    }, {
      force: true,
      operation: "checkpoint",
      checkpoint: {
        meaningful: true,
        kind: "review",
        label: "Reviewed",
        sourceCategory: "human",
      },
      sourceBytes: snapshot.bytes
        ? { before: snapshot.bytes, after: snapshot.bytes }
        : undefined,
    });
  });
}

export interface DocWriteOptions {
  /** Force overwrite even if it would lose rich formatting */
  force?: boolean;
  updatedBy?: string;
  source?: string;
  reason?: string;
  checkpointLabel?: string;
  checkpoint?: boolean;
  mermaidValidation?: "strict" | "allow-invalid";
  repairEscapedMermaidFences?: boolean;
  /** Internal staging writes can defer history until their space is published. */
  recordVersion?: boolean;
  /** Require a derived format target to still match its source bytes. */
  sourceRevision?: DocSourceRevision;
  /** Managed product writes opt into durable identity admission. */
  managedIdentity?: boolean;
}

type DocWriteTransactionOptions = DocWriteOptions & {
  /** Stable identity reserved by common namespace admission for a new source. */
  versionDocumentId?: DocumentId;
};

export interface DocWriteResult {
  ok: boolean;
  storedAs: DocFileFormat;
  error?: string;
  errorCode?: "NOT_FOUND";
  lossyFields?: string[];
  repairs?: import("@worktable/types").MermaidDocumentRepair[];
}

const formatFenceRequired = Symbol("format-fence-required");

type DocToMarkdownOptions = Pick<
  DocWriteOptions,
  "updatedBy" | "source" | "reason" | "managedIdentity"
> & {
  /** Recheck cross-file preservation constraints while the doc lock is held. */
  validateBeforeCommit?: (blocks: unknown[]) => Promise<boolean>;
  /** Complete format-dependent state changes before queued doc writes resume. */
  onConverted?: () => Promise<void>;
};

/**
 * Replace a BlockNote-backed doc with its Markdown representation.
 *
 * This is deliberately separate from `writeDoc`: ordinary Markdown writes to
 * an existing JSON doc preserve JSON storage so agents cannot silently change
 * the browser editing mode. The explicit product conversion is the only path
 * that changes a safe rich doc back to a `.md` file.
 */
export async function convertDocToMarkdownStorage(
  spaceId: string,
  docPath: string,
  options?: DocToMarkdownOptions
): Promise<DocWriteResult> {
  const pathError = options?.managedIdentity
    ? managedDocPathError(docPath)
    : null;
  if (pathError) {
    return {
      ok: false,
      storedAs: resolveDocFile(spaceId, docPath)?.format ?? "json",
      error: pathError,
    };
  }

  const convert = async (): Promise<DocWriteResult> => {
    const sanitizedDocPath = sanitizeDocPath(docPath);
    const jsonPath = docFilePathJson(spaceId, sanitizedDocPath);
    const mdPath = docFilePathMd(spaceId, sanitizedDocPath);
    for (const path of [jsonPath, mdPath]) suppressPath(path);

    try {
      const aliasError = await docAliasReservationError(spaceId, sanitizedDocPath);
      if (aliasError) {
        return { ok: false, storedAs: "json", error: aliasError };
      }

      const resolved = resolveDocFile(spaceId, sanitizedDocPath);
      if (!resolved) {
        return {
          ok: false,
          storedAs: "json",
          error: `Doc not found: ${sanitizedDocPath}`,
          errorCode: "NOT_FOUND",
        };
      }
      if (resolved.format !== "json") {
        return {
          ok: false,
          storedAs: resolved.format,
          error: "Doc is already stored as Markdown",
        };
      }

      const snapshot = await readDocSourceSnapshot(
        spaceId,
        sanitizedDocPath
      );
      const before = snapshot.result;
      if (before.error || !Array.isArray(before.data) || !snapshot.revision) {
        return {
          ok: false,
          storedAs: "json",
          error: before.error ?? "Invalid rich doc content",
        };
      }
      const sourceBlocks = before.data;

      const conversion = await prepareMarkdownStorageConversion(sourceBlocks);
      if (!conversion.safe) {
        return {
          ok: false,
          storedAs: "json",
          error: "Doc contains formatting that Markdown cannot preserve",
          lossyFields: conversion.lossyFields,
        };
      }
      if (
        options?.validateBeforeCommit &&
        !(await options.validateBeforeCommit(sourceBlocks))
      ) {
        return {
          ok: false,
          storedAs: "json",
          error: "Doc metadata cannot be preserved in Markdown",
          lossyFields: ["annotation-anchor"],
        };
      }

      const after: DocReadResult = {
        data: conversion.markdown,
        format: "markdown",
        storedAs: "md",
        error: null,
      };
      const recordConversion = async (): Promise<void> => {
        try {
          await recordDocVersion(spaceId, sanitizedDocPath, before, after, {
            updatedBy: options?.updatedBy ?? "unknown",
            source: options?.source ?? "unknown",
            reason: options?.reason,
          }, {
            sourceBytes: {
              before: snapshot.bytes!,
              after: Buffer.from(conversion.markdown, "utf8"),
            },
          });
        } catch (error) {
          console.error(
            `[store] failed to record Markdown conversion history for ${spaceId}/${sanitizedDocPath}:`,
            error
          );
        }
      };

      const { transitionDurableDocumentFormatLocked } =
        await import("./document-lifecycle-journal.ts");
      const durable = await transitionDurableDocumentFormatLocked({
        spaceId,
        docPath: sanitizedDocPath,
        format: {
          id: "worktable.markdown",
          sourceVersion: 1,
        },
        bytes: Buffer.from(conversion.markdown, "utf8"),
        sourceRevision: snapshot.revision,
        rotateCollaborationCache: true,
        context: {
          updatedBy: options?.updatedBy ?? "unknown",
          source: options?.source ?? "unknown",
          ...(options?.reason ? { reason: options.reason } : {}),
        },
        validateBeforeCommit: options?.validateBeforeCommit
          ? () => options.validateBeforeCommit!(before.data as unknown[])
          : undefined,
        onCommitted: recordConversion,
      });
      if (durable.handled) {
        if (durable.error) {
          const metadataConflict = durable.error.includes(
            "metadata cannot be preserved"
          );
          return {
            ok: false,
            storedAs: "json",
            error: durable.error,
            ...(metadataConflict ? { lossyFields: ["annotation-anchor"] } : {}),
          };
        }
        notifyDocContentChanged(spaceId, sanitizedDocPath);
        try {
          await options?.onConverted?.();
        } catch (error) {
          console.error(
            `[store] failed to finalize Markdown conversion for ${spaceId}/${sanitizedDocPath}:`,
            error
          );
        }
        return { ok: true, storedAs: "md" };
      }

      if (
        !(await docSourceRevisionIsCurrent(
          spaceId,
          sanitizedDocPath,
          snapshot.revision
        ))
      ) {
        return {
          ok: false,
          storedAs: "json",
          error: "Document changed while it was being converted. Try again.",
        };
      }

      await mkdir(dirname(mdPath), { recursive: true });
      await withWriteLock(mdPath, () =>
        atomicWriteText(mdPath, conversion.markdown)
      );
      try {
        await unlink(jsonPath);
      } catch (error) {
        await unlink(mdPath).catch(() => undefined);
        return {
          ok: false,
          storedAs: "json",
          error: `Could not replace rich doc storage: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      try {
        await rotateDocCollaborationCacheEpoch(spaceId, sanitizedDocPath);
      } catch (error) {
        await withWriteLock(jsonPath, () => atomicWrite(jsonPath, before.data));
        await unlink(mdPath).catch(() => undefined);
        return {
          ok: false,
          storedAs: "json",
          error: `Could not reset the collaboration cache: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      await recordConversion();
      notifyDocContentChanged(spaceId, sanitizedDocPath);
      try {
        await options?.onConverted?.();
      } catch (error) {
        // Portable storage is already canonical and the browser cache identity
        // has rotated. Derived cleanup must not turn a committed save into a
        // false failure that cannot succeed on retry.
        console.error(
          `[store] failed to finalize Markdown conversion for ${spaceId}/${sanitizedDocPath}:`,
          error
        );
      }
      return { ok: true, storedAs: "md" };
    } finally {
      for (const path of [jsonPath, mdPath]) {
        prepareSuppressedDocReplay(path, { spaceId, docPath: sanitizedDocPath });
        unsuppressPath(path);
      }
    }
  };

  if (options?.managedIdentity) {
    const {
      admitManagedDocumentWrite,
      ManagedDocumentAdmissionError,
    } = await import("./document-identity-admission.ts");
    try {
      return await admitManagedDocumentWrite({
        spaceId,
        path: docPath,
        family: "doc",
        transaction: convert,
        committedClaim: (result) =>
          result.ok
            ? {
                format: {
                  id: BUILTIN_DOCUMENT_FORMATS.markdown,
                  sourceVersion: 1,
                },
                source: {
                  kind: "file",
                  relativePath: `docs/${sanitizeDocPath(docPath)}.md`,
                },
              }
            : null,
      });
    } catch (error) {
      if (error instanceof ManagedDocumentAdmissionError) {
        return {
          ok: false,
          storedAs:
            resolveDocFile(spaceId, sanitizeDocPath(docPath))?.format ?? "json",
          error: error.message,
        };
      }
      throw error;
    }
  }
  return withDocPathLock(spaceId, convert);
}

/**
 * Write a document. Content can be:
 * - string: treated as markdown, stored as .md (or converted to blocks if .json exists)
 * - array: treated as BlockNote blocks, stored as .json
 */
export async function writeDoc(
  spaceId: string,
  docPath: string,
  content: unknown[] | string,
  options?: DocWriteOptions
): Promise<DocWriteResult> {
  const sanitizedDocPath = sanitizeDocPath(docPath);
  const pathError = options?.managedIdentity
    ? managedDocPathError(docPath)
    : null;
  if (pathError) {
    return {
      ok: false,
      storedAs:
        resolveDocFile(spaceId, sanitizedDocPath)?.format ??
        (typeof content === "string" ? "md" : "json"),
      error: pathError,
    };
  }

  const writeLocked = async (
    formatFenced: boolean
  ): Promise<DocWriteResult | typeof formatFenceRequired> => {
    const write = (versionDocumentId?: DocumentId) =>
      writeDocTransaction(
        spaceId,
        docPath,
        content,
        versionDocumentId ? { ...options, versionDocumentId } : options,
        formatFenced
      );

    // Managed writes admit through the format-neutral namespace while holding
    // the same lock as exact rename. Low-level filesystem and fixture writes
    // retain their historical opt-in behavior.
    if (options?.managedIdentity) {
      const {
        admitManagedDocumentWrite,
        ManagedDocumentAdmissionError,
      } = await import("./document-identity-admission.ts");
      try {
        return await admitManagedDocumentWrite({
          spaceId,
          path: docPath,
          family: "doc",
          transaction: (_path, admission) => write(admission?.documentId),
          newDocumentClaim: () => ({
            format: {
              id:
                typeof content === "string"
                  ? BUILTIN_DOCUMENT_FORMATS.markdown
                  : BUILTIN_DOCUMENT_FORMATS.richText,
              sourceVersion: 1,
            },
            source: {
              kind: "file",
              relativePath: `docs/${sanitizedDocPath}.${
                typeof content === "string" ? "md" : "json"
              }`,
            },
          }),
          committedClaim: (result) =>
            result !== formatFenceRequired && result.ok
              ? {
                  format: {
                    id:
                      result.storedAs === "md"
                        ? BUILTIN_DOCUMENT_FORMATS.markdown
                        : BUILTIN_DOCUMENT_FORMATS.richText,
                    sourceVersion: 1,
                  },
                  source: {
                    kind: "file",
                    relativePath: `docs/${sanitizedDocPath}.${result.storedAs}`,
                  },
                }
              : null,
        });
      } catch (error) {
        if (error instanceof ManagedDocumentAdmissionError) {
          return {
            ok: false,
            storedAs:
              resolveDocFile(spaceId, sanitizedDocPath)?.format ??
              (typeof content === "string" ? "md" : "json"),
            error: error.message,
          };
        }
        throw error;
      }
    }

    // Writes share the namespace lock with managed renames. This prevents both
    // creation after a move and an update racing the source file while it moves.
    return withDocPathLock(spaceId, () => write());
  };

  const result = await writeLocked(false);
  if (result !== formatFenceRequired) return result;
  const { DocFormatTransitionConflictError, yjsManager } =
    await import("./yjs-manager.ts");
  try {
    return await yjsManager.withDocFormatTransition(
      spaceId,
      sanitizedDocPath,
      async () => {
        const fencedResult = await writeLocked(true);
        if (fencedResult === formatFenceRequired) {
          throw new Error("document format transition fence was lost");
        }
        return fencedResult;
      }
    );
  } catch (error) {
    if (error instanceof DocFormatTransitionConflictError) {
      return {
        ok: false,
        storedAs: "md",
        error: "Document is already changing format. Try again.",
      };
    }
    throw error;
  }
}

async function writeDocTransaction(
  spaceId: string,
  docPath: string,
  content: unknown[] | string,
  options: DocWriteTransactionOptions | undefined,
  formatFenced: boolean
): Promise<DocWriteResult | typeof formatFenceRequired> {
  const sanitizedDocPath = sanitizeDocPath(docPath);
  // A Markdown-to-rich transition must freeze collaboration before the
  // namespace lock is held: draining a live room may itself persist via
  // writeDoc and therefore needs to acquire this lock.
  if (
    Array.isArray(content) &&
    resolveDocFile(spaceId, sanitizedDocPath)?.format === "md" &&
    !formatFenced
  ) {
    return formatFenceRequired;
  }

  // Suppress both possible storage paths for the complete canonical
  // write+provenance transaction. Callers cannot know which extension a write
  // will choose (or replace), and a watcher echo before provenance commits can
  // otherwise be misclassified as an external edit.
  const watchedPaths = [
    docFilePathMd(spaceId, sanitizedDocPath),
    docFilePathJson(spaceId, sanitizedDocPath),
  ];
  for (const path of watchedPaths) suppressPath(path);
  try {
    return await writeDocUnlocked(spaceId, docPath, content, options);
  } finally {
    for (const path of watchedPaths) {
      prepareSuppressedDocReplay(path, {
        spaceId,
        docPath: sanitizedDocPath,
      });
      unsuppressPath(path);
    }
  }
}

export type DocVersionRestoreResult =
  | {
      ok: true;
      updatedAt: number;
      provenance: DocProvenance | undefined;
    }
  | {
      ok: false;
      error: string;
      errorCode: "NOT_FOUND" | "CONFLICT";
    };

export interface RestoreDocVersionOptions {
  expectedSourceRevision?: DocSourceRevision;
  updatedBy?: string;
  source?: string;
  reason?: string;
  checkpointLabel?: string;
}

interface DocGenerationOwner {
  documentId: string;
  identity: "durable" | "provisional";
  path: string;
  format: { id: string; sourceVersion: number };
  source: { kind: "file" | "bundle"; relativePath: string };
}

type DocGenerationOwnerResult =
  | { ok: true; owner: DocGenerationOwner }
  | Extract<DocVersionRestoreResult, { ok: false }>;

/** Resolve one exact legacy Doc owner while the document namespace is held. */
async function resolveDocGenerationOwnerLocked(
  spaceId: string,
  requestedPath: string
): Promise<DocGenerationOwnerResult> {
  const analysis = analyzeDocumentPath(requestedPath);
  if (!analysis.safe || !analysis.comparisonKey) {
    return {
      ok: false,
      error: `Document path is not canonical: ${requestedPath}`,
      errorCode: "CONFLICT",
    };
  }
  // This stays dynamic because document inventory write locking depends on
  // store.ts. Restore invokes catalog discovery only after this module has
  // initialized, avoiding a store -> catalog -> inventory -> store cycle.
  const { buildDocumentCatalog } = await import("./document-catalog.ts");
  const { getWorkspaceRoot } = await import("./workspace.ts");
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
  });
  if (
    catalog.inventoryDiagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    return {
      ok: false,
      error:
        "Document versions cannot be restored until this Space's document conflicts are resolved",
      errorCode: "CONFLICT",
    };
  }
  const entry = catalog.entries.find((candidate) => {
    const key =
      candidate.kind === "conflict"
        ? candidate.pathKey
        : analyzeDocumentPath(candidate.descriptor.path).comparisonKey;
    return key === analysis.comparisonKey;
  });
  if (!entry) {
    return {
      ok: false,
      error: "Document not found",
      errorCode: "NOT_FOUND",
    };
  }
  if (entry.kind === "conflict") {
    return {
      ok: false,
      error: "This document path is ambiguous and cannot be restored",
      errorCode: "CONFLICT",
    };
  }
  if (entry.descriptor.path !== requestedPath) {
    return {
      ok: false,
      error: `Use the document's exact current path before restoring it: ${entry.descriptor.path}`,
      errorCode: "CONFLICT",
    };
  }
  if (
    entry.handle.storageProfile !==
      DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile ||
    entry.handle.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    return {
      ok: false,
      error: "This document cannot be safely restored",
      errorCode: "CONFLICT",
    };
  }
  return {
    ok: true,
    owner: {
      documentId: entry.handle.documentId,
      identity: entry.handle.identity,
      path: entry.descriptor.path,
      format: entry.descriptor.format,
      source: entry.handle.source,
    },
  };
}

function sameDocGenerationOwner(
  expected: DocGenerationOwner,
  current: DocGenerationOwner
): boolean {
  return (
    current.documentId === expected.documentId &&
    current.identity === expected.identity &&
    current.path === expected.path &&
    current.format.id === expected.format.id &&
    current.format.sourceVersion === expected.format.sourceVersion &&
    current.source.kind === expected.source.kind &&
    current.source.relativePath === expected.source.relativePath
  );
}

/** Replace one active Doc with a retained version as one generation change. */
export async function restoreDocVersion(
  spaceId: string,
  docPath: string,
  versionId: string,
  options: RestoreDocVersionOptions = {}
): Promise<DocVersionRestoreResult> {
  const pathError = generationMutationPathError(docPath);
  if (pathError) {
    return { ok: false, error: pathError, errorCode: "CONFLICT" };
  }
  const ownerResult = await withDocPathLock(spaceId, () =>
    resolveDocGenerationOwnerLocked(spaceId, docPath)
  );
  if (!ownerResult.ok) return ownerResult;
  const owner = ownerResult.owner;
  return withDocGenerationLock(spaceId, owner.path, async () => {
    // Avoid disrupting an active editor for an obviously stale URL. The
    // authoritative source and version checks repeat after the Yjs drain while
    // the namespace is held.
    if (!resolveDocFile(spaceId, owner.path)) {
      return {
        ok: false,
        error: "Document not found",
        errorCode: "NOT_FOUND",
      };
    }
    const candidateVersion = await withVersionKeyLock(
      spaceId,
      "docs",
      owner.path,
      () => getDocVersion(spaceId, owner.path, versionId)
    );
    if (!candidateVersion) {
      return {
        ok: false,
        error: "Version not found",
        errorCode: "NOT_FOUND",
      };
    }

    const { DocFormatTransitionConflictError, yjsManager } =
      await import("./yjs-manager.ts");
    const { didDocumentLifecyclePreserveGeneration } =
      await import("./document-lifecycle-journal.ts");
    try {
      return await yjsManager.withDocGenerationTransition(
        spaceId,
        owner.path,
        () =>
          withDocPathLock(spaceId, async () => {
            const currentOwner = await resolveDocGenerationOwnerLocked(
              spaceId,
              docPath
            );
            if (!currentOwner.ok) return currentOwner;
            if (!sameDocGenerationOwner(owner, currentOwner.owner)) {
              return {
                ok: false,
                error: "Document changed while restoring",
                errorCode: "CONFLICT",
              };
            }
            const version = await withVersionKeyLock(
              spaceId,
              "docs",
              owner.path,
              () => getDocVersion(spaceId, owner.path, versionId)
            );
            if (!version) {
              return {
                ok: false,
                error: "Version not found",
                errorCode: "NOT_FOUND",
              };
            }
            const activeSource = await readDocSourceSnapshot(
              spaceId,
              owner.path
            );
            if (
              activeSource.result.error ||
              activeSource.result.data === null ||
              !activeSource.revision
            ) {
              return {
                ok: false,
                error:
                  activeSource.result.error ?? "Document changed while restoring",
                errorCode: "CONFLICT",
              };
            }
            if (
              options.expectedSourceRevision &&
              !sameDocSourceRevision(
                activeSource.revision,
                options.expectedSourceRevision
              )
            ) {
              return {
                ok: false,
                error: "Document changed while restoring",
                errorCode: "CONFLICT",
              };
            }

            const content = version.after.content;
            const writeResult = await writeDocTransaction(
              spaceId,
              owner.path,
              Array.isArray(content) ? content : String(content ?? ""),
              {
                updatedBy: options.updatedBy ?? "user",
                source: options.source ?? "version-restore",
                reason: options.reason ?? `Restored version ${versionId}`,
                checkpoint: true,
                checkpointLabel:
                  options.checkpointLabel ?? "Restored Version",
                sourceRevision: activeSource.revision,
              },
              true
            );
            if (writeResult === formatFenceRequired) {
              throw new Error("document generation fence was lost");
            }
            if (!writeResult.ok) {
              return {
                ok: false,
                error: writeResult.error ?? "Write failed",
                errorCode: "CONFLICT",
              };
            }
            const statResult = await docStat(spaceId, owner.path);
            return {
              ok: true,
              provenance: await getDocProvenance(spaceId, owner.path),
              updatedAt: statResult?.updatedAt ?? Date.now(),
            };
          }),
        (result) => result.ok,
        didDocumentLifecyclePreserveGeneration
      );
    } catch (error) {
      if (error instanceof DocFormatTransitionConflictError) {
        return {
          ok: false,
          error: "Document is already changing. Try again.",
          errorCode: "CONFLICT",
        };
      }
      throw error;
    }
  });
}

async function writeDocUnlocked(
  spaceId: string,
  docPath: string,
  content: unknown[] | string,
  options: DocWriteTransactionOptions | undefined
): Promise<DocWriteResult> {
  const isMarkdownContent = typeof content === "string";
  const sanitizedDocPath = sanitizeDocPath(docPath);
  const resolved = resolveDocFile(spaceId, sanitizedDocPath);
  // Reservation is a namespace invariant, not merely a creation guard. An
  // external sync may recreate a file at an old path; API/MCP writes must not
  // update that hidden file while reads still resolve the alias elsewhere.
  const aliasError = await docAliasReservationError(spaceId, sanitizedDocPath);
  if (aliasError) {
    return {
      ok: false,
      storedAs: resolved?.format ?? (isMarkdownContent ? "md" : "json"),
      error: aliasError,
    };
  }
  const sourceSnapshot = resolved
    ? await readDocSourceSnapshot(spaceId, sanitizedDocPath)
    : null;
  const before = sourceSnapshot?.result ?? null;
  if (
    options?.sourceRevision &&
    !sameDocSourceRevision(sourceSnapshot?.revision, options.sourceRevision)
  ) {
    return {
      ok: false,
      storedAs: resolved?.format ?? (isMarkdownContent ? "md" : "json"),
      error: "Document changed while it was being updated. Try again.",
    };
  }
  const sourceChanged = async (): Promise<boolean> =>
    Boolean(
      options?.sourceRevision &&
        !(await docSourceRevisionIsCurrent(
          spaceId,
          sanitizedDocPath,
          options.sourceRevision
        ))
    );
  const staleSourceResult = (storedAs: DocFileFormat): DocWriteResult => ({
    ok: false,
    storedAs,
    error: "Document changed while it was being updated. Try again.",
  });
  const { prepareDocumentContent } = await import("./mermaid-document.ts");
  const prepared = await prepareDocumentContent(content, {
    validation: options?.mermaidValidation ?? "strict",
    repairEscapedFences: options?.repairEscapedMermaidFences,
  });
  content = prepared.content as unknown[] | string;
  const repairs = prepared.repairs;

  const finalizeWrite = async (
    storedAs: DocFileFormat,
    writtenContent: unknown[] | string
  ): Promise<DocWriteResult> => {
    const after: DocReadResult = {
      data: writtenContent,
      format: storedAs === "md" ? "markdown" : "blocknote",
      storedAs,
      error: null,
    };
    if (options?.recordVersion !== false) {
      await recordDocVersion(spaceId, docPath, before, after, {
        updatedBy: options?.updatedBy ?? "unknown",
        source: options?.source ?? "unknown",
        reason: options?.reason,
        checkpoint: options?.checkpoint,
        checkpointLabel: options?.checkpointLabel,
      }, {
        ...(options?.versionDocumentId
          ? { documentId: options.versionDocumentId }
          : {}),
        sourceBytes: {
          ...(sourceSnapshot?.bytes
            ? { before: sourceSnapshot.bytes }
            : {}),
          after:
            storedAs === "md"
              ? Buffer.from(writtenContent as string, "utf8")
              : Buffer.from(JSON.stringify(writtenContent, null, 2), "utf8"),
        },
      });
    }
    notifyDocContentChanged(spaceId, docPath);
    return { ok: true, storedAs, repairs };
  };

  if (isMarkdownContent) {
    // Agent is writing markdown
    if (resolved?.format === "json") {
      // Existing .json file: need to convert markdown to blocks and overwrite
      // But first check if the existing doc has lossy features
      const { isMarkdownSafe, markdownToBlocks } = await import("./markdown.ts");

      const existingContent = await Bun.file(resolved.path).text();
      const existingBlocks = JSON.parse(existingContent);
      const safety = isMarkdownSafe(existingBlocks);

      if (!safety.safe && !options?.force) {
        return {
          ok: false,
          storedAs: "json",
          error: `Document contains rich formatting (${safety.lossyFields.join(", ")}) that would be lost. Use force=true to overwrite, or use worktable_docs_write action patch for surgical edits.`,
          lossyFields: safety.lossyFields,
        };
      }

      // Convert markdown to blocks and write as .json
      const blocks = await markdownToBlocks(content as string);
      await mkdir(dirname(resolved.path), { recursive: true });
      const preparedBlocks = await prepareBlocksCanonical(
        blocks,
        Array.isArray(before?.data) ? before.data : undefined
      );
      // Semantic no-op: nothing was written, so record no version and emit no
      // change event — an idempotent rewrite must not alter provenance.
      if (preparedBlocks.skipped) {
        if (await sourceChanged()) return staleSourceResult("json");
        return { ok: true, storedAs: "json", repairs };
      }
      let staleSource = false;
      const markdownPath = docFilePathMd(spaceId, docPath);
      await withWriteLock(resolved.path, async () => {
        staleSource = !(await atomicWriteAfterValidation(
          resolved.path,
          preparedBlocks.content,
          async () => !(await sourceChanged()) && !existsSync(markdownPath)
        ));
      });
      if (staleSource) return staleSourceResult("json");
      return finalizeWrite("json", preparedBlocks.content);
    }

    // No existing .json: write as .md
    const mdPath = docFilePathMd(spaceId, docPath);
    await mkdir(dirname(mdPath), { recursive: true });
    let staleSource = false;
    await withWriteLock(mdPath, async () => {
      const tmpPath = `${mdPath}.tmp`;
      await writeFile(tmpPath, content as string, "utf8");
      if (await sourceChanged()) {
        staleSource = true;
        await unlink(tmpPath).catch(() => undefined);
        return;
      }
      await rename(tmpPath, mdPath);
    });
    if (staleSource) return staleSourceResult("md");
    return finalizeWrite("md", content as string);
  }

  // BlockNote blocks: always write as .json
  const jsonPath = docFilePathJson(spaceId, docPath);
  await mkdir(dirname(jsonPath), { recursive: true });
  const preparedBlocks = await prepareBlocksCanonical(
    content as unknown[],
    Array.isArray(before?.data) ? before.data : undefined
  );

  if (resolved?.format === "md") {
    const after: DocReadResult = {
      data: preparedBlocks.content,
      format: "blocknote",
      storedAs: "json",
      error: null,
    };
    const { transitionDurableDocumentFormatLocked } =
      await import("./document-lifecycle-journal.ts");
    const durable = await transitionDurableDocumentFormatLocked({
      spaceId,
      docPath: sanitizedDocPath,
      format: {
        id: "worktable.rich-text",
        sourceVersion: 1,
      },
      bytes: Buffer.from(JSON.stringify(preparedBlocks.content, null, 2)),
      sourceRevision: sourceSnapshot?.revision,
      context: {
        updatedBy: options?.updatedBy ?? "unknown",
        source: options?.source ?? "unknown",
        ...(options?.reason ? { reason: options.reason } : {}),
      },
      onCommitted: async () => {
        if (options?.recordVersion === false) return;
        await recordDocVersion(spaceId, docPath, before, after, {
          updatedBy: options?.updatedBy ?? "unknown",
          source: options?.source ?? "unknown",
          reason: options?.reason,
          checkpoint: options?.checkpoint,
          checkpointLabel: options?.checkpointLabel,
        }, {
          ...(options?.versionDocumentId
            ? { documentId: options.versionDocumentId }
            : {}),
          sourceBytes: {
            ...(sourceSnapshot?.bytes
              ? { before: sourceSnapshot.bytes }
              : {}),
            after: Buffer.from(
              JSON.stringify(preparedBlocks.content, null, 2),
              "utf8"
            ),
          },
        });
      },
    });
    if (durable.handled) {
      if (durable.error) {
        return { ok: false, storedAs: "md", error: durable.error };
      }
      notifyDocContentChanged(spaceId, docPath);
      return { ok: true, storedAs: "json", repairs };
    }
    if (
      sourceSnapshot?.revision &&
      !(await docSourceRevisionIsCurrent(
        spaceId,
        sanitizedDocPath,
        sourceSnapshot.revision
      ))
    ) {
      return {
        ok: false,
        storedAs: "md",
        error: "Document changed while it was being updated. Try again.",
      };
    }
  }

  // A Markdown source may be removed only for the verified provisional
  // Markdown-to-rich transition above. For every other write, a Markdown
  // endpoint here is a competing document and must be preserved.
  const mdPath = docFilePathMd(spaceId, docPath);
  if (resolved?.format === "md") {
    await unlink(mdPath);
  }

  // Semantic no-op: nothing was written, so record no version and emit no
  // change event — an idempotent rewrite must not alter provenance.
  if (preparedBlocks.skipped) {
    if (
      (resolved?.format === "json" && (await sourceChanged())) ||
      (resolved?.format !== "md" && existsSync(mdPath))
    ) {
      return staleSourceResult("json");
    }
    return { ok: true, storedAs: "json", repairs };
  }
  let staleSource = false;
  await withWriteLock(jsonPath, async () => {
    staleSource = !(await atomicWriteAfterValidation(
      jsonPath,
      preparedBlocks.content,
      async () =>
        !(
          (resolved?.format === "json" && (await sourceChanged())) ||
          (resolved?.format !== "md" && existsSync(mdPath))
        )
    ));
  });
  if (staleSource) return staleSourceResult("json");
  return finalizeWrite("json", preparedBlocks.content);
}

type DeleteDocResult = { error: string | null; notFound?: true };

interface DeleteDocObservation {
  sourceInode: string | null;
  documentIds: string[];
}

interface InFlightDocDelete {
  sourceInode: string | null;
  documentIds: Set<string>;
  promise: Promise<DeleteDocResult>;
}

const inFlightDocDeletes = new Map<string, Set<InFlightDocDelete>>();
const nextDocDeleteObservationWaiters = new Map<
  string,
  Set<() => void>
>();

/**
 * Exact observation barrier for concurrent-delete tests. It does not expose
 * or alter coalescing state; callers can use it only to know that the next
 * request has finished identifying the generation it observed.
 */
export function whenNextDocDeleteObservationForTests(
  spaceId: string,
  docPath: string
): Promise<void> {
  const key = `${spaceId}\0${sanitizeDocPath(docPath)}`;
  return new Promise((resolve) => {
    const waiters = nextDocDeleteObservationWaiters.get(key) ?? new Set();
    waiters.add(resolve);
    nextDocDeleteObservationWaiters.set(key, waiters);
  });
}

function reportDocDeleteObservation(spaceId: string, docPath: string): void {
  const key = `${spaceId}\0${docPath}`;
  const waiters = nextDocDeleteObservationWaiters.get(key);
  if (!waiters) return;
  nextDocDeleteObservationWaiters.delete(key);
  for (const resolve of waiters) resolve();
}

async function observedDocDeleteGeneration(
  spaceId: string,
  docPath: string
): Promise<DeleteDocObservation> {
  const { readDocumentInventory } =
    await import("./document-inventory.ts");
  const inventory = await readDocumentInventory(spaceId);
  const documentIds = [...inventory.entries.values()]
    .filter((entry) => entry.path === docPath)
    .map((entry) => entry.documentId)
    .sort();
  const source = resolveDocFile(spaceId, docPath);
  if (source) {
    try {
      const info = lstatSync(source.path);
      if (info.isFile() && !info.isSymbolicLink()) {
        // Deletion moves this inode out of the canonical path. A source
        // recreated while the first request settles therefore receives a new
        // key and cannot inherit the retired generation's result.
        return {
          sourceInode: `${source.path}:${info.dev}:${info.ino}`,
          documentIds,
        };
      }
    } catch {
      // Admission will adjudicate the raced filesystem state under its lock.
    }
  }
  return { sourceInode: null, documentIds };
}

function sameObservedDeleteGeneration(
  pending: InFlightDocDelete,
  observed: DeleteDocObservation
): boolean {
  const sharesDocumentId = observed.documentIds.some((id) =>
    pending.documentIds.has(id)
  );
  if (observed.sourceInode) {
    return sharesDocumentId || pending.sourceInode === observed.sourceInode;
  }
  if (observed.documentIds.length > 0) return sharesDocumentId;
  // No canonical source and no durable identity means no later generation is
  // observable. It is safe to linearize this retry with the pending delete.
  return true;
}

async function deleteDocOnce(
  spaceId: string,
  docPath: string,
  pending: InFlightDocDelete
): Promise<DeleteDocResult> {
  const {
    admitManagedDocumentWrite,
    ManagedDocumentAdmissionError,
  } = await import("./document-identity-admission.ts");
  try {
    // Give a provisional source its stable identity before the Yjs generation
    // drain. If an external unlink lands during that drain, the exact-delete
    // journal can retire the now-missing generation instead of leaving its
    // path-keyed history available to a later recreation.
    await admitManagedDocumentWrite({
      spaceId,
      path: docPath,
      family: "doc",
      transaction: async () => undefined,
      committedClaim: () => null,
      intent: "delete",
    });
  } catch (error) {
    if (error instanceof ManagedDocumentAdmissionError) {
      return { error: error.message };
    }
    throw error;
  }
  // Publish the identity materialized by the preflight before waiting for the
  // generation transition. A retry that arrives during that wait must join
  // this generation even if its canonical source has already disappeared.
  const materialized = await observedDocDeleteGeneration(spaceId, docPath);
  for (const id of materialized.documentIds) {
    pending.documentIds.add(id);
  }
  return withDocGenerationLock(spaceId, docPath, async () => {
    const { DocFormatTransitionConflictError, yjsManager } =
      await import("./yjs-manager.ts")
    const { didDocumentLifecyclePreserveGeneration } =
      await import("./document-lifecycle-journal.ts")
    try {
      return await yjsManager.withDocGenerationTransition(
        spaceId,
        docPath,
        async () => {
          try {
            return await admitManagedDocumentWrite({
              spaceId,
              path: docPath,
              family: "doc",
              transaction: async () => {
                // Admission may have just materialized a provisional source.
                // Bind late retries to that same stable generation before the
                // lifecycle journal begins moving its source.
                const observed = await observedDocDeleteGeneration(
                  spaceId,
                  docPath
                );
                for (const id of observed.documentIds) {
                  pending.documentIds.add(id);
                }
                return deleteDocLocked(spaceId, docPath);
              },
              committedClaim: () => null,
              intent: "delete",
            })
          } catch (error) {
            if (error instanceof ManagedDocumentAdmissionError) {
              return { error: error.message }
            }
            throw error
          }
        },
        (result) => result.error === null,
        didDocumentLifecyclePreserveGeneration
      )
    } catch (error) {
      if (error instanceof DocFormatTransitionConflictError) {
        return {
          error: "Document is already changing. Try again.",
        }
      }
      throw error
    }
  })
}

async function deleteDocObserved(
  spaceId: string,
  docPath: string
): Promise<DeleteDocResult> {
  const pathError = generationMutationPathError(docPath)
  if (pathError) return { error: pathError }
  const sanitizedDocPath = sanitizeDocPath(docPath)
  const observed = await observedDocDeleteGeneration(
    spaceId,
    sanitizedDocPath
  )
  reportDocDeleteObservation(spaceId, sanitizedDocPath)
  const key = `${spaceId}\0${sanitizedDocPath}`
  const active = inFlightDocDeletes.get(key)
  const matching = active
    ? [...active].filter((pending) =>
        sameObservedDeleteGeneration(pending, observed)
      )
    : []
  const existing =
    observed.sourceInode || observed.documentIds.length > 0
      ? matching[0]
      : matching.at(-1)
  if (existing) return existing.promise

  const pending = {
    sourceInode: observed.sourceInode,
    documentIds: new Set(observed.documentIds),
  } as InFlightDocDelete
  pending.promise = deleteDocOnce(spaceId, sanitizedDocPath, pending)
  const pendingForPath = active ?? new Set<InFlightDocDelete>()
  pendingForPath.add(pending)
  inFlightDocDeletes.set(key, pendingForPath)
  try {
    return await pending.promise
  } finally {
    pendingForPath.delete(pending)
    if (
      pendingForPath.size === 0 &&
      inFlightDocDeletes.get(key) === pendingForPath
    ) {
      inFlightDocDeletes.delete(key)
    }
  }
}

export async function deleteDoc(
  spaceId: string,
  docPath: string
): Promise<DeleteDocResult> {
  try {
    return await deleteDocObserved(spaceId, docPath)
  } catch (error) {
    const { DocumentInventorySpaceNotFoundError } =
      await import("./document-inventory.ts")
    if (error instanceof DocumentInventorySpaceNotFoundError) {
      return { error: null, notFound: true }
    }
    throw error
  }
}

async function deleteDocLocked(
  spaceId: string,
  docPath: string
): Promise<{ error: string | null; notFound?: true }> {
  const sanitized = sanitizeDocPath(docPath);
  const { deleteDurableDocExactlyLocked } =
    await import("./document-lifecycle-journal.ts");
  const durable = await deleteDurableDocExactlyLocked(spaceId, sanitized);
  if (durable.error) return { error: durable.error };
  if (durable.handled) {
    notifyDocContentChanged(spaceId, sanitized);
    return { error: null };
  }

  const aliasError = await docAliasReservationError(spaceId, sanitized);
  if (aliasError) return { error: aliasError };
  if (resolveDocFile(spaceId, sanitized)) {
    return {
      error: "Document identity could not be prepared for safe deletion",
    };
  }
  return { error: null, notFound: true };
}

export async function docExists(spaceId: string, docPath: string): Promise<boolean> {
  return resolveDocFile(spaceId, docPath) !== null;
}

export async function docStat(
  spaceId: string,
  docPath: string
): Promise<{ updatedAt: number; format: DocFileFormat } | null> {
  const resolved = resolveDocFile(spaceId, docPath);
  if (!resolved) return null;
  try {
    const s = await stat(resolved.path);
    return { updatedAt: s.mtimeMs, format: resolved.format };
  } catch {
    return null;
  }
}

export async function renameDoc(
  spaceId: string,
  oldPath: string,
  newPath: string,
  opts?: {
    /** Internal compensation only: restore a move when alias persistence failed. */
    skipAliasChecks?: boolean;
  }
): Promise<{ error: string | null }> {
  const sanitizedOldPath = sanitizeDocPath(oldPath);
  const sanitizedNewPath = sanitizeDocPath(newPath);
  const resolved = resolveDocFile(spaceId, sanitizedOldPath);
  if (!resolved) {
    return { error: `Doc not found: ${sanitizedOldPath}` };
  }
  if (!opts?.skipAliasChecks) {
    const sourceAliasError = await docAliasReservationError(spaceId, sanitizedOldPath);
    if (sourceAliasError) return { error: sourceAliasError };
  }

  const newExists = resolveDocFile(spaceId, sanitizedNewPath);
  if (newExists) {
    return { error: `Target path already exists: ${sanitizedNewPath}` };
  }
  if (!opts?.skipAliasChecks) {
    const aliasError = await docAliasReservationError(spaceId, sanitizedNewPath);
    if (aliasError) return { error: aliasError };
  }

  // Preserve original format during rename
  const newFilePath = resolved.format === "md"
    ? docFilePathMd(spaceId, sanitizedNewPath)
    : docFilePathJson(spaceId, sanitizedNewPath);

  // Move the doc's version history (versions/<space>/docs/<path>/) FIRST, before
  // the file itself moves. If this step fails the doc has not yet been renamed,
  // so we never leave a successfully-renamed doc with orphaned history.
  const oldVersionDir = versionKeyDir(spaceId, "docs", sanitizedOldPath);
  const newVersionDir = versionKeyDir(spaceId, "docs", sanitizedNewPath);
  if (existsSync(oldVersionDir)) {
    if (existsSync(newVersionDir)) {
      return { error: `Target version history already exists: ${sanitizedNewPath}` };
    }
    await mkdir(dirname(newVersionDir), { recursive: true });
    await rename(oldVersionDir, newVersionDir);
  }

  await mkdir(dirname(newFilePath), { recursive: true });
  await rename(resolved.path, newFilePath);

  await mutateDocMetaFile(spaceId, (meta) => {
    if (meta.docs[sanitizedOldPath]) {
      meta.docs[sanitizedNewPath] = meta.docs[sanitizedOldPath]!;
      delete meta.docs[sanitizedOldPath];
    }
  });

  // Manual sidebar order stores literal paths — migrate the exact entry here
  // so every rename caller (REST route, MCP tool) keeps the doc's dragged
  // position. Exact mapping only: a same-named folder's children do not move.
  await migrateDocOrderPaths(spaceId, [
    { from: sanitizedOldPath, to: sanitizedNewPath },
  ]);

  notifyDocContentChanged(spaceId, sanitizedOldPath);
  notifyDocContentChanged(spaceId, sanitizedNewPath);
  return { error: null };
}
