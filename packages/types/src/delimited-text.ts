// ============================================================
// Delimited text (CSV and TSV)
// ============================================================
//
// The one reader for CSV and TSV files: the file page's table and the import
// into Records read a file the same way, so a person and an agent never see
// two different tables. Every value stays the exact text the file holds:
// nothing is trimmed, typed or reformatted, so `007` stays `007`.

export interface DelimitedTable {
  /** The first row, as the column names. */
  header: string[]
  /** Every other row, each as long as the file wrote it. */
  rows: string[][]
}

/** The delimiter a file uses: tab for `.tsv`, else comma. */
export function delimiterForFilename(name: string): "," | "\t" {
  return name.toLowerCase().endsWith(".tsv") ? "\t" : ","
}

/**
 * Read RFC 4180 delimited text: quoted fields may hold the delimiter, line
 * breaks and doubled quotes. A leading byte-order mark is dropped, and CRLF
 * and LF both end a row. A blank last line is not a row.
 */
export function parseDelimitedText(
  text: string,
  delimiter: "," | "\t" = ","
): DelimitedTable {
  const source = text.startsWith("﻿") ? text.slice(1) : text
  const records: string[][] = []
  let row: string[] = []
  let field = ""
  // A quoted field was begun, though it may hold nothing: "" is a value.
  let fieldStarted = false
  let quoted = false
  let i = 0
  while (i < source.length) {
    const character = source[i]!
    if (quoted) {
      if (character === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += character
      i += 1
      continue
    }
    if (character === '"' && field === "") {
      quoted = true
      fieldStarted = true
      i += 1
    } else if (character === delimiter) {
      row.push(field)
      field = ""
      fieldStarted = false
      i += 1
    } else if (character === "\n" || character === "\r") {
      row.push(field)
      records.push(row)
      row = []
      field = ""
      fieldStarted = false
      i += character === "\r" && source[i + 1] === "\n" ? 2 : 1
    } else {
      field += character
      i += 1
    }
  }
  if (field !== "" || fieldStarted || row.length > 0) {
    row.push(field)
    records.push(row)
  }
  const [header = [], ...rows] = records
  return { header, rows }
}
