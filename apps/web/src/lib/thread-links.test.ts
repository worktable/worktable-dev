import { describe, expect, it } from "bun:test"
import fc from "fast-check"
import { renderThreadLinkHref } from "./thread-links"

const labelArb = fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/)
const protocolRelativeHrefArb = fc
  .record({
    hostLabels: fc.array(labelArb, { minLength: 1, maxLength: 3 }),
    port: fc.option(fc.integer({ min: 1024, max: 65535 }), {
      nil: undefined,
    }),
    path: fc.array(labelArb, { maxLength: 4 }),
    query: fc.option(
      fc.array(fc.tuple(labelArb, labelArb), { minLength: 1, maxLength: 3 }),
      { nil: undefined }
    ),
    fragment: fc.option(labelArb, { nil: undefined }),
  })
  .map(({ hostLabels, port, path, query, fragment }) => {
    const authority = `${hostLabels.join(".")}.test${port ? `:${port}` : ""}`
    const pathname = path.length > 0 ? `/${path.join("/")}` : ""
    const search = query
      ? `?${query.map(([key, value]) => `${key}=${value}`).join("&")}`
      : ""
    return `//${authority}${pathname}${search}${fragment ? `#${fragment}` : ""}`
  })

describe("thread links", () => {
  it("projects portable Doc links into the current Space", () => {
    expect(renderThreadLinkHref("product manager", "/plans/q1#risks")).toBe(
      "/spaces/product%20manager/documents/plans/q1#risks"
    )
  })

  it("moves agent-local Worktable URLs onto the reader's current origin", () => {
    expect(
      renderThreadLinkHref(
        "product-manager",
        "http://127.0.0.1:7432/spaces/product-manager/docs/vision?view=full#north-star",
        ["http://127.0.0.1:7432"]
      )
    ).toBe("/spaces/product-manager/documents/vision?view=full#north-star")
    expect(
      renderThreadLinkHref(
        "product-manager",
        "http://127.0.0.1:7432/spaces/product-manager/documents/vision#north-star",
        ["http://127.0.0.1:7432"]
      )
    ).toBe("/spaces/product-manager/documents/vision#north-star")
  })

  it("leaves external and other-Space links untouched", () => {
    expect(
      renderThreadLinkHref("product", "https://example.com/reference")
    ).toBe("https://example.com/reference")
    expect(
      renderThreadLinkHref(
        "product",
        "https://worktable.example/spaces/research/docs/notes"
      )
    ).toBe("https://worktable.example/spaces/research/docs/notes")
    expect(
      renderThreadLinkHref(
        "product",
        "https://example.com/spaces/product/docs/reference",
        ["https://worktable.example"]
      )
    ).toBe("https://example.com/spaces/product/docs/reference")
  })

  it("rejects relative document links without a Space context", () => {
    const worktable = { kind: "worktable" as const }
    expect(renderThreadLinkHref(worktable, "./notes")).toBeNull()
    expect(renderThreadLinkHref(worktable, "guide")).toBeNull()
    expect(renderThreadLinkHref(worktable, "/doc/notes")).toBeNull()
    expect(renderThreadLinkHref(worktable, "/spaces/research/docs/notes")).toBe(
      "/spaces/research/docs/notes"
    )
    expect(
      renderThreadLinkHref(worktable, "https://example.com/reference")
    ).toBe("https://example.com/reference")
  })

  it("preserves generated protocol-relative links in either location", () => {
    fc.assert(
      fc.property(protocolRelativeHrefArb, (href) => {
        expect(renderThreadLinkHref("product", href)).toBe(href)
        expect(renderThreadLinkHref({ kind: "worktable" }, href)).toBe(href)
      })
    )
  })

  it("preserves global Threads routes in either location", () => {
    const route = "/threads/worktable/thr_abcdefghijkl"
    expect(renderThreadLinkHref({ kind: "worktable" }, route)).toBe(route)
    expect(
      renderThreadLinkHref({ kind: "space", spaceId: "product" }, route)
    ).toBe(route)
  })
})
