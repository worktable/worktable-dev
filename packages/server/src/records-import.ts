// ============================================================
// Importing a CSV, TSV or JSONL file into Records
// ============================================================
//
// A table that people and agents keep working in belongs in Records, where
// each row is a file and a schema catches bad values. Import reads a file in
// the Space with the same reader the file's page uses, proposes fields from
// its columns, and writes the chosen columns by the rules create_many keeps:
// every row is checked first and nothing is written if any needs fixing;
// rows whose id or unique values exist are skipped; each skipped or failed
// row is reported. The file stays as it was, and nothing syncs the two.

import {
  CanonicalIdSchema,
  delimiterForFilename,
  parseDelimitedText,
  type RecordCollectionSchema,
} from "@worktable/types"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { readRegisteredDocumentSource } from "./document-write-service.ts"
import {
  buildRecordCollectionSchema,
  checkRecordDataWithSchema,
  createRecord,
  readRecordCollectionSchema,
  writeRecordCollectionSchema,
} from "./record-store.ts"

/** Rows one import may hold. */
export const IMPORT_MAX_ROWS = 5000
/** Problems and row results a response lists before counting the rest. */
const LISTED_MAX = 50

export type ImportFieldType = "text" | "number" | "date" | "boolean"

export interface ImportColumn {
  /** The column's name in the file. */
  column: string
  /** The Record field it fills. */
  field: string
  type: ImportFieldType
}

interface ImportTable {
  columns: string[]
  rows: Array<Record<string, string>>
}

function readTable(path: string, bytes: Uint8Array): ImportTable {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (/\.jsonl$/i.test(path)) {
    const rows: Array<Record<string, string>> = []
    const columns: string[] = []
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Line ${index + 1} is not JSON`)
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Line ${index + 1} is not an object`)
      }
      const row: Record<string, string> = {}
      for (const [key, cell] of Object.entries(value)) {
        if (!columns.includes(key)) columns.push(key)
        // Values stay as text, as a CSV's do, until a field type is chosen.
        row[key] =
          cell === null || cell === undefined
            ? ""
            : typeof cell === "string"
              ? cell
              : JSON.stringify(cell)
      }
      rows.push(row)
    }
    return { columns, rows }
  }
  const table = parseDelimitedText(text, delimiterForFilename(path))
  return {
    columns: table.header,
    rows: table.rows.map((cells) =>
      Object.fromEntries(table.header.map((column, i) => [column, cells[i] ?? ""]))
    ),
  }
}

async function readImportFile(spaceId: string, path: string) {
  if (!/\.(?:csv|tsv|jsonl)$/i.test(path)) {
    throw new Error("Import reads a .csv, .tsv or .jsonl file")
  }
  const source = await readRegisteredDocumentSource({ spaceId, path })
  if (source.format.id !== BUILTIN_DOCUMENT_FORMATS.file) {
    throw new Error("Import reads a file, not a Doc")
  }
  const table = readTable(path, source.bytes)
  if (table.rows.length > IMPORT_MAX_ROWS) {
    throw new Error(
      `This file has ${table.rows.length} rows; import up to ${IMPORT_MAX_ROWS} at a time`
    )
  }
  return table
}

/** A Record field key from a column name. */
export function fieldKeyFor(column: string): string {
  const key = column
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return /^[a-z]/.test(key) ? key : `field_${key || "value"}`
}

/**
 * The type a column's values allow, chosen cautiously: a value such as 007,
 * whose leading zero a number would lose, keeps the column text.
 */
export function proposedType(values: readonly string[]): ImportFieldType {
  const present = values.filter((value) => value !== "")
  if (present.length === 0) return "text"
  if (present.every((value) => /^(?:true|false)$/i.test(value))) return "boolean"
  if (present.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) return "date"
  if (
    present.every(
      (value) =>
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))
    )
  ) {
    return "number"
  }
  return "text"
}

/** A column whose values are all present and distinct, suited as row ids. */
function proposedIdColumn(table: ImportTable): string | undefined {
  const fits = (column: string) => {
    const values = table.rows.map((row) => row[column] ?? "")
    return (
      values.every((value) => CanonicalIdSchema.safeParse(value).success) &&
      new Set(values).size === values.length
    )
  }
  const named = table.columns.filter((column) => /^(?:id|key|slug)$/i.test(column))
  return [...named, ...table.columns].find(fits)
}

export interface ImportProposal {
  path: string
  rowCount: number
  columns: ImportColumn[]
  idColumn?: string
  sample: Array<Record<string, string>>
  /** The collection's fields now, when it exists. */
  existingFields?: string[]
}

