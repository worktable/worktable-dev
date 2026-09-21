import { describe, expect, it } from "bun:test"
import { renderDocLinkHref } from "./doc-links"

describe("renderDocLinkHref", () => {
  it("renders root-relative and document-relative links as app URLs", () => {
    expect(
      renderDocLinkHref("team one", "plans/q3/agenda", "/architecture")
    ).toBe("/spaces/team%20one/documents/architecture")
    expect(renderDocLinkHref("team", "plans/q3/agenda", "../budget")).toBe(
      "/spaces/team/documents/plans/budget"
    )
  })

  it("encodes path segments and preserves query and fragment suffixes", () => {
    expect(
      renderDocLinkHref(
        "team",
        "notes/index",
        "/release notes.md?mode=read#decisions"
      )
    ).toBe("/spaces/team/documents/release%20notes?mode=read#decisions")
  })

  it("leaves non-doc links unchanged", () => {
    for (const href of [
      "https://example.com/a",
      "mailto:person@example.com",
      "#local-heading",
      "//cdn.example.com/file",
    ]) {
      expect(renderDocLinkHref("team", "notes/index", href)).toBe(href)
    }
  })
})
