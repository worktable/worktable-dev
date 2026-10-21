// The read view a share link sees: a link opens data, not a screen. The view
// filters rows on the full stored records, then hands the query engine fresh
// records that carry only granted fields, opaque ids and relation values that
// point at rows the link can also see. The visitor's query never touches a
// stored record, so no filter, sort, cursor, aggregate, expand or backlink can
// reach what the grant hides. A collection granted as summaries answers only
// totals, and only for groups of at least the grant's minimum size. A
// collection granted as fixed reads runs only the reads saved with the link.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizeRecordFieldType, type CollectionGrant, type FixedRead, type LinkGrant, type RecordCollectionSchema, type RecordFile, type RecordPredicate, type RecordQuery, type SummaryRules } from "@worktable/types";
import { canonicalJson, canonicalRecordQuery, compareText, compileFixedRead, indexFixedReads, matchFixedRead, noteUnrecordedRead, recordQueryShape, storedRowField, type FixedReadIndex, type QueryValue } from "./link-fixed-reads.ts";
import { forEachLeaf, isSummaryDimension, readLinkGrantSchemas, validateLinkGrant } from "./link-grant.ts";
import { filterRows, flatWhereToPredicate, isPredicateTree, parsePredicate, type FieldTypeMap } from "./record-query.ts";
import { listRecords, RecordQueryError, type RecordReadView } from "./record-store.ts";

export { canonicalJson };

export type LinkQueryErrorCode = "LINK_COLLECTION_NOT_AVAILABLE" | "LINK_FIELD_NOT_AVAILABLE" | "LINK_SUMMARIES_ONLY" | "LINK_QUERY_NOT_RECORDED" | "LINK_SEARCH_TOO_LONG" | "LINK_CURSOR_INVALID";

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
const summariesOnly = (message: string) => new LinkQueryError("LINK_SUMMARIES_ONLY", message, 403);
const notRecorded = () => new LinkQueryError("LINK_QUERY_NOT_RECORDED", "This link can only run the reads saved with it.", 403);

/** The response for a failed link query, or null when the error isn't one. */
export function linkQueryFailure(error: unknown): { status: 400 | 403; body: { error: string; code: string } } | null {
  if (error instanceof LinkQueryError) return { status: error.status, body: { error: error.message, code: error.code } };
  if (error instanceof RecordQueryError) return { status: 400, body: { error: error.message, code: "VALIDATION_ERROR" } };
  return null;
}

import { LINK_SEARCH_MAX_LENGTH } from "./link-query-limits.ts";
export { LINK_SEARCH_MAX_LENGTH } from "./link-query-limits.ts";

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
 * schema can't be read at all. With `linkId`, reads the link refuses for
 * want of a saved read are counted for that link.
 */
export async function openLinkReadView(spaceId: string, grant: LinkGrant, key: LinkKey, options: { linkId?: string; schemas?: ReadonlyMap<string, RecordCollectionSchema>; loadRows?: (collectionId: string) => Promise<RecordFile[]>; onQueryRows?: (collectionId: string, rows: readonly RecordFile[]) => void } = {}): Promise<RecordReadView> {
  const schemas = options.schemas ?? await readLinkGrantSchemas(spaceId, grant);
  const blocked = new Set(validateLinkGrant(grant, schemas).map((issue) => issue.collectionId));
  const readable = new Map<string, ReadableCollection>();
  const saved: [string, FixedRead[]][] = [];
  for (const [collectionId, collectionGrant] of Object.entries(grant.collections)) {
    const schema = schemas.get(collectionId);
    if (!schema || blocked.has(collectionId)) continue;
    readable.set(collectionId, { grant: collectionGrant, schema, fields: projectFields(schema, collectionGrant) });
    if (collectionGrant.fixed) saved.push([collectionId, collectionGrant.fixed]);
  }
  const loadRows = options.loadRows ?? ((collectionId: string) => listRecords(spaceId, collectionId, { includeArchived: false }));
  const onUnrecorded = options.linkId === undefined ? undefined : noteUnrecordedRead.bind(null, options.linkId);
  return new LinkReadView(spaceId, readable, grant.limits.rowsPerQuery, key, loadRows, indexFixedReads(saved), onUnrecorded, options.onQueryRows);
}

