import { isMap, isScalar, parseDocument, stringify } from "yaml";

const YAML_HEADER = "# Worktable vNext canonical YAML. Edit carefully.\n";

export function parseCanonicalYaml(raw: string): unknown {
  const doc = parseDocument(raw, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });

  if (doc.errors.length > 0) {
    throw new Error(doc.errors.map((error) => error.message).join("; "));
  }

  return doc.toJS({ maxAliasCount: 0 });
}

/** Rewrite one existing top-level string without rebuilding the YAML mapping. */
export function rewriteYamlTopLevelString(
  raw: string,
  key: string,
  value: string
): string {
  const doc = parseDocument(raw, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  })
  if (doc.errors.length > 0) {
    throw new Error(doc.errors.map((error) => error.message).join("; "))
  }
  if (!isMap(doc.contents)) {
    throw new Error("YAML document must contain a top-level mapping")
  }
  const current = doc.get(key, true)
  if (!isScalar(current) || typeof current.value !== "string") {
    throw new Error(`YAML field ${key} must be a string`)
  }
  current.value = value
  return doc.toString()
}

/** Rewrite one top-level value without rebuilding unrelated YAML nodes. */
export function rewriteYamlTopLevelValue(
  raw: string,
  key: string,
  value: unknown
): string {
  const doc = parseDocument(raw, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  })
  if (doc.errors.length > 0) {
    throw new Error(doc.errors.map((error) => error.message).join("; "))
  }
  if (!isMap(doc.contents)) {
    throw new Error("YAML document must contain a top-level mapping")
  }
  doc.set(key, value)
  return doc.toString()
}

/** Delete one top-level value without rebuilding unrelated YAML nodes. */
export function deleteYamlTopLevelValue(raw: string, key: string): string {
  const doc = parseDocument(raw, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  })
  if (doc.errors.length > 0) {
    throw new Error(doc.errors.map((error) => error.message).join("; "))
  }
  if (!isMap(doc.contents)) {
    throw new Error("YAML document must contain a top-level mapping")
  }
  doc.delete(key)
  return doc.toString()
}

export function stringifyCanonicalYaml(value: unknown): string {
  const preserveSchemaFieldOrder = Boolean(
    value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>)["kind"] === "worktable.recordSchema"
  );
  return YAML_HEADER + stringify(sortKeysDeep(value, 0, undefined, preserveSchemaFieldOrder), {
    aliasDuplicateObjects: false,
    collectionStyle: "block",
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    indent: 2,
    lineWidth: 100,
    simpleKeys: true,
    sortMapEntries: false,
  });
}

const TOP_LEVEL_ORDER = [
  "version",
  "kind",
  "id",
  "name",
  "singular",
  "plural",
  "description",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "archive",
  "metadata",
  "schema",
  "views",
  "values",
  "mode",
  "sources",
  "layout",
  "actions",
  "sharedState",
];

function sortKeysDeep(value: unknown, depth = 0, parentKey?: string, preserveSchemaFieldOrder = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortKeysDeep(entry, depth + 1, undefined, preserveSchemaFieldOrder));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  // A record schema's `fields` mapping is an authored, portable sequence.
  // Keep its insertion order while still canonicalizing each field spec and
  // every other free-form mapping deterministically.
  const keys = preserveSchemaFieldOrder && depth === 1 && parentKey === "fields" ? Object.keys(record) : Object.keys(record).sort((left, right) => {
    const leftOrder = TOP_LEVEL_ORDER.indexOf(left);
    const rightOrder = TOP_LEVEL_ORDER.indexOf(right);
    if (leftOrder !== -1 || rightOrder !== -1) {
      if (leftOrder === -1) return 1;
      if (rightOrder === -1) return -1;
      return leftOrder - rightOrder;
    }
    return left.localeCompare(right);
  });

  return Object.fromEntries(keys.map((key) => [key, sortKeysDeep(record[key], depth + 1, key, preserveSchemaFieldOrder)]));
}
