// What a share link should open for an HTML Doc, judged from what the tool
// reads: the collections and fields its reads name. The sharer starts from
// this and edits it.

import {
  CanonicalIdSchema,
  LinkGrantSchema,
  normalizeRecordFieldType,
  RecordFieldTypeSchema,
  type LinkGrant,
  type LinkGrantInput,
  type RecordCollectionSchema,
  type RecordPredicate,
  type RecordQuery,
  type WidgetFile,
} from "@worktable/types";
import { LINK_SEARCH_MAX_LENGTH } from "./link-query-limits.ts";
import type { ObservedRecordQuery } from "./html-preview.ts";
import { forEachLeaf, isRecordKey } from "./link-grant.ts";
import { compareText } from "./link-grant-view.ts";
import { flatWhereToPredicate, isPredicateTree, parsePredicate, referencedCollections, RecordQueryShapeError } from "./record-query.ts";
import { parseRecordQuery, RecordQueryError } from "./record-store.ts";
import { hasDynamicRecordCollection, inferWidgetRecordPermissions } from "./widget-authoring.ts";
import { canWidgetRecord } from "./widget-runtime-policy.ts";

export type LinkGrantSuggestionWarningCode =
  | "whole_records"
  | "search_fields"
  | "long_search"
  | "fields_left_out"
  | "archived_rows"
  | "dynamic_collection"
  | "static_only"
  | "declared_unseen"
  | "too_many_fields";

export interface LinkGrantSuggestionWarning {
  code: LinkGrantSuggestionWarningCode;
  collectionId?: string;
  message: string;
}

export interface LinkGrantSuggestion {
  /** Whole collections, with the fields the tool's reads name. */
  grant: LinkGrant;
  warnings: LinkGrantSuggestionWarning[];
}

/** A read the preview saw, with its filter as a predicate tree. */
interface ObservedRead {
  query: RecordQuery;
  where?: RecordPredicate;
}

/** Field types a whole-record read doesn't suggest: they name people or hold
 *  paths and free-form data. */
const NOT_SUGGESTED_FOR_WHOLE_RECORDS = new Set(["person", "email", "document", "file", "json"]);
const MAX_FIELDS = 200;

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
 *   Each opens whole: every live record.
 * - Fields: every field a read names. A read without `select` takes whole
 *   records, so every field but people, email addresses, documents and JSON
 *   is suggested, and a warning says so. A relation shows only when the
 *   suggestion opens its target too.
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

  // The reads the tool made. A read that reaches a collection the tool may
  // not read, itself or through a relation, was refused, so it read nothing.
  const asked = new Map<string, ObservedRead[]>();
  // Collections the tool read archived rows of, which links never show.
  const archived = new Set<string>();
  for (const { collectionId, query } of input.observed) {
    if (!mayRead(collectionId)) continue;
    const fields = schemas.get(collectionId)!.fields;
    let read: ObservedRead;
    try {
      const parsed = parseRecordQuery(query);
      if (!referencedCollections(parsed, fields).every(mayRead)) continue;
      const where = parsed.where && Object.keys(parsed.where).length > 0
        ? parsePredicate(isPredicateTree(parsed.where, fields) ? parsed.where : flatWhereToPredicate(parsed.where)!, 0, fields)
        : undefined;
      read = { query: parsed, ...(where ? { where } : {}) };
    } catch (error) {
      if (error instanceof RecordQueryError || error instanceof RecordQueryShapeError) continue;
      throw error;
    }
    if (read.query.includeArchived) archived.add(collectionId);
    const reads = asked.get(collectionId) ?? [];
    reads.push(read);
    asked.set(collectionId, reads);
  }
  // Collections whose rows another read reaches.
  const reached = new Set<string>();
  for (const [collectionId, reads] of asked) {
    for (const { query } of reads) {
      for (const target of referencedCollections(query, schemas.get(collectionId)!.fields)) reached.add(target);
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
    for (const { query: read, where } of reads) {
      for (const name of read.select ?? []) show(collectionId, name);
      if (where) forEachLeaf(where, (path) => showPath(collectionId, path));
      const orderBy = typeof read.orderBy === "string" ? [read.orderBy] : (read.orderBy ?? []).map((entry) => entry.field);
      for (const name of orderBy) show(collectionId, name);
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

  const warnings: LinkGrantSuggestionWarning[] = [];
  if (hasDynamicRecordCollection(html)) {
    warnings.push({ code: "dynamic_collection", message: "This tool chooses some collections as it runs, so it may read collections this suggestion leaves out." });
  }
  const grants: Record<string, NonNullable<LinkGrantInput["collections"]>[string]> = {};
  for (const collectionId of collections) {
    const schema = schemas.get(collectionId)!;
    const reads = (asked.get(collectionId) ?? []).map((read) => read.query);
    if (reads.some((read) => (read.search?.length ?? 0) > LINK_SEARCH_MAX_LENGTH)) warnings.push({
      code: "long_search", collectionId,
      message: `Some ${nameOf(collectionId)} reads search more than ${LINK_SEARCH_MAX_LENGTH} characters, which links refuse.`,
    });
    if (reads.some((read) => read.search)) warnings.push({
      code: "search_fields", collectionId,
      message: `This tool searches all ${nameOf(collectionId)} fields. A link searches only the fields it shows, so matching records may differ.`,
    });
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
      // Document and file fields hold paths in the Space, which links don't show.
      if (type === "document" || type === "file") return false;
      // A relation shows only where its target's rows show too.
      if (type !== "relation") return true;
      const target = relationTarget(collectionId, name);
      return target !== null && collections.includes(target);
    }).sort(compareText);
    const left = [...explicit].filter((name) => !["id", "createdAt", "updatedAt"].includes(name) && !fields.includes(name)).sort(compareText);
    if (left.length > 0) {
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
    grants[collectionId] = { fields: fields.slice(0, MAX_FIELDS) };
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
  return { grant: LinkGrantSchema.parse({ version: 1, collections: grants }), warnings };
}
