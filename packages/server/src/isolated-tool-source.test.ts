import { expect, test } from "bun:test"
import {
  isolatedToolSource,
  MAX_ISOLATED_TOOL_SOURCE_BYTES,
} from "./isolated-tool-source.ts"

test("extracts inert Unicode source without forwarding authored markup or decoding script text", () => {
  const source =
    'worktable.ui.render({tag:"p",children:["Équipe 東京 &lt;literal&gt;"]});'
  const html = `<!doctype html><html><head><link rel="preconnect" href="https://outside.invalid"></head><body onload="fetch('https://outside.invalid')"><script TYPE=" application/worktable ">${source}</script><img src="https://outside.invalid"></body></html>`
  expect(isolatedToolSource(html)).toBe(source)
  expect(
    isolatedToolSource("<!doctype html><script>window.legacy=true</script>")
  ).toBeNull()
  expect(
    isolatedToolSource(
      '<!-- <script type="application/worktable">comment</script> -->'
    )
  ).toBeNull()
})

test("rejects ambiguous, externally loaded and empty tool programs", () => {
  for (const html of [
    '<script type="application/worktable">first()</script><script>second()</script>',
    '<script type="application/worktable">first()</script><script type="application/worktable">second()</script>',
    '<script type="application/worktable" src="">first()</script>',
    '<script type="application/worktable" src="https://outside.invalid/code.js"></script>',
    '<script type="application/worktable">  </script>',
  ])
    expect(() => isolatedToolSource(html)).toThrow()
})

test("bounds source bytes before execution, including multibyte text", () => {
  const ascii = "x".repeat(MAX_ISOLATED_TOOL_SOURCE_BYTES)
  expect(
    isolatedToolSource(`<script type="application/worktable">${ascii}</script>`)
  ).toBe(ascii)
  expect(() =>
    isolatedToolSource(
      `<script type="application/worktable">${ascii}x</script>`
    )
  ).toThrow("512 KiB")
  expect(() =>
    isolatedToolSource(
      `<script type="application/worktable">${"東京".repeat(MAX_ISOLATED_TOOL_SOURCE_BYTES / 4)}</script>`
    )
  ).toThrow("512 KiB")
})