/** What an import would do, writing nothing: the columns and proposed fields. */
export async function proposeImport(
  spaceId: string,
  path: string,
  collectionId: string
): Promise<ImportProposal> {
  const table = await readImportFile(spaceId, path)
  const existing = (await readRecordCollectionSchema(spaceId, collectionId)).data
  const idColumn = proposedIdColumn(table)
  return {
    path,
    rowCount: table.rows.length,
    columns: table.columns.map((column) => ({
      column,
      field: fieldKeyFor(column),
      type: proposedType(table.rows.map((row) => row[column] ?? "")),
    })),
    ...(idColumn ? { idColumn } : {}),
    sample: table.rows.slice(0, 5),
    ...(existing ? { existingFields: Object.keys(existing.fields) } : {}),
  }
}

function fieldValue(raw: string, type: ImportFieldType): unknown {
  if (type === "number" && /^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  if (type === "boolean" && /^(?:true|false)$/i.test(raw)) {
    return raw.toLowerCase() === "true"
  }
  return raw
}

const SCHEMA_TYPE: Record<ImportFieldType, string> = {
  text: "text",
  number: "number",
  date: "date",
  boolean: "boolean",
}

export interface ImportResult {
  collectionId: string
  counts: { rows: number; created: number; skipped: number; failed: number }
  /** Rows not created, with why: an existing id or unique value, or an error. */
  rows: Array<{ row: number; recordId?: string; skipped?: string; error?: string }>
  /** Columns of the file that went into no field. */
  columnsLeftOut: string[]
}

/**
 * Import the chosen columns into a collection, adding their fields to it
 * (or creating it). Every row is checked before anything is written.
 */
export async function importIntoRecords(options: {
  spaceId: string
  path: string
  collectionId: string
  columns: readonly ImportColumn[]
  idColumn?: string
  createdBy: string
}): Promise<ImportResult> {
  const { spaceId, collectionId } = options
  const table = await readImportFile(spaceId, options.path)
  for (const column of options.columns) {
    if (!table.columns.includes(column.column)) {
      throw new Error(`The file has no column named ${column.column}`)
    }
  }
  if (options.idColumn !== undefined && !table.columns.includes(options.idColumn)) {
    throw new Error(`The file has no column named ${options.idColumn}`)
  }

  // The chosen columns become fields, added to what the collection has.
  const existing = (await readRecordCollectionSchema(spaceId, collectionId)).data
  const fields: RecordCollectionSchema["fields"] = { ...(existing?.fields ?? {}) }
  for (const column of options.columns) {
    if (!Object.hasOwn(fields, column.field)) {
      fields[column.field] = { type: SCHEMA_TYPE[column.type], name: column.column }
    }
  }
  const rows = table.rows.map((row, index) => {
    const data: Record<string, unknown> = {}
    for (const column of options.columns) {
      const raw = row[column.column] ?? ""
      if (raw !== "") data[column.field] = fieldValue(raw, column.type)
    }
    const recordId = options.idColumn ? row[options.idColumn] : undefined
    return { row: index + 1, data, ...(recordId ? { recordId } : {}) }
  })

  // Check every row against the fields it will have before writing anything.
  const schema = buildRecordCollectionSchema({
    id: collectionId,
    fields,
    createdBy: options.createdBy,
    existing: existing ?? undefined,
  })
  const problems: string[] = []
  for (const row of rows) {
    if (row.recordId !== undefined && !CanonicalIdSchema.safeParse(row.recordId).success) {
      problems.push(`row ${row.row}: the id must use lowercase letters, digits and hyphens`)
    }
  }
  for (const row of rows) {
    const invalid = checkRecordDataWithSchema(row.data, schema)
    if (invalid) problems.push(`row ${row.row}: ${invalid}`)
  }
  if (problems.length > 0) {
    throw new Error(
      `Nothing was imported: ${problems.length} of ${rows.length} rows need fixing. ${problems.slice(0, 10).join("; ")}${problems.length > 10 ? "; …" : ""}`
    )
  }
  // Only now that every row fits does the collection get its new fields.
  const written = await writeRecordCollectionSchema(spaceId, schema)
  if (written.error) throw new Error(written.error)

  const results: ImportResult["rows"] = []
  let created = 0
  let skipped = 0
  let failed = 0
  for (const row of rows) {
    const result = await createRecord(spaceId, collectionId, {
      ...(row.recordId ? { id: row.recordId } : {}),
      data: row.data,
      createdBy: options.createdBy,
      strictFields: true,
    })
    if (result.data && result.created) {
      created += 1
    } else if (result.data) {
      skipped += 1
      if (results.length < LISTED_MAX) {
        results.push({
          row: row.row,
          recordId: result.data.id,
          skipped: result.matchedBy ? `matches ${result.matchedBy}` : "exists",
        })
      }
    } else {
      failed += 1
      if (results.length < LISTED_MAX) {
        results.push({ row: row.row, error: result.error ?? "Write failed" })
      }
    }
  }
  const mapped = new Set(options.columns.map((column) => column.column))
  return {
    collectionId,
    counts: { rows: rows.length, created, skipped, failed },
    rows: results,
    columnsLeftOut: table.columns.filter(
      (column) => !mapped.has(column) && column !== options.idColumn
    ),
  }
}
