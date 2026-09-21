// ============================================================
// v2 record query evaluation: predicate AST, multi-sort, keyset
// cursors, expand/backlinks/aggregate.
// ============================================================
//
// The legacy flat where-map NEVER routes here — filterRecords in
// record-store.ts keeps its original semantics forever. A query uses
// this evaluator only when it opts into a v2 feature (AST where,
// orderBy array, expand, backlinks, aggregate, select, cursor), and
// those semantics are documented and strict: malformed AST input is
// rejected with an error instead of silently matching nothing.
//
// This module is pure: the caller supplies the rows and a resolver
// for other collections (one-hop relation paths, expand, backlinks).

import {
  normalizeRecordFieldType,
  type RecordCollectionSchema,
  type RecordFile,
  type RecordPredicate,
  type RecordPredicateOp,
  type RecordQuery,
  type RecordQueryResult,
} from "@worktable/types";

export type FieldTypeMap = RecordCollectionSchema["fields"];

// ---- Comparators ------------------------------------------------------
// Moved verbatim from record-store.ts: the legacy filter pipeline and the
// AST evaluator must order and compare values identically.

// Coerce a stored value into something orderable. Numbers and date/datetime
// values become numbers (so they sort and compare numerically/chronologically
// instead of lexicographically); everything else falls back to a lowercased
// string. The schema field type wins when known; otherwise we sniff numeric
// strings and ISO-like dates so unschema'd collections still behave.
export function toComparable(value: unknown, fieldType?: string): number | string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const s = String(value);
  if (fieldType === "number") {
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
  }
  if (fieldType === "date" || fieldType === "datetime") {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
  }
  if (!fieldType) {
    if (s.trim() !== "" && Number.isFinite(Number(s))) return Number(s);
    if (/^\d{4}-\d{2}-\d{2}/.test(s.trim())) {
      const t = Date.parse(s);
      if (!Number.isNaN(t)) return t;
    }
  }
  return s.toLowerCase();
}

export function compareComparable(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export function compareForOrder(a: unknown, b: unknown, fieldType?: string): number {
  return compareComparable(toComparable(a, fieldType), toComparable(b, fieldType));
}

export function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

export function fieldValue(record: RecordFile, key: string): unknown {
  return key in record ? (record as unknown as Record<string, unknown>)[key] : record.data[key];
}

// ---- Query shape ------------------------------------------------------

export class RecordQueryShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordQueryShapeError";
  }
}

const PREDICATE_OPS: RecordPredicateOp[] = ["eq", "neq", "in", "contains", "has", "gt", "gte", "lt", "lte", "isEmpty"];

export function isPredicateTree(where: Record<string, unknown>): boolean {
  // Shape-aware: a legacy flat filter on a data field literally named "and"/
  // "or"/"not" with a scalar value stays legacy; only tree-shaped values are
  // treated as AST (array children for and/or, an object child for not).
  if (Array.isArray(where["and"]) || Array.isArray(where["or"])) return true;
  if (typeof where["not"] === "object" && where["not"] !== null) return true;
  return typeof where["field"] === "string" && typeof where["op"] === "string";
}

// Any v2 feature routes the query through this evaluator.
export function usesQueryV2(query: RecordQuery): boolean {
  if (query.where && isPredicateTree(query.where)) return true;
  if (Array.isArray(query.orderBy)) return true;
  return Boolean(query.expand || query.backlinks || query.aggregate || query.select || query.cursor);
}

