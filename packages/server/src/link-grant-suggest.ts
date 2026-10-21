// What a share link should open for an HTML Doc, judged from what the tool
// reads: the collections and fields its reads name, a row condition every
// read shares, totals where it only ever asks for totals, and its reads as
// candidates for saving. The sharer starts from this and edits it.

import {
  CanonicalIdSchema,
  LinkGrantSchema,
  normalizeRecordFieldType,
  RecordFieldTypeSchema,
  type FixedRead,
  type FixedReadQuery,
  type LinkGrant,
  type LinkGrantInput,
  type RecordCollectionSchema,
  type RecordPredicate,
  type RecordQuery,
  type SummaryRules,
  type WidgetFile,
} from "@worktable/types";
import { LINK_SEARCH_MAX_LENGTH } from "./link-query-limits.ts";
import type { ObservedRecordQuery } from "./html-preview.ts";
import { canonicalJson, canonicalPredicate, canonicalRecordQuery, compareText, opaqueIdOrdering } from "./link-fixed-reads.ts";
import { forEachLeaf, isRecordKey, validateLinkGrant } from "./link-grant.ts";
import { admitSummaries, LinkQueryError, projectFields } from "./link-grant-view.ts";
import { referencedCollections, RecordQueryShapeError } from "./record-query.ts";
import { parseRecordQuery, RecordQueryError } from "./record-store.ts";
import { hasDynamicRecordCollection, inferWidgetRecordPermissions } from "./widget-authoring.ts";
import { canWidgetRecord } from "./widget-runtime-policy.ts";

export type LinkGrantSuggestionWarningCode =
  | "whole_records"
  | "search_fields"
  | "later_reads"
  | "unsupported_reads"
  | "fields_left_out"
  | "archived_rows"
  | "small_groups_hidden"
  | "dynamic_collection"
  | "static_only"
  | "declared_unseen"
  | "too_many_reads"
  | "too_many_fields";

export interface LinkGrantSuggestionWarning {
  code: LinkGrantSuggestionWarningCode;
  collectionId?: string;
  message: string;
}

export interface LinkGrantSuggestion {
  /** Scoped or summaries collections only: saved reads are the sharer's choice. */
  grant: LinkGrant;
  /** Each collection's observed reads, ready to save if the sharer opens it through saved reads. */
  fixedReads: Record<string, FixedRead[]>;
  warnings: LinkGrantSuggestionWarning[];
}

/** Field types a whole-record read doesn't suggest: they name people or hold
 *  paths and free-form data. */
const NOT_SUGGESTED_FOR_WHOLE_RECORDS = new Set(["person", "email", "document", "json"]);
const MAX_FIELDS = 200;
const MAX_FIXED_READS = 50;

/**
 * Suggests a link grant for an HTML Doc from its declared permissions, its
 * HTML and the Records reads a preview observed (captureHtmlPreview with
 * observeRecordReads).
 *
 * The suggestion is a lower bound: the preview sees the tool's first load,
 * not what it reads after a click, so the warnings name what it may have
 * missed. It never widens what the tool may read, and never names `*`.
 * - Collections: those the tool may read, among the ones its HTML names, its
 *   reads query and its reads reach through relations, expands and backlinks.
 * - Fields: every field a read names. A read without `select` takes whole
 *   records, so every field but people, email addresses, documents and JSON
 *   is suggested, and a warning says so. A relation shows only when the
 *   suggestion opens its target's rows: ids the tool never looked up on
 *   first load aren't worth opening another collection for.
 * - Rows: an `eq` or `has` condition every read of the collection shares.
 * - Mode: summaries when every read of the collection is a total that a
 *   summaries link can answer. The preview can't tell group sizes, so a
 *   warning says small totals are hidden.
 * Warnings also name fields the tool reads that a link can't show, and
 * archived rows it reads, which links never show.
 */
