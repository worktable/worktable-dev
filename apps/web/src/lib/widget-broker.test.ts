import { describe, expect, it } from "bun:test"
import fc from "fast-check"
import { resolveWidgetApiTarget } from "./widget-broker"
import { htmlDocumentApiPath } from "./html-document-api-path"

const ORIGIN = "https://host.example"
const SPACE = "welcome"
const WIDGET = "welcome-tour"

// Mirrors the server's WidgetIdSchema: slash-joined canonical segments, with
// reserved route-suffix names forbidden as any segment.
const RESERVED = new Set(["records", "state", "content", "archive", "restore", "versions", "review"])
const segmentArb = fc
  .stringMatching(/^[a-z0-9][a-z0-9-]{0,10}[a-z0-9]$|^[a-z0-9]$/)
  .filter((s) => !RESERVED.has(s))
const widgetIdArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("/"))

describe("resolveWidgetApiTarget", () => {
  it("allows the widget's own state and records endpoints", () => {
    const base = htmlDocumentApiPath(SPACE, WIDGET)
    expect(
      resolveWidgetApiTarget(`${base}/state`, SPACE, WIDGET, ORIGIN)
    ).toBe(`${base}/state`)
    expect(
      resolveWidgetApiTarget(
        `${base}/records/tasks/query`,
        SPACE,
        WIDGET,
        ORIGIN
      )
    ).toBe(`${base}/records/tasks/query`)
  })

  it("preserves the query string", () => {
    const base = htmlDocumentApiPath(SPACE, WIDGET)
    expect(
      resolveWidgetApiTarget(`${base}/state?x=1`, SPACE, WIDGET, ORIGIN)
    ).toBe(`${base}/state?x=1`)
  })

  it("keeps common document paths isolated without relying on widget route segments", () => {
    const documentPath = "Team Board/state"
    const base = htmlDocumentApiPath(SPACE, documentPath)
    expect(
      resolveWidgetApiTarget(
        `${base}/records/tasks/query`,
        SPACE,
        documentPath,
        ORIGIN
      )
    ).toBe(`${base}/records/tasks/query`)
    expect(
      resolveWidgetApiTarget(
        `${htmlDocumentApiPath(SPACE, "Team Board/other")}/state`,
        SPACE,
        documentPath,
        ORIGIN
      )
    ).toBeNull()
  })

  it("denies arbitrary /api paths (no token minting, etc.)", () => {
    expect(resolveWidgetApiTarget("/api/tokens", SPACE, WIDGET, ORIGIN)).toBeNull()
    expect(resolveWidgetApiTarget("/api/spaces", SPACE, WIDGET, ORIGIN)).toBeNull()
  })

  it("denies another widget's or another space's endpoints", () => {
    expect(
      resolveWidgetApiTarget(`${htmlDocumentApiPath(SPACE, "other")}/state`, SPACE, WIDGET, ORIGIN)
    ).toBeNull()
    expect(
      resolveWidgetApiTarget(`${htmlDocumentApiPath("other", WIDGET)}/state`, SPACE, WIDGET, ORIGIN)
    ).toBeNull()
  })

  it("denies owner-authenticated widget routes that skip permission checks", () => {
    // These live under the widget prefix but are NOT permission-checked runtime
    // surfaces — a sandboxed widget must not reach them through the parent.
    for (const path of ["archive", "restore", "content", "", "state-extra"]) {
      expect(
        resolveWidgetApiTarget(`${htmlDocumentApiPath(SPACE, WIDGET)}/${path}`, SPACE, WIDGET, ORIGIN)
      ).toBeNull()
    }
    // ...and the widget resource itself (PUT/PATCH/DELETE the widget).
    expect(
      resolveWidgetApiTarget(
        htmlDocumentApiPath(SPACE, WIDGET), SPACE, WIDGET, ORIGIN)
    ).toBeNull()
  })

  it("denies path traversal that escapes the widget namespace", () => {
    expect(
      resolveWidgetApiTarget(
        `${htmlDocumentApiPath(SPACE, WIDGET)}/../../../tokens`,
        SPACE,
        WIDGET,
        ORIGIN
      )
    ).toBeNull()
  })

  it("denies cross-origin and non-http targets", () => {
    expect(
      resolveWidgetApiTarget(`https://evil.example${htmlDocumentApiPath(SPACE, WIDGET)}/state`, SPACE, WIDGET, ORIGIN)
    ).toBeNull()
    expect(resolveWidgetApiTarget("", SPACE, WIDGET, ORIGIN)).toBeNull()
  })

  // Path-style widget ids (slash-joined segments) — property-based coverage of
  // the security boundary per the testing rules in AGENTS.md.
  describe("path-style ids (properties)", () => {
    it("always allows the widget's own state and records endpoints", () => {
      fc.assert(
        fc.property(segmentArb, widgetIdArb, segmentArb, (spaceId, widgetId, collection) => {
          const base = `${htmlDocumentApiPath(spaceId, widgetId)}/`
          expect(resolveWidgetApiTarget(`${base}state`, spaceId, widgetId, ORIGIN)).toBe(`${base}state`)
          expect(resolveWidgetApiTarget(`${base}records/${collection}/query`, spaceId, widgetId, ORIGIN)).toBe(
            `${base}records/${collection}/query`
          )
        })
      )
    })

    it("anything it resolves stays inside the widget's own runtime namespace", () => {
      const rawPathArb = fc.oneof(
        fc.string(),
        fc.webUrl(),
        fc
          .tuple(segmentArb, widgetIdArb, fc.array(fc.constantFrom("..", "%2e%2e", "state", "records", "content", "archive", "restore", "tokens", "%2f", "a"), { maxLength: 6 }))
          .map(([space, widget, tail]) => `/api/spaces/${space}/widgets/${widget}/${tail.join("/")}`)
      )
      fc.assert(
        fc.property(segmentArb, widgetIdArb, rawPathArb, (spaceId, widgetId, rawPath) => {
          const resolved = resolveWidgetApiTarget(rawPath, spaceId, widgetId, ORIGIN)
          if (resolved === null) return
          const base = `${htmlDocumentApiPath(spaceId, widgetId)}/`
          const pathname = resolved.split("?")[0] ?? ""
          expect(pathname === `${base}state` || pathname.startsWith(`${base}records/`)).toBe(true)
        })
      )
    })

    it("never grants a widget access to a prefix-sibling widget's endpoints", () => {
      // Sibling `w/<seg>` for any valid (non-reserved) segment: its state and
      // records paths must not resolve under widget `w`. Reserved segments are
      // exactly the names the server forbids in ids, which is what keeps
      // `<base>records/...` unambiguous.
      fc.assert(
        fc.property(segmentArb, widgetIdArb, segmentArb, (spaceId, widgetId, childSegment) => {
          const sibling = `${widgetId}/${childSegment}`
          expect(
            resolveWidgetApiTarget(`${htmlDocumentApiPath(spaceId, sibling)}/state`, spaceId, widgetId, ORIGIN)
          ).toBeNull()
          expect(
            resolveWidgetApiTarget(`${htmlDocumentApiPath(spaceId, widgetId)}/../other/state`, spaceId, widgetId, ORIGIN)
          ).toBeNull()
        })
      )
    })

    it("normalizes traversal before the prefix check for nested ids", () => {
      fc.assert(
        fc.property(segmentArb, widgetIdArb, (spaceId, widgetId) => {
          const escapes = [
            `${htmlDocumentApiPath(spaceId, widgetId)}/../../../tokens`,
            `${htmlDocumentApiPath(spaceId, widgetId)}/state/../../other/state`,
            `${htmlDocumentApiPath(spaceId, widgetId)}/records/../archive`,
          ]
          for (const path of escapes) {
            const resolved = resolveWidgetApiTarget(path, spaceId, widgetId, ORIGIN)
            if (resolved !== null) {
              const base = `${htmlDocumentApiPath(spaceId, widgetId)}/`
              const pathname = resolved.split("?")[0] ?? ""
              expect(pathname === `${base}state` || pathname.startsWith(`${base}records/`)).toBe(true)
            }
          }
        })
      )
    })
  })
})
