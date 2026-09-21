// ============================================================
// Doc version-history retention (pruning engine)
//
// Enforces the user's retention policy (see settings-store.ts) over the doc
// version snapshots on disk under <workspace>/versions/<space>/docs/**. This is
// history MAINTENANCE, not a content change: it never emits doc-change events and
// never touches the live doc — only old snapshot files.
//
// Invariants (property-tested in version-retention.test.ts):
//   1. The NEWEST version of every doc is never deleted, whatever the policy.
//   2. Only files under getVersionsDir() are ever removed — every candidate is
//      resolve()d and skipped (with a log) if it escapes that root.
//   3. Existing, archived, and legacy orphan histories in the active docs tree
//      are treated identically. Generation-retired histories live under
//      `.retired` and stay outside sweeps until retention can use the original
//      document-key lock identity safely.
//   4. mode "all" is a hard no-op (no directory walk at all).
//   5. Idempotent: running twice equals running once.
//
// Deliberately imports nothing from store.ts (store.ts imports this module for
// the count-mode post-write check), mirroring version-store.ts's boundary.
// ============================================================

import { existsSync } from "node:fs";
import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DocumentIdSchema, type DocumentId } from "@worktable/types";
import { readFile } from "node:fs/promises";
import {
  listDocumentGenerationsV2,
  pruneDocumentGenerationsV2,
} from "./document-version-store-v2.ts";
import {
  getServerSettings,
  getRetentionPolicyGeneration,
  type RetentionPolicy,
} from "./settings-store.ts";
import { getSpacesDir, getVersionsDir, getWorkspaceRoot } from "./workspace.ts";
import { evictFreshness } from "./freshness-cache.ts";
import { evictWidgetFreshness } from "./widget-freshness.ts";
import {
  versionIdTimestamp,
  versionKeyDir,
  withVersionKeyLock,
} from "./version-store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionSweepResult {
  policy: RetentionPolicy;
  /** Docs (version-key dirs) from which at least one snapshot was deleted. */
  docsTouched: number;
  /** Total snapshot files deleted. */
  filesDeleted: number;
  /** Bytes freed (summed sizes of deleted files). */
  bytesFreed: number;
}

interface VersionFile {
  id: string;
  path: string;
  /** Effective creation time (ms). See `effectiveTimestamp`. */
  ts: number;
  /** True when `ts` came from the versionId instead of filesystem metadata. */
  tsFromId: boolean;
  /** File mtime (ms) — fallback ordering for legacy ids only. */
  mtime: number;
}

function isMissingVersionDirError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

let provenanceProtectionGeneration = 0;

export function noteDocProvenanceChanged(): void {
  provenanceProtectionGeneration += 1;
}

interface ProvenanceProtectionCacheDeps {
  readGeneration?: () => number;
  readIds?: (spaceId: string) => Promise<ReadonlySet<string>>;
}

export class ProvenanceProtectionCache {
  private readonly bySpace = new Map<
    string,
    { generation: number; ids: ReadonlySet<string> }
  >();

  private readonly readGeneration: () => number;
  private readonly readIds: (spaceId: string) => Promise<ReadonlySet<string>>;

  constructor(deps: ProvenanceProtectionCacheDeps = {}) {
    this.readGeneration = deps.readGeneration ?? (() => provenanceProtectionGeneration);
    this.readIds = deps.readIds ?? provenanceVersionIds;
  }

  async get(spaceId: string): Promise<ReadonlySet<string>> {
    for (;;) {
      const generation = this.readGeneration();
      const cached = this.bySpace.get(spaceId);
      if (cached && cached.generation === generation) {
        return cached.ids;
      }
      const ids = await this.readIds(spaceId);
      if (generation !== this.readGeneration()) continue;
      this.bySpace.set(spaceId, {
        generation,
        ids,
      });
      return ids;
    }
  }
}

