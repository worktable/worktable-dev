// Importing a file into Records, apart from the Records API every page
// loads: only the import dialog, on a file's page, reads it.

import { fetchJSON } from "./http.ts"

export type ImportFieldType = "text" | "number" | "date" | "boolean"

export interface ImportColumn {
  column: string
  field: string
  type: ImportFieldType
}

export interface ImportProposal {
  path: string
  rowCount: number
  columns: ImportColumn[]
  idColumn?: string
  /** Every column that can give rows their ids. */
  idColumns: string[]
  /** The proposed column to name records by. */
  titleColumn?: string
  sample: Array<Record<string, string>>
  existingFields?: string[]
}

export interface ImportResult {
  collectionId: string
  counts: { rows: number; created: number; skipped: number; failed: number }
  rows: Array<{ row: number; recordId?: string; skipped?: string; error?: string }>
  columnsLeftOut: string[]
}

/** What importing a file would do: its columns and proposed fields. */
export function proposeRecordsImport(
  spaceId: string,
  collectionId: string,
  path: string
) {
  return fetchJSON<{ proposal: ImportProposal }>(
    `/api/spaces/${spaceId}/records/${encodeURIComponent(collectionId)}/import`,
    { method: "POST", body: JSON.stringify({ path, dryRun: true }) }
  ).then((result) => result.proposal)
}

/** Import a file's chosen columns into a collection. */
export function importIntoRecords(
  spaceId: string,
  collectionId: string,
  input: {
    path: string
    columns: ImportColumn[]
    idColumn?: string
    titleColumn?: string
    /** What a new collection is called. */
    name?: string
  }
) {
  return fetchJSON<ImportResult>(
    `/api/spaces/${spaceId}/records/${encodeURIComponent(collectionId)}/import`,
    { method: "POST", body: JSON.stringify(input) }
  )
}
