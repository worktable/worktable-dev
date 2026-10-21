// A link grant names the Records a share link opens. It is checked against
// the live schemas when it is saved and again every time it is used: a
// granted field that disappears, or turns into something a link can't show,
// closes the collection rather than widening it.

import { normalizeRecordFieldType, recordTitleFieldKey, type LinkGrant, type RecordCollectionSchema, type RecordPredicate } from "@worktable/types";
import { readRecordCollectionSchema } from "./record-store.ts";
import { parsePredicate, RecordQueryShapeError } from "./record-query.ts";

export interface LinkGrantIssue {
  collectionId: string;
  message: string;
}

const DIMENSION_TYPES = new Set(["select", "multi_select", "boolean"]);

/** Keys a link's record already has beside `data`. Queries read these from
 *  the record before its data, so a data field under one of them would be
 *  filtered, sorted and grouped by the wrong value. */
const VIEW_RECORD_KEYS = new Set(["id", "version", "kind", "collectionId", "createdAt", "updatedAt", "data"]);

/** The live schemas of every collection a grant names. Missing or unreadable
 *  schemas are left out, which validateLinkGrant reports. */
export async function readLinkGrantSchemas(spaceId: string, grant: LinkGrant): Promise<Map<string, RecordCollectionSchema>> {
  const schemas = new Map<string, RecordCollectionSchema>();
  for (const collectionId of Object.keys(grant.collections)) {
    const schema = (await readRecordCollectionSchema(spaceId, collectionId)).data;
    if (schema) schemas.set(collectionId, schema);
  }
  return schemas;
}

/** Problems that stop a grant's collections from opening. Empty means every
 *  granted collection can be read as granted. */
export function validateLinkGrant(grant: LinkGrant, schemas: ReadonlyMap<string, RecordCollectionSchema>): LinkGrantIssue[] {
  const issues: LinkGrantIssue[] = [];
  for (const [collectionId, collection] of Object.entries(grant.collections)) {
    const add = (message: string) => issues.push({ collectionId, message });
    const schema = schemas.get(collectionId);
    if (!schema) {
      add("This collection doesn't exist.");
      continue;
    }
    const field = (name: string) => (Object.hasOwn(schema.fields, name) ? schema.fields[name] : undefined);
    const typeOf = (name: string) => {
      const spec = field(name);
      return spec ? normalizeRecordFieldType(spec.type) : undefined;
    };

    for (const name of collection.fields) {
      const spec = field(name);
      const type = typeOf(name);
      if (!spec) add(`Field "${name}" doesn't exist.`);
      else if (VIEW_RECORD_KEYS.has(name) || name in Object.prototype) add(`Field "${name}" has a name records use for themselves, so links can't show it.`);
      else if (type === "document") add(`Field "${name}" holds document links, which links can't show yet.`);
      else if (type === "relation" && (!spec.references || !Object.hasOwn(grant.collections, spec.references))) {
        add(`Field "${name}" points at a collection this link doesn't open.`);
      }
    }

    if (collection.rows) {
      try {
        forEachLeaf(parsePredicate(collection.rows, 0, schema.fields), (leaf) => {
          // The view judges rows on their id and data alone, so `id` is the
          // stored id and every other name is a data field, envelope or not.
          if (leaf === "id") return;
          if (leaf.includes(".")) add(`The row condition can't follow "${leaf}" into another collection.`);
          else if (leaf === "data" || !field(leaf)) add(`The row condition uses "${leaf}", which isn't a field of this collection.`);
          else if (typeOf(leaf) === "document") add(`The row condition can't use the document field "${leaf}".`);
        });
      } catch (error) {
        if (!(error instanceof RecordQueryShapeError)) throw error;
        add(`The row condition is invalid: ${error.message}`);
      }
    }

    if (collection.summaries) {
      // Rows are never shown in summaries, so dimensions are chosen for what
      // a total may be split by: low-cardinality fields that don't name a row.
      const titleField = recordTitleFieldKey(schema);
      for (const name of collection.summaries.groupBy) {
        const spec = field(name);
        if (!spec) add(`Summary grouping "${name}" isn't a field of this collection.`);
        else if (!DIMENSION_TYPES.has(typeOf(name)!) || spec.unique === true || name === titleField) {
          add(`Summaries can't be grouped by "${name}". Use a select, multi-select or yes/no field.`);
        }
      }
      for (const name of collection.summaries.measures) {
        if (!field(name)) add(`Summary measure "${name}" isn't a field of this collection.`);
        else if (typeOf(name) !== "number") add(`Summary measure "${name}" must be a number field.`);
      }
    }
    if (collection.writes) add("Links can't change records yet.");
  }
  return issues;
}

/** Visits the field path of every leaf in a parsed predicate. */
export function forEachLeaf(node: RecordPredicate, visit: (field: string) => void): void {
  if ("and" in node) node.and.forEach((child) => forEachLeaf(child, visit));
  else if ("or" in node) node.or.forEach((child) => forEachLeaf(child, visit));
  else if ("not" in node) forEachLeaf(node.not, visit);
  else visit(node.field);
}
