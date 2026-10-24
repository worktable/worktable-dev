import { describe, expect, it } from "bun:test"
import { delimiterForFilename, parseDelimitedText } from "./delimited-text"

describe("reading CSV and TSV", () => {
  it("keeps every value exactly as the file holds it", () => {
    const table = parseDelimitedText(
      '﻿id,name,note\r\n007," Ada, Lovelace ","said ""hi""\nthen left"\r\n008,,\n'
    )
    expect(table.header).toEqual(["id", "name", "note"])
    expect(table.rows).toEqual([
      ["007", " Ada, Lovelace ", 'said "hi"\nthen left'],
      ["008", "", ""],
    ])
    // A last record that is one quoted empty value is still a record.
    expect(parseDelimitedText('value\n""').rows).toEqual([[""]])
    // A preview keeps only the rows it shows, and counts the rest.
    const long = parseDelimitedText("n\n1\n2\n3\n", ",", { maxRows: 2 })
    expect(long.rows).toEqual([["1"], ["2"]])
    expect(long.rowCount).toBe(3)
  })

  it("reads TSV by its name, and keeps ragged rows as written", () => {
    expect(delimiterForFilename("export.TSV")).toBe("\t")
    expect(delimiterForFilename("feedback.csv")).toBe(",")
    expect(parseDelimitedText("a\tb\n1\n2\t3\t4", "\t")).toEqual({
      header: ["a", "b"],
      rows: [["1"], ["2", "3", "4"]],
      rowCount: 2,
    })
  })
})