/**
 * The effective creation time of a snapshot file: the versionId-encoded
 * timestamp when present (the naming scheme is authoritative and matches the
 * `createdAt` ordering `listVersionEntries` uses), otherwise the file's mtime as
 * a fallback for snapshots whose name doesn't encode a timestamp.
 */
/** All snapshot files in a single version-key dir, sorted newest-first. */
async function collectVersionFiles(dir: string): Promise<VersionFile[]> {
  // withFileTypes + isFile(): a NESTED DOC whose next path segment ends in
  // .json ("parent/child.json" is a legal docPath) creates a *directory* named
  // child.json in here — treating it as a snapshot would let its mtime win
  // "newest" and push every real snapshot into the deletion set.
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A concurrent doc rename/delete can move this key dir after the sweep
    // walker yields it. Treat that like an already-empty history directory so
    // one raced-away doc does not abort pruning for the rest of the workspace.
    if (isMissingVersionDirError(error)) return [];
    throw error;
  }
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name);
  const files: VersionFile[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, "");
    let mtime = 0;
    try {
      mtime = (await stat(join(dir, name))).mtimeMs;
    } catch {
      // Vanished mid-walk (concurrent prune/write) — keep 0; it sorts oldest.
    }
    const parsedTs = versionIdTimestamp(id);
    files.push({
      id,
      path: join(dir, name),
      // versionId-encoded timestamp is authoritative; mtime for legacy names.
      ts: parsedTs ?? mtime,
      tsFromId: parsedTs !== null,
      mtime,
    });
  }
  // Newest first. For timestamped ids, the filename is authoritative through
  // the same-ms sequence segment; mtime can move later when an old checkpoint is
  // rewritten, so it must not decide which timestamped snapshot is newest. Only
  // legacy names without an encoded timestamp fall back to mtime.
  files.sort((a, b) => {
    const byTs = b.ts - a.ts;
    if (byTs !== 0) return byTs;
    if (a.tsFromId && b.tsFromId) return b.id.localeCompare(a.id);
    return (b.mtime - a.mtime) || b.id.localeCompare(a.id);
  });
  return files;
}

/**
 * Which files to delete for a policy, given the doc's files sorted newest-first.
 * The file at index 0 (newest) is NEVER a candidate — invariant 1.
 */
function selectDeletions(
  files: VersionFile[],
  policy: RetentionPolicy,
  protect?: ReadonlySet<string>,
): VersionFile[] {
  if (files.length <= 1) return [];
  let candidates: VersionFile[];
  switch (policy.mode) {
    case "all":
      return [];
    case "age": {
      const cutoff = Date.now() - policy.maxAgeDays * DAY_MS;
      candidates = files.slice(1).filter((f) => f.ts < cutoff);
      break;
    }
    case "count": {
      // Keep the newest `maxPerDoc`; delete the remainder. Validation enforces
      // maxPerDoc >= 1, but clamp anyway so invariant 1 holds structurally even
      // against a hand-edited settings file.
      candidates = files.slice(Math.max(1, policy.maxPerDoc));
      break;
    }
  }
  // Pinned versions are never candidates: the post-write prune pins the id it
  // just recorded, and every sweep pins each doc's provenance-pointed version
  // (a checkpoint rewrite can hand the previous snapshot a newer mtime, so
  // ordering alone cannot be trusted to keep the live doc's current version).
  return protect && protect.size > 0
    ? candidates.filter((f) => !protect.has(f.id))
    : candidates;
}

/**
 * Prune one version-key dir under the per-doc-key lock. `versionsRootResolved`
 * is the resolved getVersionsDir(); every deletion candidate is re-resolved and
 * refused if it escapes that root (invariant 2).
 */
interface PruneContext {
  policy: RetentionPolicy;
  protect: ReadonlySet<string>;
}

function isInsideResolvedRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

