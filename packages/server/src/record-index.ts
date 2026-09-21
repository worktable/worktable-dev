// ============================================================
// Record index: derived, rebuildable SQLite projection of records
// ============================================================
//
// Records are canonical as one-YAML-file-per-record in the workspace
// (record-store.ts). This module maintains a machine-local SQLite
// projection of them under the app data root, keyed per workspace
// like the Yjs cache. It is a *cache* in the storage-contract sense:
// deleting it loses nothing — it rebuilds from the files.
//
// Freshness comes from three feeds, all applied idempotently (upserts
// keyed by content hash, so the internal-write event and its watcher
// echo double-apply harmlessly):
//   1. record-events.ts — synchronous write-through from every store
//      mutation (REST, widget bridge, MCP), giving read-your-writes.
//   2. Watcher events — external edits (agents writing files, git).
//   3. A background full build at boot / on format mismatch.
//
// Invalid YAML is indexed as an invalid row (never silently dropped),
// so diagnostics can come from the index once reads flip to it.
//
// This module must not import record-store.ts: the store consults the
// index for reads, so the dependency points store -> index only.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CanonicalIdSchema, normalizeRecordFieldType, RecordCollectionSchemaSchema, RecordFileSchema, SpaceFileSchema, type RecordCollectionProjectionHealth, type RecordCollectionReconcileResult, type RecordField, type RecordFile, type RecordProjectionState } from "@worktable/types";
import { getAppDir } from "./app-storage.ts";
import { onRecordChanged, type RecordChangeEvent } from "./record-events.ts";
import { getSpacesBaseDir, withStoreWriteLock } from "./store.ts";
import { workspaceCacheKey, getWorkspaceRoot } from "./workspace.ts";
import { parseCanonicalYaml, stringifyCanonicalYaml } from "./yaml.ts";

// Bump when the table layout or row semantics change; a mismatch wipes and
// rebuilds the file (it is a cache — rebuild is always safe).
const RECORD_INDEX_FORMAT = 3;

export interface RecordSearchHit {
  spaceId: string;
  collectionId: string;
  recordId: string;
  title: string;
  /** Collection display name — part of the indexed body, so a hit can match on it. */
  collectionName: string;
  /** Parsed record data, so the caller can build a display excerpt. */
  data: unknown;
}

interface RowShape {
  space_id: string;
  collection_id: string;
  record_id: string;
  json: string | null;
  archived: number;
  valid: number;
  error: string | null;
  file_hash: string;
}