// Validate an untrusted predicate tree, rejecting malformed shapes loudly
// (the AST is a new surface — no legacy quirk to preserve).
export function parsePredicate(input: unknown, depth = 0): RecordPredicate {
  if (depth > 20) throw new RecordQueryShapeError("Predicate tree too deep (max 20 levels)");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RecordQueryShapeError("Predicate must be an object");
  const node = input as Record<string, unknown>;
  // Strict key sets: a tree node carrying extra keys (e.g. an "and" array
  // plus a leftover flat filter) is rejected, not silently narrowed to the
  // tree — dropped constraints would broaden results without warning.
  if ("and" in node || "or" in node || "not" in node) {
    const extras = Object.keys(node).filter((k) => k !== "and" && k !== "or" && k !== "not");
    if (extras.length > 0) throw new RecordQueryShapeError(`Predicate connective has unexpected keys: ${extras.join(", ")} (flat filters cannot be mixed into a predicate tree)`);
    if (Object.keys(node).length !== 1) throw new RecordQueryShapeError("Predicate connective must be exactly one of and/or/not");
  }
  if ("and" in node || "or" in node) {
    const key = "and" in node ? "and" : "or";
    if (!Array.isArray(node[key])) throw new RecordQueryShapeError(`"${key}" must be an array of predicates`);
    // Empty connectives are rejected rather than given vacuous-truth semantics
    // ({and: []} matches all, {or: []} matches none — silently opposite for
    // identically shaped input). A builder with zero clauses should omit the
    // connective.
    if ((node[key] as unknown[]).length === 0) throw new RecordQueryShapeError(`"${key}" requires at least one predicate`);
    const children = (node[key] as unknown[]).map((child) => parsePredicate(child, depth + 1));
    return key === "and" ? { and: children } : { or: children };
  }
  if ("not" in node) return { not: parsePredicate(node["not"], depth + 1) };
  const field = node["field"];
  const op = node["op"];
  if (typeof field !== "string" || !field) throw new RecordQueryShapeError("Predicate leaf needs a string \"field\"");
  if (typeof op !== "string" || !PREDICATE_OPS.includes(op as RecordPredicateOp)) {
    throw new RecordQueryShapeError(`Unknown predicate op ${JSON.stringify(op)} (expected one of ${PREDICATE_OPS.join(", ")})`);
  }
  const leafExtras = Object.keys(node).filter((k) => k !== "field" && k !== "op" && k !== "value");
  if (leafExtras.length > 0) throw new RecordQueryShapeError(`Predicate leaf has unexpected keys: ${leafExtras.join(", ")}`);
  const value = node["value"];
  if (op === "in" && !Array.isArray(value)) throw new RecordQueryShapeError('"in" requires an array value');
  if (op === "contains" && typeof value !== "string") throw new RecordQueryShapeError('"contains" requires a string value');
  if (op === "has" && (value === undefined || value === null || Array.isArray(value) || typeof value === "object")) {
    throw new RecordQueryShapeError('"has" requires a scalar value');
  }
  if ((op === "gt" || op === "gte" || op === "lt" || op === "lte") && (value === undefined || value === null)) {
    throw new RecordQueryShapeError(`"${op}" requires a value`);
  }
  if (op === "isEmpty" && value !== undefined && typeof value !== "boolean") throw new RecordQueryShapeError('"isEmpty" takes an optional boolean value');
  return { field, op: op as RecordPredicateOp, value };
}

// Collections a query reaches beyond its own: expand targets, the backlinks
// source, and the targets of one-hop relation paths in predicates. The widget
// bridge permission-gates each of these.
export function referencedCollections(query: RecordQuery, fields: FieldTypeMap | undefined): string[] {
  const out = new Set<string>();
  const relationTarget = (fieldName: string): string | null => {
    const spec = fields?.[fieldName];
    if (!spec || normalizeRecordFieldType(spec.type) !== "relation" || !spec.references) return null;
    return spec.references;
  };
  for (const fieldName of Object.keys(query.expand ?? {})) {
    const target = relationTarget(fieldName);
    if (target) out.add(target);
  }
  if (query.backlinks) out.add(query.backlinks.collection);
  if (query.where && isPredicateTree(query.where)) {
    const walk = (node: RecordPredicate): void => {
      if ("and" in node) node.and.forEach(walk);
      else if ("or" in node) node.or.forEach(walk);
      else if ("not" in node) walk(node.not);
      else if (node.field.includes(".")) {
        const target = relationTarget(node.field.split(".")[0]!);
        if (target) out.add(target);
      }
    };
    walk(parsePredicate(query.where));
  }
  return [...out];
}

// ---- Evaluation -------------------------------------------------------

export type CollectionResolver = (collectionId: string) => Promise<Map<string, RecordFile>>;
export type FieldsResolver = (collectionId: string) => Promise<FieldTypeMap | undefined>;

interface EvalContext {
  fields: FieldTypeMap | undefined;
  targets: Map<string, Map<string, RecordFile>>;
  // The referenced collections' field types, so relation-path comparisons get
  // the same schema-typed treatment as local fields.
  targetFields: Map<string, FieldTypeMap | undefined>;
  resolveDocumentPath?: (path: string) => string;
}

