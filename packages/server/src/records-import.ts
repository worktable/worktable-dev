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
/** Columns an import reads at most, as many as a collection takes. */
const IMPORT_MAX_COLUMNS = 200
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

/** A JSON number as the file wrote it, so no digit is lost to a float. */
class NumberText {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}

const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON

function tooManyRows(count: number): Error {
  return new Error(
    `This file has ${count.toLocaleString("en-US")} rows; import up to ${IMPORT_MAX_ROWS.toLocaleString("en-US")} at a time`
  )
}

function tooManyColumns(): Error {
  return new Error(`Import reads up to ${IMPORT_MAX_COLUMNS} columns`)
}

/**
 * The file's columns and rows, all as text. Rows past the import's limit
 * are refused while reading, before the file's rows are all held.
 */
function readTable(path: string, bytes: Uint8Array): ImportTable {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (/\.jsonl$/i.test(path)) {
    const rows: Array<Record<string, string>> = []
    const columns: string[] = []
    const known = new Set<string>()
    let start = 0
    for (let index = 0; start <= text.length; index++) {
      const newline = text.indexOf("\n", start)
      const end = newline === -1 ? text.length : newline
      const line = text.slice(start, end).replace(/\r$/, "")
      start = end + 1
      if (!line.trim()) continue
      if (rows.length === IMPORT_MAX_ROWS) throw tooManyRows(IMPORT_MAX_ROWS + 1)
      let value: unknown
      try {
        value = JSON.parse(
          line,
          (_key, cell: unknown, context?: { source?: string }) =>
            typeof cell === "number" && context?.source !== undefined
              ? new NumberText(context.source)
              : cell
        )
      } catch {
        throw new Error(`Line ${index + 1} is not JSON`)
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Line ${index + 1} is not an object`)
      }
      const row: Record<string, string> = {}
      for (const [key, cell] of Object.entries(value)) {
        if (!known.has(key)) {
          if (known.size === IMPORT_MAX_COLUMNS) throw tooManyColumns()
          known.add(key)
          columns.push(key)
        }
        // Values stay as text, as a CSV's do, until a field type is chosen.
        row[key] =
          cell === null || cell === undefined
            ? ""
            : typeof cell === "string"
              ? cell
              : cell instanceof NumberText
                ? cell.text
                : JSON.stringify(cell, (_key, inner: unknown) =>
                    inner instanceof NumberText ? rawJSON(inner.text) : inner
                  )
      }
      rows.push(row)
    }
    return { columns, rows }
  }
  const table = parseDelimitedText(text, delimiterForFilename(path), {
    maxRows: IMPORT_MAX_ROWS,
  })
  if (table.rowCount > IMPORT_MAX_ROWS) throw tooManyRows(table.rowCount)
  if (table.header.length > IMPORT_MAX_COLUMNS) throw tooManyColumns()
  // Rows become objects by column name, so a repeated name would lose a column.
  const seen = new Set<string>()
  for (const column of table.header) {
    if (seen.has(column)) {
      throw new Error(`The file has two columns named "${column}"; rename one to import it`)
    }
    seen.add(column)
  }
  const rows: Array<Record<string, string>> = []
  for (const [index, cells] of table.rows.entries()) {
    // A blank line is no row. A row longer than the header would lose
    // values; a shorter one leaves the rest empty, as exports often do.
    if (cells.length === 1 && cells[0] === "" && table.header.length > 1) continue
    if (cells.length > table.header.length) {
      throw new Error(
        `Row ${index + 1} has ${cells.length} values for ${table.header.length} columns`
      )
    }
    rows.push(
      Object.fromEntries(table.header.map((column, i) => [column, cells[i] ?? ""]))
    )
  }
  return { columns: table.header, rows }
}

async function readImportFile(spaceId: string, path: string) {
  if (!/\.(?:csv|tsv|jsonl)$/i.test(path)) {
    throw new Error("Import reads a .csv, .tsv or .jsonl file")
  }
  const source = await readRegisteredDocumentSource({ spaceId, path })
  if (source.format.id !== BUILTIN_DOCUMENT_FORMATS.file) {
    throw new Error("Import reads a file, not a Doc")
  }
  return readTable(path, source.bytes)
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
  if (present.every(numberKeepsValue)) return "number"
  return "text"
}

/**
 * The columns that can give rows their ids: every value present, distinct,
 * and already an id (lowercase letters, digits and hyphens). Ones named like
 * ids come first.
 */
function idColumnsOf(table: ImportTable): string[] {
  const fits = (column: string) => {
    const values = table.rows.map((row) => row[column] ?? "")
    return (
      values.every((value) => CanonicalIdSchema.safeParse(value).success) &&
      new Set(values).size === values.length
    )
  }
  const named = table.columns.filter((column) => /^(?:id|key|slug)$/i.test(column))
  return [...new Set([...named, ...table.columns])].filter(fits)
}

/**
 * The text column that best names a row: one named like a title, else the
 * one with the most different values, the first of equals.
 */
function proposedTitleColumn(
  table: ImportTable,
  columns: readonly ImportColumn[]
): string | undefined {
  const text = columns.filter((column) => column.type === "text")
  const named = text.find((column) =>
    /^(?:title|name|subject|summary|label)$/i.test(column.column)
  )
  if (named) return named.column
  let best: { column: string; distinct: number } | undefined
  for (const column of text) {
    const distinct = new Set(
      table.rows.map((row) => row[column.column] ?? "").filter((value) => value !== "")
    ).size
    if (!best || distinct > best.distinct) best = { column: column.column, distinct }
  }
  return best?.column
}

export interface ImportProposal {
  path: string
  rowCount: number
  columns: ImportColumn[]
  idColumn?: string
  /** Every column that can give rows their ids, the proposed one first. */
  idColumns: string[]
  /** The column that names each record, proposed from the text columns. */
  titleColumn?: string
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
  const idColumns = idColumnsOf(table)
  const idColumn = idColumns[0]
  // Columns whose names make one key, such as First Name and first_name,
  // are proposed distinct fields.
  const taken = new Set<string>()
  const nextSuffix = new Map<string, number>()
  const columns = table.columns.map((column) => {
    const key = fieldKeyFor(column)
    let field = key
    // Each key remembers its next suffix, so many clashes stay quick.
    for (let n = nextSuffix.get(key) ?? 2; taken.has(field); n++) {
      field = `${key}_${n}`
      nextSuffix.set(key, n + 1)
    }
    taken.add(field)
    return {
      column,
      field,
      type: proposedType(table.rows.map((row) => row[column] ?? "")),
    }
  })
  const titleColumn = proposedTitleColumn(
    table,
    columns.filter((column) => column.column !== idColumn)
  )
  return {
    path,
    rowCount: table.rows.length,
    columns,
    ...(idColumn ? { idColumn } : {}),
    idColumns,
    ...(titleColumn ? { titleColumn } : {}),
    sample: table.rows.slice(0, 5),
    ...(existing ? { existingFields: Object.keys(existing.fields) } : {}),
  }
}

/**
 * Whether a value reads as a number without changing: an id such as
 * 9007199254740993, past what a number holds exactly, stays text.
 */
function numberKeepsValue(value: string): boolean {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false
  if (!value.includes(".")) return Number.isSafeInteger(Number(value))
  return value.replace(/[-.]/g, "").replace(/^0+/, "").length <= 15
}

function fieldValue(raw: string, type: ImportFieldType): unknown {
  // A value a number can't hold exactly stays as written, so the row is
  // refused rather than changed.
  if (type === "number" && numberKeepsValue(raw)) return Number(raw)
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
  /**
   * A chosen column that names each record. A new collection without one
   * is named by the proposed column, so its records aren't named by ids.
   */
  titleColumn?: string
  createdBy: string
}): Promise<ImportResult> {
  if (options.columns.length === 0) {
    throw new Error("Choose at least one column to import")
  }
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
  const filled = new Map<string, string>()
  for (const column of options.columns) {
    const other = filled.get(column.field)
    if (other !== undefined) {
      throw new Error(
        `${other} and ${column.column} both fill the field ${column.field}; give each its own field`
      )
    }
    filled.set(column.field, column.column)
  }

  if (
    options.titleColumn !== undefined &&
    !options.columns.some((column) => column.column === options.titleColumn)
  ) {
    throw new Error(`Name records by one of the columns imported, not ${options.titleColumn}`)
  }

  // The chosen columns become fields, added to what the collection has.
  const existing = (await readRecordCollectionSchema(spaceId, collectionId)).data
  const titleColumn =
    options.titleColumn ??
    (existing ? undefined : proposedTitleColumn(table, options.columns))
  const titleField = options.columns.find(
    (column) => column.column === titleColumn
  )?.field
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
    // With an id column, every row needs its id, so importing again skips it.
    const recordId =
      options.idColumn !== undefined ? (row[options.idColumn] ?? "") : undefined
    return { row: index + 1, data, ...(recordId !== undefined ? { recordId } : {}) }
  })

  // Check every row against the fields it will have before writing anything.
  const schema = buildRecordCollectionSchema({
    id: collectionId,
    fields,
    createdBy: options.createdBy,
    existing: existing ?? undefined,
    ...(titleField ? { titleField } : {}),
  })
  const problems: string[] = []
  for (const row of rows) {
    if (row.recordId === "") {
      problems.push(`row ${row.row}: no id in ${options.idColumn}`)
    } else if (
      row.recordId !== undefined &&
      !CanonicalIdSchema.safeParse(row.recordId).success
    ) {
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
