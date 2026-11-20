import { describe, expect, it } from "bun:test"
import { TextLinePage, contentsReaderFor } from "./file-contents.ts"

const encode = (text: string) => new TextEncoder().encode(text)

/** A page of `bytes` read in chunks of `chunk` bytes. */
function pageOf(
  bytes: Uint8Array,
  options: { offset?: number; limit?: number; maxBytes?: number; chunk?: number } = {}
) {
  const page = new TextLinePage(options.offset, options.limit, options.maxBytes)
  const step = options.chunk ?? bytes.byteLength
  for (let at = 0; at < bytes.byteLength; at += step) {
    page.update(bytes.subarray(at, at + step))
  }
  return page.page()
}

describe("a text file's contents", () => {
  it("pages lines exactly as stored, however the bytes arrive", () => {
    const file = encode("﻿first\r\nzweite Zeile é\nthird\n\nlast without an ending")
    // One byte at a time splits every character and line ending.
    for (const chunk of [1, 3, file.byteLength]) {
      expect(pageOf(file, { chunk })).toEqual({
        state: "ready",
        text: "﻿first\r\nzweite Zeile é\nthird\n\nlast without an ending",
        startLine: 1,
        endLine: 5,
        totalLines: 5,
        missing: [],
      })
      expect(pageOf(file, { chunk, offset: 2, limit: 2 })).toMatchObject({
        text: "zweite Zeile é\nthird\n",
        startLine: 2,
        endLine: 3,
        nextOffset: 4,
      })
    }
    expect(pageOf(encode(""))).toMatchObject({ text: "", endLine: 0, totalLines: 0 })
    expect(pageOf(encode("a\nb\n"), { offset: 9 })).toMatchObject({
      text: "",
      startLine: 9,
      endLine: 8,
      totalLines: 2,
    })
  })

  it("stops a page at its byte limit, and cuts only a line too long for any page", () => {
    const lines = encode("aaaa\nbbbb\ncccc\n")
    expect(pageOf(lines, { maxBytes: 10, chunk: 2 })).toMatchObject({
      state: "ready",
      text: "aaaa\nbbbb\n",
      endLine: 2,
      nextOffset: 3,
    })
    // A first line past the limit is kept up to it, ending on a whole
    // character, and the page says where and why.
    // Read chunks that end exactly at the limit split the last character too.
    const long = encode(`${"é".repeat(8)}\nnext\n`)
    for (const chunk of [1, 2, 3, 7, long.byteLength]) {
      const cut = pageOf(long, { maxBytes: 7, chunk })
      expect(cut, `chunk ${chunk}`).toMatchObject({
        state: "partial",
        text: "ééé",
        endLine: 1,
        nextOffset: 2,
      })
      expect(cut.missing).toEqual([{ where: "line 1", why: expect.stringContaining("cut") }])
    }
  })

  it("has no contents for text that isn't UTF-8, and says why", () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])
    expect(pageOf(latin1)).toMatchObject({
      state: "unsupported",
      text: "",
      totalLines: 1,
      missing: [{ why: expect.stringContaining("UTF-8") }],
    })
  })

  it("is read for text, code and tables as text, a PDF by its reader, and not yet for anything else", () => {
    for (const path of ["notes.txt", "data.csv", "app/main.py", "Dockerfile", "logo.svg"]) {
      expect(contentsReaderFor(path), path).toBe("text")
    }
    expect(contentsReaderFor("Report.PDF")).toBe("pdf")
    for (const path of ["photo.png", "budget.xlsx", "unknown.bin"]) {
      expect(contentsReaderFor(path), path).toBeNull()
    }
  })
})
