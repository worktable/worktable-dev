// Saved reads: a link in fixed mode runs only the record reads saved with
// it. A read is saved in one canonical form, so the same question asked the
// same way always looks the same. A visitor's query matches a saved read when
// it asks the same thing (its shape) with the saved values, or with values
// the read leaves open. The server then runs the saved read, never the
// visitor's query.

import { LINK_SEARCH_MAX_LENGTH } from "./link-query-limits.ts";
import { createHash } from "node:crypto";
import type { CollectionGrant, FixedParam, FixedRead, FixedReadQuery, LinkGrant, RecordCollectionSchema, RecordPredicate, RecordPredicateOp, RecordQuery } from "@worktable/types";
import { normalizeRecordFieldType } from "@worktable/types";
import { flatWhereToPredicate, isPredicateTree, parsePredicate, RecordQueryShapeError, type FieldTypeMap } from "./record-query.ts";

// ---- Canonical form -------------------------------------------------------

/**
 * A query in the form saved reads are kept and compared in: `where` is a
 * predicate tree whose `and`/`or` children are flattened and sorted by shape,
 * then value; `in` values, `select` and expand projections are sorted;
 * `orderBy` is a list with explicit directions. Paging and the archive flag
 * are left out, because the engine supplies them. `fields` only tells a flat
 * filter from a tree on collections with fields named "field" and "op".
 */
export function canonicalRecordQuery(query: RecordQuery | FixedReadQuery, fields?: FieldTypeMap): FixedReadQuery {
  const out: Record<string, unknown> = {};
  const where = query.where as Record<string, unknown> | undefined;
  if (where && Object.keys(where).length > 0) {
    const tree = isPredicateTree(where, fields) ? where : flatWhereToPredicate(where)!;
    out["where"] = canonicalPredicate(parsePredicate(tree, 0, fields));
  }
  // An empty search searches nothing.
  if (query.search) out["search"] = query.search;
  if (query.orderBy !== undefined) {
    out["orderBy"] = typeof query.orderBy === "string"
      ? [{ field: query.orderBy, dir: query.order ?? "asc" }]
      : query.orderBy.map((entry) => ({ field: entry.field, dir: entry.dir ?? "asc" }));
  }
  if (query.limit !== undefined) out["limit"] = query.limit;
  if (query.select) out["select"] = sortedUnique(query.select);
  if (query.expand) {
    out["expand"] = Object.fromEntries(Object.entries(query.expand).map(([name, projection]) => [name, projection === true ? true : sortedUnique(projection)]));
  }
  if (query.backlinks) out["backlinks"] = { collection: query.backlinks.collection, field: query.backlinks.field };
  if (query.aggregate) {
    const { groupBy, select } = query.aggregate;
    out["aggregate"] = {
      ...(groupBy !== undefined ? { groupBy } : {}),
      select: Object.fromEntries(Object.entries(select).map(([alias, spec]) => [alias, spec.field !== undefined ? { fn: spec.fn, field: spec.field } : { fn: spec.fn }])),
    };
  }
  return out as FixedReadQuery;
}

/** A parsed predicate in canonical form. Equivalent trees come out equal. */
export function canonicalPredicate(node: RecordPredicate): RecordPredicate {
  if ("and" in node || "or" in node) {
    const key = "and" in node ? "and" : "or";
    const children: RecordPredicate[] = [];
    for (const child of ((node as Record<string, RecordPredicate[]>)[key]!).map(canonicalPredicate)) {
      // a and (b and c) is a and b and c.
      if (key in child) children.push(...(child as Record<string, RecordPredicate[]>)[key]!);
      else children.push(child);
    }
    if (children.length === 1) return children[0]!;
    const sorted = children
      .map((child) => [predicateShape(child), canonicalJson(child), child] as const)
      .sort(([shapeA, jsonA], [shapeB, jsonB]) => compareText(shapeA, shapeB) || compareText(jsonA, jsonB))
      .map(([, , child]) => child);
    return key === "and" ? { and: sorted } : { or: sorted };
  }
  if ("not" in node) return { not: canonicalPredicate(node.not) };
  // isEmpty without a value means isEmpty: true.
  const value = node.op === "isEmpty" ? node.value ?? true : node.op === "in" ? sortedUnique(node.value as unknown[]) : node.value;
  return value === undefined ? { field: node.field, op: node.op } : { field: node.field, op: node.op, value };
}

/** What a canonical query asks, without the values it compares with. Two
 *  queries with one shape differ at most in their values and limit. */