/** A stored row as row conditions see it: only the stored id and data. On a
 *  bare {id, data}, every other name reads a data field, never the envelope. */
function storedShell(record: RecordFile): RecordFile {
  return Object.assign(Object.create(null), { id: record.id, data: record.data }) as RecordFile;
}

// A summaries grant shows no rows, so it reads only its groupings and
// measures; `fields` is what a scoped or fixed grant's rows show.
export function projectFields(schema: RecordCollectionSchema, grant: CollectionGrant): FieldTypeMap {
  const fields: FieldTypeMap = {};
  const names = grant.mode === "summaries" ? [...grant.summaries!.groupBy, ...grant.summaries!.measures] : grant.fields;
  for (const name of names) {
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

  // The saved read each admitted fixed query runs, for sealing its cursor,
  // and its conditions on fields the link doesn't show.
  private readonly admittedReads = new WeakMap<RecordQuery, string>();
  private readonly savedRowConditions = new WeakMap<RecordQuery, RecordPredicate>();

  readonly spaceId: string;
  private readonly readable: ReadonlyMap<string, ReadableCollection>;
  private readonly rowsPerQuery: number;
  private readonly key: LinkKey;
  private readonly loadRows: (collectionId: string) => Promise<RecordFile[]>;
  private readonly savedReads: FixedReadIndex;
  private readonly onUnrecorded: ((collectionId: string, shape: string) => void) | undefined;
  readonly onQueryRows?: (collectionId: string, rows: readonly RecordFile[]) => void;

  constructor(
    spaceId: string,
    readable: ReadonlyMap<string, ReadableCollection>,
    rowsPerQuery: number,
    key: LinkKey,
    loadRows: (collectionId: string) => Promise<RecordFile[]>,
    savedReads: FixedReadIndex,
    onUnrecorded?: (collectionId: string, shape: string) => void,
    onQueryRows?: (collectionId: string, rows: readonly RecordFile[]) => void,
  ) {
    this.spaceId = spaceId;
    this.readable = readable;
    this.rowsPerQuery = rowsPerQuery;
    this.key = key;
    this.loadRows = loadRows;
    this.savedReads = savedReads;
    this.onUnrecorded = onUnrecorded;
    this.onQueryRows = onQueryRows;
  }

  fields(collectionId: string): FieldTypeMap | null {
    return this.readable.get(collectionId)?.fields ?? null;
  }

  rows(collectionId: string, query?: RecordQuery): Promise<RecordFile[]> {
    const collection = this.readable.get(collectionId);
    if (!collection) return Promise.reject(collectionNotAvailable());
    let rows = this.rowsMemo.get(collectionId);
    if (!rows) {
      rows = this.buildRows(collectionId, collection);
      this.rowsMemo.set(collectionId, rows);
    }
    const condition = query && this.savedRowConditions.get(query);
    return condition ? this.rowsMeeting(collectionId, collection, rows, condition) : rows;
  }

  /** The rows a saved read's conditions on unshown fields keep. They are
   *  judged on the stored rows, like the grant's row condition. */
  private async rowsMeeting(collectionId: string, collection: ReadableCollection, rows: Promise<RecordFile[]>, condition: RecordPredicate): Promise<RecordFile[]> {
    const stored = filterRows((await this.visibleStoredRows(collectionId)).map(storedShell), condition, collection.schema.fields);
    const kept = new Set(stored.map((record) => this.key.recordId(collectionId, record.id)));
    return (await rows).filter((row) => kept.has(row.id));
  }

  /** Full stored rows the grant's row condition admits. Archived rows never
   *  load. */
  private visibleStoredRows(collectionId: string): Promise<RecordFile[]> {
    let rows = this.visibleMemo.get(collectionId);
    if (!rows) {
      rows = (async () => {
        const collection = this.readable.get(collectionId);
        if (!collection) return [];
        const full = await this.loadRows(collectionId);
        if (!collection.grant.rows) return full;
        const kept = new Set(filterRows(full.map(storedShell), collection.grant.rows, collection.schema.fields).map((record) => record.id));
        return full.filter((record) => kept.has(record.id));
      })();
      this.visibleMemo.set(collectionId, rows);
    }
    return rows;
  }

  /** Whether the link shows this collection's rows one by one: a summaries
   *  collection is never a relation, expand or backlink target. */
  private showsRows(collectionId: string): boolean {
    const mode = this.readable.get(collectionId)?.grant.mode;
    return mode === "scoped" || mode === "fixed";
  }

  /** Whether any query may reach this collection's rows: a fixed
   *  collection's rows are reached only by the reads saved with the link. */
  private readonly anyQueryReaches = (collectionId: string): boolean => this.readable.get(collectionId)?.grant.mode === "scoped";
  private readonly savedReadReaches = (collectionId: string): boolean => this.showsRows(collectionId);

  private async buildRows(collectionId: string, collection: ReadableCollection): Promise<RecordFile[]> {
    // Relation values survive only when they point at a row the target's own
    // grant shows; anything else reads as no value.
    const targets = new Map<string, { collectionId: string; visible: Set<string> }>();
    for (const [name, spec] of Object.entries(collection.fields)) {
      if (normalizeRecordFieldType(spec.type) !== "relation") continue;
      const target = spec.references;
      const visible = target && this.showsRows(target)
        ? new Set((await this.visibleStoredRows(target)).map((record) => record.id))
        : new Set<string>();
      targets.set(name, { collectionId: target ?? "", visible });
    }
    const fieldNames = Object.keys(collection.fields);
    const summaries = collection.grant.mode === "summaries";
    const showTimes = !summaries && collection.grant.timestamps;
    const rows = (await this.visibleStoredRows(collectionId)).map((stored) => {
      const data: Record<string, unknown> = {};
      for (const name of fieldNames) {
        if (!Object.hasOwn(stored.data, name)) continue;
        const target = targets.get(name);
        data[name] = target ? this.relationValue(stored.data[name], target.collectionId, target.visible) : stored.data[name];
      }
      // A fresh object: stored records may carry keys this version doesn't
      // know, and spreading one would pass them through. Every envelope value
      // is the view's own: the stored format version may follow what a
      // record holds, so a link always says version 1.
      return {
        version: 1,
        kind: "worktable.record",
        id: this.key.recordId(collectionId, stored.id),
        collectionId,
        ...(showTimes ? { createdAt: stored.createdAt, updatedAt: stored.updatedAt } : {}),
        data,
      } as RecordFile;
    });
    // Order by what the link shows, so nothing downstream (group order,
    // backlink lists) follows stored ids or hidden times.
    if (summaries) {
      // Totals add rows in an order set by their values alone, so not even
      // the last digit of a sum follows ids or times. Rows with equal values
      // are interchangeable.
      const keyed = rows.map((row) => [canonicalJson(row.data), row] as const);
      return keyed.sort(([a], [b]) => compareText(a, b)).map(([, row]) => row);
    }
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
    const { grant } = this.readable.get(collectionId)!;
    if (grant.mode === "summaries") return admitSummaries(fields, grant.summaries!, query);
    if (grant.mode === "fixed") return this.admitSavedRead(collectionId, query);
    return this.admitRows(collectionId, query, this.anyQueryReaches);
  }

  /**
   * Admits a query on a fixed collection by the saved read it matches, and
   * returns that read to run instead: its saved values in the link's ids,
   * with the visitor's values only where the read leaves them open. Nothing
   * else of the visitor's query runs. The read's saved conditions on fields
   * the link doesn't show narrow the stored rows, like a row condition; the
   * rest runs in the view.
   */
  private admitSavedRead(collectionId: string, query: RecordQuery): RecordQuery {
    const asked = canonicalRecordQuery(query, this.readable.get(collectionId)!.schema.fields);
    const toView = (position: QueryValue, value: unknown) => this.toViewIds(collectionId, position, value);
    const match = matchFixedRead(this.savedReads, collectionId, asked, toView);
    if (!match) {
      this.onUnrecorded?.(collectionId, recordQueryShape(asked));
      throw notRecorded();
    }
    const saved = compileFixedRead(match, toView);
    const { unshown, shown } = this.splitSavedWhere(collectionId, saved.where);
    const limits = [saved.limit, query.limit].filter((limit) => limit !== undefined);
    const run: RecordQuery = {
      ...saved,
      where: shown as RecordQuery["where"],
      limit: limits.length > 0 ? Math.min(...limits) : undefined,
      cursor: query.cursor,
    };
    const admitted = this.admitRows(collectionId, run, this.savedReadReaches, match.read.id);
    this.admittedReads.set(admitted, match.read.id);
    if (unshown) this.savedRowConditions.set(admitted, unshown);
    return admitted;
  }

  /** Splits a saved read's conditions: those every result must meet on a
   *  field of the collection the link doesn't show, and the rest. Grant
   *  checks allow unshown fields only there, and only with saved values. */
  private splitSavedWhere(collectionId: string, where: RecordPredicate | undefined): { unshown: RecordPredicate | null; shown: RecordPredicate | undefined } {
    if (!where) return { unshown: null, shown: undefined };
    const { schema } = this.readable.get(collectionId)!;
    const unshownField = (node: RecordPredicate) => "field" in node && storedRowField(schema, node.field) && !this.shows(collectionId, node.field);
    const conditions = "and" in where ? where.and : [where];
    const unshown = conditions.filter(unshownField);
    if (unshown.length === 0) return { unshown: null, shown: where };
    const shown = conditions.filter((node) => !unshownField(node));
    const join = (nodes: RecordPredicate[]) => (nodes.length === 0 ? undefined : nodes.length === 1 ? nodes[0] : { and: nodes });
    return { unshown: join(unshown)!, shown: join(shown) };
  }

  /** Whether the link shows a field of this collection. */
  private shows(collectionId: string, name: string): boolean {
    if (name === "id") return true;
    const collection = this.readable.get(collectionId)!;
    if (name === "createdAt" || name === "updatedAt") return collection.grant.timestamps;
    return Object.hasOwn(collection.fields, name);
  }

  /** A saved value as the link's rows hold it: stored ids become the link's
   *  ids. Other values, and ids the tool computed, stay as they are. */
  private toViewIds(collectionId: string, position: QueryValue, value: unknown): unknown {
    if (position.field === undefined || !ID_OPS.has(position.op!)) return value;
    const target = this.idCollection(collectionId, position.field);
    if (!target) return value;
    const toView = (id: unknown) => (typeof id === "string" ? this.key.recordId(target, id) : id);
    return Array.isArray(value) ? value.map(toView) : toView(value);
  }

  /** The collection whose ids a field path holds: the record's own for "id",
   *  a relation's target for the relation and for its "id". */
  private idCollection(collectionId: string, path: string): string | null {
    if (path === "id") return collectionId;
    const fields = this.fields(collectionId);
    const dot = path.indexOf(".");
    const head = dot === -1 ? path : path.slice(0, dot);
    const spec = fields && Object.hasOwn(fields, head) ? fields[head]! : undefined;
    if (!spec || normalizeRecordFieldType(spec.type) !== "relation" || !spec.references) return null;
    return dot === -1 ? spec.references : this.idCollection(spec.references, path.slice(dot + 1));
  }

  /** Admits a query that reads rows. `reaches` says which other collections'
   *  rows it may read; `savedRead` seals its cursor to that read. */
  private admitRows(collectionId: string, query: RecordQuery, reaches: (collectionId: string) => boolean, savedRead?: string): RecordQuery {
    const fields = this.fields(collectionId)!;
    const admitted: RecordQuery = { ...query, includeArchived: false, limit: Math.min(query.limit ?? this.rowsPerQuery, this.rowsPerQuery) };

    if (query.where && Object.keys(query.where).length > 0) {
      const tree = isPredicateTree(query.where, fields) ? query.where : flatWhereToPredicate(query.where)!;
      forEachLeaf(parsePredicate(tree, 0, fields), (path) => this.requirePath(collectionId, path, reaches));
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
        const target = this.relationTarget(collectionId, name, reaches);
        if (!target) throw fieldNotAvailable(name);
        const targetFields = this.fields(target)!;
        admitted.expand[name] = projection === true ? true : projection.filter((entry) => Object.hasOwn(targetFields, entry));
      }
    }
    if (query.backlinks) {
      const sourceFields = reaches(query.backlinks.collection) ? this.fields(query.backlinks.collection) : null;
      if (!sourceFields) throw collectionNotAvailable();
      if (!Object.hasOwn(sourceFields, query.backlinks.field)) throw fieldNotAvailable(query.backlinks.field);
    }
    if (query.cursor !== undefined) admitted.cursor = this.openCursor(collectionId, admitted, query.cursor, savedRead);
    return admitted;
  }

  /** A name a query may filter, sort or group by: a granted field, the id,
   *  or the record's times when the grant shows them. */
  private requireName(collectionId: string, name: string): void {
    if (!this.shows(collectionId, name)) throw fieldNotAvailable(name);
  }

  private requirePath(collectionId: string, path: string, reaches: (collectionId: string) => boolean): void {
    const dot = path.indexOf(".");
    if (dot === -1) return this.requireName(collectionId, path);
    const target = this.relationTarget(collectionId, path.slice(0, dot), reaches);
    if (!target) throw fieldNotAvailable(path);
    try {
      this.requireName(target, path.slice(dot + 1));
    } catch {
      throw fieldNotAvailable(path);
    }
  }

  /** The collection a granted relation field points at, when the query may
   *  reach its rows. */
  private relationTarget(collectionId: string, name: string, reaches: (collectionId: string) => boolean): string | null {
    const fields = this.fields(collectionId)!;
    if (!Object.hasOwn(fields, name)) return null;
    const spec = fields[name]!;
    if (normalizeRecordFieldType(spec.type) !== "relation" || !spec.references) return null;
    return reaches(spec.references) ? spec.references : null;
  }

  // Too-small groups are dropped, never pooled: an "other" bucket would give
  // them back by subtraction from the total. Groups come in key order, so
  // their order says nothing about the rows behind them.
  shownGroups(collectionId: string, groups: Record<string, unknown>[]): Record<string, unknown>[] {
    const collection = this.readable.get(collectionId);
    if (collection?.grant.mode !== "summaries") return groups;
    const { minGroupSize } = collection.grant.summaries!;
    return groups
      .filter((group) => (group[GROUP_SIZE] as number) >= minGroupSize)
      .map((group) => {
        const shown = { ...group };
        delete shown[GROUP_SIZE];
        return shown;
      })
      .sort((a, b) => compareText(canonicalJson(a["key"]), canonicalJson(b["key"])));
  }

  // Cursors carry only view values, so they reveal nothing on their own. The
  // seal ties each one to this link, this collection and this query (for a
  // saved read, the read and the values the visitor gave it), so a member's
  // cursor or a hand-made one is refused before it is decoded.
  sealCursor(collectionId: string, query: RecordQuery, cursor: string): string {
    return `${cursor}.${this.key.tag(cursorMessage(collectionId, query, cursor, this.admittedReads.get(query)))}`;
  }

  private openCursor(collectionId: string, query: RecordQuery, sealed: string, savedRead: string | undefined): string {
    const dot = sealed.lastIndexOf(".");
    const cursor = sealed.slice(0, Math.max(dot, 0));
    const expected = Buffer.from(this.key.tag(cursorMessage(collectionId, query, cursor, savedRead)));
    const given = Buffer.from(sealed.slice(dot + 1));
    if (dot <= 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new LinkQueryError("LINK_CURSOR_INVALID", "This cursor doesn't continue this query.", 400);
    }
    return cursor;
  }
}