// Values a (possibly one-hop) field path yields for a record. A plain field
// yields one value; a path through a many-relation yields one per target.
function pathValues(record: RecordFile, path: string, ctx: EvalContext): { values: unknown[]; fieldType?: string; document?: boolean } {
  if (!path.includes(".")) {
    const spec = ctx.fields?.[path];
    return {
      values: [fieldValue(record, path)],
      fieldType: spec ? normalizeType(spec.type) : undefined,
      document: spec ? normalizeRecordFieldType(spec.type) === "document" : false,
    };
  }
  const [head, ...restParts] = path.split(".");
  const rest = restParts.join(".");
  const spec = ctx.fields?.[head!];
  if (!spec || normalizeRecordFieldType(spec.type) !== "relation" || !spec.references) return { values: [] };
  const targets = ctx.targets.get(spec.references);
  if (!targets) return { values: [] };
  const raw = record.data[head!];
  const ids = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const values: unknown[] = [];
  for (const id of ids) {
    const target = typeof id === "string" ? targets.get(id) : undefined;
    if (target) values.push(fieldValue(target, rest));
  }
  const targetSpec = ctx.targetFields.get(spec.references)?.[rest];
  return {
    values,
    fieldType: targetSpec ? normalizeType(targetSpec.type) : undefined,
    document: targetSpec ? normalizeRecordFieldType(targetSpec.type) === "document" : false,
  };
}

