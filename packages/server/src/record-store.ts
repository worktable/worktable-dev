import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CanonicalIdSchema, normalizeRecordFieldType, parseDocumentReference, RecordCollectionSchemaSchema, RecordFileSchema, RecordQuerySchema, requiresSchemaV2, WidgetIdSchema, type RecordCollectionSchema, type RecordCollectionSummary, type RecordDiagnostic, type RecordFile, type RecordQuery, type RecordQueryResult } from "@worktable/types";
import { readDocAliases, resolveDocAliasIn } from "./doc-aliases.ts";
import { compareForOrder, fieldValue, isMissing, RecordQueryShapeError, referencedCollections, runQueryV2, usesQueryV2 } from "./record-query.ts";
import { notifyRecordChanged } from "./record-events.ts";
import { recordIndex, recordIndexEnabled } from "./record-index.ts";
import { atomicWriteText, deduplicateSlug, ensureSpaceDirectories, getSpacesBaseDir, slugify, withStoreWriteLock } from "./store.ts";
import { parseCanonicalYaml, stringifyCanonicalYaml } from "./yaml.ts";

export type { RecordQuery } from "@worktable/types";

export class RecordQueryError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid record query: ${issues.join("; ")}`);
    this.name = "RecordQueryError";
    this.issues = issues;
  }
}

// The single validation gate for record queries. Every read path (REST, widget
// bridge, MCP) flows through listRecords, which calls this — so caps like the
// max limit cannot be bypassed by a caller that skips route-level validation.
export function parseRecordQuery(input: unknown): RecordQuery {
  const parsed = RecordQuerySchema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new RecordQueryError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`));
  }
  return parsed.data;
}

function isCanonicalId(id: string): boolean {
  return CanonicalIdSchema.safeParse(id).success;
}

function invalidIdError(kind: string, id: string): string {
  return `Invalid ${kind} id: ${id}`;
}

function spaceDir(spaceId: string): string {
  return join(getSpacesBaseDir(), spaceId);
}

function recordsDir(spaceId: string): string {
  return join(spaceDir(spaceId), "records");
}

function collectionDir(spaceId: string, collectionId: string): string {
  return join(recordsDir(spaceId), collectionId);
}

function schemaPath(spaceId: string, collectionId: string): string {
  return join(collectionDir(spaceId, collectionId), "schema.yaml");
}

/** The per-field properties that affect record VALIDATION (name,
 *  description, unit, inverse, and onDelete do not — onDelete matters at
 *  delete time, not write time). The gate scans rows only when one of
 *  these changes. */
function validationProjection(field: RecordCollectionSchema["fields"][string]): Record<string, unknown> {
  return {
    type: field.type,
    required: field.required ?? false,
    values: field.values ?? null,
    references: field.references ?? null,
    many: field.many ?? false,
  };
}

/** Lock shared by record writes and schema writes: the conforming-row gate
 *  must not race a record landing between its scan and the schema write.
 *  Lock ordering is acyclic: record writers hold their per-record (or
 *  #create) lock, THEN this gate; the schema writer holds this gate, THEN
 *  the schema file lock — record writers never take the schema file lock. */
function schemaGateKey(spaceId: string, collectionId: string): string {
  return `${collectionDir(spaceId, collectionId)}#schema-gate`;
}

function recordPath(spaceId: string, collectionId: string, recordId: string): string {
  return join(collectionDir(spaceId, collectionId), `${recordId}.yaml`);
}

async function readYamlFile(path: string): Promise<unknown> {
  return parseCanonicalYaml(await Bun.file(path).text());
}

async function writeTextFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withStoreWriteLock(path, () => atomicWriteText(path, value));
}

async function ensureRecordDirs(spaceId: string, collectionId?: string): Promise<void> {
  await ensureSpaceDirectories(spaceId);
  await mkdir(collectionId ? collectionDir(spaceId, collectionId) : recordsDir(spaceId), { recursive: true });
}

export function buildRecordCollectionSchema(input: {
  id: string;
  name?: string;
  description?: string;
  fields?: RecordCollectionSchema["fields"];
  wellKnownType?: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
  existing?: RecordCollectionSchema;
}): RecordCollectionSchema {
  const now = new Date().toISOString();
  const fields = input.fields ?? input.existing?.fields ?? {};
  return {
    // Spread the existing schema first so keys (and versions) written by a newer
    // Worktable survive an edit from this one instead of being silently dropped.
    ...(input.existing ?? {}),
    // Stamp the lowest version the fields actually require: collections using
    // only v1 types stay version 1 (readable on every Worktable ever shipped);
    // v2 types/metadata bump to 2. Never downgrade a newer server's stamp.
    version: Math.max(input.existing?.version ?? 1, requiresSchemaV2(fields) ? 2 : 1),
    kind: "worktable.recordSchema",
    id: input.id,
    name: input.name ?? input.existing?.name ?? input.id,
    description: input.description ?? input.existing?.description,
    wellKnownType: input.wellKnownType ?? input.existing?.wellKnownType,
    fields,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    createdBy: input.existing?.createdBy ?? input.createdBy ?? "user",
    updatedBy: input.existing ? input.createdBy ?? "user" : undefined,
    metadata: input.metadata ?? input.existing?.metadata ?? {},
  };
}

export function buildRecordFile(input: {
  id: string;
  collectionId: string;
  data: Record<string, unknown>;
  createdBy?: string;
  metadata?: Record<string, unknown>;
  existing?: RecordFile;
}): RecordFile {
  const now = new Date().toISOString();
  return {
    // Same tolerance rule as buildRecordCollectionSchema: preserve unknown keys
    // and the version stamped by a newer Worktable across read-modify-writes.
    ...(input.existing ?? {}),
    version: input.existing?.version ?? 1,
    kind: "worktable.record",
    id: input.id,
    collectionId: input.collectionId,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    createdBy: input.existing?.createdBy ?? input.createdBy ?? "user",
    updatedBy: input.existing ? input.createdBy ?? "user" : undefined,
    archive: input.existing?.archive ?? null,
    metadata: input.metadata ?? input.existing?.metadata ?? {},
    data: input.data,
  };
}

