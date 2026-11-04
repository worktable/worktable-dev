import { describe, expect, it } from "bun:test"
import fc from "fast-check"
import {
  analyzeDocumentPath,
  newPathRefusal,
  parseNewDocumentPath,
} from "./document-path.ts"

describe("document path authority", () => {
  it("normalizes portable identity without rewriting legacy input", () => {
    const composed = analyzeDocumentPath("Plans/Caf\u00e9")
    const decomposed = analyzeDocumentPath("plans/Cafe\u0301")

    expect(composed.safe).toBe(true)
    expect(decomposed.safe).toBe(true)
    expect(composed.comparisonKey).toBe(decomposed.comparisonKey)
    expect(decomposed.input).toBe("plans/Cafe\u0301")
    expect(decomposed.diagnostics).toContainEqual({
      code: "non-normalized-unicode",
      segment: "Cafe\u0301",
    })
  })

  it("keeps readable legacy paths separate from the new-path portability policy", () => {
    const longPath = Array.from({ length: 20 }, () => "a".repeat(60)).join("/")
    const cases = [
      {
        path: "Plans/Quarterly report.",
        diagnostic: "trailing-dot-or-space",
      },
      { path: "notes/percent%mark", diagnostic: "invalid-encoding" },
      { path: longPath, diagnostic: "path-too-long" },
      { path: "notes/a:b", diagnostic: "windows-invalid-character" },
      { path: "notes/legacy-note ", diagnostic: "trailing-dot-or-space" },
      { path: "notes/COM¹", diagnostic: "windows-reserved" },
      { path: "notes/LPT².txt", diagnostic: "windows-reserved" },
    ] as const

    for (const entry of cases) {
      const analysis = analyzeDocumentPath(entry.path)
      expect(analysis.safe).toBe(true)
      expect(analysis.diagnostics).toContainEqual(
        expect.objectContaining({ code: entry.diagnostic })
      )
      if (entry.diagnostic === "invalid-encoding") {
        expect(analysis.portable).toBe(true)
        expect(parseNewDocumentPath(entry.path)).not.toHaveProperty("error")
      } else {
        expect(analysis.portable).toBe(false)
        expect(parseNewDocumentPath(entry.path)).toHaveProperty("error")
      }
    }
  })

  it("rejects unsafe encodings, separators, dot segments, and malformed Unicode", () => {
    let excessiveEncoding = "%2e%2e"
    for (let pass = 0; pass < 32; pass += 1) {
      excessiveEncoding = excessiveEncoding.replaceAll("%", "%25")
    }
    const fixedCases = [
      "../secret",
      "%2e%2e/secret",
      "%252e%252e/secret",
      "%2525252525252e%2525252525252e/secret",
      "safe%2f..%2fsecret",
      "safe\\..\\secret",
      "notes/x\ud800",
      "notes/x\udc00",
      `notes/${excessiveEncoding}`,
      `${"safe/".repeat(1_000)}leaf`,
    ]
    for (const path of fixedCases) {
      expect(analyzeDocumentPath(path).safe).toBe(false)
    }

    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.constantFrom("", ".", "..", "%2e%2e", "a%2fb", "a\\b"),
        (safeSegments, unsafeSegment) => {
          const candidate = [...safeSegments, unsafeSegment].join("/")
          expect(analyzeDocumentPath(candidate).safe).toBe(false)
        }
      )
    )
  })

  it("refuses a new name for one reason on the written list, and says which", () => {
    const reason = (path: string, fileName = false) =>
      newPathRefusal(path, { fileName })?.code ?? null
    expect(reason("notes/../plan")).toBe("UNSAFE_PATH")
    expect(reason("/plan")).toBe("UNSAFE_PATH")
    expect(reason(".notes/plan")).toBe("HIDDEN_NAME")
    expect(reason("notes/.plan")).toBe("HIDDEN_NAME")
    expect(reason(".env", true)).toBe("HIDDEN_NAME")
    expect(reason("notes/plan.md")).toBe("DOC_NAME")
    expect(reason("notes/plan.md", true)).toBe("DOC_NAME")
    expect(reason("notes/CON")).toBe("NOT_PORTABLE")
    expect(reason("notes/a:b")).toBe("NOT_PORTABLE")
    expect(reason("notes/plan ")).toBe("NOT_PORTABLE")
    expect(reason("notes/plan")).toBeNull()
    expect(reason("data/config.json", true)).toBeNull()
    expect(newPathRefusal(".notes/plan")?.message).not.toContain("Doc")
  })

  it("keeps stable storage suffixes outside new logical paths", () => {
    for (const path of [
      "notes/readme.md",
      "notes/blocks.json",
      "notes/view.html",
      "notes/archive.wtdoc",
    ]) {
      expect(parseNewDocumentPath(path)).toHaveProperty("error")
    }
    expect(parseNewDocumentPath("notes/future.canvas")).toEqual({
      path: "notes/future.canvas",
      comparisonKey: "notes/future.canvas",
    })
    expect(parseNewDocumentPath("notes/sketch.excalidraw")).toEqual({
      path: "notes/sketch.excalidraw",
      comparisonKey: "notes/sketch.excalidraw",
    })
    expect(parseNewDocumentPath("notes/readme")).toEqual({
      path: "notes/readme",
      comparisonKey: "notes/readme",
    })
  })
})
