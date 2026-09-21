import { describe, expect, it } from "bun:test"
import fc from "fast-check"
import { externalLinkProps, worktableLinkOrigins } from "./external-links"

const labelArb = fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/)
const originArb = fc
  .record({
    protocol: fc.constantFrom("http", "https"),
    subdomain: labelArb,
    domain: labelArb,
    port: fc.option(fc.integer({ min: 1024, max: 65535 }), {
      nil: undefined,
    }),
  })
  .map(
    ({ protocol, subdomain, domain, port }) =>
      `${protocol}://${subdomain}.${domain}.test${port ? `:${port}` : ""}`
  )
const pathArb = fc
  .array(labelArb, { minLength: 1, maxLength: 4 })
  .map((segments) => `/${segments.join("/")}?view=full#decision`)
const relativeHrefArb = fc
  .tuple(
    fc.constantFrom("", "./", "../"),
    fc.array(labelArb, { minLength: 1, maxLength: 4 })
  )
  .map(([prefix, segments]) => `${prefix}${segments.join("/")}`)
const nonWebHrefArb = fc
  .tuple(
    fc.constantFrom("mailto", "tel", "sms", "ftp"),
    fc.stringMatching(/^[a-z0-9.+@-]{1,30}$/)
  )
  .map(([scheme, value]) => `${scheme}:${value}`)
const malformedHrefArb = fc
  .stringMatching(/^[a-z0-9]{0,30}$/)
  .map((value) => `https://[${value}`)

describe("external link targets", () => {
  const origins = worktableLinkOrigins(
    "https://worktable.example",
    "https://api.worktable.example/v1"
  )

  it("keeps Worktable destinations in the current tab", () => {
    for (const href of [
      "/spaces/product/docs/plan",
      "https://worktable.example/threads/worktable/thread-1",
      "https://api.worktable.example/status",
      "#decision",
    ]) {
      expect(externalLinkProps(href, origins)).toEqual({})
    }
  })

  it("opens off-origin web destinations in a separate tab", () => {
    for (const href of [
      "https://example.com/reference",
      "http://example.net/reference",
      "//cdn.example.org/reference",
    ]) {
      expect(externalLinkProps(href, origins)).toEqual({
        target: "_blank",
        rel: "noopener noreferrer",
      })
    }
  })

  it("leaves non-web and malformed destinations to native handling", () => {
    for (const href of [
      "mailto:person@example.com",
      "tel:+15550123",
      "https://[invalid",
    ]) {
      expect(externalLinkProps(href, origins)).toEqual({})
    }
  })

  it("ignores malformed configured origins", () => {
    expect(
      worktableLinkOrigins("https://worktable.example", "https://[invalid")
    ).toEqual(["https://worktable.example"])
  })

  it("keeps generated loopback aliases on the same port in Worktable", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("http", "https"),
        fc.integer({ min: 1024, max: 65535 }),
        fc.boolean(),
        pathArb,
        (protocol, port, pageUsesLocalhost, path) => {
          const pageHost = pageUsesLocalhost ? "localhost" : "127.0.0.1"
          const linkHost = pageUsesLocalhost ? "127.0.0.1" : "localhost"
          const otherPort = port === 65535 ? port - 1 : port + 1
          const generatedOrigins = worktableLinkOrigins(
            `${protocol}://${pageHost}:${port}`
          )

          expect(
            externalLinkProps(
              `${protocol}://${linkHost}:${port}${path}`,
              generatedOrigins
            )
          ).toEqual({})
          expect(
            externalLinkProps(
              `${protocol}://${linkHost}:${otherPort}${path}`,
              generatedOrigins
            )
          ).toEqual({
            target: "_blank",
            rel: "noopener noreferrer",
          })
        }
      )
    )
  })

  it("does not trust loopback destinations from a remote Worktable", () => {
    expect(
      externalLinkProps(
        "http://127.0.0.1:7480/spaces/product/docs/plan",
        worktableLinkOrigins("https://worktable.example")
      )
    ).toEqual({
      target: "_blank",
      rel: "noopener noreferrer",
    })
  })

  it("classifies generated web destinations by normalized origin", () => {
    const distinctOriginsArb = fc
      .tuple(originArb, originArb, originArb)
      .filter(
        (origins) =>
          new Set(origins.map((origin) => new URL(origin).origin)).size === 3
      )

    fc.assert(
      fc.property(
        distinctOriginsArb,
        pathArb,
        ([pageOrigin, apiOrigin, externalOrigin], path) => {
          const generatedOrigins = worktableLinkOrigins(
            pageOrigin,
            `${apiOrigin}/api`
          )

          expect(
            externalLinkProps(new URL(path, pageOrigin).href, generatedOrigins)
          ).toEqual({})
          expect(
            externalLinkProps(new URL(path, apiOrigin).href, generatedOrigins)
          ).toEqual({})
          expect(
            externalLinkProps(
              new URL(path, externalOrigin).href,
              generatedOrigins
            )
          ).toEqual({
            target: "_blank",
            rel: "noopener noreferrer",
          })
        }
      )
    )
  })

  it("keeps generated relative, non-web, and malformed links native", () => {
    fc.assert(
      fc.property(
        originArb,
        relativeHrefArb,
        nonWebHrefArb,
        malformedHrefArb,
        (origin, relativeHref, nonWebHref, malformedHref) => {
          const generatedOrigins = worktableLinkOrigins(origin)

          expect(externalLinkProps(relativeHref, generatedOrigins)).toEqual({})
          expect(externalLinkProps(nonWebHref, generatedOrigins)).toEqual({})
          expect(externalLinkProps(malformedHref, generatedOrigins)).toEqual({})
        }
      )
    )
  })
})
