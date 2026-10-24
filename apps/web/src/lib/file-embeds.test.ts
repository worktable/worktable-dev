import { afterEach, describe, expect, it } from "bun:test"
import { embeddedFileName, embedSourceUrl, uploadEmbeddedFile } from "./file-embeds"

const realFetch = globalThis.fetch

describe("a Doc's embedded files", () => {
  it("load from the Doc's Space, resolved from the Doc's folder", () => {
    expect(embedSourceUrl("product", "onboarding/signup-flow", "signup-flow/error.png")).toEndWith(
      "/api/spaces/product/documents/file?path=onboarding%2Fsignup-flow%2Ferror.png"
    )
    expect(embedSourceUrl("product", "onboarding/signup-flow", "/brand/logo.svg")).toEndWith(
      "?path=brand%2Flogo.svg"
    )
    // Anything outside the Space stays as written.
    expect(embedSourceUrl("product", "a", "https://example.com/x.png")).toBe(
      "https://example.com/x.png"
    )
    expect(embedSourceUrl("product", "a", "data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA"
    )
    // With the version the Doc's page gave, the browser keeps the file.
    expect(
      embedSourceUrl("product", "onboarding/signup-flow", "signup-flow/error.png", {
        "onboarding/signup-flow/error.png": "2026-10-23T14:02:00.000Z",
      })
    ).toEndWith("error.png&v=2026-10-23T14%3A02%3A00.000Z")
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("saved into a Doc whose name holds \"#\" load from where they were saved", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ path: "notes/review#1/error.png" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch
    const stored = await uploadEmbeddedFile(
      "product",
      "notes/review#1",
      new File(["x"], "error.png", { type: "image/png" })
    )
    expect(embedSourceUrl("product", "notes/review#1", stored)).toEndWith(
      "?path=notes%2Freview%231%2Ferror.png"
    )
  })

  it("are saved under their own name as a slug, or a dated one for a clipboard image", () => {
    const at = new Date(2026, 9, 23, 14, 2)
    expect(
      embeddedFileName(new File(["x"], "Signup Error (v2).PNG", { type: "image/png" }), at)
    ).toBe("signup-error-v2.png")
    expect(embeddedFileName(new File(["x"], "image.png", { type: "image/png" }), at)).toBe(
      "pasted-image-2026-10-23-1402.png"
    )
    expect(embeddedFileName(new File(["x"], "", { type: "image/jpeg" }), at)).toBe(
      "pasted-image-2026-10-23-1402.jpg"
    )
    expect(embeddedFileName(new File(["x"], "Q3 report.pdf", { type: "application/pdf" }), at)).toBe(
      "q3-report.pdf"
    )
  })
})
