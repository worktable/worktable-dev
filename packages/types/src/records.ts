import { z } from "zod";
import { RECORD_PREDICATE_OPS } from "./constants";
import { ArchiveInfoSchemaV1, CanonicalIdSchema, CanonicalMetadataSchema, IsoTimestampSchema } from "./widgets";

// The version-1 field types. Schemas that use only these stay stamped
// version 1 so every Worktable ever shipped can validate them.
export const RECORD_FIELD_TYPES_V1 = ["string", "number", "boolean", "date", "datetime", "enum", "json", "reference"] as const;

// The version-2 additions. `select`/`multi_select` supersede `enum` and
// `relation` supersedes `reference` — v1 spellings remain readable forever and
// are normalized at validation/query time (files are never rewritten).
export const RECORD_FIELD_TYPES_V2 = ["text", "url", "email", "person", "select", "multi_select", "relation", "document"] as const;

// Field types this version of Worktable knows how to validate and write.
// Readers must stay tolerant of types beyond this list (see RecordFieldSchema).
export const RecordFieldTypeSchema = z.enum([...RECORD_FIELD_TYPES_V1, ...RECORD_FIELD_TYPES_V2]);

// Read-lift for v1 type spellings: callers that branch on field type should
// normalize first so `enum` behaves as `select` and `reference` as `relation`.
export function normalizeRecordFieldType(type: string): string {
  if (type === "enum") return "select";
  if (type === "reference") return "relation";
  return type;
}

// True when a schema's fields require the version-2 format (new types or
// relation/number metadata v1 servers don't understand).
export function requiresSchemaV2(fields: Record<string, { type: string; many?: boolean; inverse?: string; onDelete?: string; unit?: string }>): boolean {
  const v1 = new Set<string>(RECORD_FIELD_TYPES_V1);
  return Object.values(fields).some(
    (field) => !v1.has(field.type) || field.many !== undefined || field.inverse !== undefined || field.onDelete !== undefined || field.unit !== undefined,
  );
}

/** Field types that can name a record. */
export const TITLE_FIELD_TYPES = ["string", "text", "url", "email", "person", "select"] as const;

/**
 * The field that names a record: the collection's titleField, else `title` or
 * `name` (string), else the first required string field. Shared by the server
 * and the web so a record has one name everywhere.
 */
export function recordTitleFieldKey(schema: { titleField?: string; fields: Record<string, { type: string; required?: boolean }> } | null | undefined): string | null {
  if (!schema) return null;
  if (schema.titleField && schema.fields[schema.titleField]) return schema.titleField;
  for (const key of ["title", "name"]) {
    const field = schema.fields[key];
    const type = field ? normalizeRecordFieldType(field.type) : null;
    if (type === "string" || type === "text") return key;
  }
  for (const [key, field] of Object.entries(schema.fields)) {
    if (field.required && normalizeRecordFieldType(field.type) === "string") return key;
  }
  return null;
}

// Reader schemas are deliberately tolerant: `version` accepts any integer >= 1,
// `type` accepts unknown strings, and unknown keys pass through unchanged. A
// workspace synced from a newer Worktable must stay readable and writable here —
// unknown field types simply skip validation, and round-tripping a file must
// never drop keys this version doesn't understand. Writers stay conservative:
// they stamp the lowest schema version the fields actually require.
export const RecordFieldSchema = z.looseObject({
  type: z.string().min(1),
  // Display name, separate from the slug key (the key IS the field's
  // identity and the data-map key; renaming the display name touches
  // schema.yaml only). Additive and v1-safe: older readers pass it through.
  name: z.string().optional(),
  required: z.boolean().optional(),
  values: z.array(z.string()).optional(),
  references: CanonicalIdSchema.optional(),
  description: z.string().optional(),
  // relation metadata: single vs list, backlink name, delete policy
  many: z.boolean().optional(),
  inverse: z.string().optional(),
  onDelete: z.enum(["restrict", "setNull", "none"]).optional(),
  // number metadata
  unit: z.string().optional(),
  // No two records may hold the same non-empty value. Additive and v1-safe:
  // older readers pass it through without enforcing it.
  unique: z.boolean().optional(),
});

export const RecordCollectionSchemaSchema = z.looseObject({
  version: z.number().int().min(1),
  kind: z.literal("worktable.recordSchema"),
  id: CanonicalIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  // Optional well-known type annotation (e.g. "schema:Person") — an ignorable
  // hint for agent priors and future interop, never a validation constraint.
  wellKnownType: z.string().optional(),
  // The field that names a record in lists, links and generated ids. Unset,
  // a record is named by title, name, or the first required string field.
  titleField: z.string().optional(),
  fields: z.record(z.string(), RecordFieldSchema).default({}),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  createdBy: z.string().min(1),
  updatedBy: z.string().min(1).optional(),
  metadata: CanonicalMetadataSchema.default({}),
});

export const RecordFileSchema = z.looseObject({
  version: z.number().int().min(1),
  kind: z.literal("worktable.record"),
  id: CanonicalIdSchema,
  collectionId: CanonicalIdSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  createdBy: z.string().min(1),
  updatedBy: z.string().min(1).optional(),
  archive: ArchiveInfoSchemaV1.nullable().optional(),
  metadata: CanonicalMetadataSchema.default({}),
  data: z.record(z.string(), z.unknown()).default({}),
});

