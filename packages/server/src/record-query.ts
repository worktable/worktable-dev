// ============================================================
// v2 record query evaluation: predicate AST, multi-sort, keyset
// cursors, expand/backlinks/aggregate.
// ============================================================
//
// Every query through queryRecords runs here. A legacy flat where-map is
// compiled into the equivalent predicate tree first, so flat filters page
// with cursors and combine with select, aggregate and the rest. Semantics
// are documented and strict: malformed input is rejected with an error
// instead of silently matching nothing. (listRecords keeps its own flat
// filter for internal callers.)
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

type FieldSpec = RecordCollectionSchema["fields"][string];

/** Order two values of one field for sorting. Select fields follow their
 *  option order, the order the schema lists them in; a value no longer in
 *  the list sorts after every option, and a missing value before them. */
export function compareFieldValues(a: unknown, b: unknown, spec: FieldSpec | undefined): number {
  const values = spec && normalizeRecordFieldType(spec.type) === "select" ? spec.values : undefined;
  if (values && values.length > 0) {
    const rank = (value: unknown): number => {
      if (isMissing(value) || value === "") return -1;
      const index = values.indexOf(String(value));
      return index === -1 ? values.length : index;
    };
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
  }
  return compareForOrder(a, b, spec ? normalizeType(spec.type) : undefined);
}

/** Free-text search over a record's field values: strings, numbers and the
 *  entries of lists, never field names or the record envelope. */
export function recordMatchesSearch(record: RecordFile, needle: string): boolean {
  const lowered = needle.toLowerCase();
  // Iterative, so values nested at any depth (json fields) are searched.
  const pending: unknown[] = Object.values(record.data);
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      if (value.toLowerCase().includes(lowered)) return true;
    } else if (typeof value === "number" || typeof value === "boolean") {
      if (String(value).toLowerCase().includes(lowered)) return true;
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (typeof value === "object") {
      pending.push(...Object.values(value as Record<string, unknown>));
    }
  }
  return false;
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

export function isPredicateTree(where: Record<string, unknown>, fields?: FieldTypeMap): boolean {
  // Shape-aware: a flat filter on a data field literally named "and"/"or"/
  // "not" with a scalar value stays flat; only tree-shaped values are treated
  // as AST (array children for and/or, an object child for not).
  if (Array.isArray(where["and"]) || Array.isArray(where["or"])) return true;
  if (typeof where["not"] === "object" && where["not"] !== null) return true;
  if (typeof where["field"] !== "string" || typeof where["op"] !== "string") return false;
  // A collection with data fields named "field" and "op" can mean a flat
  // filter on them; it is a leaf only when op names a real operator.
  if (fields?.["field"] && fields?.["op"]) return PREDICATE_OPS.includes(where["op"] as RecordPredicateOp);
  return true;
}

const FLAT_OPS = ["in", "contains", "gt", "gte", "lt", "lte"] as const;

/** Compile a legacy flat where-map ({status: "open"}, {due: {gte: ...}}) into
 *  the predicate tree it means: a scalar is `eq`, and an operator object is
 *  one leaf per operator, all of which must hold. */
export function flatWhereToPredicate(where: Record<string, unknown>): Record<string, unknown> | null {
  const leaves: Record<string, unknown>[] = [];
  for (const [field, expected] of Object.entries(where)) {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const ops = expected as Record<string, unknown>;
      const present = FLAT_OPS.filter((op) => op in ops);
      if (present.length > 0) {
        for (const op of present) leaves.push({ field, op, value: ops[op] });
        continue;
      }
    }
    leaves.push({ field, op: "eq", value: expected });
  }
  if (leaves.length === 0) return null;
  return leaves.length === 1 ? leaves[0]! : { and: leaves };
}

