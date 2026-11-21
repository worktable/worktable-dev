import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"

import {
  buildPdfViewerFrame,
  buildWordViewerFrame,
  viewerFrameOutput,
  type ViewerFrameBuild,
} from "./viewer-frames"

/** What every viewer frame keeps to: no origin, no network, one script. */
function expectLockedDown(frame: ViewerFrameBuild) {
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
  expect(frame.csp).not.toContain("'unsafe-eval'")
  expect(frame.html).not.toMatch(/<script[^>]+\ssrc=/)
  expect(frame.html).not.toMatch(/<link\b/)
  expect(frame.html).toContain('<script type="text/plain" id="viewer-worker">')
  // Its public files are data only, never code.
  expect(
    [...frame.files.keys()].filter((name) => name.endsWith(".js"))
  ).toEqual([])
  expect([...viewerFrameOutput(frame).keys()]).toContain(
    `${frame.key}/policy.json`
  )
  return policy
}

describe("the Word viewer frame", () => {
  test("carries Extend with its engine and fonts as files, and lets inline styles alone through", async () => {
    const frame = await buildWordViewerFrame()
    const policy = expectLockedDown(frame)
    // Extend draws with inline styles, which can run nothing.
    expect(policy.get("style-src")).toEqual(["'unsafe-inline'"])
    // The look-alike fonts are files the frame asks for, not 7 MB of text
    // in the document.
    const names = [...frame.files.keys()]
    expect(names).toContain("wasm/docx_wasm_bg.wasm")
    expect(names).toContain("fonts/carlito-0.woff2")
    expect(names).toContain("notices/OfficeArt-NOTICES.txt")
    expect(frame.html.length).toBeLessThan(2_000_000)
    expect(frame.html).not.toContain("data:font/woff2")
    // The engine is sent compressed.
    expect([...viewerFrameOutput(frame).keys()]).toContain(
      "word/files/wasm/docx_wasm_bg.wasm.br"
    )
  }, 120_000)
})

describe("the PDF viewer frame", () => {
  test("is one document that loads nothing, under a policy that lets it reach nothing", async () => {
    const frame = await buildPdfViewerFrame()
    expectLockedDown(frame)
    // Its own style is allowed by hash too.
    expect(frame.csp).not.toContain("unsafe-inline")
    // Its public files are fonts, character maps and decoders.
    const names = [...frame.files.keys()]
    expect(names.some((name) => name.startsWith("standard_fonts/"))).toBe(true)
    expect(names.some((name) => name.startsWith("cmaps/"))).toBe(true)
  }, 120_000)
})