export async function listRecordCollections(spaceId: string): Promise<RecordCollectionSummary[]> {
  if (!isCanonicalId(spaceId)) return [];
  const dir = recordsDir(spaceId);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const summaries: RecordCollectionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isCanonicalId(entry.name)) continue;
    const records = await listRecords(spaceId, entry.name, { includeArchived: false });
    const schema = await readRecordCollectionSchema(spaceId, entry.name);
    summaries.push({
      id: entry.name,
      name: schema.data?.name ?? entry.name,
      description: schema.data?.description,
      count: records.length,
      ...(schema.data ? { schema: schema.data } : {}),
    });
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readRecordCollectionSchema(spaceId: string, collectionId: string): Promise<{ data: RecordCollectionSchema | null; error: string | null }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  if (!isCanonicalId(collectionId)) return { data: null, error: invalidIdError("collection", collectionId) };
  const path = schemaPath(spaceId, collectionId);
  if (!existsSync(path)) return { data: null, error: null };
  try {
    return { data: RecordCollectionSchemaSchema.parse(await readYamlFile(path)), error: null };
  } catch (error) {
    return { data: null, error: `Failed to parse record schema: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function writeRecordCollectionSchema(
  spaceId: string,
  schema: RecordCollectionSchema,
  opts?: { ifAbsent?: boolean }
): Promise<{ data: RecordCollectionSchema | null; error: string | null; conflict?: boolean }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  const parsed = RecordCollectionSchemaSchema.safeParse(schema);
  if (!parsed.success) return { data: null, error: parsed.error.message };
  for (const [name, spec] of Object.entries(parsed.data.fields)) {
    // Contradictory policy: deleting the target must clear the field, but the
    // field may not be empty. Rejecting at schema save keeps deletes decidable.
    if (normalizeRecordFieldType(spec.type) === "relation" && spec.onDelete === "setNull" && spec.required) {
      return { data: null, error: `Field ${name} cannot be required with onDelete: setNull — deleting its target must be able to clear it` };
    }
  }
  await ensureRecordDirs(spaceId, parsed.data.id);
  const path = schemaPath(spaceId, parsed.data.id);
  // The whole gate + write runs under the collection's SCHEMA GATE lock,
  // which record writes also take (writeRecordInner): a record created or
  // edited between the conforming-row scan and the schema write would
  // otherwise slip past the gate and land newly invalid.
  let conflict = false;
  let gateError: string | null = null;
  await withStoreWriteLock(schemaGateKey(spaceId, parsed.data.id), async () => {
    // Strict-create (ifAbsent) conflicts come FIRST: a duplicate create must
    // 409 per its contract, not surface the gate's 400 about rows it was
    // never allowed to adopt. The check runs inside the gate lock, so two
    // racing creates cannot both pass and the answer cannot change before
    // the write below. A collection exists when its schema file does OR its
    // directory has any content — schemaless collections are real
    // collections and a strict create must not silently adopt them (the dir
    // itself is no signal: ensureRecordDirs above just created it).
    if (opts?.ifAbsent) {
      const entries = existsSync(path) ? ["schema.yaml"] : await readdir(dirname(path)).catch(() => []);
      if (entries.length > 0) {
        conflict = true;
        return;
      }
    }
    // Conforming-row gate (the storage decision's "schema evolution routes
    // through one gate"): a field change that would break EXISTING records
    // is rejected with per-record diagnostics, never applied silently.
    // Evaluated PER FIELD: only fields whose validation-relevant properties
    // changed are scanned, so (a) display-only edits (name, description,
    // unit, inverse, onDelete) skip the row scan entirely instead of holding
    // the gate lock over a full listRecords, and (b) a row's unrelated
    // pre-existing drift on some OTHER field cannot mask new breakage
    // (whole-schema validation returns only the first error). A null
    // previous schema counts as "everything conformed", so the FIRST schema
    // on a schemaless collection is gated too. Applies to every API caller
    // (REST + MCP) via this single writer; direct file edits still bypass
    // by design and surface as diagnostics.
    const previous = (await readRecordCollectionSchema(spaceId, parsed.data.id)).data;
    const changedKeys = Object.keys(parsed.data.fields).filter((key) => {
      const next = validationProjection(parsed.data.fields[key]!);
      const prev = previous?.fields[key] ? validationProjection(previous.fields[key]!) : null;
      return JSON.stringify(next) !== JSON.stringify(prev);
    });
    if (changedKeys.length > 0) {
      // File-truth scan, same rule as delete-policy resolution: listRecords
      // can serve the index, and a just-edited YAML file the watcher hasn't
      // ingested yet would evade the gate. Unreadable files are pre-existing
      // damage (already surfaced as diagnostics) and don't block the change.
      const rows: RecordFile[] = [];
      const dir = collectionDir(spaceId, parsed.data.id);
      if (existsSync(dir)) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".yaml") || entry.name === "schema.yaml") continue;
          const rowId = entry.name.replace(/\.yaml$/, "");
          if (!isCanonicalId(rowId)) continue;
          const { data: row } = await readRecord(spaceId, parsed.data.id, rowId);
          if (row) rows.push(row);
        }
      }
      const broken: { recordId: string; error: string }[] = [];
      for (const row of rows) {
        for (const key of changedKeys) {
          const newError = validateAgainstSchema(row.data, { ...parsed.data, fields: { [key]: parsed.data.fields[key]! } });
          if (!newError) continue;
          // Same single-field failure under the OLD spec = pre-existing
          // drift on THIS field; a brand-new field has no old constraint.
          const oldSpec = previous?.fields[key];
          const oldError = oldSpec ? validateAgainstSchema(row.data, { ...previous!, fields: { [key]: oldSpec } }) : null;
          if (oldError) continue;
          broken.push({ recordId: row.id, error: newError });
          break;
        }
      }
      if (broken.length > 0) {
        const preview = broken.slice(0, 5).map((entry) => `${entry.recordId}: ${entry.error}`).join("; ");
        gateError = `Schema change would break ${broken.length} existing record(s) — fix the records first or loosen the change. ${preview}${broken.length > 5 ? "; …" : ""}`;
        return;
      }
    }
    await withStoreWriteLock(path, async () => {
      await mkdir(dirname(path), { recursive: true });
      await atomicWriteText(path, stringifyCanonicalYaml(parsed.data));
    });
  });
  if (gateError) {
    return { data: null, error: gateError };
  }
  if (conflict) {
    return { data: null, error: `Collection "${parsed.data.id}" already exists`, conflict: true };
  }
  notifyRecordChanged({ kind: "collection", spaceId, collectionId: parsed.data.id });
  return { data: parsed.data, error: null };
}

function validateAgainstSchema(data: Record<string, unknown>, schema: RecordCollectionSchema | null): string | null {
  if (!schema) return null;
  for (const [field, spec] of Object.entries(schema.fields)) {
    const value = data[field];
    const type = normalizeRecordFieldType(spec.type);
    const emptyRequiredSelection = Array.isArray(value) && value.length === 0 && (
      type === "multi_select" || ((type === "relation" || type === "document") && spec.many)
    );
    if (spec.required && (value === undefined || value === null || value === "" || emptyRequiredSelection)) return `Missing required field: ${field}`;
    if (value === undefined || value === null) continue;
    // Read-lift: v1 spellings (enum, reference) validate with their original,
    // looser rules below; the normalized type drives everything else.
    if ((type === "string" || type === "text" || type === "person") && typeof value !== "string") return `Field ${field} must be a string`;
    if (type === "number" && typeof value !== "number") return `Field ${field} must be a number`;
    if (type === "boolean" && typeof value !== "boolean") return `Field ${field} must be a boolean`;
    if (type === "select") {
      if (typeof value !== "string") return spec.type === "enum" ? `Field ${field} must be an enum string` : `Field ${field} must be a select string`;
      if (spec.values && !spec.values.includes(value)) return `Field ${field} must be one of: ${spec.values.join(", ")}`;
    }
    if (type === "multi_select") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return `Field ${field} must be an array of strings`;
      if (spec.values) {
        const invalid = (value as string[]).find((entry) => !spec.values!.includes(entry));
        if (invalid !== undefined) return `Field ${field} values must be one of: ${spec.values.join(", ")}`;
      }
    }
    if ((type === "date" || type === "datetime") && typeof value !== "string") return `Field ${field} must be a ${type} string`;
    if (type === "url") {
      if (typeof value !== "string") return `Field ${field} must be a URL string`;
      try {
        new URL(value);
      } catch {
        return `Field ${field} must be a valid URL`;
      }
    }
    if (type === "email" && (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return `Field ${field} must be a valid email address`;
    if (type === "relation") {
      if (spec.type === "reference") {
        // v1 reference only ever required a string — keep that contract for
        // existing data; canonical-id enforcement applies to v2 relations only.
        if (typeof value !== "string") return `Field ${field} must be a record id string`;
      } else if (spec.many) {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !isCanonicalId(entry))) return `Field ${field} must be an array of record ids`;
      } else if (typeof value !== "string" || !isCanonicalId(value)) {
        return `Field ${field} must be a record id`;
      }
    }
    if (type === "document") {
      const values = spec.many ? value : [value];
      if (!Array.isArray(values)) return `Field ${field} must be ${spec.many ? "an array of document paths" : "a document path"}`;
      for (const entry of values) {
        const parsed = parseDocumentReference(entry);
        if ("error" in parsed) return `Field ${field} ${parsed.error}`;
        if (parsed.path !== entry) return `Field ${field} must use canonical document path ${parsed.path}`;
      }
    }
    if (type === "json") {
      // json is the structured escape hatch: accept any value, but make the type
      // intentional rather than a silent no-op by rejecting non-serializable input.
      try {
        JSON.stringify(value);
      } catch {
        return `Field ${field} must be JSON-serializable`;
      }
    }
  }
  return null;
}

function normalizeDocumentFields(data: Record<string, unknown>, schema: RecordCollectionSchema | null): { data?: Record<string, unknown>; error?: string } {
  if (!schema) return { data };
  const normalized = { ...data };
  for (const [field, spec] of Object.entries(schema.fields)) {
    if (normalizeRecordFieldType(spec.type) !== "document") continue;
    const value = normalized[field];
    if (value === undefined || value === null || value === "") continue;
    const entries = spec.many ? value : [value];
    if (!Array.isArray(entries)) return { error: `Field ${field} must be ${spec.many ? "an array of document paths" : "a document path"}` };
    const paths: string[] = [];
    for (const entry of entries) {
      const parsed = parseDocumentReference(entry);
      if ("error" in parsed) return { error: `Field ${field} ${parsed.error}` };
      paths.push(parsed.path);
    }
    normalized[field] = spec.many ? paths : paths[0];
  }
  return { data: normalized };
}

// Diagnostics for record files that exist on disk but can't be served (parse or
// schema failures). Refreshed on every collection scan so callers can surface
// "N files excluded" instead of results silently shrinking. Keyed per collection.
const scanDiagnostics = new Map<string, RecordDiagnostic[]>();
const loggedDiagnostics = new Set<string>();

function diagnosticsKey(spaceId: string, collectionId: string): string {
  return `${spaceId}/${collectionId}`;
}

function recordDiagnostic(diagnostics: RecordDiagnostic[], file: string, error: string, key: string): void {
  diagnostics.push({ file, error });
  const logKey = `${key}/${file}:${error}`;
  if (!loggedDiagnostics.has(logKey)) {
    loggedDiagnostics.add(logKey);
    console.warn(`[records] Excluding unreadable record file ${key}/${file}: ${error}`);
  }
}

// Diagnostics are keyed by space/collection only, so tests that reuse ids across
// temp workspaces must clear them between cases (wired into test-setup.ts).
export function resetRecordDiagnosticsForTests(): void {
  scanDiagnostics.clear();
  loggedDiagnostics.clear();
}

// Returns the diagnostics from the most recent scan of the collection, scanning
// now if this collection has not been listed yet this process.
export async function getRecordDiagnostics(spaceId: string, collectionId: string): Promise<RecordDiagnostic[]> {
  const key = diagnosticsKey(spaceId, collectionId);
  if (!scanDiagnostics.has(key)) await listRecords(spaceId, collectionId, { includeArchived: true });
  return scanDiagnostics.get(key) ?? [];
}

/**
 * Find at most one record while inspecting no more than `maxFiles` record
 * files. This is for best-effort lookups where a full collection scan would be
 * disproportionate; canonical queries should continue to use listRecords.
 */
export async function findRecordBounded(
  spaceId: string,
  collectionId: string,
  predicate: (record: RecordFile) => boolean,
  options: { includeArchived?: boolean; maxFiles: number }
): Promise<RecordFile | null> {
  if (!isCanonicalId(spaceId) || !isCanonicalId(collectionId)) return null;
  if (!Number.isFinite(options.maxFiles)) return null;
  const maxFiles = Math.max(0, Math.floor(options.maxFiles));
  if (maxFiles === 0) return null;
  const dir = collectionDir(spaceId, collectionId);
  if (!existsSync(dir)) return null;

  const entries = await readdir(dir, { withFileTypes: true });
  let inspected = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml") || entry.name === "schema.yaml") continue;
    if (inspected >= maxFiles) break;
    inspected += 1;
    const result = await readRecord(spaceId, collectionId, entry.name.replace(/\.yaml$/, ""));
    if (!result.data || (!options.includeArchived && result.data.archive)) continue;
    if (predicate(result.data)) return result.data;
  }
  return null;
}

export async function listRecords(spaceId: string, collectionId: string, query: RecordQuery = {}): Promise<RecordFile[]> {
  const safeQuery = parseRecordQuery(query);
  if (!isCanonicalId(spaceId) || !isCanonicalId(collectionId)) return [];
  const key = diagnosticsKey(spaceId, collectionId);
  const dir = collectionDir(spaceId, collectionId);
  if (!existsSync(dir)) {
    // A collection that no longer exists has no records and no diagnostics —
    // drop any cached diagnostics, and heal the index: deleting a whole
    // directory emits no per-file watcher events, so without this its rows
    // would keep serving ghost records until a full rebuild.
    scanDiagnostics.delete(key);
    if (recordIndex.isStarted()) recordIndex.dropCollection(spaceId, collectionId);
    return [];
  }
  const schemaResult = await readRecordCollectionSchema(spaceId, collectionId);
  const fields = schemaResult.data?.fields;
  const documentFilterKeys = Object.keys(safeQuery.where ?? {}).filter(
    (field) => fields?.[field] && normalizeRecordFieldType(fields[field].type) === "document",
  );
  const aliases = documentFilterKeys.length > 0 ? (await readDocAliases(spaceId)).aliases : null;
  const resolveDocumentPath = aliases
    ? (path: string) => resolveDocAliasIn(aliases, path) ?? path
    : undefined;

  // Read path: the record index serves collection reads once its initial build
  // completes (rows are byte-equivalent to parsing the files, and filterRecords
  // below is the same code either way). Files remain the write path and the
  // fallback — WORKTABLE_RECORDS_INDEX=0 forces the file scan.
  if (recordIndexEnabled() && recordIndex.isReady()) {
    const rows = recordIndex.listCollection(spaceId, collectionId, safeQuery.includeArchived ?? false);
    if (rows) {
      const indexDiagnostics = recordIndex.listDiagnostics(spaceId, collectionId) ?? [];
      const diagnostics: RecordDiagnostic[] = [];
      for (const diagnostic of indexDiagnostics) recordDiagnostic(diagnostics, diagnostic.file, diagnostic.error, key);
      if (schemaResult.error) recordDiagnostic(diagnostics, "schema.yaml", schemaResult.error, key);
      scanDiagnostics.set(key, diagnostics);
      return filterRecords(rows, safeQuery, fields, resolveDocumentPath);
    }
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const diagnostics: RecordDiagnostic[] = [];
  let records: RecordFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml") || entry.name === "schema.yaml") continue;
    const recordId = entry.name.replace(/\.yaml$/, "");
    const result = await readRecord(spaceId, collectionId, recordId);
    if (!result.data) {
      recordDiagnostic(diagnostics, entry.name, result.error ?? "Unreadable record file", key);
      continue;
    }
    if (!safeQuery.includeArchived && result.data.archive) continue;
    records.push(result.data);
  }
  if (schemaResult.error) recordDiagnostic(diagnostics, "schema.yaml", schemaResult.error, key);
  scanDiagnostics.set(key, diagnostics);
  records = filterRecords(records, safeQuery, fields, resolveDocumentPath);
  return records;
}

/**
 * Rebind the machine-local projection after a prepared space directory is
 * atomically published under its durable id. Store writes may already have
 * projected the records under the private preparation id, while filesystem
 * watchers cannot reliably infer a directory rename. Reconciliation keeps the
 * projection disposable and makes the newly published collection queryable
 * before startup releases workspace-facing requests.
 */
export async function reconcilePublishedRecordCollection(
  preparedSpaceId: string,
  publishedSpaceId: string,
  collectionId: string,
): Promise<void> {
  if (!recordIndexEnabled() || !recordIndex.isStarted()) return;
  await recordIndex.reconcileCollection(preparedSpaceId, collectionId);
  await recordIndex.reconcileCollection(publishedSpaceId, collectionId);
}

/** Remove machine-local rows for a private preparation that was discarded. */
export async function reconcileDiscardedRecordCollection(
  preparedSpaceId: string,
  collectionId: string,
): Promise<void> {
  if (!recordIndexEnabled() || !recordIndex.isStarted()) return;
  await recordIndex.reconcileCollection(preparedSpaceId, collectionId);
}

// The full query surface: legacy queries delegate to listRecords (original
// semantics, forever); any v2 feature (predicate AST, orderBy array, expand,
// backlinks, aggregate, select, cursor) runs the documented v2 evaluator.
// Cross-collection lookups resolve through listRecords, so they use the index
// or the file scan exactly like the primary collection.
export async function queryRecords(spaceId: string, collectionId: string, input: unknown): Promise<RecordQueryResult> {
  const query = parseRecordQuery(input);
  const withProjectionWarnings = async (result: RecordQueryResult, collectionIds: string[]): Promise<RecordQueryResult> => {
    const drifted: { collectionId: string; indexedFileCount: number; canonicalFileCount: number }[] = [];
    for (const targetCollectionId of new Set(collectionIds)) {
      // Full health compares exact file hashes and belongs to the explicit
      // health/reconciliation path. Queries reuse its last result so paging,
      // filtering, and relation expansion stay independent of collection size.
      const projection = recordIndex.cachedCollectionHealth(spaceId, targetCollectionId);
      if (projection?.state === "drifted") drifted.push({ collectionId: targetCollectionId, ...projection });
    }
    if (drifted.length === 0) return result;
    return {
      ...result,
      warnings: [
        ...(result.warnings ?? []),
        ...drifted.map((projection) =>
          `Record projection for collection "${projection.collectionId}" is incomplete: ${projection.indexedFileCount} of ${projection.canonicalFileCount} canonical files are indexed. Results may be incomplete until reconciliation finishes.`),
      ],
    };
  };
  if (!usesQueryV2(query)) {
    return withProjectionWarnings({ records: await listRecords(spaceId, collectionId, query) }, [collectionId]);
  }
  const schema = (await readRecordCollectionSchema(spaceId, collectionId)).data;
  const rows = await listRecords(spaceId, collectionId, { includeArchived: query.includeArchived ?? false });
  try {
    // A one-hop predicate can target a document field in another collection,
    // so every v2 query gets the same alias-aware identity comparator.
    const aliases = (await readDocAliases(spaceId)).aliases;
    // The caller's includeArchived flag governs every row the query touches:
    // expand targets, relation-path lookups, and backlink sources follow the
    // same visibility rule as the primary collection.
    const result = await runQueryV2(
      rows,
      query,
      schema?.fields,
      async (targetCollectionId) => {
        const targetRows = await listRecords(spaceId, targetCollectionId, { includeArchived: query.includeArchived ?? false });
        return new Map(targetRows.map((record) => [record.id, record]));
      },
      async (targetCollectionId) => (await readRecordCollectionSchema(spaceId, targetCollectionId)).data?.fields,
      aliases ? { resolveDocumentPath: (path) => resolveDocAliasIn(aliases, path) ?? path } : undefined,
    );
    return withProjectionWarnings(result, [collectionId, ...referencedCollections(query, schema?.fields)]);
  } catch (error) {
    if (error instanceof RecordQueryShapeError) throw new RecordQueryError([error.message]);
    throw error;
  }
}

// Collections a query reaches beyond its own — the widget bridge permission-
// gates each one before running the query.
export async function queryTargetCollections(spaceId: string, collectionId: string, input: unknown): Promise<string[]> {
  const query = parseRecordQuery(input);
  if (!usesQueryV2(query)) return [];
  const schema = (await readRecordCollectionSchema(spaceId, collectionId)).data;
  try {
    return referencedCollections(query, schema?.fields);
  } catch (error) {
    if (error instanceof RecordQueryShapeError) throw new RecordQueryError([error.message]);
    throw error;
  }
}

type FieldTypeMap = RecordCollectionSchema["fields"];

function filterRecords(
  records: RecordFile[],
  query: RecordQuery,
  fields?: FieldTypeMap,
  resolveDocumentPath?: (path: string) => string,
): RecordFile[] {
  let next = records;
  if (query.where) {
    next = next.filter((record) => Object.entries(query.where ?? {}).every(([key, expected]) => {
      const rawValue = fieldValue(record, key);
      const fieldType = fields?.[key]?.type;
      const documentField = fieldType && normalizeRecordFieldType(fieldType) === "document";
      const resolveValue = (value: unknown): unknown => {
        if (!documentField || !resolveDocumentPath) return value;
        if (typeof value === "string") return resolveDocumentPath(value);
        if (Array.isArray(value)) {
          return value.map((entry) => typeof entry === "string" ? resolveDocumentPath(entry) : entry);
        }
        return value;
      };
      const value = resolveValue(rawValue);
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        const ops = expected as Record<string, unknown>;
        const opKeys = ["in", "contains", "gt", "gte", "lt", "lte"];
        if (opKeys.some((k) => k in ops)) {
          // Apply every recognized operator with AND semantics so a range like
          // { gte, lte } bounds both ends. (The old code returned on the first
          // operator and silently ignored the rest.) A malformed operand (e.g.
          // `in` without an array, `contains` without a string) excludes the
          // record rather than matching everything.
          if ("in" in ops && (!Array.isArray(ops.in) || !ops.in.map(resolveValue).includes(value))) return false;
          if ("contains" in ops && (typeof ops.contains !== "string" || !String(value ?? "").toLowerCase().includes(ops.contains.toLowerCase()))) return false;
          // Range comparisons require BOTH a present field value and a present
          // operand. A missing field (null/undefined) must not satisfy any bound:
          // toComparable maps it to "" which would sort below numeric bounds and
          // wrongly pass lt/lte, and a null operand would otherwise match-all.
          // This restores the prior Number()/NaN exclusion behavior.
          if ("gt" in ops && (isMissing(value) || isMissing(ops.gt) || !(compareForOrder(value, ops.gt, fieldType) > 0))) return false;
          if ("gte" in ops && (isMissing(value) || isMissing(ops.gte) || !(compareForOrder(value, ops.gte, fieldType) >= 0))) return false;
          if ("lt" in ops && (isMissing(value) || isMissing(ops.lt) || !(compareForOrder(value, ops.lt, fieldType) < 0))) return false;
          if ("lte" in ops && (isMissing(value) || isMissing(ops.lte) || !(compareForOrder(value, ops.lte, fieldType) <= 0))) return false;
          return true;
        }
      }
      return value === resolveValue(expected);
    }));
  }
  if (query.search) {
    const needle = query.search.toLowerCase();
    next = next.filter((record) => JSON.stringify(record.data).toLowerCase().includes(needle));
  }
  if (typeof query.orderBy === "string") {
    const key = query.orderBy;
    const dir = query.order === "desc" ? -1 : 1;
    const fieldType = fields?.[key]?.type;
    next = [...next].sort((a, b) => compareForOrder(fieldValue(a, key), fieldValue(b, key), fieldType) * dir || a.id.localeCompare(b.id));
  } else {
    next = [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  if (typeof query.limit === "number") next = next.slice(0, Math.max(0, query.limit));
  return next;
}

export async function readRecord(spaceId: string, collectionId: string, recordId: string): Promise<{ data: RecordFile | null; error: string | null }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  if (!isCanonicalId(collectionId)) return { data: null, error: invalidIdError("collection", collectionId) };
  if (!isCanonicalId(recordId)) return { data: null, error: invalidIdError("record", recordId) };
  const path = recordPath(spaceId, collectionId, recordId);
  if (!existsSync(path)) return { data: null, error: `Record not found: ${recordId}` };
  try {
    return { data: RecordFileSchema.parse(await readYamlFile(path)), error: null };
  } catch (error) {
    return { data: null, error: `Failed to parse record: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Validate + persist a record WITHOUT acquiring the per-path write lock. Callers
// that already hold a lock across a read-modify-write (updateRecord) use this to
// avoid deadlocking the non-reentrant lock; writeRecord wraps it with the lock.
async function writeRecordInner(
  spaceId: string,
  record: RecordFile,
  opts?: { skipDataValidation?: boolean }
): Promise<{ data: RecordFile | null; error: string | null }> {
  const parsed = RecordFileSchema.safeParse(record);
  if (!parsed.success) return { data: null, error: parsed.error.message };
  return withStoreWriteLock(schemaGateKey(spaceId, parsed.data.collectionId), () => writeRecordValidated(spaceId, parsed.data, opts));
}

async function writeRecordValidated(
  spaceId: string,
  record: RecordFile,
  opts?: { skipDataValidation?: boolean }
): Promise<{ data: RecordFile | null; error: string | null }> {
  const parsed = { data: record };
  // Lifecycle-only writes (archive/restore) leave `data` untouched, so they
  // skip schema validation: a record whose data drifted invalid via a file
  // edit or schema change must still be archivable to get it out of the way.
  if (!opts?.skipDataValidation) {
    const { data: schema, error: schemaError } = await readRecordCollectionSchema(spaceId, parsed.data.collectionId);
    if (schemaError) return { data: null, error: schemaError };
    const normalized = normalizeDocumentFields(parsed.data.data, schema);
    if (normalized.error || !normalized.data) return { data: null, error: normalized.error ?? "Invalid document field" };
    parsed.data.data = normalized.data;
    const validationError = validateAgainstSchema(parsed.data.data, schema);
    if (validationError) return { data: null, error: validationError };
  }
  await ensureRecordDirs(spaceId, parsed.data.collectionId);
  const path = recordPath(spaceId, parsed.data.collectionId, parsed.data.id);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteText(path, stringifyCanonicalYaml(parsed.data));
  notifyRecordChanged({ kind: "write", spaceId, record: parsed.data });
  return { data: parsed.data, error: null };
}

export async function writeRecord(spaceId: string, record: RecordFile): Promise<{ data: RecordFile | null; error: string | null }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  return withStoreWriteLock(recordPath(spaceId, record.collectionId, record.id), () => writeRecordInner(spaceId, record));
}

export async function createRecord(spaceId: string, collectionId: string, input: { id?: string; data: Record<string, unknown>; metadata?: Record<string, unknown>; createdBy?: string }): Promise<{ data: RecordFile | null; error: string | null }> {
  if (!isCanonicalId(collectionId)) return { data: null, error: invalidIdError("collection", collectionId) };
  await ensureRecordDirs(spaceId, collectionId);
  if (input.id) {
    const record = buildRecordFile({ id: input.id, collectionId, data: input.data, metadata: input.metadata, createdBy: input.createdBy });
    return writeRecord(spaceId, record);
  }
  // Derive a unique slug under a collection-scoped lock so two concurrent creates
  // can't scan the same directory and land on the same id. writeRecord then takes
  // the (different) per-record-path lock, so there is no deadlock.
  return withStoreWriteLock(`${collectionDir(spaceId, collectionId)}#create`, async () => {
    const existing = await listRecords(spaceId, collectionId, { includeArchived: true });
    const baseId = slugify(String(input.data["title"] ?? input.data["name"] ?? "record"));
    const id = await deduplicateSlug(baseId, existing.map((record) => record.id));
    const record = buildRecordFile({ id, collectionId, data: input.data, metadata: input.metadata, createdBy: input.createdBy });
    return writeRecord(spaceId, record);
  });
}

export async function updateRecord(spaceId: string, collectionId: string, recordId: string, patch: { data?: Record<string, unknown>; metadata?: Record<string, unknown>; updatedBy?: string }): Promise<{ data: RecordFile | null; error: string | null }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  if (!isCanonicalId(collectionId)) return { data: null, error: invalidIdError("collection", collectionId) };
  if (!isCanonicalId(recordId)) return { data: null, error: invalidIdError("record", recordId) };
  // Hold the per-record lock across the whole read-modify-write so concurrent
  // patches can't read the same "before" state and lost-update each other.
  return withStoreWriteLock(recordPath(spaceId, collectionId, recordId), async () => {
    const { data: existing, error } = await readRecord(spaceId, collectionId, recordId);
    if (error || !existing) return { data: null, error: error ?? `Record not found: ${recordId}` };
    const record = buildRecordFile({ id: recordId, collectionId, data: { ...existing.data, ...(patch.data ?? {}) }, metadata: patch.metadata ?? existing.metadata, createdBy: patch.updatedBy, existing });
    return writeRecordInner(spaceId, record);
  });
}

