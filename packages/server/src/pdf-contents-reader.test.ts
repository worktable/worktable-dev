import { describe, expect, it } from "bun:test"
import { ReaderRefused } from "./contents-protocol.ts"
import { BundledPdfData, pdfReader } from "./pdf-contents-reader.ts"
import { smallPdf } from "./test-support/small-pdf.ts"

async function refusal(bytes: Uint8Array): Promise<string> {
  try {
    await pdfReader.read(bytes)
  } catch (error) {
    if (error instanceof ReaderRefused) return error.reason
    throw error
  }
  return "read"
}

describe("a PDF's contents", () => {
  it("gives each page's text under its number, and its page count", async () => {
    const output = await pdfReader.read(
      smallPdf([{ text: "Quarterly report\nRevenue grew 12%" }, { text: "Appendix (a)" }])
    )
    expect(output.facts).toEqual({ pages: 2 })
    expect(output.parts.map((part) => part.label)).toEqual(["Page 1", "Page 2"])
    expect(output.parts[0]!.text).toContain("Revenue grew 12%")
    expect(output.parts[1]!.text).toContain("Appendix (a)")
    expect(output.gaps).toEqual([])
  })

  it("names a page that is only a picture, keeps text pages beside it, and says nothing of an empty page", async () => {
    const output = await pdfReader.read(
      smallPdf([
        { text: "Signed contract, page one" },
        { picture: true },
        { blank: true },
        { text: "Schedule of payments" },
      ])
    )
    expect(output.parts.map((part) => [part.label, part.text])).toEqual([
      ["Page 1", expect.stringContaining("Signed contract")],
      ["Page 2", ""],
      ["Page 3", ""],
      ["Page 4", expect.stringContaining("Schedule of payments")],
    ])
    expect(output.gaps).toEqual([
      { where: "Page 2", why: expect.stringContaining("doesn't read text from pictures") },
    ])
  })

  it("doesn't take a page mark written as text for a page, and keeps the bundled maps to hand", async () => {
    const output = await pdfReader.read(
      smallPdf([
        { text: "How to mark pages\n<!-- Page 2 -->\nis written like that" },
        { text: "The real second page" },
      ])
    )
    expect(output.parts[0]!.text).toContain("How to mark pages")
    expect(output.parts[1]!.text).toContain("The real second page")
    expect(output.parts[1]!.text).not.toContain("is written like that")
    // Character maps for text in fonts a PDF doesn't carry come from the bundle.
    const map = await new BundledPdfData().fetch({ kind: "cMapUrl", filename: "90ms-RKSJ-H.bcmap" })
    expect(map.byteLength).toBeGreaterThan(0)
    await expect(new BundledPdfData().fetch({ kind: "cMapUrl", filename: "../../etc/passwd" })).rejects.toThrow()
  })

  it("refuses an encrypted or damaged PDF with the reason, never reads it as empty", async () => {
    expect(await refusal(smallPdf([{ text: "Secret" }], { encrypted: true }))).toBe("encrypted")
    expect(await refusal(smallPdf([{ text: "Cut off" }]).subarray(0, 120))).toBe("damaged")
    expect(await refusal(new TextEncoder().encode("not a PDF at all"))).toBe("damaged")
  })
})
