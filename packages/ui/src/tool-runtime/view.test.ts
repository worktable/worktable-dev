import { expect, it } from "bun:test"
import { validateToolView } from "./view.ts"

it("accepts data tables, responsive layout, controls and inline vector charts", () => {
  expect(
    validateToolView({
      tag: "section",
      style: {
        display: "grid",
        gridTemplateColumns: 2,
        gap: 16,
        color: "text",
      },
      children: [
        {
          tag: "label",
          children: [
            "Region",
            {
              tag: "input",
              key: "region",
              props: { value: "North" },
              on: { input: "filter" },
            },
          ],
        },
        {
          tag: "svg",
          props: { viewBox: "0 0 200 80", "aria-label": "Revenue" },
          children: [
            {
              tag: "path",
              props: {
                d: "M0 80 L100 40 L200 0",
                stroke: "accent",
                fill: "none",
              },
            },
          ],
        },
      ],
    })
  ).toMatchObject({
    style: {
      color: "var(--ad-text)",
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    },
  })
})

it("rejects browser resource channels, HTML injection and arbitrary CSS", () => {
  for (const tag of [
    "script",
    "link",
    "meta",
    "base",
    "iframe",
    "img",
    "audio",
    "video",
    "object",
    "style",
    "foreignObject",
    "use",
    "animate",
  ])
    expect(() => validateToolView({ tag })).toThrow()
  for (const props of [
    { href: "https://synthetic.invalid" },
    { src: "https://synthetic.invalid" },
    { innerHTML: "<img src=//synthetic.invalid>" },
    { onclick: "fetch('https://synthetic.invalid')" },
    { id: "worktable-comments" },
    { style: "background:url(//synthetic.invalid)" },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ])
    expect(() => validateToolView({ tag: "div", props })).toThrow()
  for (const style of [
    { backgroundImage: "url(//synthetic.invalid)" },
    { color: "var(--url)" },
    { backgroundColor: "\\75rl(//synthetic.invalid)" },
    { fontFamily: "attacker" },
    { width: "calc(1px + url(//synthetic.invalid))" },
    { width: 1e12 },
    { gridTemplateColumns: "url(//synthetic.invalid)" },
    { position: "fixed" },
  ])
    expect(() => validateToolView({ tag: "div", style })).toThrow()
  expect(() =>
    validateToolView({
      tag: "svg",
      children: [{ tag: "path", props: { fill: "url(//synthetic.invalid)" } }],
    })
  ).toThrow()
  expect(() =>
    validateToolView({ tag: "svg", children: [{ tag: "div" }] })
  ).toThrow()
  expect(validateToolView("<script>literal text</script>")).toBe(
    "<script>literal text</script>"
  )
})

it("bounds trees, text and layout values before any rendering", () => {
  const cycle: { tag: string; children?: unknown[] } = { tag: "div" }
  cycle.children = [cycle]
  expect(() => validateToolView(cycle)).toThrow("cycle")
  expect(() =>
    validateToolView({ tag: "div", children: Array(2048).fill("row") })
  ).toThrow("too large")
  expect(() => validateToolView("x".repeat(16_385))).toThrow()
  expect(() =>
    validateToolView({ tag: "input", props: { max: Infinity } })
  ).toThrow()
  expect(() =>
    validateToolView({
      tag: "div",
      children: [
        { tag: "p", key: "same" },
        { tag: "p", key: "same" },
      ],
    })
  ).toThrow("duplicate")
})