interface InboundRelation {
  fromCollection: string;
  fromRecord: string;
  field: string;
  onDelete: "restrict" | "setNull" | "none";
}

// Every relation field elsewhere in the space that points at this record,
// with its declared delete policy. Deliberately file-truth, never the index:
// a drifted index could both falsely block (stale edge) and falsely allow
// (missed edge) a delete, and restrict is a safety promise. Deletes are rare —
// correctness over speed. The scan is bounded to collections whose schemas
// declare a relation into this one.
async function findInboundRelations(spaceId: string, collectionId: string, recordId: string): Promise<{ relations: InboundRelation[]; unverifiable: string[] }> {
  const policyOf = (schema: RecordCollectionSchema | null, field: string): InboundRelation["onDelete"] => {
    const declared = schema?.fields[field]?.onDelete;
    return declared === "restrict" || declared === "setNull" ? declared : "none";
  };

  const out: InboundRelation[] = [];
  // Files we could not read where a restrict policy might be at stake. The
  // delete fails closed on these: an unreadable schema could declare restrict
  // relations we cannot see, and an unreadable record in a restrict-declaring
  // collection could hold the blocking reference. Collections whose relations
  // into the target are only setNull/none don't fail closed — a skipped file
  // there just leaves a dangling id, which integrity warnings surface.
  const unverifiable: string[] = [];
  const spaceRecordsDir = recordsDir(spaceId);
  if (!existsSync(spaceRecordsDir)) return { relations: out, unverifiable };
  for (const collEntry of await readdir(spaceRecordsDir, { withFileTypes: true })) {
    if (!collEntry.isDirectory() || !isCanonicalId(collEntry.name)) continue;
    const fromCollection = collEntry.name;
    const schemaResult = await readRecordCollectionSchema(spaceId, fromCollection);
    if (schemaResult.error) {
      unverifiable.push(`${fromCollection}/schema.yaml`);
      continue;
    }
    const schema = schemaResult.data;
    if (!schema) continue;
    const relationFields = Object.entries(schema.fields)
      .filter(([, spec]) => normalizeRecordFieldType(spec.type) === "relation" && spec.references === collectionId)
      .map(([field]) => field);
    if (relationFields.length === 0) continue;
    const restrictAtStake = relationFields.some((field) => policyOf(schema, field) === "restrict");
    // readRecord is always file-backed — going through listRecords here would
    // serve index rows, defeating the file-truth guarantee.
    for (const fileEntry of await readdir(collectionDir(spaceId, fromCollection), { withFileTypes: true })) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(".yaml") || fileEntry.name === "schema.yaml") continue;
      const fromRecord = fileEntry.name.replace(/\.yaml$/, "");
      if (!isCanonicalId(fromRecord)) continue;
      const { data: record, error } = await readRecord(spaceId, fromCollection, fromRecord);
      if (!record) {
        // A file listed but gone by read time is a concurrent delete, not an
        // unreadable file; only parse failures make the policy unknowable.
        if (restrictAtStake && error && !error.startsWith("Record not found")) unverifiable.push(`${fromCollection}/${fromRecord}.yaml`);
        continue;
      }
      for (const field of relationFields) {
        const value = record.data[field];
        const hit = Array.isArray(value) ? value.includes(recordId) : value === recordId;
        if (hit) out.push({ fromCollection, fromRecord: record.id, field, onDelete: policyOf(schema, field) });
      }
    }
  }
  return { relations: out, unverifiable };
}

