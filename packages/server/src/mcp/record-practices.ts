import {
  normalizeRecordFieldType,
  type RecordCollectionSchema,
  type RecordFile,
} from "@worktable/types"

export type RecordPracticeWarningCode =
  | "collection_description_too_long"
  | "large_initial_schema"
  | "many_optional_narrative_fields"
  | "near_synonymous_fields"
  | "system_provenance_field"
  | "missing_recognizable_title"
  | "duplicate_title"
  | "identifier_like_title"

export interface RecordPracticeWarning {
  code: RecordPracticeWarningCode
  message: string
  suggestion: string
  /** Structural evidence only. Values from record data never appear here. */
  evidence?: Record<string, number | string[]>
}

const INITIAL_SCHEMA_FIELD_WARNING = 10
const OPTIONAL_NARRATIVE_FIELD_WARNING = 5
const CONCISE_COLLECTION_DESCRIPTION_LENGTH = 180

const SYSTEM_PROVENANCE_KEYS = new Set([
  "archive",
  "collection-id",
  "created-at",
  "created-by",
  "record-id",
  "updated-at",
  "updated-by",
])

const SYNONYM_GROUPS: Array<{ label: string; names: Set<string> }> = [
  {
    label: "summary/description/details",
    names: new Set(["summary", "description", "details", "overview"]),
  },
  {
    label: "notes/context/rationale",
    names: new Set(["notes", "context", "rationale", "reasoning"]),
  },
  { label: "status/state/stage", names: new Set(["status", "state", "stage"]) },
  { label: "owner/assignee", names: new Set(["owner", "assignee"]) },
  {
    label: "source/origin/provenance",
    names: new Set(["source", "origin", "provenance"]),
  },
]

function normalizedFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
}

function identityField(schema: RecordCollectionSchema | null): string | null {
  if (!schema) return null
  for (const key of ["title", "name"]) {
    const field = schema.fields[key]
    if (field && normalizeRecordFieldType(field.type) === "string") return key
  }
  for (const [key, field] of Object.entries(schema.fields)) {
    if (field.required && normalizeRecordFieldType(field.type) === "string")
      return key
  }
  return null
}

export function recordPracticeIdentity(
  data: Record<string, unknown>,
  schema: RecordCollectionSchema | null
): { field: string; value: string } | null {
  for (const key of ["title", "name", identityField(schema)]) {
    if (!key) continue
    const value = data[key]
    if (typeof value === "string" && value.trim())
      return { field: key, value: value.trim() }
  }
  return null
}

function normalizedIdentity(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

export function recordPracticeIdentitiesMatch(
  left: { field: string; value: string },
  right: { field: string; value: string }
): boolean {
  return (
    left.field === right.field &&
    normalizedIdentity(left.value) === normalizedIdentity(right.value)
  )
}

function looksLikeIdentifier(value: string): boolean {
  const compact = value.trim()
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      compact
    )
  )
    return true
  if (/^\d[\d._/-]{5,}$/.test(compact)) return true
  if (
    /^[a-z]{1,5}[-_]?\d[\da-z._/-]{5,}$/i.test(compact) &&
    !/\s/.test(compact)
  )
    return true
  return /^[0-9a-f]{16,}$/i.test(compact)
}