// The one query grammar for records. Enforced inside the record store so every
// caller — REST, widget bridge, MCP — shares identical caps and semantics.
export const RECORD_QUERY_MAX_LIMIT = 1000;

// v2 query additions. `where` accepts either the legacy flat map (evaluated
// with the original filterRecords semantics, forever) or a predicate tree:
// {and:[...]} | {or:[...]} | {not:...} | {field, op, value?}. A leaf's field
// may be a one-hop relation path ("project.status"). `has` is EXACT
// membership for array-valued fields (multi_select values, many-relation id
// lists) and strict equality for scalars — `contains` stays substring.
export const RecordPredicateOpSchema = z.enum(RECORD_PREDICATE_OPS);

export const RecordAggregateFnSchema = z.enum(["count", "sum", "avg", "min", "max", "unique"]);

export const RecordQuerySchema = z.object({
  where: z.record(z.string(), z.unknown()).optional(),
  search: z.string().optional(),
  orderBy: z.union([z.string(), z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() }))]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(0).max(RECORD_QUERY_MAX_LIMIT).optional(),
  includeArchived: z.boolean().optional(),
  // v2 features (any of these routes the query through the AST evaluator)
  expand: z.record(z.string(), z.union([z.literal(true), z.array(z.string())])).optional(),
  backlinks: z.object({ collection: z.string(), field: z.string() }).optional(),
  aggregate: z
    .object({
      groupBy: z.string().optional(),
      select: z.record(z.string(), z.object({ fn: RecordAggregateFnSchema, field: z.string().optional() })),
    })
    .optional(),
  select: z.array(z.string()).optional(),
  cursor: z.string().optional(),
});

export type RecordPredicateOp = z.infer<typeof RecordPredicateOpSchema>;
export type RecordPredicate =
  | { and: RecordPredicate[] }
  | { or: RecordPredicate[] }
  | { not: RecordPredicate }
  | { field: string; op: RecordPredicateOp; value?: unknown };

/** The deepest predicate tree the query engine evaluates; the root is depth 0. */
export const RECORD_PREDICATE_MAX_DEPTH = 20;

// The value rules the query engine's parsePredicate enforces per operator.
function predicateValueProblem(op: RecordPredicateOp, value: unknown): string | null {
  if (op === "in" && !Array.isArray(value)) return '"in" requires an array value';
  if (op === "contains" && typeof value !== "string") return '"contains" requires a string value';
  if (op === "has" && (value === undefined || value === null || typeof value === "object")) return '"has" requires a scalar value';
  if ((op === "gt" || op === "gte" || op === "lt" || op === "lte") && (value === undefined || value === null)) return `"${op}" requires a value`;
  if (op === "isEmpty" && value !== undefined && typeof value !== "boolean") return '"isEmpty" takes an optional boolean value';
  return null;
}

const RecordPredicateLeafSchema = z
  .strictObject({ field: z.string().min(1), op: RecordPredicateOpSchema, value: z.unknown().optional() })
  .superRefine((leaf, ctx) => {
    const problem = predicateValueProblem(leaf.op, leaf.value);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["value"] });
  });

// One schema per level, so the depth limit holds while parsing: a tree
// deeper than the limit fails at the last level instead of recursing on.
function predicateSchemaAt(depth: number): z.ZodType<RecordPredicate> {
  if (depth === RECORD_PREDICATE_MAX_DEPTH) return RecordPredicateLeafSchema;
  const child = predicateSchemaAt(depth + 1);
  return z.union([
    z.strictObject({ and: z.array(child).min(1) }),
    z.strictObject({ or: z.array(child).min(1) }),
    z.strictObject({ not: child }),
    RecordPredicateLeafSchema,
  ]);
}

/**
 * A predicate tree in the canonical form the query engine's parser returns.
 * Unlike `RecordQuery.where`, it never accepts a flat filter map, so stored
 * conditions such as link grants have exactly one spelling.
 */
export const RecordPredicateSchema = predicateSchemaAt(0);

export interface RecordQueryResult {
  records: RecordFile[];
  expanded?: Record<string, Record<string, RecordFile>>;
  backlinks?: Record<string, string[]>;
  groups?: Record<string, unknown>[];
  nextCursor?: string;
  /** How many records match the query across all pages. */
  total?: number;
  /** Non-fatal integrity notices; results may be incomplete until repaired. */
  warnings?: string[];
}

export type RecordField = z.infer<typeof RecordFieldSchema>;
export type RecordCollectionSchema = z.infer<typeof RecordCollectionSchemaSchema>;
export type RecordFile = z.infer<typeof RecordFileSchema>;
export type RecordQuery = z.infer<typeof RecordQuerySchema>;

export interface RecordDiagnostic {
  file: string;
  error: string;
}

export type RecordProjectionState = "disabled" | "indexing" | "ready" | "drifted" | "degraded";

export interface RecordCollectionProjectionHealth {
  state: RecordProjectionState;
  canonicalFileCount: number;
  indexedFileCount: number;
  validRecordCount: number;
  invalidRecordCount: number;
  lastReconciledAt: string | null;
}

export interface RecordCollectionReconcileResult extends RecordCollectionProjectionHealth {
  changedRecordCount: number;
}

export interface RecordCollectionSummary {
  id: string;
  name: string;
  description?: string;
  count: number;
  schema?: RecordCollectionSchema;
}
