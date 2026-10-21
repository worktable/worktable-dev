// The read view a share link sees: a link opens data, not a screen. The view
// filters rows on the full stored records, then hands the query engine fresh
// records that carry only granted fields, opaque ids and relation values that
// point at rows the link can also see. The visitor's query never touches a
// stored record, so no filter, sort, cursor, aggregate, expand or backlink can
// reach what the grant hides.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizeRecordFieldType, type CollectionGrant, type LinkGrant, type RecordCollectionSchema, type RecordFile, type RecordQuery } from "@worktable/types";
import { forEachLeaf, readLinkGrantSchemas, validateLinkGrant } from "./link-grant.ts";
import { filterRows, flatWhereToPredicate, isPredicateTree, parsePredicate, type FieldTypeMap } from "./record-query.ts";
import { listRecords, RecordQueryError, type RecordReadView } from "./record-store.ts";

export type LinkQueryErrorCode = "LINK_COLLECTION_NOT_AVAILABLE" | "LINK_FIELD_NOT_AVAILABLE" | "LINK_SEARCH_TOO_LONG" | "LINK_CURSOR_INVALID";

/** A query the link can't run. The message never depends on hidden data:
 *  a hidden field or collection gets the same answer as a missing one. */
export class LinkQueryError extends Error {
  readonly code: LinkQueryErrorCode;
  readonly status: 400 | 403;
  constructor(code: LinkQueryErrorCode, message: string, status: 400 | 403) {
    super(message);
    this.name = "LinkQueryError";
    this.code = code;
    this.status = status;
  }
}

const collectionNotAvailable = () => new LinkQueryError("LINK_COLLECTION_NOT_AVAILABLE", "This link can't read that collection.", 403);
const fieldNotAvailable = (name: string) => new LinkQueryError("LINK_FIELD_NOT_AVAILABLE", `This link can't read the field "${name}".`, 403);

/** The response for a failed link query, or null when the error isn't one. */
export function linkQueryFailure(error: unknown): { status: 400 | 403; body: { error: string; code: string } } | null {
  if (error instanceof LinkQueryError) return { status: error.status, body: { error: error.message, code: error.code } };
  if (error instanceof RecordQueryError) return { status: 400, body: { error: error.message, code: "VALIDATION_ERROR" } };
  return null;
}

export const LINK_SEARCH_MAX_LENGTH = 200;

// ---- Link keys ----------------------------------------------------------

/** What a link's secret key derives: the ids it shows and its cursor seals. */
export interface LinkKey {
  /** The id this link shows for a stored record. */
  recordId(collectionId: string, storedId: string): string;
  /** A tag that binds a message to this link. */
  tag(message: string): string;
}

