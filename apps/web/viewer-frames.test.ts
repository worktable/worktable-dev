import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"

import { buildPdfViewerFrame, viewerFrameOutput } from "./viewer-frames"

describe("the PDF viewer frame", () => {
  test("is one document that loads nothing, under a policy that lets it reach nothing", async () => {
    const frame = await buildPdfViewerFrame()
    const policy = new Map(
      frame.csp.split("; ").map((directive) => {
        const [name, ...values] = directive.split(" ")
        return [name!, values] as const
      })
    )
    // No origin, no network, no frames, no forms, no navigation of the app.
    expect(policy.get("sandbox")).toEqual(["allow-scripts"])
    expect(policy.get("default-src")).toEqual(["'none'"])
    expect(policy.get("connect-src")).toEqual(["'none'"])
    expect(policy.get("frame-src")).toEqual(["'none'"])
    expect(policy.get("form-action")).toEqual(["'none'"])
    expect(policy.get("worker-src")).toEqual(["blob:"])

    // The only script that may run is the one in the document, and nothing
    // in the document points anywhere else for code or styles.
    const scripts = [
      ...frame.html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g),
    ]
    expect(scripts).toHaveLength(1)
    const hash = `'sha256-${createHash("sha256").update(scripts[0]![1]!).digest("base64")}'`
    expect(policy.get("script-src")).toEqual([hash, "'wasm-unsafe-eval'"])
    expect(frame.csp).not.toContain("unsafe-inline")
    expect(frame.csp).not.toContain("'unsafe-eval'")
    expect(frame.html).not.toMatch(/<script[^>]+\ssrc=/)
    expect(frame.html).not.toMatch(/<link\b/)
    expect(frame.html).toContain(
      '<script type="text/plain" id="viewer-worker">'
    )

    // Its public files are data only: fonts, character maps and decoders.
    const names = [...frame.files.keys()]
    expect(names.some((name) => name.startsWith("standard_fonts/"))).toBe(true)
    expect(names.some((name) => name.startsWith("cmaps/"))).toBe(true)
    expect(names.filter((name) => name.endsWith(".js"))).toEqual([])
    expect([...viewerFrameOutput(frame).keys()]).toContain("pdf/policy.json")
  }, 120_000)
})