// ---- Summaries ----------------------------------------------------------

/** The only keys a summaries query may carry. Archived rows stay out
 *  whatever it asks, as on every link read. */
const SUMMARY_QUERY_KEYS = new Set(["aggregate", "where", "includeArchived"]);
/** Each picks out cells of a grouping: `has` is how a multi-select grouping
 *  is narrowed to one of its values, and on a single value it is `eq`. */
const SUMMARY_FILTER_OPS = new Set(["eq", "in", "has"]);
/** The hidden count each group carries until shownGroups judges it. */
const GROUP_SIZE = "__wt_n";
/** Conditions whose values name rows by id. */
const ID_OPS = new Set<string>(["eq", "neq", "in", "has"]);

/**
 * Admits a query on a collection the link shows only as totals: one
 * aggregate over the grant's groupings, functions and measures, filtered at
 * most to cells of those groupings. A name the link doesn't read gets the
 * same answer as a missing one; a name it reads but can't use this way is
 * refused as summaries-only.
 */
export function admitSummaries(fields: FieldTypeMap, rules: SummaryRules, query: RecordQuery): RecordQuery {
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && !SUMMARY_QUERY_KEYS.has(key)) throw summariesOnly(`This link shows only totals, so a query can't use "${key}".`);
  }
  if (!query.aggregate) throw summariesOnly("This link shows only totals, so a query must ask for an aggregate.");
  const readable = (name: string) => Object.hasOwn(fields, name);
  const dimension = (name: string) => rules.groupBy.includes(name) && isSummaryDimension(fields[name]!.type);
  const measure = (name: string) => rules.measures.includes(name) && normalizeRecordFieldType(fields[name]!.type) === "number";

  const { groupBy, select } = query.aggregate;
  if (groupBy !== undefined) {
    if (!readable(groupBy)) throw fieldNotAvailable(groupBy);
    if (!dimension(groupBy)) throw summariesOnly(`This link can't group totals by "${groupBy}".`);
  }
  for (const [alias, spec] of Object.entries(select)) {
    // A grouped answer names each group by its "key".
    if (alias.startsWith("__wt") || (groupBy !== undefined && alias === "key")) {
      throw summariesOnly(`The aggregate name "${alias}" is reserved.`);
    }
    if (spec.field !== undefined && !readable(spec.field)) throw fieldNotAvailable(spec.field);
    if (!rules.fns.includes(spec.fn)) throw summariesOnly(`This link can't compute "${spec.fn}".`);
    if (spec.field !== undefined && !measure(spec.field)) throw summariesOnly(`This link can't summarize "${spec.field}".`);
    if (spec.field === undefined && spec.fn !== "count") throw summariesOnly(`"${spec.fn}" needs one of this link's measures.`);
  }
  if (query.where && Object.keys(query.where).length > 0) {
    const tree = parsePredicate(isPredicateTree(query.where, fields) ? query.where : flatWhereToPredicate(query.where)!, 0, fields);
    forEachLeaf(tree, (path) => {
      if (!readable(path)) throw fieldNotAvailable(path);
    });
    requireCellFilter(tree, dimension);
  }
  return {
    ...(query.where ? { where: query.where } : {}),
    includeArchived: false,
    aggregate: { ...(groupBy !== undefined ? { groupBy } : {}), select: { ...select, [GROUP_SIZE]: { fn: "count" } } },
  };
}

