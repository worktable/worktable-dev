import { requireScope, restWriteActor } from "../auth.ts";
import { Hono } from "hono";
import { z } from "zod";
import { readSpace } from "../store.ts";
import { buildRecordCollectionSchema, createRecord, deleteRecord, getRecordDiagnostics, listIntegrityWarnings, listRecordCollections, listRecords, queryRecords, readRecord, readRecordCollectionSchema, RecordQueryError, setRecordArchive, updateRecord, writeRecordCollectionSchema } from "../record-store.ts";
import { recordIndex, recordIndexEnabled } from "../record-index.ts";
import { noteRecordMutated } from "../search-index.ts";
import { wsManager } from "../ws.ts";

export const recordsRouter = new Hono();

// Loose on purpose, mirroring the store's tolerant reader: unknown per-field
// keys and unknown TYPES from a newer Worktable must round-trip through this
// route unharmed — a strict object here silently stripped newer metadata on
// every save, and a closed type enum made any schema containing a newer type
// uneditable. Known-type validation happens in the store at write time.
const FieldSchema = z.looseObject({
  type: z.string().min(1),
  // Display name, separate from the slug key (renaming it touches schema.yaml only).
  name: z.string().optional(),
  required: z.boolean().optional(),
  values: z.array(z.string()).optional(),
  references: z.string().optional(),
  description: z.string().optional(),
  many: z.boolean().optional(),
  inverse: z.string().optional(),
  onDelete: z.enum(["restrict", "setNull", "none"]).optional(),
  unit: z.string().optional(),
});

const CollectionSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  wellKnownType: z.string().optional(),
  fields: z.record(z.string(), FieldSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.string().optional(),
});

const CreateRecordSchema = z.object({
  id: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.string().optional(),
});

const UpdateRecordSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  updatedBy: z.string().optional(),
});

async function ensureSpace(spaceId: string) {
  const { data: space, error } = await readSpace(spaceId);
  return error || !space ? error ?? "Space not found" : null;
}

recordsRouter.get("/", requireScope("records:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const error = await ensureSpace(spaceId);
  if (error) return c.json({ error, code: "NOT_FOUND" }, 404);
  return c.json({ collections: await listRecordCollections(spaceId) });
});

recordsRouter.post("/", requireScope("records:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const error = await ensureSpace(spaceId);
  if (error) return c.json({ error, code: "NOT_FOUND" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = CollectionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const id = parsed.data.id ?? ((parsed.data.name ?? "collection").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "collection");
  const existing = await readRecordCollectionSchema(spaceId, id);
  // ifAbsent=true is the strict-create contract (used by the web UI): the
  // default upsert would let a colliding name silently edit the existing
  // collection's schema. The store enforces it under the schema write lock,
  // so racing creates cannot both pass.
  const ifAbsent = c.req.query("ifAbsent") === "true";
  if (existing.data && ifAbsent) {
    return c.json({ error: `Collection "${id}" already exists`, code: "CONFLICT" }, 409);
  }
  const schema = buildRecordCollectionSchema({ id, name: parsed.data.name ?? id, description: parsed.data.description, wellKnownType: parsed.data.wellKnownType, fields: parsed.data.fields, metadata: parsed.data.metadata, createdBy: restWriteActor(c, parsed.data.createdBy), existing: existing.data ?? undefined });
  const result = await writeRecordCollectionSchema(spaceId, schema, { ifAbsent });
  if (result.conflict) return c.json({ error: result.error ?? `Collection "${id}" already exists`, code: "CONFLICT" }, 409);
  if (result.error || !result.data) return c.json({ error: result.error ?? "Write failed", code: "VALIDATION_ERROR" }, 400);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_collection_update", spaceId, collectionId: id, data: result.data });
  return c.json({ collection: result.data }, existing.data ? 200 : 201);
});

recordsRouter.get("/:collectionId", requireScope("records:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const collectionId = c.req.param("collectionId") ?? "";
  const error = await ensureSpace(spaceId);
  if (error) return c.json({ error, code: "NOT_FOUND" }, 404);
  const includeArchived = c.req.query("includeArchived") === "true";
  // includeRecords=false is the metadata read (schema + health) for clients
  // that page rows through /query — it must not ship the whole collection.
  // listRecords still runs either way: with the index off, it is the file
  // scan that refreshes the diagnostics cache, and a warm-but-stale cache
  // would otherwise keep reporting an old clean state after a file on disk
  // turned unreadable. Only the response payload is dropped.
  const includeRecords = c.req.query("includeRecords") !== "false";
  const records = await listRecords(spaceId, collectionId, { includeArchived });
  const schema = await readRecordCollectionSchema(spaceId, collectionId);
  const diagnostics = await getRecordDiagnostics(spaceId, collectionId);
  const integrity = await listIntegrityWarnings(spaceId, collectionId);
  const projection = await recordIndex.collectionHealth(spaceId, collectionId);
  return c.json({
    ...(includeRecords ? { records } : {}),
    schema: schema.data,
    diagnostics,
    integrityWarnings: integrity.warnings,
    integrityWarningsComplete: integrity.complete,
    projection,
  });
});

recordsRouter.post("/:collectionId/query", requireScope("records:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const collectionId = c.req.param("collectionId") ?? "";
  const error = await ensureSpace(spaceId);
  if (error) return c.json({ error, code: "NOT_FOUND" }, 404);
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await queryRecords(spaceId, collectionId, body ?? {}));
  } catch (err) {
    if (err instanceof RecordQueryError) return c.json({ error: err.message, code: "VALIDATION_ERROR" }, 400);
    throw err;
  }
});