export function reviewRecordSchema(input: {
  schema: RecordCollectionSchema
  existingSchema: RecordCollectionSchema | null
}): RecordPracticeWarning[] {
  const warnings: RecordPracticeWarning[] = []
  const fields = Object.entries(input.schema.fields)
  const existingFields = Object.entries(input.existingSchema?.fields ?? {})
  const isInitialSchema = input.existingSchema === null

  if (
    input.schema.description !== input.existingSchema?.description &&
    ((input.schema.description?.trim().length ?? 0) >
      CONCISE_COLLECTION_DESCRIPTION_LENGTH ||
      input.schema.description?.includes("\n"))
  ) {
    warnings.push({
      code: "collection_description_too_long",
      message:
        "The collection description is longer than a quick orientation sentence.",
      suggestion:
        "Keep it to a very concise statement of what belongs in the collection; put operating guidance in a doc.",
      evidence: {
        characterCount: input.schema.description?.trim().length ?? 0,
      },
    })
  }

  if (isInitialSchema && fields.length >= INITIAL_SCHEMA_FIELD_WARNING) {
    warnings.push({
      code: "large_initial_schema",
      message: `This first schema introduces ${fields.length} fields at once. That may be justified, but it is unusual for a new collection.`,
      suggestion:
        "Confirm each field supports a current edit, query, validation rule, automation, or useful default scan; otherwise start smaller and evolve it.",
      evidence: { fieldCount: fields.length },
    })
  }

  const optionalNarrativeFields = fields
    .filter(([, field]) => {
      const type = normalizeRecordFieldType(field.type)
      return !field.required && (type === "string" || type === "text")
    })
    .map(([key]) => key)
  const existingOptionalNarrativeCount = existingFields.filter(([, field]) => {
    const type = normalizeRecordFieldType(field.type)
    return !field.required && (type === "string" || type === "text")
  }).length
  if (
    optionalNarrativeFields.length >= OPTIONAL_NARRATIVE_FIELD_WARNING &&
    (isInitialSchema ||
      optionalNarrativeFields.length > existingOptionalNarrativeCount)
  ) {
    warnings.push({
      code: "many_optional_narrative_fields",
      message: `The schema contains ${optionalNarrativeFields.length} optional text fields, which can duplicate prose without creating a distinct workflow.`,
      suggestion:
        "Keep only fields people edit, validate, filter, sort, group, search, or automate independently.",
      evidence: {
        fieldCount: optionalNarrativeFields.length,
        fields: optionalNarrativeFields,
      },
    })
  }

  for (const group of SYNONYM_GROUPS) {
    const matches = fields
      .map(([key]) => ({ key, normalized: normalizedFieldKey(key) }))
      .filter(({ normalized }) => group.names.has(normalized))
      .map(({ key }) => key)
    const existingMatches = existingFields
      .map(([key]) => ({ key, normalized: normalizedFieldKey(key) }))
      .filter(({ normalized }) => group.names.has(normalized))
      .map(({ key }) => key)
    if (
      matches.length < 2 ||
      (!isInitialSchema &&
        matches.every((key) => existingMatches.includes(key)))
    )
      continue
    warnings.push({
      code: "near_synonymous_fields",
      message: `Several fields appear to cover the same ${group.label} concept.`,
      suggestion:
        "Reuse one compatible field unless each field has a separate current workflow.",
      evidence: { fields: matches },
    })
  }

  const provenanceFields = fields
    .map(([key]) => key)
    .filter(
      (key) =>
        SYSTEM_PROVENANCE_KEYS.has(normalizedFieldKey(key)) &&
        !Object.hasOwn(input.existingSchema?.fields ?? {}, key)
    )
  if (provenanceFields.length > 0) {
    warnings.push({
      code: "system_provenance_field",
      message:
        "The schema duplicates provenance already stored in Worktable's record envelope.",
      suggestion:
        "Use created/updated metadata unless the user explicitly needs a separate domain value for querying.",
      evidence: { fields: provenanceFields },
    })
  }

  return warnings
}

export function reviewRecordCreate(input: {
  schema: RecordCollectionSchema | null
  data: Record<string, unknown>
  existingRecords: RecordFile[]
}): RecordPracticeWarning[] {
  const warnings: RecordPracticeWarning[] = []
  const identity = recordPracticeIdentity(input.data, input.schema)

  if (!identity) {
    warnings.push({
      code: "missing_recognizable_title",
      message: "This record has no short human-recognizable title or name.",
      suggestion:
        "Add a concise navigation label, or reconsider whether the item has enough independent identity to be a record.",
    })
    return warnings
  }

  const duplicateCount = input.existingRecords.filter((record) => {
    const existingIdentity = recordPracticeIdentity(record.data, input.schema)
    return (
      existingIdentity !== null &&
      recordPracticeIdentitiesMatch(existingIdentity, identity)
    )
  }).length
  if (duplicateCount > 0) {
    warnings.push({
      code: "duplicate_title",
      message: "Another record already has the same title or name.",
      suggestion:
        "Check whether this should update or merge with the existing record before creating more related items.",
      evidence: { matchingRecordCount: duplicateCount },
    })
  }

  if (looksLikeIdentifier(identity.value)) {
    warnings.push({
      code: "identifier_like_title",
      message: "The record title looks primarily like an internal identifier.",
      suggestion:
        "Use a recognizable label when the domain allows it; keep the identifier in its own field when it needs to be queried.",
    })
  }

  return warnings
}

export function logRecordPracticeWarnings(
  action: "schema_upsert" | "record_create",
  warnings: RecordPracticeWarning[],
  structural: { fieldCount?: number; duplicateMatchCount?: number }
): void {
  if (warnings.length === 0) return
  // Service stdout is machine-local app data. Deliberately omit field names,
  // collection ids, titles, and record content from this diagnostic.
  console.error(
    "[worktable] record-practice-warning",
    JSON.stringify({
      action,
      warningCodes: warnings.map((warning) => warning.code),
      warningCount: warnings.length,
      ...structural,
    })
  )
}