// Dangling relation targets in this collection — records whose relation fields
// point at ids that no longer exist. Index-backed. `complete: false` means the
// warnings are UNKNOWN (index off or still building), not absent — callers
// must not read an empty list as a healthy collection in that state.
export async function listIntegrityWarnings(spaceId: string, collectionId: string): Promise<{ warnings: { recordId: string; field: string; target: string }[]; complete: boolean }> {
  if (!isCanonicalId(spaceId) || !isCanonicalId(collectionId)) return { warnings: [], complete: true };
  const dangling = recordIndexEnabled() ? recordIndex.listDanglingRefs(spaceId, collectionId) : null;
  if (!dangling) return { warnings: [], complete: false };
  return { warnings: dangling.map((ref) => ({ recordId: ref.fromRecord, field: ref.field, target: `${ref.toCollection}/${ref.toRecord}` })), complete: true };
}

/** Archive (or restore, with `archive: null`) a record. Same lock discipline
 *  as updateRecord: the read-modify-write holds the per-record lock so a
 *  concurrent data patch cannot lose the archive flip or vice versa. */
export async function setRecordArchive(
  spaceId: string,
  collectionId: string,
  recordId: string,
  archive: { archivedBy?: string; reason?: string } | null,
  restoredBy = "user"
): Promise<{ data: RecordFile | null; error: string | null }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  if (!isCanonicalId(collectionId)) return { data: null, error: invalidIdError("collection", collectionId) };
  if (!isCanonicalId(recordId)) return { data: null, error: invalidIdError("record", recordId) };
  return withStoreWriteLock(recordPath(spaceId, collectionId, recordId), async () => {
    const { data: existing, error } = await readRecord(spaceId, collectionId, recordId);
    if (error || !existing) return { data: null, error: error ?? `Record not found: ${recordId}` };
    const record: RecordFile = {
      ...existing,
      // Restamp identity from the ADDRESSED path: this lifecycle write is
      // meant to work on drifted files, and a stale embedded id/collectionId
      // (manual move or edit) would otherwise steer writeRecordInner to write
      // a different path than the one being archived.
      id: recordId,
      collectionId,
      updatedAt: new Date().toISOString(),
      updatedBy: archive ? archive.archivedBy ?? "user" : restoredBy,
      archive: archive
        ? {
            archivedAt: new Date().toISOString(),
            archivedBy: archive.archivedBy ?? "user",
            ...(archive.reason ? { reason: archive.reason } : {}),
          }
        : null,
    };
    return writeRecordInner(spaceId, record, { skipDataValidation: true });
  });
}

