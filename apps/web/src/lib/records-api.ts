import type {
  RecordCollectionProjectionHealth,
  RecordCollectionReconcileResult,
  RecordCollectionSchema,
  RecordCollectionSummary,
  RecordDiagnostic,
  RecordFile,
  RecordQuery,
  RecordQueryResult,
} from "@worktable/types"
import { fetchJSON } from "./http.ts"

/** Dangling-relation warning from the server's integrity sweep. */
export interface RecordIntegrityWarning {
  recordId: string
  field: string
  target: string
}

export interface RecordCollectionHealth {
  schema?: RecordCollectionSchema
  diagnostics?: RecordDiagnostic[]
  integrityWarnings?: RecordIntegrityWarning[]
  integrityWarningsComplete?: boolean
  projection?: RecordCollectionProjectionHealth
}

export interface RecordListResponse extends RecordCollectionHealth {
  records: RecordFile[]
}

export function listRecordCollections(spaceId: string) {
  return fetchJSON<{ collections: RecordCollectionSummary[] }>(`/api/spaces/${spaceId}/records`).then((r) => r.collections)
}

export function listRecords(spaceId: string, collectionId: string, opts?: { includeArchived?: boolean }) {
  const params = new URLSearchParams()
  if (opts?.includeArchived !== undefined) params.set("includeArchived", String(opts.includeArchived))
  const suffix = params.toString() ? `?${params.toString()}` : ""
  return fetchJSON<RecordListResponse>(`/api/spaces/${spaceId}/records/${collectionId}${suffix}`)
}

/** Schema + health (diagnostics, integrity warnings) WITHOUT the records
 *  payload — the metadata read for surfaces that page rows through /query. */
export function getRecordCollectionHealth(spaceId: string, collectionId: string) {
  return fetchJSON<RecordCollectionHealth>(`/api/spaces/${spaceId}/records/${collectionId}?includeRecords=false`)
}

export function reconcileRecordCollection(spaceId: string, collectionId: string) {
  return fetchJSON<{ ok: boolean; projection: RecordCollectionReconcileResult }>(
    `/api/spaces/${spaceId}/records/${collectionId}/reconcile`,
    { method: "POST" }
  ).then((r) => r.projection)
}

/** Run the shared record query grammar (filters, search, multi-sort, expand, cursors). */
export function queryRecords(spaceId: string, collectionId: string, query: RecordQuery) {
  return fetchJSON<RecordQueryResult>(`/api/spaces/${spaceId}/records/${collectionId}/query`, {
    method: "POST",
    body: JSON.stringify(query),
  })
}

export function readRecord(spaceId: string, collectionId: string, recordId: string) {
  // Encoded as a single path segment: record ids are canonical slugs, but a
  // hostile value must not be able to rewrite the path shape.
  return fetchJSON<{ record: RecordFile }>(
    `/api/spaces/${spaceId}/records/${collectionId}/${encodeURIComponent(recordId)}`
  ).then((r) => r.record)
}

/** Upsert an existing collection's schema (name, description, fields). The
 *  server's conforming-row gate rejects field changes that would break
 *  existing records, with per-record diagnostics in the error message. */
export function updateRecordCollection(
  spaceId: string,
  data: { id: string; name?: string; description?: string; wellKnownType?: string; fields?: RecordCollectionSchema["fields"] }
) {
  return fetchJSON<{ collection: RecordCollectionSchema }>(`/api/spaces/${spaceId}/records`, {
    method: "POST",
    body: JSON.stringify(data),
  }).then((r) => r.collection)
}

export function createRecordCollection(
  spaceId: string,
  data: { id?: string; name: string; description?: string; fields?: RecordCollectionSchema["fields"]; metadata?: Record<string, unknown> }
) {
  // ifAbsent: strict create — the server 409s instead of upserting when the
  // slug already exists (enforced under the store's write lock).
  return fetchJSON<{ collection: RecordCollectionSchema }>(`/api/spaces/${spaceId}/records?ifAbsent=true`, {
    method: "POST",
    body: JSON.stringify(data),
  }).then((r) => r.collection)
}

export function createRecord(
  spaceId: string,
  collectionId: string,
  data: { id?: string; data: Record<string, unknown>; metadata?: Record<string, unknown> }
) {
  return fetchJSON<{ record: RecordFile; recordId: string }>(`/api/spaces/${spaceId}/records/${collectionId}`, {
    method: "POST",
    body: JSON.stringify(data),
  })
}

export function updateRecord(
  spaceId: string,
  collectionId: string,
  recordId: string,
  data: { data?: Record<string, unknown>; metadata?: Record<string, unknown> }
) {
  return fetchJSON<{ record: RecordFile }>(`/api/spaces/${spaceId}/records/${collectionId}/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  }).then((r) => r.record)
}

/** Deletes fail with 409 CONFLICT when an inbound `onDelete: restrict` relation blocks them. */
export function deleteRecord(spaceId: string, collectionId: string, recordId: string) {
  return fetchJSON<{ ok: boolean }>(`/api/spaces/${spaceId}/records/${collectionId}/${recordId}`, {
    method: "DELETE",
  })
}

export function archiveRecord(spaceId: string, collectionId: string, recordId: string, reason?: string) {
  return fetchJSON<{ ok: boolean; record: RecordFile }>(
    `/api/spaces/${spaceId}/records/${collectionId}/${encodeURIComponent(recordId)}/archive`,
    { method: "POST", body: JSON.stringify(reason ? { reason } : {}) }
  ).then((r) => r.record)
}

export function restoreRecord(spaceId: string, collectionId: string, recordId: string) {
  return fetchJSON<{ ok: boolean; record: RecordFile }>(
    `/api/spaces/${spaceId}/records/${collectionId}/${encodeURIComponent(recordId)}/restore`,
    { method: "POST" }
  ).then((r) => r.record)
}