export function suggestLinkGrant(input: {
  permissions: WidgetFile["permissions"] | undefined;
  html: string;
  observed: readonly ObservedRecordQuery[];
  schemas: ReadonlyMap<string, RecordCollectionSchema>;
}): LinkGrantSuggestion {
  const { permissions, html, schemas } = input;
  const mayRead = (collectionId: string) =>
    schemas.has(collectionId) && CanonicalIdSchema.safeParse(collectionId).success && canWidgetRecord({ permissions }, collectionId, "read");
  const nameOf = (collectionId: string) => schemas.get(collectionId)?.name ?? collectionId;
  const relationTarget = (collectionId: string, name: string): string | null => {
    const fields = schemas.get(collectionId)?.fields;
    const spec = fields && Object.hasOwn(fields, name) ? fields[name]! : undefined;
    return spec && normalizeRecordFieldType(spec.type) === "relation" && spec.references ? spec.references : null;
  };

  // The reads the tool made, once each in canonical form. A read that
  // reaches a collection the tool may not read, itself or through a
  // relation, was refused, so it read nothing.
  const asked = new Map<string, FixedReadQuery[]>();
  // Collections the tool read archived rows of, which links never show.
  const archived = new Set<string>();
  for (const { collectionId, query } of input.observed) {
    if (!mayRead(collectionId)) continue;
    const fields = schemas.get(collectionId)!.fields;
    let parsed: RecordQuery;
    let canonical: FixedReadQuery;
    try {
      parsed = parseRecordQuery(query);
      canonical = canonicalRecordQuery(parsed, fields);
    } catch (error) {
      if (error instanceof RecordQueryError || error instanceof RecordQueryShapeError) continue;
      throw error;
    }
    if (!referencedCollections(canonical as RecordQuery, fields).every(mayRead)) continue;
    if (parsed.includeArchived) archived.add(collectionId);
    const reads = asked.get(collectionId) ?? [];
    if (!reads.some((read) => canonicalJson(read) === canonicalJson(canonical))) reads.push(canonical);
    asked.set(collectionId, reads);
  }
  // Collections whose rows another read reaches, which totals can't serve.
  const reached = new Set<string>();
  for (const [collectionId, reads] of asked) {
    for (const read of reads) {
      for (const target of referencedCollections(read as RecordQuery, schemas.get(collectionId)!.fields)) reached.add(target);
    }
  }
  const named = Object.entries(inferWidgetRecordPermissions(html)).filter(([, actions]) => actions.read).map(([collectionId]) => collectionId);
  const seen = new Set([...named, ...asked.keys(), ...reached]);
  const collections = [...seen].filter(mayRead).sort(compareText);

  const shown = new Map(collections.map((collectionId) => [collectionId, new Set<string>()]));
  const whole = new Set<string>();
  const show = (collectionId: string, name: string) => shown.get(collectionId)?.add(name);
  const showPath = (collectionId: string, path: string) => {
    const dot = path.indexOf(".");
    if (dot === -1) return show(collectionId, path);
    show(collectionId, path.slice(0, dot));
    const target = relationTarget(collectionId, path.slice(0, dot));
    if (target) show(target, path.slice(dot + 1));
  };
  for (const [collectionId, reads] of asked) {
    for (const read of reads) {
      for (const name of read.select ?? []) show(collectionId, name);
      if (read.where) forEachLeaf(read.where, (path) => showPath(collectionId, path));
      for (const entry of (read.orderBy ?? []) as { field: string }[]) show(collectionId, entry.field);
      if (read.aggregate?.groupBy !== undefined) show(collectionId, read.aggregate.groupBy);
      for (const spec of Object.values(read.aggregate?.select ?? {})) if (spec.field !== undefined) show(collectionId, spec.field);
      for (const [name, projection] of Object.entries(read.expand ?? {})) {
        show(collectionId, name);
        const target = relationTarget(collectionId, name);
        if (!target) continue;
        if (projection === true) whole.add(target);
        else for (const field of projection) show(target, field);
      }
      if (read.backlinks) show(read.backlinks.collection, read.backlinks.field);
      if (!read.select && !read.aggregate) whole.add(collectionId);
    }
  }

  const summaries = new Map<string, SummaryRules>();
  for (const collectionId of collections) {
    const reads = asked.get(collectionId) ?? [];
    if (reached.has(collectionId) || reads.length === 0 || !reads.every((read) => read.aggregate)) continue;
    const rules = summaryRules(collectionId, reads, schemas);
    if (rules) summaries.set(collectionId, rules);
  }

  const warnings: LinkGrantSuggestionWarning[] = [];
  if (hasDynamicRecordCollection(html)) {
    warnings.push({ code: "dynamic_collection", message: "This tool chooses some collections as it runs, so it may read collections this suggestion leaves out." });
  }
  const grants: Record<string, NonNullable<LinkGrantInput["collections"]>[string]> = {};
  const fixedReads: Record<string, FixedRead[]> = {};
  for (const collectionId of collections) {
    const schema = schemas.get(collectionId)!;
    const reads = asked.get(collectionId) ?? [];
    const rows = sharedRowCondition(schema, reads);
    const rules = summaries.get(collectionId);
    const saveableReads = reads.filter((read) => (read.search?.length ?? 0) <= LINK_SEARCH_MAX_LENGTH && opaqueIdOrdering(read, collectionId, schemas).length === 0);
    if (saveableReads.length !== reads.length) warnings.push({
      code: "unsupported_reads", collectionId,
      message: `Some ${nameOf(collectionId)} reads exceed the link's ${LINK_SEARCH_MAX_LENGTH}-character search limit or sort by record IDs. Those reads cannot be saved.`,
    });
    if (reads.some((read) => read.search)) warnings.push({
      code: "search_fields", collectionId,
      message: `This tool searches all ${nameOf(collectionId)} fields. A link searches only the fields it shows, so matching records or totals may differ.`,
    });
    if (named.includes(collectionId) && asked.has(collectionId)) warnings.push({
      code: "later_reads", collectionId,
      message: `This preview saw ${nameOf(collectionId)} reads on first load only. Later actions may need different fields or rows; check those actions before sharing.`,
    });
    if (saveableReads.length > 0) fixedReads[collectionId] = saveableReads.slice(0, MAX_FIXED_READS).map((query, i) => ({ id: `read-${i + 1}`, query, params: {} }));
    if (reads.length > MAX_FIXED_READS) {
      warnings.push({
        code: "too_many_reads",
        collectionId,
        message: `This tool read ${nameOf(collectionId)} in more ways than a link can save. Saving its reads would cover only the first ${MAX_FIXED_READS}.`,
      });
    }
    if (archived.has(collectionId)) {
      warnings.push({ code: "archived_rows", collectionId, message: `This tool reads archived ${nameOf(collectionId)} records, which links never show.` });
    }
    const explicit = shown.get(collectionId)!;
    const names = new Set(explicit);
    if (whole.has(collectionId)) {
      for (const [name, spec] of Object.entries(schema.fields)) {
        if (!NOT_SUGGESTED_FOR_WHOLE_RECORDS.has(normalizeRecordFieldType(spec.type))) names.add(name);
      }
      warnings.push({
        code: "whole_records",
        collectionId,
        message: `This tool reads whole ${nameOf(collectionId)} records, so the suggestion shows every field except people, email addresses, documents, JSON and links to collections it doesn't open.`,
      });
    }
    const fields = [...names].filter((name) => {
      if (!Object.hasOwn(schema.fields, name) || isRecordKey(name)) return false;
      if (!RecordFieldTypeSchema.safeParse(schema.fields[name]!.type).success) return false;
      const type = normalizeRecordFieldType(schema.fields[name]!.type);
      if (type === "document") return false;
      // A relation shows only where its target's rows show too.
      if (type !== "relation") return true;
      const target = relationTarget(collectionId, name);
      return target !== null && collections.includes(target) && !summaries.has(target);
    }).sort(compareText);
    const left = [...explicit].filter((name) => !["id", "createdAt", "updatedAt"].includes(name) && !fields.includes(name)).sort(compareText);
    if (left.length > 0 && !rules) {
      warnings.push({
        code: "fields_left_out",
        collectionId,
        message: `The suggestion leaves out ${left.map((name) => `"${name}"`).join(", ")} on ${nameOf(collectionId)}: those fields are missing, links can't show them, or they point at collections it doesn't open.`,
      });
    }
    if (fields.length > MAX_FIELDS) {
      warnings.push({
        code: "too_many_fields",
        collectionId,
        message: `This tool reads more ${nameOf(collectionId)} fields than a link can show. The suggestion shows the first ${MAX_FIELDS}; choose the ones the link needs.`,
      });
    }
    if (rules) {
      // Totals read only their groupings and measures. The fields stay listed
      // so the saved reads still fit if the sharer switches to them.
      grants[collectionId] = { rows, fields: fields.slice(0, MAX_FIELDS), mode: "summaries", summaries: rules };
      warnings.push({
        code: "small_groups_hidden",
        collectionId,
        message: `This link shows ${nameOf(collectionId)} only as totals and hides totals of fewer than ${rules.minGroupSize} records, so some totals the tool shows may be missing.`,
      });
      continue;
    }
    grants[collectionId] = { rows, fields: fields.slice(0, MAX_FIELDS) };
    if (named.includes(collectionId) && !asked.has(collectionId) && !reached.has(collectionId)) {
      warnings.push({
        code: "static_only",
        collectionId,
        message: `This tool may read ${nameOf(collectionId)} after a click. The suggestion opens it with no fields until you choose them.`,
      });
    }
  }
  for (const [collectionId, permission] of Object.entries(permissions?.records ?? {})) {
    if (collectionId === "*" || !permission.read || seen.has(collectionId)) continue;
    warnings.push({
      code: "declared_unseen",
      collectionId,
      message: `This tool may read ${nameOf(collectionId)}, but didn't when it first loaded, so the suggestion leaves it out.`,
    });
  }
  return { grant: LinkGrantSchema.parse({ version: 1, collections: grants }), fixedReads, warnings };
}