const RECORD_ID_MEMO_LIMIT = 100_000;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Lower(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/**
 * Keys a link from its 32-byte secret. A record shows as
 * "lr-" + base32(HMAC-SHA256(key, "rec\0" + collection + "\0" + stored id))
 * cut to 120 bits: stable for the link, unrelated across links, and no help
 * in guessing the stored id (which is often a slug of the title). Keep one
 * LinkKey per link so its memo spares repeat queries the HMACs.
 */
export function createLinkKey(secret: Uint8Array): LinkKey {
  if (secret.byteLength < 32) throw new Error("A link key needs at least 32 bytes");
  const key = Buffer.from(secret);
  const mac = (message: string) => createHmac("sha256", key).update(message, "utf8").digest();
  const memo = new Map<string, string>();
  return {
    recordId(collectionId, storedId) {
      const memoKey = `${collectionId}\0${storedId}`;
      let id = memo.get(memoKey);
      if (id === undefined) {
        if (memo.size >= RECORD_ID_MEMO_LIMIT) memo.clear();
        id = `lr-${base32Lower(mac(`rec\0${collectionId}\0${storedId}`).subarray(0, 15))}`;
        memo.set(memoKey, id);
      }
      return id;
    },
    tag: (message) => mac(message).subarray(0, 16).toString("base64url"),
  };
}

// ---- The view -----------------------------------------------------------

interface ReadableCollection {
  grant: CollectionGrant;
  schema: RecordCollectionSchema;
  /** Granted fields as the engine sees them: no document fields, and only
   *  the field properties queries use. */
  fields: FieldTypeMap;
}

/**
 * Opens the view a grant gives of one Space. The grant is checked against the
 * live schemas here, every time: a collection whose grant no longer fits its
 * schema can't be read at all. This stage serves scoped grants; summaries and
 * fixed reads stay unavailable until their rules exist.
 */
export async function openLinkReadView(spaceId: string, grant: LinkGrant, key: LinkKey): Promise<RecordReadView> {
  const schemas = await readLinkGrantSchemas(spaceId, grant);
  const blocked = new Set(validateLinkGrant(grant, schemas).map((issue) => issue.collectionId));
  const readable = new Map<string, ReadableCollection>();
  for (const [collectionId, collectionGrant] of Object.entries(grant.collections)) {
    const schema = schemas.get(collectionId);
    if (!schema || blocked.has(collectionId) || collectionGrant.mode !== "scoped") continue;
    readable.set(collectionId, { grant: collectionGrant, schema, fields: projectFields(schema, collectionGrant) });
  }
  const loadRows = (collectionId: string) => listRecords(spaceId, collectionId, { includeArchived: false });
  return new LinkReadView(spaceId, readable, grant.limits.rowsPerQuery, key, loadRows);
}

function projectFields(schema: RecordCollectionSchema, grant: CollectionGrant): FieldTypeMap {
  const fields: FieldTypeMap = {};
  for (const name of grant.fields) {
    if (!Object.hasOwn(schema.fields, name)) continue;
    const spec = schema.fields[name]!;
    if (normalizeRecordFieldType(spec.type) === "document") continue;
    fields[name] = {
      type: spec.type,
      ...(spec.values ? { values: spec.values } : {}),
      ...(spec.references ? { references: spec.references } : {}),
      ...(spec.many !== undefined ? { many: spec.many } : {}),
    };
  }
  return fields;
}

class LinkReadView implements RecordReadView {
  // Per view, which is per request: each collection loads at most once.
  private readonly visibleMemo = new Map<string, Promise<RecordFile[]>>();
  private readonly rowsMemo = new Map<string, Promise<RecordFile[]>>();

  readonly spaceId: string;
  private readonly readable: ReadonlyMap<string, ReadableCollection>;
  private readonly rowsPerQuery: number;
  private readonly key: LinkKey;
  private readonly loadRows: (collectionId: string) => Promise<RecordFile[]>;

  constructor(
    spaceId: string,
    readable: ReadonlyMap<string, ReadableCollection>,
    rowsPerQuery: number,
    key: LinkKey,
    loadRows: (collectionId: string) => Promise<RecordFile[]>,
  ) {
    this.spaceId = spaceId;
    this.readable = readable;
    this.rowsPerQuery = rowsPerQuery;
    this.key = key;
    this.loadRows = loadRows;
  }

  fields(collectionId: string): FieldTypeMap | null {
    return this.readable.get(collectionId)?.fields ?? null;
  }

  rows(collectionId: string): Promise<RecordFile[]> {
    const collection = this.readable.get(collectionId);
    if (!collection) return Promise.reject(collectionNotAvailable());
    let rows = this.rowsMemo.get(collectionId);
    if (!rows) {
      rows = this.buildRows(collectionId, collection);
      this.rowsMemo.set(collectionId, rows);
    }
    return rows;
  }

  /** Full stored rows the grant's row condition admits. Archived rows never
   *  load. The condition sees only the stored id and data: on a bare
   *  {id, data}, every other name reads a data field, never the envelope. */
  private visibleStoredRows(collectionId: string): Promise<RecordFile[]> {
    let rows = this.visibleMemo.get(collectionId);
    if (!rows) {
      rows = (async () => {
        const collection = this.readable.get(collectionId);
        if (!collection) return [];
        const full = await this.loadRows(collectionId);
        if (!collection.grant.rows) return full;
        const shells = full.map((record) => Object.assign(Object.create(null), { id: record.id, data: record.data }) as RecordFile);
        const kept = new Set(filterRows(shells, collection.grant.rows, collection.schema.fields).map((record) => record.id));
        return full.filter((record) => kept.has(record.id));
      })();
      this.visibleMemo.set(collectionId, rows);
    }
    return rows;
  }

  private async buildRows(collectionId: string, collection: ReadableCollection): Promise<RecordFile[]> {
    // Relation values survive only when they point at a row the target's own
    // grant shows; anything else reads as no value.
    const targets = new Map<string, { collectionId: string; visible: Set<string> }>();
    for (const [name, spec] of Object.entries(collection.fields)) {
      if (normalizeRecordFieldType(spec.type) !== "relation") continue;
      const target = spec.references;
      const visible = target && this.readable.has(target)
        ? new Set((await this.visibleStoredRows(target)).map((record) => record.id))
        : new Set<string>();
      targets.set(name, { collectionId: target ?? "", visible });
    }
    const fieldNames = Object.keys(collection.fields);
    const showTimes = collection.grant.timestamps;
    const rows = (await this.visibleStoredRows(collectionId)).map((stored) => {
      const data: Record<string, unknown> = {};
      for (const name of fieldNames) {
        if (!Object.hasOwn(stored.data, name)) continue;
        const target = targets.get(name);
        data[name] = target ? this.relationValue(stored.data[name], target.collectionId, target.visible) : stored.data[name];
      }
      // A fresh object: stored records may carry keys this version doesn't
      // know, and spreading one would pass them through.
      return {
        version: stored.version,
        kind: stored.kind,
        id: this.key.recordId(collectionId, stored.id),
        collectionId,
        ...(showTimes ? { createdAt: stored.createdAt, updatedAt: stored.updatedAt } : {}),
        data,
      } as RecordFile;
    });
    // Order by what the link shows, so nothing downstream (group order,
    // backlink lists) follows stored ids or hidden times.
    return rows.sort((a, b) =>
      (showTimes ? compareText(b.updatedAt, a.updatedAt) : 0) || compareText(a.id, b.id));
  }

  private relationValue(value: unknown, targetCollectionId: string, visible: ReadonlySet<string>): unknown {
    const opaque = (id: unknown) => (typeof id === "string" && visible.has(id) ? this.key.recordId(targetCollectionId, id) : null);
    if (Array.isArray(value)) return value.map(opaque).filter((id): id is string => id !== null);
    return opaque(value);
  }

  admit(collectionId: string, query: RecordQuery): RecordQuery {
    const fields = this.fields(collectionId);
    if (!fields) throw collectionNotAvailable();
    const admitted: RecordQuery = { ...query, includeArchived: false, limit: Math.min(query.limit ?? this.rowsPerQuery, this.rowsPerQuery) };

    if (query.where && Object.keys(query.where).length > 0) {
      const tree = isPredicateTree(query.where, fields) ? query.where : flatWhereToPredicate(query.where)!;
      forEachLeaf(parsePredicate(tree, 0, fields), (path) => this.requirePath(collectionId, path));
    }
    if (query.search !== undefined && query.search.length > LINK_SEARCH_MAX_LENGTH) {
      throw new LinkQueryError("LINK_SEARCH_TOO_LONG", `Search text on a link can be at most ${LINK_SEARCH_MAX_LENGTH} characters.`, 400);
    }
    const orderFields = typeof query.orderBy === "string" ? [query.orderBy] : (query.orderBy ?? []).map((entry) => entry.field);
    for (const name of orderFields) this.requireName(collectionId, name);
    if (query.aggregate) {
      if (query.aggregate.groupBy !== undefined) this.requireName(collectionId, query.aggregate.groupBy);
      for (const spec of Object.values(query.aggregate.select)) {
        if (spec.field !== undefined) this.requireName(collectionId, spec.field);
      }
    }
    if (query.select) admitted.select = query.select.filter((name) => Object.hasOwn(fields, name));
    if (query.expand) {
      admitted.expand = {};
      for (const [name, projection] of Object.entries(query.expand)) {
        const target = this.relationTarget(collectionId, name);
        if (!target) throw fieldNotAvailable(name);
        const targetFields = this.fields(target)!;
        admitted.expand[name] = projection === true ? true : projection.filter((entry) => Object.hasOwn(targetFields, entry));
      }
    }
    if (query.backlinks) {
      const sourceFields = this.fields(query.backlinks.collection);
      if (!sourceFields) throw collectionNotAvailable();
      if (!Object.hasOwn(sourceFields, query.backlinks.field)) throw fieldNotAvailable(query.backlinks.field);
    }
    if (query.cursor !== undefined) admitted.cursor = this.openCursor(collectionId, admitted, query.cursor);
    return admitted;
  }

  /** A name a query may filter, sort or group by: a granted field, the id,
   *  or the record's times when the grant shows them. */
  private requireName(collectionId: string, name: string): void {
    if (name === "id") return;
    const collection = this.readable.get(collectionId)!;
    if ((name === "createdAt" || name === "updatedAt") && collection.grant.timestamps) return;
    if (!Object.hasOwn(collection.fields, name)) throw fieldNotAvailable(name);
  }

  private requirePath(collectionId: string, path: string): void {
    const dot = path.indexOf(".");
    if (dot === -1) return this.requireName(collectionId, path);
    const target = this.relationTarget(collectionId, path.slice(0, dot));
    if (!target) throw fieldNotAvailable(path);
    try {
      this.requireName(target, path.slice(dot + 1));
    } catch {
      throw fieldNotAvailable(path);
    }
  }

  /** The readable collection a granted relation field points at. */
  private relationTarget(collectionId: string, name: string): string | null {
    const fields = this.fields(collectionId)!;
    if (!Object.hasOwn(fields, name)) return null;
    const spec = fields[name]!;
    if (normalizeRecordFieldType(spec.type) !== "relation" || !spec.references) return null;
    return this.readable.has(spec.references) ? spec.references : null;
  }

  // Cursors carry only view values, so they reveal nothing on their own. The
  // seal ties each one to this link, this collection and this query, so a
  // member's cursor or a hand-made one is refused before it is decoded.
  sealCursor(collectionId: string, query: RecordQuery, cursor: string): string {
    return `${cursor}.${this.key.tag(cursorMessage(collectionId, query, cursor))}`;
  }

  private openCursor(collectionId: string, query: RecordQuery, sealed: string): string {
    const dot = sealed.lastIndexOf(".");
    const cursor = sealed.slice(0, Math.max(dot, 0));
    const expected = Buffer.from(this.key.tag(cursorMessage(collectionId, query, cursor)));
    const given = Buffer.from(sealed.slice(dot + 1));
    if (dot <= 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new LinkQueryError("LINK_CURSOR_INVALID", "This cursor doesn't continue this query.", 400);
    }
    return cursor;
  }
}

/** What a cursor is bound to: the collection, everything that decides which
 *  rows come in which order, and the payload. Limit and projection may
 *  change from page to page. */
function cursorMessage(collectionId: string, query: RecordQuery, cursor: string): string {
  const orderBy = typeof query.orderBy === "string"
    ? [[query.orderBy, query.order ?? "asc"]]
    : query.orderBy?.map((entry) => [entry.field, entry.dir ?? "asc"]) ?? null;
  const where = query.where && Object.keys(query.where).length > 0 ? query.where : null;
  const shape = createHash("sha256").update(canonicalJson({ where, search: query.search || null, orderBy })).digest("base64url");
  return `cur\0${collectionId}\0${shape}\0${cursor}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => compareText(a, b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareText(a: string | undefined, b: string | undefined): number {
  const left = a ?? "";
  const right = b ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}