async function deleteVersionFileSafely(
  file: VersionFile,
  versionsRootResolved: string,
  versionsRootReal: string,
): Promise<{ deleted: boolean; bytesFreed: number }> {
  const resolved = resolve(file.path);
  if (!isInsideResolvedRoot(resolved, versionsRootResolved)) {
    console.warn(
      `[version-retention] refusing to delete a path outside the versions dir: ${resolved}`,
    );
    return { deleted: false, bytesFreed: 0 };
  }

  // A symlink snapshot has no business in a versions dir; deleting one is
  // harmless but refusing is simpler to reason about.
  if ((await lstat(resolved)).isSymbolicLink()) {
    console.warn(`[version-retention] refusing to delete symlink ${resolved}`);
    return { deleted: false, bytesFreed: 0 };
  }

  const parent = dirname(resolved);
  const realParent = await realpath(parent);
  if (!isInsideResolvedRoot(realParent, versionsRootReal)) {
    console.warn(
      `[version-retention] refusing to delete ${resolved} — parent resolves outside the versions dir (${realParent})`,
    );
    return { deleted: false, bytesFreed: 0 };
  }

  const size = (await stat(resolved)).size;
  const latestRealParent = await realpath(parent);
  if (!isInsideResolvedRoot(latestRealParent, versionsRootReal)) {
    console.warn(
      `[version-retention] refusing to delete ${resolved} — parent moved outside the versions dir (${latestRealParent})`,
    );
    return { deleted: false, bytesFreed: 0 };
  }

  await rm(resolved, { force: true });
  return { deleted: true, bytesFreed: size };
}

async function pruneKeyDir(
  spaceId: string,
  key: string,
  dir: string,
  versionsRootResolved: string,
  // Resolved UNDER the per-doc lock, immediately before selecting deletions:
  // a prune can queue behind a write (or another sweep) for this doc, and by
  // the time it runs both the policy and the doc's provenance may have moved —
  // a snapshot taken at call time would delete under a stale policy or miss a
  // just-recorded provenance version. Returning null skips the dir.
  resolveContext: () => Promise<PruneContext | null>,
): Promise<{ filesDeleted: number; bytesFreed: number }> {
  return withVersionKeyLock(spaceId, "docs", key, async () => {
    let filesDeleted = 0;
    let bytesFreed = 0;
    if (!existsSync(dir)) return { filesDeleted, bytesFreed };

    // The deletion boundary must hold through SYMLINKS, not just lexically:
    // resolve() doesn't follow links, so a symlinked key dir would pass a
    // prefix check while rm() deletes files outside the versions tree. Compare
    // realpaths — if the dir's real location isn't inside the real versions
    // root, refuse the whole dir.
    let realRoot: string;
    let realDir: string;
    try {
      realRoot = await realpath(versionsRootResolved);
      realDir = await realpath(dir);
    } catch (err) {
      console.warn(`[version-retention] could not resolve ${dir}, skipping:`, err);
      return { filesDeleted, bytesFreed };
    }
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
      console.warn(
        `[version-retention] refusing to prune ${dir} — resolves outside the versions dir (${realDir})`,
      );
      return { filesDeleted, bytesFreed };
    }

    const ctx = await resolveContext();
    if (!ctx) return { filesDeleted, bytesFreed };
    const files = await collectVersionFiles(dir);
    const toDelete = selectDeletions(files, ctx.policy, ctx.protect);
    for (const file of toDelete) {
      try {
        const result = await deleteVersionFileSafely(file, versionsRootResolved, realRoot);
        if (result.deleted) {
          filesDeleted += 1;
          bytesFreed += result.bytesFreed;
        }
      } catch (err) {
        console.warn(`[version-retention] failed to delete ${file.path}:`, err);
      }
    }
    return { filesDeleted, bytesFreed };
  });
}

/**
 * Every version-key dir under docs: any directory that directly contains `.json`
 * snapshot files. Walks the raw filesystem (not the doc listing) so histories of
 * DELETED docs are found and treated like any other (invariant 3). Yields
 * `{ spaceId, key, dir }`. A dir can be BOTH a key dir and a parent of nested
 * doc keys (docPath segments nest as subdirs), so recursion continues regardless.
 */