/** Summary rules that answer every read, or null when a summaries link
 *  would refuse one of them. */
function summaryRules(collectionId: string, reads: readonly FixedReadQuery[], schemas: ReadonlyMap<string, RecordCollectionSchema>): SummaryRules | null {
  const groupBy = new Set<string>();
  const measures = new Set<string>();
  const fns = new Set<SummaryRules["fns"][number]>();
  for (const read of reads) {
    if (read.aggregate!.groupBy !== undefined) groupBy.add(read.aggregate!.groupBy);
    for (const spec of Object.values(read.aggregate!.select)) {
      fns.add(spec.fn);
      if (spec.field !== undefined) measures.add(spec.field);
    }
    if (read.where) forEachLeaf(read.where, (path) => groupBy.add(path));
  }
  if (groupBy.size > 6 || measures.size > 12) return null;
  const grant = LinkGrantSchema.parse({
    version: 1,
    collections: {
      [collectionId]: {
        fields: [],
        mode: "summaries",
        summaries: { groupBy: [...groupBy].sort(compareText), measures: [...measures].sort(compareText), fns: [...fns].sort(compareText) },
      },
    },
  });
  if (validateLinkGrant(grant, schemas).length > 0) return null;
  const collection = grant.collections[collectionId]!;
  const fields = projectFields(schemas.get(collectionId)!, collection);
  try {
    for (const read of reads) admitSummaries(fields, collection.summaries!, read as RecordQuery);
  } catch (error) {
    if (error instanceof LinkQueryError) return null;
    throw error;
  }
  return collection.summaries!;
}