export function recordQueryShape(query: FixedReadQuery): string {
  return canonicalJson({
    ...query,
    where: query.where ? maskPredicate(query.where) : undefined,
    search: query.search !== undefined ? "?" : undefined,
    limit: undefined,
  });
}

function predicateShape(node: RecordPredicate): string {
  return canonicalJson(maskPredicate(node));
}

function maskPredicate(node: RecordPredicate): unknown {
  if ("and" in node) return { and: node.and.map(maskPredicate) };
  if ("or" in node) return { or: node.or.map(maskPredicate) };
  if ("not" in node) return { not: maskPredicate(node.not) };
  return node.value === undefined ? { field: node.field, op: node.op } : { field: node.field, op: node.op, value: "?" };
}

/** A value a query compares with: a condition's value, or the search text. */
export interface QueryValue {
  /** JSON pointer into the canonical query, such as "/where/and/0/value". */
  pointer: string;
  value: unknown;
  /** The condition's field path and operator; absent for the search text. */
  field?: string;
  op?: RecordPredicateOp;
}

/** The query with each value it compares with replaced, in a fixed order. */
function replaceQueryValues(query: FixedReadQuery, replace: (position: QueryValue) => unknown): FixedReadQuery {
  const visit = (node: RecordPredicate, pointer: string): RecordPredicate => {
    if ("and" in node) return { and: node.and.map((child, i) => visit(child, `${pointer}/and/${i}`)) };
    if ("or" in node) return { or: node.or.map((child, i) => visit(child, `${pointer}/or/${i}`)) };
    if ("not" in node) return { not: visit(node.not, `${pointer}/not`) };
    if (node.value === undefined) return node;
    return { field: node.field, op: node.op, value: replace({ pointer: `${pointer}/value`, value: node.value, field: node.field, op: node.op }) };
  };
  return {
    ...query,
    ...(query.where ? { where: visit(query.where, "/where") } : {}),
    ...(query.search !== undefined ? { search: replace({ pointer: "/search", value: query.search }) as string } : {}),
  };
}

/** Every value a canonical query compares with, in order. */
export function queryValues(query: FixedReadQuery): QueryValue[] {
  const values: QueryValue[] = [];
  replaceQueryValues(query, (position) => {
    values.push(position);
    return position.value;
  });
  return values;
}

// ---- Matching -------------------------------------------------------------

interface SavedRead {
  read: FixedRead;
  values: QueryValue[];
}

/** Saved reads by collection and shape: finding the candidates is one lookup. */
export type FixedReadIndex = ReadonlyMap<string, readonly SavedRead[]>;

export function indexFixedReads(collections: Iterable<readonly [string, readonly FixedRead[]]>): FixedReadIndex {
  const index = new Map<string, SavedRead[]>();
  for (const [collectionId, reads] of collections) {
    for (const read of reads) {
      const key = `${collectionId}\0${recordQueryShape(read.query)}`;
      const saved = index.get(key) ?? [];
      saved.push({ read, values: queryValues(read.query) });
      index.set(key, saved);
    }
  }
  return index;
}

export interface FixedReadMatch {
  read: FixedRead;
  /** Each saved value's position, with what the visitor sent there. */
  values: { position: QueryValue; param: FixedParam | undefined; given: unknown }[];
}

/**
 * The saved read a visitor's canonical query matches, or null. A value the
 * read doesn't leave open must equal the saved one exactly, as the tool sent
 * it: stored ids included. `oneOf` takes a listed value, and on `in` a subset
 * of the list; a listed stored id may also come as the link's id for it,
 * through `toView`. `any` takes any value. Of saved reads that differ only in
 * their limit, the one allowing the most rows runs; the visitor's own limit
 * still applies.
 */
export function matchFixedRead(
  index: FixedReadIndex,
  collectionId: string,
  query: FixedReadQuery,
  toView: (position: QueryValue, value: unknown) => unknown = (_position, value) => value,
): FixedReadMatch | null {
  const saved = index.get(`${collectionId}\0${recordQueryShape(query)}`);
  if (!saved) return null;
  // One shape, so the values line up one to one. Open places never sit
  // beside a condition of the same form (grant checks refuse that), so
  // sorting by value can't move a visitor's value into another's place.
  const given = queryValues(query);
  let best: FixedReadMatch | null = null;
  for (const { read, values } of saved) {
    const matched = values.map((position, i) => {
      const param = paramAt(read, position.pointer);
      return { position, param, given: param?.kind === "oneOf" ? asListed(param.values, position, given[i]!.value, toView) : given[i]!.value };
    });
    if (!matched.every(({ position, param, given }) => allows(param, position, given))) continue;
    if (!best || (read.query.limit ?? Infinity) > (best.read.query.limit ?? Infinity)) best = { read, values: matched };
  }
  return best;
}