export async function deleteRecord(spaceId: string, collectionId: string, recordId: string): Promise<{ error: string | null }> {
  if (!isCanonicalId(spaceId) || !isCanonicalId(collectionId) || !isCanonicalId(recordId)) return { error: null };
  // Idempotent: deleting a record that does not exist succeeds without policy
  // checks (a retry must not 409 on dangling references to the gone record).
  // Still notify, so a drifted index row for the missing file gets cleaned.
  if (!existsSync(recordPath(spaceId, collectionId, recordId))) {
    notifyRecordChanged({ kind: "delete", spaceId, collectionId, recordId });
    return { error: null };
  }
  // Enforce the schema-declared delete policies of every relation pointing at
  // this record before touching the file. Direct file deletions bypass this
  // (files are canonical); those surface later as integrity warnings instead.
  // Known boundary (by design): policy resolution and the file removal are
  // not one atomic step — a reference created in the window between them
  // becomes a dangling id surfaced by integrity warnings, exactly like a
  // direct file edit that bypasses the API. Closing the window would require
  // cross-file transactions, which the file-canonical architecture explicitly
  // does not promise.
  const { relations: inbound, unverifiable } = await findInboundRelations(spaceId, collectionId, recordId);
  if (unverifiable.length > 0) {
    return { error: `Cannot verify delete policies for ${recordId}: unreadable file(s) may hold restricting references (${unverifiable.slice(0, 5).join(", ")}). Fix or remove them first.` };
  }
  const blockers = inbound.filter((ref) => ref.onDelete === "restrict");
  if (blockers.length > 0) {
    const list = blockers.slice(0, 5).map((ref) => `${ref.fromCollection}/${ref.fromRecord}.${ref.field}`).join(", ");
    return { error: `Cannot delete ${recordId}: referenced by ${blockers.length} record(s) with onDelete: restrict (${list})` };
  }
  // Compute every setNull clear first and validate it against the referrer's
  // schema BEFORE applying any, so a doomed clear aborts the whole delete
  // instead of leaving the policy half-applied. Only fields that actually
  // still point at this record are touched — an edge the index remembers but
  // the file no longer confirms (drift) must not wipe a retargeted field.
  const clears: { ref: InboundRelation; next: unknown }[] = [];
  for (const ref of inbound.filter((entry) => entry.onDelete === "setNull")) {
    const { data: referrer } = await readRecord(spaceId, ref.fromCollection, ref.fromRecord);
    if (!referrer) continue;
    const value = referrer.data[ref.field];
    let next: unknown;
    if (Array.isArray(value)) {
      if (!value.includes(recordId)) continue;
      next = value.filter((entry) => entry !== recordId);
    } else if (value === recordId) {
      next = null;
    } else {
      continue;
    }
    const referrerSchema = (await readRecordCollectionSchema(spaceId, ref.fromCollection)).data;
    const validationError = validateAgainstSchema({ ...referrer.data, [ref.field]: next }, referrerSchema);
    if (validationError) {
      return { error: `Cannot delete ${recordId}: clearing ${ref.fromCollection}/${ref.fromRecord}.${ref.field} would fail validation (${validationError})` };
    }
    clears.push({ ref, next });
  }
  for (const { ref, next } of clears) {
    const result = await updateRecord(spaceId, ref.fromCollection, ref.fromRecord, { data: { [ref.field]: next }, updatedBy: "system:on-delete" });
    if (result.error) return { error: `Failed to clear reference ${ref.fromCollection}/${ref.fromRecord}.${ref.field}: ${result.error}` };
  }
  // Same per-path lock as writes and index ingests, so a delete can't
  // interleave with an in-flight ingest's read-then-upsert and resurrect
  // the row from a pre-delete file snapshot.
  await withStoreWriteLock(recordPath(spaceId, collectionId, recordId), async () => {
    await rm(recordPath(spaceId, collectionId, recordId), { force: true });
    notifyRecordChanged({ kind: "delete", spaceId, collectionId, recordId });
  });
  return { error: null };
}

