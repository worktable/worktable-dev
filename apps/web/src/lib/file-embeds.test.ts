import { describe, expect, it } from "bun:test"
import { embeddedFileName, embedSourceUrl } from "./file-embeds"

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