function rowKey(spaceId: string, collectionId: string, recordId: string): string {
  return `${spaceId}/${collectionId}/${recordId}`;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isCanonicalId(id: string): boolean {
  return CanonicalIdSchema.safeParse(id).success;
}

// Mirrors search-index.ts recordTitle so record search results keep their
// titles when the search read path moves onto this index.
function recordTitle(record: RecordFile, collectionName: string): string {
  const data = record.data;
  const title = data["title"] ?? data["name"];
  if (typeof title === "string" && title.trim()) return title;
  return `${collectionName}: ${record.id}`;
}

class RecordIndex {
  private db: Database | null = null;
  private started = false;
  private ready = false;
  private ftsAvailable = false;
  private unsubscribe: (() => void) | null = null;
  private buildPromise: Promise<void> | null = null;
  // Bumped by every stop(): a build started under an older generation must not
  // mark the (restarted) instance ready or keep touching its database.
  private generation = 0;
  // Events arriving while a rebuild scans files are buffered and re-applied
  // after it finishes, so a scan that read a file just before a mutation
  // cannot overwrite the mutation's row with stale content. Managed by
  // rebuild() itself, so drift-repair rebuilds get the same protection as
  // the boot build.
  private pendingDuringBuild: Map<string, RecordChangeEvent> | null = null;
  // While a rebuild is scanning, this aliases its `seen` set: every row
  // written mid-build (watcher ingests, store events) registers here so the
  // end-of-build prune cannot delete rows the scan's directory listing
  // happened to miss.
  private buildSeen: Set<string> | null = null;
  // Collection metadata needs the same protection as record rows: a schema
  // created while a rebuild scans must not be mistaken for stale projection
  // state just because the scan's directory listing predates it.
  private buildCollectionsSeen: Set<string> | null = null;
  // Rebuilds are serialized: overlapping scans would feed one run's seen-set
  // while the other prunes, deleting live rows.
  private rebuildQueue: Promise<void> = Promise.resolve();
  // Store events can start async schema refreshes outside the serialized
  // rebuild queue. Lifecycle shutdown must drain those too before closing the
  // SQLite handle or changing workspace/app-storage providers.
  private pendingTasks = new Set<Promise<unknown>>();
  private lastReconciledAt = new Map<string, string>();
  // Query responses may include a previously detected drift warning, but they
  // must never rescan and hash an entire collection on the request hot path.
  // The explicit health endpoint and reconciliation refresh this cache.
  private healthCache = new Map<string, RecordCollectionProjectionHealth>();

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.db = this.open();
    } catch (err) {
      console.error("[record-index] failed to open index database, records index disabled:", err);
      this.started = false;
      return;
    }
    this.unsubscribe = onRecordChanged((event) => this.applyEvent(event));
    const gen = this.generation;
    this.buildPromise = this.rebuild()
      .then(async () => {
        if (gen === this.generation && this.db) {
          // Queries must never pay for a full hash scan, so populate health for
          // every collection before the initial ready promise is observable.
          await this.refreshProjectionHealthCache(true);
          this.ready = true;
        }
      })
      .catch((err) => {
        console.error("[record-index] initial build failed:", err);
      });
  }

  stop(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.db?.close();
    this.db = null;
    this.started = false;
    this.ready = false;
    this.ftsAvailable = false;
    this.buildPromise = null;
    this.pendingDuringBuild = null;
    this.buildSeen = null;
    this.buildCollectionsSeen = null;
    this.lastReconciledAt.clear();
    this.healthCache.clear();
  }

  isStarted(): boolean {
    return this.started;
  }

  isReady(): boolean {
    return this.ready && this.db !== null;
  }

  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  async whenReady(): Promise<void> {
    await this.buildPromise;
  }

  /** Wait for build/reconciliation work before closing or changing providers. */
  async whenIdle(): Promise<void> {
    // Reconciliation can append to the serialized queue while an earlier task
    // is settling. Keep taking snapshots until both references stay stable.
    while (true) {
      const build = this.buildPromise;
      const queue = this.rebuildQueue;
      const pending = [...this.pendingTasks];
      await Promise.all([build, queue, ...pending]);
      if (
        build === this.buildPromise &&
        queue === this.rebuildQueue &&
        this.pendingTasks.size === 0
      ) return;
    }
  }

  private trackTask(task: Promise<unknown>): void {
    this.pendingTasks.add(task);
    void task.finally(() => this.pendingTasks.delete(task)).catch(() => {});
  }

  private indexPath(): string {
    return join(getAppDir(), "records-index", workspaceCacheKey(), "index.db");
  }

  private open(): Database {
    const path = this.indexPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let db = new Database(path, { create: true });
    // The FTS mode is part of the file's identity: a database populated while
    // FTS was unavailable has no search rows, and the hash-unchanged upsert
    // fast path would never backfill them. When the self-test verdict differs
    // from the one stored in meta, wipe and rebuild in the current mode.
    const fts = this.ftsSelfTest(db);
    if (!this.metaMatches(db, fts)) {
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
      db = new Database(path, { create: true });
    }
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run(
      "CREATE TABLE IF NOT EXISTS records (" +
        "space_id TEXT NOT NULL, collection_id TEXT NOT NULL, record_id TEXT NOT NULL, " +
        "json TEXT, archived INTEGER NOT NULL DEFAULT 0, valid INTEGER NOT NULL DEFAULT 1, " +
        "error TEXT, file_hash TEXT NOT NULL, " +
        "PRIMARY KEY (space_id, collection_id, record_id))",
    );
    db.run("CREATE TABLE IF NOT EXISTS collections (space_id TEXT NOT NULL, collection_id TEXT NOT NULL, name TEXT NOT NULL, fields_json TEXT, schema_hash TEXT, PRIMARY KEY (space_id, collection_id))");
    // Relation edges, stored once per (record, field, target). Backlinks,
    // delete-policy checks, and dangling-reference warnings all read this.
    db.run(
      "CREATE TABLE IF NOT EXISTS record_refs (" +
        "space_id TEXT NOT NULL, from_collection TEXT NOT NULL, from_record TEXT NOT NULL, " +
        "field TEXT NOT NULL, to_collection TEXT NOT NULL, to_record TEXT NOT NULL)",
    );
    db.run("CREATE INDEX IF NOT EXISTS record_refs_from ON record_refs (space_id, from_collection, from_record)");
    db.run("CREATE INDEX IF NOT EXISTS record_refs_to ON record_refs (space_id, to_collection, to_record)");
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('format', ?), ('workspaceRoot', ?), ('fts', ?)", [String(RECORD_INDEX_FORMAT), getWorkspaceRoot(), fts ? "1" : "0"]);
    this.ftsAvailable = fts;
    if (fts) {
      db.run("CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(title, body, space_id UNINDEXED, collection_id UNINDEXED, record_id UNINDEXED)");
    } else {
      console.warn("[record-index] SQLite FTS5 self-test failed; record search will use a plain scan fallback");
    }
    return db;
  }

  private metaMatches(db: Database, fts: boolean): boolean {
    try {
      const rows = db.query("SELECT key, value FROM meta").all() as { key: string; value: string }[];
      const meta = new Map(rows.map((row) => [row.key, row.value]));
      return (
        meta.get("format") === String(RECORD_INDEX_FORMAT) &&
        meta.get("workspaceRoot") === getWorkspaceRoot() &&
        meta.get("fts") === (fts ? "1" : "0")
      );
    } catch {
      // No meta table yet: a brand-new file, which open() initializes in place.
      return true;
    }
  }

  // Guard against the macOS system-SQLite FTS5 corruption class: exercise the
  // full insert/update/delete cycle once per open before trusting FTS5.
  private ftsSelfTest(db: Database): boolean {
    try {
      db.run("DROP TABLE IF EXISTS fts_probe");
      db.run("CREATE VIRTUAL TABLE fts_probe USING fts5(t)");
      db.run("INSERT INTO fts_probe (rowid, t) VALUES (1, 'hello world')");
      db.run("UPDATE fts_probe SET t = 'hello there' WHERE rowid = 1");
      const hit = db.query("SELECT rowid FROM fts_probe WHERE fts_probe MATCH 'hello'").all();
      db.run("DELETE FROM fts_probe WHERE rowid = 1");
      db.run("DROP TABLE fts_probe");
      return hit.length === 1;
    } catch {
      return false;
    }
  }

  private applyEvent(event: RecordChangeEvent): void {
    if (!this.db) return;
    if (this.pendingDuringBuild) {
      const key =
        event.kind === "write"
          ? rowKey(event.spaceId, event.record.collectionId, event.record.id)
          : event.kind === "delete"
            ? rowKey(event.spaceId, event.collectionId, event.recordId)
            : `collection:${event.spaceId}/${event.collectionId}`;
      this.pendingDuringBuild.set(key, event);
    }
    try {
      if (event.kind === "write") {
        // Hash of the exact canonical text the store just wrote, so the watcher
        // echo (which hashes the file) is recognized as already applied.
        this.upsertValid(event.spaceId, event.record, hashText(stringifyCanonicalYaml(event.record)));
      } else if (event.kind === "delete") {
        this.deleteRow(event.spaceId, event.collectionId, event.recordId);
      } else {
        this.trackTask(
          this.refreshCollection(event.spaceId, event.collectionId).catch((err) =>
            console.error("[record-index] collection refresh failed:", err),
          ),
        );
      }
    } catch (err) {
      console.error("[record-index] failed to apply record event:", err);
    }
  }

  private collectionName(spaceId: string, collectionId: string): string {
    if (!this.db) return collectionId;
    const row = this.db.query("SELECT name FROM collections WHERE space_id = ? AND collection_id = ?").get(spaceId, collectionId) as { name: string } | null;
    return row?.name ?? collectionId;
  }

  private collectionFields(spaceId: string, collectionId: string): Record<string, RecordField> | null {
    if (!this.db) return null;
    const row = this.db.query("SELECT fields_json FROM collections WHERE space_id = ? AND collection_id = ?").get(spaceId, collectionId) as { fields_json: string | null } | null;
    if (!row?.fields_json) return null;
    try {
      return JSON.parse(row.fields_json) as Record<string, RecordField>;
    } catch {
      return null;
    }
  }

  // Relation edges a record's data declares, per its collection schema. Values
  // that aren't canonical ids are skipped — they can never resolve, and v1
  // reference fields legally hold loose strings.
  private extractRefs(fields: Record<string, RecordField> | null, record: RecordFile): { field: string; toCollection: string; toRecord: string }[] {
    if (!fields) return [];
    const refs: { field: string; toCollection: string; toRecord: string }[] = [];
    for (const [name, spec] of Object.entries(fields)) {
      if (normalizeRecordFieldType(spec.type) !== "relation" || !spec.references) continue;
      const value = record.data[name];
      const ids = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      for (const id of ids) {
        if (typeof id === "string" && isCanonicalId(id)) refs.push({ field: name, toCollection: spec.references, toRecord: id });
      }
    }
    return refs;
  }

  private replaceRefs(spaceId: string, collectionId: string, recordId: string, record: RecordFile | null): void {
    if (!this.db) return;
    this.db.run("DELETE FROM record_refs WHERE space_id = ? AND from_collection = ? AND from_record = ?", [spaceId, collectionId, recordId]);
    if (!record) return;
    for (const ref of this.extractRefs(this.collectionFields(spaceId, collectionId), record)) {
      this.db.run("INSERT INTO record_refs (space_id, from_collection, from_record, field, to_collection, to_record) VALUES (?, ?, ?, ?, ?, ?)", [
        spaceId, collectionId, recordId, ref.field, ref.toCollection, ref.toRecord,
      ]);
    }
  }

  private upsertValid(spaceId: string, record: RecordFile, fileHash: string): void {
    if (!this.db) return;
    // Any row written while a rebuild scans is alive by definition — register
    // it so the end-of-build prune can't delete it (the scan's directory
    // listing may predate this write). Registered even on the hash-unchanged
    // fast path: the row exists on disk either way.
    this.buildSeen?.add(rowKey(spaceId, record.collectionId, record.id));
    this.buildCollectionsSeen?.add(`${spaceId}/${record.collectionId}`);
    const existing = this.db.query("SELECT file_hash FROM records WHERE space_id = ? AND collection_id = ? AND record_id = ?").get(spaceId, record.collectionId, record.id) as { file_hash: string } | null;
    if (existing?.file_hash === fileHash) return;
    const apply = this.db.transaction(() => {
      this.db!.run(
        "INSERT OR REPLACE INTO records (space_id, collection_id, record_id, json, archived, valid, error, file_hash) VALUES (?, ?, ?, ?, ?, 1, NULL, ?)",
        [spaceId, record.collectionId, record.id, JSON.stringify(record), record.archive ? 1 : 0, fileHash],
      );
      this.replaceRefs(spaceId, record.collectionId, record.id, record);
      if (this.ftsAvailable) {
        this.db!.run("DELETE FROM records_fts WHERE space_id = ? AND collection_id = ? AND record_id = ?", [spaceId, record.collectionId, record.id]);
        // Archived records are not searchable (parity with the MiniSearch index,
        // which indexes with includeArchived: false).
        if (!record.archive) {
          const name = this.collectionName(spaceId, record.collectionId);
          this.db!.run("INSERT INTO records_fts (title, body, space_id, collection_id, record_id) VALUES (?, ?, ?, ?, ?)", [
            recordTitle(record, name),
            `${name} ${JSON.stringify(record.data)}`,
            spaceId,
            record.collectionId,
            record.id,
          ]);
        }
      }
    });
    apply();
  }

  private upsertInvalid(spaceId: string, collectionId: string, recordId: string, error: string, fileHash: string): void {
    if (!this.db) return;
    this.buildSeen?.add(rowKey(spaceId, collectionId, recordId));
    this.buildCollectionsSeen?.add(`${spaceId}/${collectionId}`);
    const apply = this.db.transaction(() => {
      this.db!.run(
        "INSERT OR REPLACE INTO records (space_id, collection_id, record_id, json, archived, valid, error, file_hash) VALUES (?, ?, ?, NULL, 0, 0, ?, ?)",
        [spaceId, collectionId, recordId, error, fileHash],
      );
      this.replaceRefs(spaceId, collectionId, recordId, null);
      if (this.ftsAvailable) {
        this.db!.run("DELETE FROM records_fts WHERE space_id = ? AND collection_id = ? AND record_id = ?", [spaceId, collectionId, recordId]);
      }
    });
    apply();
  }

  private deleteRow(spaceId: string, collectionId: string, recordId: string): void {
    if (!this.db) return;
    const apply = this.db.transaction(() => {
      this.db!.run("DELETE FROM records WHERE space_id = ? AND collection_id = ? AND record_id = ?", [spaceId, collectionId, recordId]);
      this.replaceRefs(spaceId, collectionId, recordId, null);
      if (this.ftsAvailable) {
        this.db!.run("DELETE FROM records_fts WHERE space_id = ? AND collection_id = ? AND record_id = ?", [spaceId, collectionId, recordId]);
      }
    });
    apply();
  }

  // Watcher feed: an external edit touched a record file. Re-read it from disk
  // and apply idempotently; a missing file is a delete. Runs under the same
  // per-path lock the store's write path holds, so an ingest's read-then-upsert
  // cannot interleave with a store write and clobber the fresher row with an
  // older file snapshot. (The store's write-through event never re-enters this
  // lock — applyEvent upserts directly — so there is no re-entrancy.)
  async ingestFile(spaceId: string, collectionId: string, recordId: string): Promise<void> {
    if (!this.db || !isCanonicalId(spaceId) || !isCanonicalId(collectionId) || !isCanonicalId(recordId)) return;
    const path = join(getSpacesBaseDir(), spaceId, "records", collectionId, `${recordId}.yaml`);
    await withStoreWriteLock(path, async () => {
      let text: string;
      try {
        text = await Bun.file(path).text();
      } catch {
        this.deleteRow(spaceId, collectionId, recordId);
        return;
      }
      const fileHash = hashText(text);
      try {
        const record = RecordFileSchema.parse(parseCanonicalYaml(text));
        if (record.id !== recordId || record.collectionId !== collectionId) {
          this.upsertInvalid(
            spaceId,
            collectionId,
            recordId,
            `Record identity does not match its canonical path (expected ${collectionId}/${recordId}, found ${record.collectionId}/${record.id})`,
            fileHash,
          );
          return;
        }
        this.upsertValid(spaceId, record, fileHash);
      } catch (error) {
        this.upsertInvalid(spaceId, collectionId, recordId, error instanceof Error ? error.message : String(error), fileHash);
      }
    });
  }

  // Watcher/store feed: a collection schema changed. Refresh the cached name
  // and rewrite the collection's search rows (their bodies embed the name).
  async refreshCollection(spaceId: string, collectionId: string): Promise<void> {
    if (!this.db || !isCanonicalId(spaceId) || !isCanonicalId(collectionId)) return;
    this.buildCollectionsSeen?.add(`${spaceId}/${collectionId}`);
    const previous = this.db.query("SELECT name, fields_json, schema_hash FROM collections WHERE space_id = ? AND collection_id = ?").get(spaceId, collectionId) as { name: string; fields_json: string | null; schema_hash: string | null } | null;
    const { status, name, fields, schemaHash } = await this.readCollectionSchemaFromDisk(spaceId, collectionId);
    if (status === "error") {
      // An unparseable schema must not erase what we knew: dropping fields
      // would delete every relation edge derived under the last good schema,
      // silencing integrity warnings while they still hold on disk. Keep the
      // previous name and fields; the corruption itself is surfaced through
      // the collection's diagnostics. A MISSING schema (deleted on purpose)
      // still clears fields and edges below — that collection genuinely
      // declares no relations anymore.
      if (!previous) this.db.run("INSERT OR REPLACE INTO collections (space_id, collection_id, name, fields_json, schema_hash) VALUES (?, ?, ?, NULL, NULL)", [spaceId, collectionId, name]);
      if (this.isReady() && this.pendingDuringBuild === null) await this.collectionHealth(spaceId, collectionId);
      return;
    }
    const fieldsJson = fields ? JSON.stringify(fields) : null;
    this.db.run("INSERT OR REPLACE INTO collections (space_id, collection_id, name, fields_json, schema_hash) VALUES (?, ?, ?, ?, ?)", [spaceId, collectionId, name, fieldsJson, schemaHash]);
    // Relation declarations changed: re-derive every row's edges under the new
    // schema (adding a relation field must index existing values).
    if ((previous?.fields_json ?? null) !== fieldsJson) {
      const rows = this.db.query("SELECT record_id, json FROM records WHERE space_id = ? AND collection_id = ? AND valid = 1").all(spaceId, collectionId) as { record_id: string; json: string }[];
      for (const row of rows) this.replaceRefs(spaceId, collectionId, row.record_id, JSON.parse(row.json) as RecordFile);
    }
    if (this.ftsAvailable && previous?.name !== name) {
      const rows = this.db.query("SELECT json, archived FROM records WHERE space_id = ? AND collection_id = ? AND valid = 1").all(spaceId, collectionId) as { json: string; archived: number }[];
      for (const row of rows) {
        const record = JSON.parse(row.json) as RecordFile;
        this.db.run("DELETE FROM records_fts WHERE space_id = ? AND collection_id = ? AND record_id = ?", [spaceId, collectionId, record.id]);
        // Same rule as upsertValid: archived records are not searchable.
        if (row.archived) continue;
        this.db.run("INSERT INTO records_fts (title, body, space_id, collection_id, record_id) VALUES (?, ?, ?, ?, ?)", [
          recordTitle(record, name),
          `${name} ${JSON.stringify(record.data)}`,
          spaceId,
          collectionId,
          record.id,
        ]);
      }
    }
    // Schema changes are uncommon and already run off the query path. Seed a
    // health result here so a newly created collection is immediately covered
    // for MCP/widget queries too. Rebuilds refresh all collections at the end.
    if (this.isReady() && this.pendingDuringBuild === null) await this.collectionHealth(spaceId, collectionId);
  }

  private async readCollectionSchemaFromDisk(spaceId: string, collectionId: string): Promise<{ status: "ok" | "missing" | "error"; name: string; fields: Record<string, RecordField> | null; schemaHash: string | null }> {
    const path = join(getSpacesBaseDir(), spaceId, "records", collectionId, "schema.yaml");
    if (!existsSync(path)) return { status: "missing", name: collectionId, fields: null, schemaHash: null };
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch {
      return { status: "error", name: collectionId, fields: null, schemaHash: null };
    }
    const schemaHash = hashText(text);
    try {
      const schema = RecordCollectionSchemaSchema.parse(parseCanonicalYaml(text));
      return { status: "ok", name: schema.name, fields: schema.fields, schemaHash };
    } catch {
      return { status: "error", name: collectionId, fields: null, schemaHash };
    }
  }

  // Full build from the filesystem. Always safe; also the drift repair path.
  // Serialized: a rebuild requested while one is running waits for it.
  async rebuild(): Promise<void> {
    const run = this.rebuildQueue.then(async () => {
      await this.doRebuild();
      if (this.isReady()) await this.refreshProjectionHealthCache();
    });
    this.rebuildQueue = run.catch(() => {});
    return run;
  }

  // Buffers events that arrive mid-scan (see pendingDuringBuild) and aborts
  // quietly if stop() ran while it was scanning.
  private async doRebuild(): Promise<void> {
    if (!this.db) return;
    const gen = this.generation;
    const ownBuffer = this.pendingDuringBuild === null;
    if (ownBuffer) this.pendingDuringBuild = new Map();
    // Alias the scan's seen-set so every mid-build writer (upsertValid /
    // upsertInvalid, whether from watcher ingests or store events) registers
    // its row as alive before the prune runs.
    const seen = new Set<string>();
    const seenCollections = new Set<string>();
    if (ownBuffer) {
      this.buildSeen = seen;
      this.buildCollectionsSeen = seenCollections;
    }
    try {
      const spacesDir = getSpacesBaseDir();
      if (existsSync(spacesDir)) {
        for (const spaceEntry of await readdir(spacesDir, { withFileTypes: true })) {
          if (gen !== this.generation || !this.db) return;
          if (!spaceEntry.isDirectory() || !isCanonicalId(spaceEntry.name)) continue;
          const spaceId = spaceEntry.name;
          // Private starter staging directories carry a final manifest whose
          // id does not match their directory name. A restart must not index
          // their records as ghost search results.
          if (spaceId.startsWith("welcome-seed-")) {
            try {
              const manifest = SpaceFileSchema.parse(
                await Bun.file(join(spacesDir, spaceId, "space.json")).json(),
              );
              if (manifest.id !== spaceId) continue;
            } catch {
              continue;
            }
          }
          const recordsDir = join(spacesDir, spaceId, "records");
          if (!existsSync(recordsDir)) continue;
          for (const collEntry of await readdir(recordsDir, { withFileTypes: true })) {
            if (gen !== this.generation || !this.db) return;
            if (!collEntry.isDirectory() || !isCanonicalId(collEntry.name)) continue;
            const collectionId = collEntry.name;
            seenCollections.add(`${spaceId}/${collectionId}`);
            await this.refreshCollection(spaceId, collectionId);
            for (const fileEntry of await readdir(join(recordsDir, collectionId), { withFileTypes: true })) {
              if (gen !== this.generation || !this.db) return;
              if (!fileEntry.isFile() || !fileEntry.name.endsWith(".yaml") || fileEntry.name === "schema.yaml") continue;
              const recordId = fileEntry.name.replace(/\.yaml$/, "");
              if (!isCanonicalId(recordId)) continue;
              await this.ingestFile(spaceId, collectionId, recordId);
              seen.add(rowKey(spaceId, collectionId, recordId));
            }
            this.lastReconciledAt.set(`${spaceId}/${collectionId}`, new Date().toISOString());
          }
        }
      }
      if (gen !== this.generation || !this.db) return;
      // Prune rows whose files no longer exist.
      const rows = this.db.query("SELECT space_id, collection_id, record_id FROM records").all() as RowShape[];
      for (const row of rows) {
        if (!seen.has(rowKey(row.space_id, row.collection_id, row.record_id))) {
          this.deleteRow(row.space_id, row.collection_id, row.record_id);
        }
      }
      // Empty collections have no record row to drive the prune above. Remove
      // their stale schema/name projection too when the canonical directory is
      // gone, while preserving collections created concurrently with the scan.
      const collections = this.db.query("SELECT space_id, collection_id FROM collections").all() as { space_id: string; collection_id: string }[];
      for (const row of collections) {
        if (!seenCollections.has(`${row.space_id}/${row.collection_id}`)) {
          this.dropCollection(row.space_id, row.collection_id);
        }
      }
    } finally {
      if (ownBuffer) {
        if (this.buildSeen === seen) this.buildSeen = null;
        if (this.buildCollectionsSeen === seenCollections) this.buildCollectionsSeen = null;
        const pending = this.pendingDuringBuild ?? new Map<string, RecordChangeEvent>();
        this.pendingDuringBuild = null;
        if (gen === this.generation && this.db) {
          for (const event of pending.values()) this.applyEvent(event);
        }
      }
    }
  }

  private async refreshProjectionHealthCache(assumeReady = false): Promise<void> {
    const projected = this.projectedCollections();
    const liveKeys = new Set(projected.map(({ spaceId, collectionId }) => `${spaceId}/${collectionId}`));
    for (const key of this.healthCache.keys()) {
      if (!liveKeys.has(key)) this.healthCache.delete(key);
    }
    for (const { spaceId, collectionId } of projected) {
      await this.computeCollectionHealth(spaceId, collectionId, assumeReady);
    }
  }

  /**
   * Reconcile one collection from canonical files. This is the correctness
   * backstop for ambiguous/coalesced watcher activity: it upserts every live
   * canonical row and prunes projected rows whose files disappeared.
   * Collection work shares the full-rebuild queue so maintenance scans cannot
   * race each other's prune phase.
   */
  async reconcileCollection(spaceId: string, collectionId: string): Promise<RecordCollectionReconcileResult> {
    let result: RecordCollectionReconcileResult | null = null;
    const run = this.rebuildQueue.then(async () => {
      result = await this.doReconcileCollection(spaceId, collectionId);
    });
    this.rebuildQueue = run.catch(() => {});
    await run;
    return result ?? {
      state: this.started ? "indexing" : "disabled",
      canonicalFileCount: 0,
      indexedFileCount: 0,
      validRecordCount: 0,
      invalidRecordCount: 0,
      lastReconciledAt: null,
      changedRecordCount: 0,
    };
  }

  private async doReconcileCollection(spaceId: string, collectionId: string): Promise<RecordCollectionReconcileResult> {
    if (!this.db || !isCanonicalId(spaceId) || !isCanonicalId(collectionId)) {
      return {
        state: this.started ? "indexing" : "disabled",
        canonicalFileCount: 0,
        indexedFileCount: 0,
        validRecordCount: 0,
        invalidRecordCount: 0,
        lastReconciledAt: null,
        changedRecordCount: 0,
      };
    }

    const beforeRows = this.db.query("SELECT record_id, file_hash FROM records WHERE space_id = ? AND collection_id = ?").all(spaceId, collectionId) as { record_id: string; file_hash: string }[];
    const before = new Map(beforeRows.map((row) => [row.record_id, row.file_hash]));
    const dir = join(getSpacesBaseDir(), spaceId, "records", collectionId);
    const seen = new Set<string>();
    const gen = this.generation;
    const ownBuffer = this.pendingDuringBuild === null;
    if (ownBuffer) {
      this.pendingDuringBuild = new Map();
      this.buildSeen = seen;
    }
    try {
      if (!existsSync(dir)) {
        this.dropCollection(spaceId, collectionId);
      } else {
        await this.refreshCollection(spaceId, collectionId);
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".yaml") || entry.name === "schema.yaml") continue;
          const recordId = entry.name.replace(/\.yaml$/, "");
          if (!isCanonicalId(recordId)) continue;
          seen.add(rowKey(spaceId, collectionId, recordId));
          await this.ingestFile(spaceId, collectionId, recordId);
        }

        const projected = this.db.query("SELECT record_id FROM records WHERE space_id = ? AND collection_id = ?").all(spaceId, collectionId) as { record_id: string }[];
        for (const row of projected) {
          if (!seen.has(rowKey(spaceId, collectionId, row.record_id))) this.deleteRow(spaceId, collectionId, row.record_id);
        }
      }
    } finally {
      if (ownBuffer) {
        if (this.buildSeen === seen) this.buildSeen = null;
        const pending = this.pendingDuringBuild ?? new Map<string, RecordChangeEvent>();
        this.pendingDuringBuild = null;
        if (gen === this.generation && this.db) {
          for (const event of pending.values()) this.applyEvent(event);
        }
      }
    }

    const stamp = new Date().toISOString();
    this.lastReconciledAt.set(`${spaceId}/${collectionId}`, stamp);
    const afterRows = this.db.query("SELECT record_id, file_hash FROM records WHERE space_id = ? AND collection_id = ?").all(spaceId, collectionId) as { record_id: string; file_hash: string }[];
    const after = new Map(afterRows.map((row) => [row.record_id, row.file_hash]));
    const ids = new Set([...before.keys(), ...after.keys()]);
    const changedRecordCount = [...ids].filter((id) => before.get(id) !== after.get(id)).length;
    const health = await this.collectionHealth(spaceId, collectionId);
    return { ...health, changedRecordCount };
  }

  /** Compare the bounded canonical inventory with the projected inventory. */
  async collectionHealth(spaceId: string, collectionId: string): Promise<RecordCollectionProjectionHealth> {
    return this.computeCollectionHealth(spaceId, collectionId, false);
  }

  private async computeCollectionHealth(spaceId: string, collectionId: string, assumeReady: boolean): Promise<RecordCollectionProjectionHealth> {
    if (!recordIndexEnabled() || !this.started || !this.db || !isCanonicalId(spaceId) || !isCanonicalId(collectionId)) {
      return { state: "disabled", canonicalFileCount: 0, indexedFileCount: 0, validRecordCount: 0, invalidRecordCount: 0, lastReconciledAt: null };
    }

    const dir = join(getSpacesBaseDir(), spaceId, "records", collectionId);
    const schemaPath = join(dir, "schema.yaml");
    let canonicalSchemaHash: string | null = null;
    if (existsSync(schemaPath)) {
      try {
        canonicalSchemaHash = hashText(await Bun.file(schemaPath).text());
      } catch {
        // An unreadable canonical schema cannot match a successfully projected
        // schema; use a sentinel that is never persisted as a projection hash.
        canonicalSchemaHash = "unreadable";
      }
    }
    const canonical = new Map<string, string | null>();
    if (existsSync(dir)) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".yaml") || entry.name === "schema.yaml") continue;
        const recordId = entry.name.replace(/\.yaml$/, "");
        if (!isCanonicalId(recordId)) continue;
        try {
          canonical.set(recordId, hashText(await Bun.file(join(dir, entry.name)).text()));
        } catch {
          canonical.set(recordId, null);
        }
      }
    }
    const projected = this.db.query(
      "SELECT record_id, file_hash, valid FROM records WHERE space_id = ? AND collection_id = ?",
    ).all(spaceId, collectionId) as { record_id: string; file_hash: string; valid: number }[];
    const projectedCollection = this.db.query(
      "SELECT schema_hash FROM collections WHERE space_id = ? AND collection_id = ?",
    ).get(spaceId, collectionId) as { schema_hash: string | null } | null;
    const projectedHashes = new Map(projected.map((row) => [row.record_id, row.file_hash]));
    const canonicalFileCount = canonical.size;
    const indexedFileCount = projected.length;
    const validRecordCount = projected.filter((row) => row.valid === 1).length;
    const invalidRecordCount = projected.length - validRecordCount;
    const projectionMatches = canonicalSchemaHash === (projectedCollection?.schema_hash ?? null) &&
      canonicalFileCount === indexedFileCount &&
      [...canonical].every(([recordId, fileHash]) => fileHash !== null && projectedHashes.get(recordId) === fileHash);
    const state: RecordProjectionState = !assumeReady && !this.isReady()
      ? "indexing"
      : !projectionMatches
        ? "drifted"
        : invalidRecordCount > 0
          ? "degraded"
          : "ready";
    const health = {
      state,
      canonicalFileCount,
      indexedFileCount,
      validRecordCount,
      invalidRecordCount,
      lastReconciledAt: this.lastReconciledAt.get(`${spaceId}/${collectionId}`) ?? null,
    };
    this.healthCache.set(`${spaceId}/${collectionId}`, health);
    return health;
  }

  /** Last full filesystem comparison, for latency-sensitive query warnings. */
  cachedCollectionHealth(spaceId: string, collectionId: string): RecordCollectionProjectionHealth | null {
    if (!isCanonicalId(spaceId) || !isCanonicalId(collectionId)) return null;
    return this.healthCache.get(`${spaceId}/${collectionId}`) ?? null;
  }

  /** Collection identities currently represented by the machine projection. */
  projectedCollections(): { spaceId: string; collectionId: string }[] {
    if (!this.db) return [];
    return this.db.query(
      "SELECT space_id AS spaceId, collection_id AS collectionId FROM collections " +
        "UNION SELECT space_id AS spaceId, collection_id AS collectionId FROM records ORDER BY spaceId, collectionId",
    ).all() as { spaceId: string; collectionId: string }[];
  }

  // The PR3 read path: every valid record in a collection, reconstructed to the
  // exact shape readRecord returns. null while the initial build is running so
  // callers fall back to the file scan.
  listCollection(spaceId: string, collectionId: string, includeArchived: boolean): RecordFile[] | null {
    if (!this.isReady()) return null;
    const sql = includeArchived
      ? "SELECT json FROM records WHERE space_id = ? AND collection_id = ? AND valid = 1"
      : "SELECT json FROM records WHERE space_id = ? AND collection_id = ? AND valid = 1 AND archived = 0";
    const rows = this.db!.query(sql).all(spaceId, collectionId) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as RecordFile);
  }

  listDiagnostics(spaceId: string, collectionId: string): { file: string; error: string }[] | null {
    if (!this.isReady()) return null;
    const rows = this.db!.query("SELECT record_id, error FROM records WHERE space_id = ? AND collection_id = ? AND valid = 0").all(spaceId, collectionId) as { record_id: string; error: string }[];
    return rows.map((row) => ({ file: `${row.record_id}.yaml`, error: row.error }));
  }

  // Records in other collections whose relation fields point at this record.
  // The delete-policy check and backlink expansion read this. null until ready.
  listInboundRefs(spaceId: string, toCollection: string, toRecord: string): { fromCollection: string; fromRecord: string; field: string }[] | null {
    if (!this.isReady()) return null;
    const rows = this.db!.query(
      "SELECT from_collection, from_record, field FROM record_refs WHERE space_id = ? AND to_collection = ? AND to_record = ?",
    ).all(spaceId, toCollection, toRecord) as { from_collection: string; from_record: string; field: string }[];
    return rows.map((row) => ({ fromCollection: row.from_collection, fromRecord: row.from_record, field: row.field }));
  }

  // Relation edges from this collection whose target record does not exist —
  // the queryable integrity warnings for dangling references.
  listDanglingRefs(spaceId: string, collectionId: string): { fromRecord: string; field: string; toCollection: string; toRecord: string }[] | null {
    if (!this.isReady()) return null;
    // A target only counts as live when its row is valid: a reference to a
    // record whose file exists but cannot be parsed is unresolvable right now
    // and must surface, not hide behind the broken file. Archived targets stay
    // live — archival is a lifecycle state, not a broken link.
    const rows = this.db!.query(
      "SELECT rr.from_record AS from_record, rr.field AS field, rr.to_collection AS to_collection, rr.to_record AS to_record " +
        "FROM record_refs rr LEFT JOIN records r ON r.space_id = rr.space_id AND r.collection_id = rr.to_collection AND r.record_id = rr.to_record AND r.valid = 1 " +
        "WHERE rr.space_id = ? AND rr.from_collection = ? AND r.record_id IS NULL",
    ).all(spaceId, collectionId) as { from_record: string; field: string; to_collection: string; to_record: string }[];
    return rows.map((row) => ({ fromRecord: row.from_record, field: row.field, toCollection: row.to_collection, toRecord: row.to_record }));
  }

  // Heal path for a collection whose directory vanished from disk: deleting a
  // whole directory emits no per-file watcher events (the path parser only
  // matches file-depth paths), so nothing else prunes these rows until a full
  // rebuild.
  dropCollection(spaceId: string, collectionId: string): void {
    if (!this.db) return;
    const apply = this.db.transaction(() => {
      this.db!.run("DELETE FROM records WHERE space_id = ? AND collection_id = ?", [spaceId, collectionId]);
      this.db!.run("DELETE FROM collections WHERE space_id = ? AND collection_id = ?", [spaceId, collectionId]);
      this.db!.run("DELETE FROM record_refs WHERE space_id = ? AND from_collection = ?", [spaceId, collectionId]);
      if (this.ftsAvailable) {
        this.db!.run("DELETE FROM records_fts WHERE space_id = ? AND collection_id = ?", [spaceId, collectionId]);
      }
    });
    apply();
    this.lastReconciledAt.delete(`${spaceId}/${collectionId}`);
    this.healthCache.delete(`${spaceId}/${collectionId}`);
  }

  // Which engine served the last searchRecords call. Test-visible so a broken
  // FTS query can't hide behind the scan fallback returning the same results.
  lastSearchEngine: "fts" | "scan" | null = null;

  searchRecords(term: string, limit: number, spaceId?: string): RecordSearchHit[] | null {
    if (!this.isReady()) return null;
    const trimmed = term.trim();
    if (!trimmed) return [];
    if (this.ftsAvailable) {
      // Quote each token to neutralize FTS5 query syntax; trailing * gives the
      // prefix behavior MiniSearch users are used to.
      const match = trimmed
        .split(/\s+/)
        .map((token) => `"${token.replaceAll('"', '""')}"*`)
        .join(" ");
      try {
        // Join against the records table so every hit is re-validated in the
        // same query: an orphaned FTS row (index-internal drift) or a row that
        // turned archived/invalid can never surface as a search result. The
        // space scope must live in the SQL too — filtering after LIMIT would
        // let other spaces' matches crowd out in-scope hits.
        const scope = spaceId ? " AND f.space_id = ?" : "";
        const params: (string | number)[] = spaceId ? [match, spaceId, limit] : [match, limit];
        const rows = this.db!.query(
          "SELECT f.title AS title, f.space_id AS space_id, f.collection_id AS collection_id, f.record_id AS record_id, r.json AS json " +
            "FROM records_fts f JOIN records r ON r.space_id = f.space_id AND r.collection_id = f.collection_id AND r.record_id = f.record_id " +
            `WHERE records_fts MATCH ? AND r.valid = 1 AND r.archived = 0${scope} ORDER BY rank LIMIT ?`,
        ).all(...params) as { title: string; space_id: string; collection_id: string; record_id: string; json: string }[];
        this.lastSearchEngine = "fts";
        return rows.map((row) => ({
          spaceId: row.space_id,
          collectionId: row.collection_id,
          recordId: row.record_id,
          title: row.title,
          collectionName: this.collectionName(row.space_id, row.collection_id),
          data: (JSON.parse(row.json) as RecordFile).data,
        }));
      } catch (err) {
        console.error("[record-index] FTS query failed, falling back to scan:", err);
      }
    }
    this.lastSearchEngine = "scan";
    const needle = trimmed.toLowerCase();
    const scanSql = spaceId
      ? "SELECT json, space_id, collection_id, record_id FROM records WHERE valid = 1 AND archived = 0 AND space_id = ?"
      : "SELECT json, space_id, collection_id, record_id FROM records WHERE valid = 1 AND archived = 0";
    const rows = (spaceId ? this.db!.query(scanSql).all(spaceId) : this.db!.query(scanSql).all()) as { json: string; space_id: string; collection_id: string; record_id: string }[];
    const hits: RecordSearchHit[] = [];
    for (const row of rows) {
      const record = JSON.parse(row.json) as RecordFile;
      const name = this.collectionName(row.space_id, row.collection_id);
      if (`${name} ${JSON.stringify(record.data)}`.toLowerCase().includes(needle)) {
        hits.push({ spaceId: row.space_id, collectionId: row.collection_id, recordId: row.record_id, title: recordTitle(record, name), collectionName: name, data: record.data });
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  // Test hook: a stable dump of every row for equivalence comparisons.
  dumpRowsForTests(): RowShape[] {
    if (!this.db) return [];
    return this.db.query("SELECT space_id, collection_id, record_id, json, archived, valid, error, file_hash FROM records ORDER BY space_id, collection_id, record_id").all() as RowShape[];
  }
}

export const recordIndex = new RecordIndex();

export function recordIndexEnabled(): boolean {
  return process.env["WORKTABLE_RECORDS_INDEX"] !== "0";
}