/** A visitor may name a listed record by the id the link showed them: such a
 *  value is read as the listed stored id it stands for. */
function asListed(listed: readonly unknown[], position: QueryValue, given: unknown, toView: (position: QueryValue, value: unknown) => unknown): unknown {
  const byView = new Map(listed.map((value) => [canonicalJson(toView(position, value)), value]));
  const one = (value: unknown) => byView.get(canonicalJson(value)) ?? value;
  return position.op === "in" && Array.isArray(given) ? given.map(one) : one(given);
}

/**
 * The saved read with the visitor's values in its open places, ready to run.
 * `toView` turns a value into the one the link's rows hold; values sent for
 * an `any` place are used as sent.
 */
export function compileFixedRead(match: FixedReadMatch, toView: (position: QueryValue, value: unknown) => unknown): FixedReadQuery {
  let i = 0;
  return replaceQueryValues(match.read.query, () => {
    const { position, param, given } = match.values[i++]!;
    if (param?.kind === "any") return given;
    return toView(position, param ? given : position.value);
  });
}

function paramAt(read: FixedRead, pointer: string): FixedParam | undefined {
  return Object.hasOwn(read.params, pointer) ? read.params[pointer] : undefined;
}

function allows(param: FixedParam | undefined, position: QueryValue, given: unknown): boolean {
  if (!param) return canonicalJson(given) === canonicalJson(position.value);
  if (param.kind === "any") return true;
  const listed = new Set(param.values.map(canonicalJson));
  if (position.op === "in") return Array.isArray(given) && given.every((entry) => listed.has(canonicalJson(entry)));
  return listed.has(canonicalJson(given));
}

// ---- Checking saved reads against a grant ---------------------------------

/** Problems with a fixed collection's saved reads. Empty means each one can be matched. */
export function fixedReadIssues(collectionId: string, grant: LinkGrant, schemas: ReadonlyMap<string, RecordCollectionSchema>): string[] {
  const collection = grant.collections[collectionId]!;
  const schema = schemas.get(collectionId);
  if (!schema) return [];
  const issues: string[] = [];
  for (const read of collection.fixed ?? []) {
    let canonical: FixedReadQuery;
    try {
      canonical = canonicalRecordQuery(read.query, schema.fields);
    } catch (error) {
      if (!(error instanceof RecordQueryShapeError)) throw error;
      issues.push(`Saved read "${read.id}" is invalid: ${error.message}`);
      continue;
    }
    // Open places are named by where they sit in the canonical form.
    if (canonicalJson(canonical) !== canonicalJson(read.query)) {
      issues.push(`Saved read "${read.id}" isn't in canonical form.`);
      continue;
    }
    if (canonical.search !== undefined && canonical.search.length > LINK_SEARCH_MAX_LENGTH) {
      issues.push(`Saved read "${read.id}" searches more than ${LINK_SEARCH_MAX_LENGTH} characters.`);
    }
    const positions = new Map(queryValues(canonical).map((position) => [position.pointer, position]));
    for (const pointer of Object.keys(read.params)) {
      const position = positions.get(pointer);
      if (!position) issues.push(`Saved read "${read.id}" leaves "${pointer}" open, which isn't a value it compares with.`);
      // Search text only reaches fields the link shows. A condition's value
      // may be open, even to a list, only where the link shows the field:
      // anywhere else, the answers would tell what a hidden field holds.
      else if (position.field !== undefined && !grantShows(grant, schemas, collectionId, collection, position.field)) {
        issues.push(`Saved read "${read.id}" can leave "${position.field}" open only if the link shows it.`);
      }
      // Conditions of one form sort by value, so a visitor's value could
      // take a neighbour's place.
      else if (beside(canonical.where, pointer)) issues.push(`Saved read "${read.id}" can't leave "${pointer}" open beside a condition of the same form.`);
    }
    // A saved condition on a field the link doesn't show narrows the stored
    // rows, like the grant's row condition: it must be on the collection's
    // own field, and every result must meet it.
    const required = !canonical.where ? [] : "and" in canonical.where ? canonical.where.and : [canonical.where];
    forEachCondition(canonical.where, "/where", (leaf, pointer) => {
      if (grantShows(grant, schemas, collectionId, collection, leaf.field)) {
        // Shown ids are the link's own, so only equality can carry a saved id
        // across; text and order comparisons would test another value.
        if (ORDER_OR_TEXT_OPS.has(leaf.op) && holdsIds(schemas, collectionId, leaf.field)) {
          issues.push(`Saved read "${read.id}" can compare "${leaf.field}" only for equality, since links show their own ids.`);
        }
        return;
      }
      if (Object.hasOwn(read.params, `${pointer}/value`)) return;
      if (!storedRowField(schema, leaf.field)) issues.push(`Saved read "${read.id}" can't filter on "${leaf.field}", which this link doesn't show.`);
      else if (!required.includes(leaf)) {
        issues.push(`Saved read "${read.id}" can filter on "${leaf.field}", which this link doesn't show, only with a condition every result meets.`);
      }
    });
    // Sorting, grouping, expanding and backlinks read the values themselves.
    const shown = (name: string) => !name.includes(".") && grantShows(grant, schemas, collectionId, collection, name);
    const used = [
      ...(canonical.orderBy as { field: string }[] | undefined ?? []).map((entry) => entry.field),
      ...(canonical.aggregate?.groupBy !== undefined ? [canonical.aggregate.groupBy] : []),
      ...Object.values(canonical.aggregate?.select ?? {}).flatMap((spec) => (spec.field !== undefined ? [spec.field] : [])),
    ];
    for (const name of used) if (!shown(name)) issues.push(`Saved read "${read.id}" uses "${name}", which this link doesn't show.`);
    for (const name of opaqueIdOrdering(canonical, collectionId, schemas)) {
      issues.push(`Saved read "${read.id}" can't sort by "${name}", since links show their own ids.`);
    }
    // An expanded relation must lead to rows the link shows.
    for (const name of Object.keys(canonical.expand ?? {})) {
      if (!grantShows(grant, schemas, collectionId, collection, `${name}.id`)) issues.push(`Saved read "${read.id}" uses "${name}", which this link doesn't show.`);
    }
    if (canonical.backlinks) {
      const { collection: sourceId, field } = canonical.backlinks;
      const source = Object.hasOwn(grant.collections, sourceId) ? grant.collections[sourceId]! : undefined;
      if (!source || source.mode === "summaries" || !grantShows(grant, schemas, sourceId, source, field) || field.includes(".")) {
        issues.push(`Saved read "${read.id}" uses "${sourceId}.${field}", which this link doesn't show.`);
      }
    }
  }
  return issues;
}