function normalizeType(type: string): string | undefined {
  const normalized = normalizeRecordFieldType(type);
  // Only the types toComparable understands matter for comparison hints.
  return normalized === "number" || normalized === "date" || normalized === "datetime" ? normalized : undefined;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function leafMatches(record: RecordFile, leaf: { field: string; op: RecordPredicateOp; value?: unknown }, ctx: EvalContext): boolean {
  const { values, fieldType, document } = pathValues(record, leaf.field, ctx);
  if (leaf.op === "isEmpty") {
    const wantEmpty = leaf.value === undefined ? true : Boolean(leaf.value);
    const empty = values.length === 0 || values.every(isEmptyValue);
    return empty === wantEmpty;
  }
  // For multi-valued paths (arrays, many-relations) a leaf matches when ANY
  // value matches — except neq, which requires ALL values to differ.
  const equivalent = (left: unknown, right: unknown): boolean => {
    if (!document || !ctx.resolveDocumentPath || typeof left !== "string" || typeof right !== "string") return left === right;
    return ctx.resolveDocumentPath(left) === ctx.resolveDocumentPath(right);
  };
  const single = (value: unknown): boolean => {
    switch (leaf.op) {
      case "eq":
        return equivalent(value, leaf.value);
      case "neq":
        return !equivalent(value, leaf.value);
      case "in":
        return (leaf.value as unknown[]).some((expected) => equivalent(value, expected));
      case "contains": {
        const needle = (leaf.value as string).toLowerCase();
        if (Array.isArray(value)) return value.some((entry) => String(entry ?? "").toLowerCase().includes(needle));
        return String(value ?? "").toLowerCase().includes(needle);
      }
      case "has":
        // Exact membership for array fields (multi_select values, many-relation
        // id lists); strict equality for scalars. The substring semantics of
        // `contains` would make option "art" match a record tagged "cart".
        if (Array.isArray(value)) return value.some((entry) => equivalent(entry, leaf.value));
        return equivalent(value, leaf.value);
      case "gt":
        return !isMissing(value) && compareForOrder(value, leaf.value, fieldType) > 0;
      case "gte":
        return !isMissing(value) && compareForOrder(value, leaf.value, fieldType) >= 0;
      case "lt":
        return !isMissing(value) && compareForOrder(value, leaf.value, fieldType) < 0;
      case "lte":
        return !isMissing(value) && compareForOrder(value, leaf.value, fieldType) <= 0;
      default:
        return false;
    }
  };
  if (values.length === 0) return leaf.op === "neq";
  if (leaf.op === "neq") return values.every(single);
  return values.some(single);
}

function predicateMatches(record: RecordFile, node: RecordPredicate, ctx: EvalContext): boolean {
  if ("and" in node) return node.and.every((child) => predicateMatches(record, child, ctx));
  if ("or" in node) return node.or.some((child) => predicateMatches(record, child, ctx));
  if ("not" in node) return !predicateMatches(record, node.not, ctx);
  return leafMatches(record, node, ctx);
}

// ---- Sort + cursor ----------------------------------------------------

interface SortKey {
  field: string;
  dir: 1 | -1;
}

function sortKeys(query: RecordQuery): SortKey[] {
  if (Array.isArray(query.orderBy)) {
    return query.orderBy.map((entry) => ({ field: entry.field, dir: entry.dir === "desc" ? -1 : 1 }));
  }
  if (typeof query.orderBy === "string") return [{ field: query.orderBy, dir: query.order === "desc" ? -1 : 1 }];
  return [{ field: "updatedAt", dir: -1 }];
}

function buildComparator(keys: SortKey[], fields: FieldTypeMap | undefined): (a: RecordFile, b: RecordFile) => number {
  return (a, b) => {
    for (const key of keys) {
      const fieldType = fields?.[key.field] ? normalizeType(fields[key.field]!.type) : undefined;
      const cmp = compareForOrder(fieldValue(a, key.field), fieldValue(b, key.field), fieldType) * key.dir;
      if (cmp !== 0) return cmp;
    }
    // Deterministic tiebreak so keyset cursors are stable.
    return a.id.localeCompare(b.id);
  };
}

function encodeCursor(record: RecordFile, keys: SortKey[]): string {
  const payload = { k: keys.map((key) => fieldValue(record, key.field) ?? null), id: record.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, keyCount: number): { k: unknown[]; id: string } {
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { k: unknown[]; id: string };
    if (!Array.isArray(payload.k) || payload.k.length !== keyCount || typeof payload.id !== "string") throw new Error("shape");
    return payload;
  } catch {
    throw new RecordQueryShapeError("Invalid cursor");
  }
}

// ---- Aggregation ------------------------------------------------------

function aggregateGroups(records: RecordFile[], aggregate: NonNullable<RecordQuery["aggregate"]>, ctx: EvalContext): Record<string, unknown>[] {
  const fields = ctx.fields;
  const groupField = aggregate.groupBy ? fields?.[aggregate.groupBy] : undefined;
  const documentGroup = groupField && normalizeRecordFieldType(groupField.type) === "document";
  const resolveGroupValue = (value: unknown): unknown => {
    if (!documentGroup || !ctx.resolveDocumentPath) return value;
    if (typeof value === "string") return ctx.resolveDocumentPath(value);
    if (Array.isArray(value)) {
      return value.map((entry) => typeof entry === "string" ? ctx.resolveDocumentPath!(entry) : entry);
    }
    return value;
  };
  const groups = new Map<string, { key: unknown; rows: RecordFile[] }>();
  for (const record of records) {
    const key = aggregate.groupBy ? resolveGroupValue(fieldValue(record, aggregate.groupBy) ?? null) : null;
    const mapKey = JSON.stringify(key);
    if (!groups.has(mapKey)) groups.set(mapKey, { key, rows: [] });
    groups.get(mapKey)!.rows.push(record);
  }
  const out: Record<string, unknown>[] = [];
  for (const group of groups.values()) {
    const row: Record<string, unknown> = aggregate.groupBy ? { key: group.key } : {};
    for (const [alias, spec] of Object.entries(aggregate.select)) {
      if (spec.fn === "count") {
        row[alias] = group.rows.length;
        continue;
      }
      const field = spec.field;
      if (!field) throw new RecordQueryShapeError(`Aggregate "${spec.fn}" requires a field`);
      const values = group.rows.map((record) => fieldValue(record, field)).filter((value) => !isMissing(value));
      if (spec.fn === "unique") {
        row[alias] = new Set(values.map((value) => JSON.stringify(value))).size;
      } else if (spec.fn === "sum" || spec.fn === "avg") {
        const nums = values.map(Number).filter((n) => Number.isFinite(n));
        row[alias] = spec.fn === "sum" ? nums.reduce((a, b) => a + b, 0) : nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      } else {
        // min / max on the shared comparable scale with the field's schema
        // type (same treatment as predicates and sorting), returning the
        // original value.
        const fieldType = fields?.[field] ? normalizeType(fields[field]!.type) : undefined;
        let best: unknown = null;
        for (const value of values) {
          if (best === null) best = value;
          else {
            const cmp = compareComparable(toComparable(value, fieldType), toComparable(best, fieldType));
            if ((spec.fn === "min" && cmp < 0) || (spec.fn === "max" && cmp > 0)) best = value;
          }
        }
        row[alias] = best;
      }
    }
    out.push(row);
  }
  return out;
}

// ---- Pipeline ---------------------------------------------------------

export async function runQueryV2(
  records: RecordFile[],
  query: RecordQuery,
  fields: FieldTypeMap | undefined,
  resolve: CollectionResolver,
  resolveFields?: FieldsResolver,
  options?: { resolveDocumentPath?: (path: string) => string },
): Promise<RecordQueryResult> {
  // Preload every collection the query reaches so evaluation is synchronous.
  const ctx: EvalContext = { fields, targets: new Map(), targetFields: new Map(), resolveDocumentPath: options?.resolveDocumentPath };
  for (const collectionId of referencedCollections(query, fields)) {
    ctx.targets.set(collectionId, await resolve(collectionId));
    ctx.targetFields.set(collectionId, resolveFields ? await resolveFields(collectionId) : undefined);
  }

  let rows = records;
  const hasWhere = query.where !== undefined && Object.keys(query.where).length > 0;
  if (hasWhere && isPredicateTree(query.where!)) {
    const predicate = parsePredicate(query.where);
    rows = rows.filter((record) => predicateMatches(record, predicate, ctx));
  } else if (hasWhere) {
    throw new RecordQueryShapeError("Legacy flat where-maps do not combine with v2 query features; use a predicate tree");
  }
  if (query.search) {
    const needle = query.search.toLowerCase();
    rows = rows.filter((record) => JSON.stringify(record.data).toLowerCase().includes(needle));
  }

  if (query.aggregate) {
    return { records: [], groups: aggregateGroups(rows, query.aggregate, ctx) };
  }

  const keys = sortKeys(query);
  rows = [...rows].sort(buildComparator(keys, fields));

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor, keys.length);
    const marker = { id: cursor.id, data: {} } as RecordFile;
    // Rebuild a comparable row from the cursor payload: sort values first,
    // then id, exactly mirroring buildComparator's key order.
    rows = rows.filter((record) => {
      for (const [i, key] of keys.entries()) {
        const fieldType = fields?.[key.field] ? normalizeType(fields[key.field]!.type) : undefined;
        const cmp = compareForOrder(fieldValue(record, key.field), cursor.k[i], fieldType) * key.dir;
        if (cmp !== 0) return cmp > 0;
      }
      return record.id.localeCompare(marker.id) > 0;
    });
  }

  let nextCursor: string | undefined;
  if (typeof query.limit === "number" && rows.length > query.limit) {
    rows = rows.slice(0, Math.max(0, query.limit));
    if (rows.length > 0) nextCursor = encodeCursor(rows[rows.length - 1]!, keys);
  }

  const result: RecordQueryResult = { records: rows };
  if (nextCursor) result.nextCursor = nextCursor;

  if (query.expand) {
    const expanded: Record<string, Record<string, RecordFile>> = {};
    for (const [fieldName, projection] of Object.entries(query.expand)) {
      const spec = fields?.[fieldName];
      if (!spec || normalizeRecordFieldType(spec.type) !== "relation" || !spec.references) continue;
      const targets = ctx.targets.get(spec.references);
      if (!targets) continue;
      const bucket = (expanded[spec.references] ??= {});
      for (const record of rows) {
        const raw = record.data[fieldName];
        const ids = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
        for (const id of ids) {
          const target = typeof id === "string" ? targets.get(id) : undefined;
          if (!target || bucket[id as string]) continue;
          bucket[id as string] = projection === true ? target : projectRecord(target, projection);
        }
      }
    }
    result.expanded = expanded;
  }

  if (query.backlinks) {
    const sources = ctx.targets.get(query.backlinks.collection) ?? new Map<string, RecordFile>();
    const byTarget = new Map<string, string[]>();
    for (const source of sources.values()) {
      const raw = source.data[query.backlinks.field];
      const ids = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
      for (const id of ids) {
        if (typeof id !== "string") continue;
        if (!byTarget.has(id)) byTarget.set(id, []);
        byTarget.get(id)!.push(source.id);
      }
    }
    result.backlinks = Object.fromEntries(rows.map((record) => [record.id, byTarget.get(record.id) ?? []]));
  }

  if (query.select) {
    result.records = result.records.map((record) => projectRecord(record, query.select!));
  }

  return result;
}

function projectRecord(record: RecordFile, keys: string[]): RecordFile {
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in record.data) data[key] = record.data[key];
  }
  return { ...record, data };
}