// Validate an untrusted predicate tree, rejecting malformed shapes loudly
// (the AST is a new surface — no legacy quirk to preserve).
export function parsePredicate(input: unknown, depth = 0, fields?: FieldTypeMap): RecordPredicate {
  if (depth > 20) throw new RecordQueryShapeError("Predicate tree too deep (max 20 levels)");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RecordQueryShapeError("Predicate must be an object");
  const node = input as Record<string, unknown>;
  // A flat filter inside a tree ({and: [{status: "open"}, {not: false}]})
  // means the same as at the top level, including on fields named and/or/not.
  // Classify the shape before reading any key as a connective.
  if (!isPredicateTree(node, fields)) {
    const compiled = flatWhereToPredicate(node);
    if (!compiled) throw new RecordQueryShapeError("Predicate must not be empty");
    return parsePredicate(compiled, depth + 1, fields);
  }
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
    const children = (node[key] as unknown[]).map((child) => parsePredicate(child, depth + 1, fields));
    return key === "and" ? { and: children } : { or: children };
  }
  if ("not" in node) return { not: parsePredicate(node["not"], depth + 1, fields) };
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
  const where = query.where && (isPredicateTree(query.where, fields) ? query.where : flatWhereToPredicate(query.where));
  if (where) {
    const walk = (node: RecordPredicate): void => {
      if ("and" in node) node.and.forEach(walk);
      else if ("or" in node) node.or.forEach(walk);
      else if ("not" in node) walk(node.not);
      else if (node.field.includes(".")) {
        const target = relationTarget(node.field.split(".")[0]!);
        if (target) out.add(target);
      }
    };
    walk(parsePredicate(where, 0, fields));
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
        // A document reference compares by its current path, so a value
        // stored before a rename still matches the renamed path.
        const text = (entry: unknown): string =>
          document && ctx.resolveDocumentPath && typeof entry === "string" ? ctx.resolveDocumentPath(entry) : String(entry ?? "");
        if (Array.isArray(value)) return value.some((entry) => text(entry).toLowerCase().includes(needle));
        return text(value).toLowerCase().includes(needle);
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

/** The rows a parsed predicate matches, judged on their own fields only: a
 *  relation path finds no targets here, so it matches as an empty relation. */
export function filterRows(rows: RecordFile[], predicate: RecordPredicate, fields: FieldTypeMap | undefined): RecordFile[] {
  const ctx: EvalContext = { fields, targets: new Map(), targetFields: new Map() };
  return rows.filter((record) => predicateMatches(record, predicate, ctx));
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
      const cmp = compareFieldValues(fieldValue(a, key.field), fieldValue(b, key.field), fields?.[key.field]) * key.dir;
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

function aggregateGroups(
  records: RecordFile[],
  aggregate: NonNullable<RecordQuery["aggregate"]>,
  ctx: EvalContext,
  groupEachValue = false,
): Record<string, unknown>[] {
  const fields = ctx.fields;
  const groupField = aggregate.groupBy ? fields?.[aggregate.groupBy] : undefined;
  const groupType = groupField ? normalizeRecordFieldType(groupField.type) : undefined;
  // With groupEachValue, a list field (multi_select, or a many relation or
  // document field) counts each record once under every value it holds,
  // instead of once under the whole combination.
  const splitValues = groupEachValue && (groupType === "multi_select" || ((groupType === "relation" || groupType === "document") && groupField?.many === true));
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
    const keys = splitValues && Array.isArray(key) ? (key.length > 0 ? [...new Set(key)] : [null]) : [key];
    for (const groupKey of keys) {
      const mapKey = JSON.stringify(groupKey);
      if (!groups.has(mapKey)) groups.set(mapKey, { key: groupKey, rows: [] });
      groups.get(mapKey)!.rows.push(record);
    }
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
  options?: { resolveDocumentPath?: (path: string) => string; groupEachValue?: boolean },
): Promise<RecordQueryResult> {
  // Preload every collection the query reaches so evaluation is synchronous.
  const ctx: EvalContext = { fields, targets: new Map(), targetFields: new Map(), resolveDocumentPath: options?.resolveDocumentPath };
  for (const collectionId of referencedCollections(query, fields)) {
    ctx.targets.set(collectionId, await resolve(collectionId));
    ctx.targetFields.set(collectionId, resolveFields ? await resolveFields(collectionId) : undefined);
  }

  let rows = records;
  const hasWhere = query.where !== undefined && Object.keys(query.where).length > 0;
  const where = hasWhere ? (isPredicateTree(query.where!, fields) ? query.where! : flatWhereToPredicate(query.where!)) : null;
  if (where) {
    const predicate = parsePredicate(where, 0, fields);
    rows = rows.filter((record) => predicateMatches(record, predicate, ctx));
  }
  if (query.search) {
    const needle = query.search;
    rows = rows.filter((record) => recordMatchesSearch(record, needle));
  }

  if (query.aggregate) {
    return { records: [], groups: aggregateGroups(rows, query.aggregate, ctx, options?.groupEachValue) };
  }

  const keys = sortKeys(query);
  rows = [...rows].sort(buildComparator(keys, fields));
  const total = rows.length;

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor, keys.length);
    const marker = { id: cursor.id, data: {} } as RecordFile;
    // Rebuild a comparable row from the cursor payload: sort values first,
    // then id, exactly mirroring buildComparator's key order.
    rows = rows.filter((record) => {
      for (const [i, key] of keys.entries()) {
        const cmp = compareFieldValues(fieldValue(record, key.field), cursor.k[i], fields?.[key.field]) * key.dir;
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

  const result: RecordQueryResult = { records: rows, total };
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