/** Totals filter only to cells: value matches on groupings, joined by "and". */
function requireCellFilter(node: RecordPredicate, dimension: (name: string) => boolean): void {
  if ("and" in node) return node.and.forEach((child) => requireCellFilter(child, dimension));
  if ("or" in node || "not" in node) throw summariesOnly('This link filters totals only with conditions joined by "and".');
  if (!dimension(node.field)) throw summariesOnly(`This link can't filter totals by "${node.field}".`);
  if (!SUMMARY_FILTER_OPS.has(node.op)) throw summariesOnly('This link filters totals only with "eq", "in" and "has".');
}

/** What a cursor is bound to: the collection, everything that decides which
 *  rows come in which order, the saved read it runs if any, and the payload.
 *  Limit and projection may change from page to page. */
function cursorMessage(collectionId: string, query: RecordQuery, cursor: string, savedRead: string | undefined): string {
  const orderBy = typeof query.orderBy === "string"
    ? [[query.orderBy, query.order ?? "asc"]]
    : query.orderBy?.map((entry) => [entry.field, entry.dir ?? "asc"]) ?? null;
  const where = query.where && Object.keys(query.where).length > 0 ? query.where : null;
  const shape = createHash("sha256").update(canonicalJson({ where, search: query.search || null, orderBy, savedRead })).digest("base64url");
  return `cur\0${collectionId}\0${shape}\0${cursor}`;
}