const ORDER_OR_TEXT_OPS = new Set(["contains", "gt", "gte", "lt", "lte"]);

/** Whether a field path holds record ids: "id", a relation, or a relation's
 *  "id" or relation one hop on. */
function holdsIds(schemas: ReadonlyMap<string, RecordCollectionSchema>, collectionId: string, path: string): boolean {
  if (path === "id") return true;
  const dot = path.indexOf(".");
  const head = dot === -1 ? path : path.slice(0, dot);
  const fields = schemas.get(collectionId)?.fields;
  const spec = fields && Object.hasOwn(fields, head) ? fields[head]! : undefined;
  if (!spec || normalizeRecordFieldType(spec.type) !== "relation" || !spec.references) return false;
  return dot === -1 || holdsIds(schemas, spec.references, path.slice(dot + 1));
}

/** Saved ordering cannot carry stored ID order across opaque projection. */
export function opaqueIdOrdering(query: FixedReadQuery, collectionId: string, schemas: ReadonlyMap<string, RecordCollectionSchema>): string[] {
  const names = typeof query.orderBy === "string" ? [query.orderBy] : (query.orderBy ?? []).map((entry) => entry.field);
  return names.filter((name) => holdsIds(schemas, collectionId, name));
}

/** Whether a condition on this field can be judged on stored rows, as row
 *  conditions are: a field of the collection itself, and not one whose
 *  value is a document path or a name every object inherits. */
export function storedRowField(schema: RecordCollectionSchema, name: string): boolean {
  if (name.includes(".") || name === "data" || name in Object.prototype || !Object.hasOwn(schema.fields, name)) return false;
  return normalizeRecordFieldType(schema.fields[name]!.type) !== "document";
}

/** Whether the condition at a "/where/..." pointer, or a group holding it,
 *  has a sibling of the same shape. */