recordsRouter.post("/:collectionId/reconcile", requireScope("records:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const collectionId = c.req.param("collectionId") ?? "";
  const error = await ensureSpace(spaceId);
  if (error) return c.json({ error, code: "NOT_FOUND" }, 404);
  if (!recordIndexEnabled() || !recordIndex.isReady()) {
    return c.json({ error: "The record projection is unavailable or still indexing", code: "PROJECTION_DISABLED" }, 503);
  }
  const projection = await recordIndex.reconcileCollection(spaceId, collectionId);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_collection_update", spaceId, collectionId });
  return c.json({ ok: true, projection });
});

recordsRouter.post("/:collectionId", requireScope("records:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const collectionId = c.req.param("collectionId") ?? "";
  const body = await c.req.json().catch(() => null);
  const parsed = CreateRecordSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const result = await createRecord(spaceId, collectionId, { ...parsed.data, createdBy: restWriteActor(c, parsed.data.createdBy) });
  if (result.error || !result.data) return c.json({ error: result.error ?? "Write failed", code: "VALIDATION_ERROR" }, 400);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_update", spaceId, collectionId, recordId: result.data.id, data: result.data });
  return c.json({ record: result.data, recordId: result.data.id }, 201);
});

recordsRouter.get("/:collectionId/:recordId", requireScope("records:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const collectionId = c.req.param("collectionId") ?? "";
  const recordId = c.req.param("recordId") ?? "";
  const { data, error } = await readRecord(spaceId, collectionId, recordId);
  if (error || !data) return c.json({ error: error ?? "Record not found", code: "NOT_FOUND" }, 404);
  return c.json({ record: data });
});

recordsRouter.patch("/:collectionId/:recordId", requireScope("records:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const collectionId = c.req.param("collectionId") ?? "";
  const recordId = c.req.param("recordId") ?? "";
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateRecordSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const result = await updateRecord(spaceId, collectionId, recordId, { ...parsed.data, updatedBy: restWriteActor(c, parsed.data.updatedBy) });
  if (result.error || !result.data) return c.json({ error: result.error ?? "Update failed", code: "VALIDATION_ERROR" }, 400);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_update", spaceId, collectionId, recordId, data: result.data });
  return c.json({ record: result.data });
});

// Archive/restore mirror the widget routes: archived records stay on disk
// and in queries behind includeArchived, unlike delete.
recordsRouter.post("/:collectionId/:recordId/archive", requireScope("records:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const collectionId = c.req.param("collectionId") ?? "";
  const recordId = c.req.param("recordId") ?? "";
  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason : undefined;
  const archivedBy = typeof body?.archivedBy === "string" ? body.archivedBy : undefined;
  const result = await setRecordArchive(spaceId, collectionId, recordId, { archivedBy: restWriteActor(c, archivedBy), ...(reason ? { reason } : {}) });
  if (result.error || !result.data) return c.json({ error: result.error ?? "Archive failed", code: "NOT_FOUND" }, 404);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_update", spaceId, collectionId, recordId, data: result.data });
  return c.json({ ok: true, record: result.data });
});

recordsRouter.post("/:collectionId/:recordId/restore", requireScope("records:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const collectionId = c.req.param("collectionId") ?? "";
  const recordId = c.req.param("recordId") ?? "";
  const result = await setRecordArchive(spaceId, collectionId, recordId, null, restWriteActor(c));
  if (result.error || !result.data) return c.json({ error: result.error ?? "Restore failed", code: "NOT_FOUND" }, 404);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_update", spaceId, collectionId, recordId, data: result.data });
  return c.json({ ok: true, record: result.data });
});

recordsRouter.delete("/:collectionId/:recordId", requireScope("records:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const collectionId = c.req.param("collectionId") ?? "";
  const recordId = c.req.param("recordId") ?? "";
  const result = await deleteRecord(spaceId, collectionId, recordId);
  if (result.error) return c.json({ error: result.error, code: "CONFLICT" }, 409);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_deleted", spaceId, collectionId, recordId });
  return c.json({ ok: true });
});