/** The `eq` and `has` conditions on the collection's own fields that every
 *  read applies at its top level, as one row condition. */
function sharedRowCondition(schema: RecordCollectionSchema, reads: readonly FixedReadQuery[]): RecordPredicate | null {
  if (reads.length === 0) return null;
  const usable = (leaf: RecordPredicate): leaf is Extract<RecordPredicate, { field: string }> => {
    if (!("field" in leaf) || (leaf.op !== "eq" && leaf.op !== "has") || leaf.value === undefined) return false;
    if (leaf.field === "id") return true;
    if (leaf.field === "data" || leaf.field in Object.prototype || !Object.hasOwn(schema.fields, leaf.field)) return false;
    return normalizeRecordFieldType(schema.fields[leaf.field]!.type) !== "document";
  };
  const leafSets = reads.map((read) => {
    const top = !read.where ? [] : "and" in read.where ? read.where.and : [read.where];
    return new Map<string, RecordPredicate>(top.filter(usable).map((leaf) => [canonicalJson(leaf), leaf]));
  });
  const leaves = [...leafSets[0]!].filter(([key]) => leafSets.every((set) => set.has(key))).map(([, leaf]) => leaf);
  if (leaves.length === 0) return null;
  return canonicalPredicate(leaves.length === 1 ? leaves[0]! : { and: leaves });
}