async function* iterDocKeyDirs(): AsyncGenerator<{ spaceId: string; key: string; dir: string }> {
  const versionsRoot = getVersionsDir();
  if (!existsSync(versionsRoot)) return;
  let spaceEntries;
  try {
    const st = await lstat(versionsRoot);
    if (!st.isDirectory()) return;
    spaceEntries = await readdir(versionsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const space of spaceEntries) {
    if (!space.isDirectory()) continue;
    const docsRoot = join(versionsRoot, space.name, "docs");
    // lstat, not existsSync: a symlinked docs root would be FOLLOWED by the
    // walk (deletion is refused later by the realpath guard, but traversing an
    // arbitrary external tree can hang an awaited policy-change sweep). walk()
    // itself never descends symlinks — readdir dirents report a symlinked dir
    // as a symlink, not a directory.
    try {
      const st = await lstat(docsRoot);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    yield* walk(space.name, docsRoot, docsRoot);
  }
}

async function* iterActiveDocumentGenerationOwners(): AsyncGenerator<{
  spaceId: string;
  documentId: DocumentId;
}> {
  const versionsRoot = getVersionsDir();
  if (!existsSync(versionsRoot)) return;
  let spaces;
  try {
    const info = await lstat(versionsRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    spaces = await readdir(versionsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const space of spaces) {
    if (!space.isDirectory() || space.isSymbolicLink()) continue;
    const documentsRoot = join(versionsRoot, space.name, "documents");
    let documents;
    try {
      const info = await lstat(documentsRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      documents = await readdir(documentsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const document of documents) {
      if (!document.isDirectory() || document.isSymbolicLink()) continue;
      const parsed = DocumentIdSchema.safeParse(document.name);
      if (parsed.success) {
        yield { spaceId: space.name, documentId: parsed.data };
      }
    }
  }
}

async function* walk(
  spaceId: string,
  docsRoot: string,
  dir: string,
): AsyncGenerator<{ spaceId: string; key: string; dir: string }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  let hasJson = false;
  for (const e of entries) {
    if (e.isDirectory()) {
      yield* walk(spaceId, docsRoot, join(dir, e.name));
    } else if (e.isFile() && e.name.endsWith(".json")) {
      hasJson = true;
    }
  }
  if (hasJson) {
    const key = relative(docsRoot, dir).split(sep).join("/");
    if (key) yield { spaceId, key, dir };
  }
}

/**
 * Every provenance-pointed versionId in a space, read straight from
 * docs.meta.json (fs-only on purpose: store.ts imports this module, so this
 * module cannot import store.ts). A snapshot some doc's provenance points at is
 * the doc's CURRENT version — deleting it makes the live doc's version id
 * unreadable from history, which the invariant-1 "newest" guard alone can't
 * prevent when a checkpoint rewrite hands the previous snapshot a newer mtime.
 * Tolerant: missing/corrupt meta yields an empty set (invariant 1 still bounds).
 */
async function provenanceVersionIds(spaceId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const raw = await readFile(
      join(getSpacesDir(), spaceId, "docs.meta.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      docs?: Record<string, { provenance?: { versionId?: unknown } }>;
    };
    for (const entry of Object.values(parsed.docs ?? {})) {
      const id = entry?.provenance?.versionId;
      if (typeof id === "string" && id) ids.add(id);
    }
  } catch {
    // Missing or malformed meta — protect nothing extra.
  }
  return ids;
}

function describePolicy(policy: RetentionPolicy): string {
  switch (policy.mode) {
    case "all":
      return "keep all";
    case "age":
      return `keep ${policy.maxAgeDays}d`;
    case "count":
      return `keep ${policy.maxPerDoc}/doc`;
  }
}

function documentGenerationRetention(
  policy: Exclude<RetentionPolicy, { mode: "all" }>,
  now: number,
): {
  maxNonCheckpointGenerations: number;
  maxNonCheckpointBytes: number;
  minimumCreatedAt?: string;
} {
  if (policy.mode === "count") {
    return {
      maxNonCheckpointGenerations: policy.maxPerDoc,
      maxNonCheckpointBytes: Number.MAX_SAFE_INTEGER,
    };
  }
  return {
    maxNonCheckpointGenerations: Number.MAX_SAFE_INTEGER,
    maxNonCheckpointBytes: Number.MAX_SAFE_INTEGER,
    minimumCreatedAt: new Date(now - policy.maxAgeDays * DAY_MS).toISOString(),
  };
}

function retentionStillCurrent(
  generation: number,
  policy: RetentionPolicy,
): boolean {
  return (
    getRetentionPolicyGeneration() === generation &&
    JSON.stringify(getServerSettings().history.retention) ===
      JSON.stringify(policy)
  );
}

/** Apply count retention to one newly written V2 document generation. */
export async function pruneDocumentGenerationsForCountV2(
  spaceId: string,
  documentId: DocumentId,
): Promise<number> {
  const generation = getRetentionPolicyGeneration();
  const policy = getServerSettings().history.retention;
  if (policy.mode !== "count") return 0;
  const removed = await pruneDocumentGenerationsV2({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    documentId,
    retention: documentGenerationRetention(policy, Date.now()),
    authorizeRetention: () => retentionStillCurrent(generation, policy),
  });
  if (removed > 0) {
    evictFreshness(spaceId);
    evictWidgetFreshness(spaceId);
  }
  return removed;
}

/**
 * Full retention sweep over all doc histories. Reads the current policy from
 * settings unless one is passed (the settings-change trigger passes the new
 * policy explicitly so it can't race a stale cache). `all` is a hard no-op.
 * Logs a one-line summary only when something was deleted.
 */
export async function runRetentionSweep(
  policy?: RetentionPolicy,
  opts?: { expectedRetentionGeneration?: number },
): Promise<RetentionSweepResult> {
  const p = policy ?? getServerSettings().history.retention;
  const launchGeneration =
    opts?.expectedRetentionGeneration ?? getRetentionPolicyGeneration();
  const result: RetentionSweepResult = {
    policy: p,
    docsTouched: 0,
    filesDeleted: 0,
    bytesFreed: 0,
  };
  if (getRetentionPolicyGeneration() !== launchGeneration) return result;
  if (p.mode === "all") return result; // invariant 4: no walk at all

  const versionsRootResolved = resolve(getVersionsDir());
  const protectCache = new ProvenanceProtectionCache();
  for await (const { spaceId, key, dir } of iterDocKeyDirs()) {
    // A destructive walk must not outlive its policy: if a later settings
    // write landed (e.g. the owner relaxed retention right after tightening
    // it), this sweep's snapshot is stale — stop; the policy-change trigger
    // for that write runs its own sweep under the new policy.
    if (getRetentionPolicyGeneration() !== launchGeneration) {
      console.log(
        "[version-retention] retention policy changed mid-sweep; stopping this sweep",
      );
      break;
    }
    const { filesDeleted, bytesFreed } = await pruneKeyDir(
      spaceId,
      key,
      dir,
      versionsRootResolved,
      async () => {
        // Under the lock: re-check the policy generation (this sweep may have
        // queued behind a write) and read the space's provenance from a
        // generation-aware cache. Most spaces parse docs.meta.json once per
        // sweep; if a write lands while this sweep waits on a doc lock, the
        // provenance generation changes and the next lookup refreshes before
        // selecting deletions.
        if (getRetentionPolicyGeneration() !== launchGeneration) return null;
        return { policy: p, protect: await protectCache.get(spaceId) };
      },
    );
    if (filesDeleted > 0) {
      result.docsTouched += 1;
      result.filesDeleted += filesDeleted;
      result.bytesFreed += bytesFreed;
      // Freshness (lastHumanTouch/humanReviewed) is derived from the version
      // files just deleted, but its cache is keyed by provenance.versionId,
      // which pruning doesn't change — evict so the next read rescans. The
      // sweep key is the sanitized dir name, which may differ from the doc
      // path the cache was keyed with, so evict the whole space (cheap; it
      // rebuilds lazily and sweeps are rare).
      evictFreshness(spaceId);
    }
  }

  const generationRetention = documentGenerationRetention(p, Date.now());
  for await (const {
    spaceId,
    documentId,
  } of iterActiveDocumentGenerationOwners()) {
    if (getRetentionPolicyGeneration() !== launchGeneration) {
      console.log(
        "[version-retention] retention policy changed mid-sweep; stopping this sweep",
      );
      break;
    }
    try {
      const before = await listDocumentGenerationsV2({
        workspaceRoot: getWorkspaceRoot(),
        spaceId,
        documentId,
      });
      const removed = await pruneDocumentGenerationsV2({
        workspaceRoot: getWorkspaceRoot(),
        spaceId,
        documentId,
        retention: generationRetention,
        authorizeRetention: () =>
          getRetentionPolicyGeneration() === launchGeneration,
      });
      if (removed === 0) continue;
      const afterIds = new Set(
        (
          await listDocumentGenerationsV2({
            workspaceRoot: getWorkspaceRoot(),
            spaceId,
            documentId,
          })
        ).map((manifest) => manifest.id),
      );
      result.docsTouched += 1;
      result.filesDeleted += removed;
      result.bytesFreed += before
        .filter((manifest) => !afterIds.has(manifest.id))
        .reduce((total, manifest) => total + manifest.totalBytes, 0);
      evictFreshness(spaceId);
      evictWidgetFreshness(spaceId);
    } catch (error) {
      console.warn(
        `[version-retention] failed to prune V2 generations for ${spaceId}/${documentId}:`,
        error,
      );
    }
  }

  if (result.filesDeleted > 0) {
    console.log(
      `[version-retention] pruned ${result.filesDeleted} version(s) across ` +
        `${result.docsTouched} doc(s), freed ${result.bytesFreed} bytes ` +
        `(policy: ${describePolicy(p)})`,
    );
  }
  return result;
}

/**
 * Cheap same-doc check run right after `recordDocVersion` writes a snapshot.
 * Only does anything under `count` mode — `age` needs no per-write action (a new
 * version can't push an existing one out of its age window) and `all` never
 * prunes. Acquires the per-doc-key lock itself, so `recordDocVersion` must have
 * released the snapshot-write lock before calling (it does).
 */
export async function pruneDocKeyForCount(
  spaceId: string,
  docPath: string,
  opts?: { protectVersionId?: string },
): Promise<void> {
  if (getServerSettings().history.retention.mode !== "count") return;
  const versionsRoot = getVersionsDir();
  try {
    const st = await lstat(versionsRoot);
    if (!st.isDirectory()) return;
  } catch {
    return;
  }
  const dir = versionKeyDir(spaceId, "docs", docPath);
  if (!existsSync(dir)) return;
  // Best-effort BY CONTRACT: this runs on the doc-write path after the content
  // is already on disk — a retention hiccup (unreadable/renamed versions dir)
  // must never turn a successful write into a failure. Callers may still wrap
  // defensively, but this function itself does not reject on fs errors.
  try {
    const versionsRootResolved = resolve(versionsRoot);
    const { filesDeleted } = await pruneKeyDir(
      spaceId,
      docPath,
      dir,
      versionsRootResolved,
      async () => {
        // Under the lock: this prune may have queued behind another operation
        // on the same doc, and the owner may have relaxed retention meanwhile —
        // re-read instead of trusting the entry-time snapshot.
        const current = getServerSettings().history.retention;
        if (current.mode !== "count") return null;
        const protect = await provenanceVersionIds(spaceId);
        if (opts?.protectVersionId) protect.add(opts.protectVersionId);
        return { policy: current, protect };
      },
    );
    // See the sweep-path eviction note; here the true docPath is in hand.
    if (filesDeleted > 0) evictFreshness(spaceId, docPath);
  } catch (err) {
    console.warn(
      `[version-retention] post-write prune failed for ${spaceId}/${docPath}:`,
      err,
    );
  }
}