function beside(where: RecordPredicate | undefined, pointer: string): boolean {
  if (!where || !pointer.startsWith("/where/")) return false;
  const steps = pointer.slice("/where/".length).split("/");
  let node: RecordPredicate = where;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step === "not" && "not" in node) node = node.not;
    else if ((step === "and" || step === "or") && step in node) {
      const children = (node as Record<string, RecordPredicate[]>)[step]!;
      const child = children[Number(steps[++i])]!;
      const shape = predicateShape(child);
      if (children.some((other) => other !== child && predicateShape(other) === shape)) return true;
      node = child;
    } else return false;
  }
  return false;
}

function forEachCondition(node: RecordPredicate | undefined, pointer: string, visit: (leaf: Extract<RecordPredicate, { field: string }>, pointer: string) => void): void {
  if (!node) return;
  if ("and" in node) node.and.forEach((child, i) => forEachCondition(child, `${pointer}/and/${i}`, visit));
  else if ("or" in node) node.or.forEach((child, i) => forEachCondition(child, `${pointer}/or/${i}`, visit));
  else if ("not" in node) forEachCondition(node.not, `${pointer}/not`, visit);
  else visit(node, pointer);
}

/** Whether a link shows a collection's field, or the field a relation path ends at. */
function grantShows(grant: LinkGrant, schemas: ReadonlyMap<string, RecordCollectionSchema>, collectionId: string, collection: CollectionGrant, path: string): boolean {
  const dot = path.indexOf(".");
  if (dot === -1) {
    if (path === "id") return true;
    if (path === "createdAt" || path === "updatedAt") return collection.timestamps;
    const schema = schemas.get(collectionId);
    return collection.fields.includes(path) && !!schema && Object.hasOwn(schema.fields, path);
  }
  const head = path.slice(0, dot);
  const spec = schemas.get(collectionId)?.fields;
  const relation = collection.fields.includes(head) && spec && Object.hasOwn(spec, head) ? spec[head]! : undefined;
  if (!relation || normalizeRecordFieldType(relation.type) !== "relation" || !relation.references) return false;
  const target = Object.hasOwn(grant.collections, relation.references) ? grant.collections[relation.references]! : undefined;
  if (!target || target.mode === "summaries") return false;
  const rest = path.slice(dot + 1);
  return !rest.includes(".") && grantShows(grant, schemas, relation.references, target, rest);
}

// ---- Reads a link refused -------------------------------------------------

// Counted per link in this process, for "View as Visitor". A refused read is
// kept as a digest of its shape: never the visitor's values, nor the names
// they chose. Memory stays bounded.
const UNRECORDED_LINKS_LIMIT = 256;
const UNRECORDED_SHAPES_PER_LINK = 16;

export interface UnrecordedRead {
  collectionId: string;
  /** A digest of recordQueryShape, to tell refused reads apart. */
  shapeDigest: string;
  count: number;
}

const unrecorded = new Map<string, { total: number; reads: Map<string, UnrecordedRead> }>();

/** A short digest of a read's shape. */
export function shapeDigest(shape: string): string {
  return createHash("sha256").update(shape).digest("base64url").slice(0, 16);
}

/** Notes that a link refused a read it has no saved read for. */
export function noteUnrecordedRead(linkId: string, collectionId: string, shape: string): void {
  let entry = unrecorded.get(linkId);
  if (!entry) {
    if (unrecorded.size >= UNRECORDED_LINKS_LIMIT) unrecorded.delete(unrecorded.keys().next().value!);
    entry = { total: 0, reads: new Map() };
    unrecorded.set(linkId, entry);
  }
  entry.total++;
  const digest = shapeDigest(shape);
  const key = `${collectionId}\0${digest}`;
  const read = entry.reads.get(key);
  if (read) read.count++;
  else if (entry.reads.size < UNRECORDED_SHAPES_PER_LINK) entry.reads.set(key, { collectionId, shapeDigest: digest, count: 1 });
}

/** The reads a link refused since this process started, most common first. */
export function unrecordedReads(linkId: string): { total: number; reads: UnrecordedRead[] } {
  const entry = unrecorded.get(linkId);
  if (!entry) return { total: 0, reads: [] };
  return { total: entry.total, reads: [...entry.reads.values()].map((read) => ({ ...read })).sort((a, b) => b.count - a.count) };
}

// ---- Shared helpers -------------------------------------------------------

/** JSON with object keys sorted, so equal values print equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => compareText(a, b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function compareText(a: string | undefined, b: string | undefined): number {
  const left = a ?? "";
  const right = b ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T>(values: readonly T[]): T[] {
  const byJson = new Map<string, T>();
  for (const value of values) byJson.set(canonicalJson(value), value);
  return [...byJson.entries()].sort(([a], [b]) => compareText(a, b)).map(([, value]) => value);
}