export async function readWidgetState(spaceId: string, widgetId: string): Promise<Record<string, unknown>> {
  if (!isCanonicalId(spaceId)) return {};
  const {
    isHtmlDocumentPath,
    readHtmlDocumentRuntimeStateV2,
    usesHtmlDocumentStorageV2,
  } = await import("./html-document-storage-v2.ts");
  const storageV2 = await usesHtmlDocumentStorageV2();
  if (storageV2) {
    if (!isHtmlDocumentPath(widgetId)) return {};
    return readHtmlDocumentRuntimeStateV2({ spaceId, path: widgetId });
  }
  if (!WidgetIdSchema.safeParse(widgetId).success) return {};
  const path = join(spaceDir(spaceId), "widgets", widgetId, "state.yaml");
  if (!existsSync(path)) return {};
  const parsed = await readYamlFile(path);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export async function writeWidgetState(spaceId: string, widgetId: string, state: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isCanonicalId(spaceId)) throw new Error(invalidIdError("space", spaceId));
  const {
    isHtmlDocumentPath,
    usesHtmlDocumentStorageV2,
    writeHtmlDocumentRuntimeStateV2,
  } = await import("./html-document-storage-v2.ts");
  const storageV2 = await usesHtmlDocumentStorageV2();
  if (storageV2) {
    if (!isHtmlDocumentPath(widgetId))
      throw new Error(invalidIdError("widget", widgetId))
    return writeHtmlDocumentRuntimeStateV2({
      spaceId,
      path: widgetId,
      state,
    })
  }
  if (!WidgetIdSchema.safeParse(widgetId).success) throw new Error(invalidIdError("widget", widgetId));
  const path = join(spaceDir(spaceId), "widgets", widgetId, "state.yaml");
  await writeTextFile(path, stringifyCanonicalYaml(state));
  return state;
}
