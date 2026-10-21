import { expect, test, type Page } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

// One Doc written twice: as Markdown and as rich text. Both formats, and the
// rich Doc's saved preview, should put every line in the same place.
const markdown = `# Layout title

Opening paragraph that sits below the title.

## Second level

- First bullet
- Second bullet
  - Nested bullet
- Third bullet

1. First number
2. Second number

- [ ] Open task
- [x] Done task

> Quoted line.

\`\`\`ts
const value = 1
\`\`\`

| Name | Value |
| --- | --- |
| Alpha | 1 |

#### Fourth level

Before the rule.

---

Closing paragraph.
`

const text = (value: string) => [{ type: "text", text: value, styles: {} }]
const item = (type: string, value: string, extra: object = {}) => ({
  type,
  content: text(value),
  ...extra,
})
const rich = [
  item("heading", "Layout title", { props: { level: 1 } }),
  item("paragraph", "Opening paragraph that sits below the title."),
  item("heading", "Second level", { props: { level: 2 } }),
  item("bulletListItem", "First bullet"),
  item("bulletListItem", "Second bullet", {
    children: [item("bulletListItem", "Nested bullet")],
  }),
  item("bulletListItem", "Third bullet"),
  item("numberedListItem", "First number"),
  item("numberedListItem", "Second number"),
  item("checkListItem", "Open task", { props: { checked: false } }),
  item("checkListItem", "Done task", { props: { checked: true } }),
  item("quote", "Quoted line."),
  item("codeBlock", "const value = 1", { props: { language: "typescript" } }),
  {
    type: "table",
    content: {
      type: "tableContent",
      headerRows: 1,
      rows: [
        { cells: [text("Name"), text("Value")] },
        { cells: [text("Alpha"), text("1")] },
      ],
    },
  },
  item("heading", "Fourth level", { props: { level: 4 } }),
  item("paragraph", "Before the rule."),
  { type: "divider" },
  item("paragraph", "Closing paragraph."),
]

const lines = [
  "Layout title",
  "Opening paragraph",
  "Second level",
  "First bullet",
  "Nested bullet",
  "Third bullet",
  "First number",
  "Second number",
  "Open task",
  "Done task",
  "Quoted line.",
  "const",
  "Name",
  "Alpha",
  "Fourth level",
  "Before the rule.",
  "Closing paragraph.",
]

// Long enough to scroll on a phone, with fences written the way people and
// agents write them: an alias, a language the editor doesn't know, none.
const longMarkdown = [
  "# Long",
  ...Array.from(
    { length: 30 },
    (_, index) =>
      `Paragraph ${index + 1} has enough words in it to wrap onto a second line on a phone.`
  ),
  "| Name | Value |\n| --- | --- |\n| A cell that wraps in a narrow column | 1 |",
  "```txt\ntree/\n  leaf\n```",
  "```made-up\nsource\n```",
  "```\nplain\n```",
  "Reading here.",
  ...Array.from({ length: 30 }, (_, index) => `Closing ${index + 1}.`),
].join("\n\n")

function appUrl(path: string): string {
  return new URL(path, harness.webUrl).href
}

type Line = { top: number; width: number }

/**
 * Where each line's text starts, from the top of the page frame, and how wide
 * that text runs, which catches tracking and ligature differences.
 */
async function linePositions(page: Page, root: string): Promise<Line[]> {
  return page.locator(root).evaluate((element, texts) => {
    const frame = element.closest(".worktable-document-content") ?? element
    const top = frame.getBoundingClientRect().top
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    return texts.map((value) => {
      const node = nodes.find((candidate) => candidate.data.includes(value))
      if (!node) return { top: Number.NaN, width: Number.NaN }
      const range = document.createRange()
      const start = node.data.indexOf(value)
      range.setStart(node, start)
      range.setEnd(node, start + 1)
      const first = range.getBoundingClientRect().top - top
      range.setEnd(node, start + value.length)
      return { top: first, width: range.getBoundingClientRect().width }
    })
  }, lines)
}

// Line boxes match exactly; glyphs inside them may snap to a neighboring
// pixel when the two renderers nest text differently.
function expectSameLayout(actual: Line[], expected: Line[], label: string) {
  lines.forEach((line, index) => {
    const [a, e] = [actual[index]!, expected[index]!]
    expect(
      Math.abs(a.top - e.top),
      `${label}: "${line}" at ${a.top} instead of ${e.top}`
    ).toBeLessThanOrEqual(1.5)
    expect(
      Math.abs(a.width - e.width),
      `${label}: "${line}" ${a.width}px wide instead of ${e.width}px`
    ).toBeLessThanOrEqual(0.5)
  })
}

test.beforeAll(async () => {
  harness = await startWebHarness("document-layout-browser")
  const jsonHeaders = { "Content-Type": "application/json" }
  const space = await fetch(`${harness.apiUrl}/api/spaces`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: "Layout" }),
  })
  expect(space.status).toBe(201)
  const doc = await fetch(`${harness.apiUrl}/api/spaces/layout/docs/rich`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ content: rich }),
  })
  expect(doc.ok).toBe(true)
  await writeFile(
    harness.workspacePath("spaces/layout/docs/plain.md"),
    markdown
  )
  for (const width of [1280, 390]) {
    await writeFile(
      harness.workspacePath(`spaces/layout/docs/long-${width}.md`),
      longMarkdown
    )
  }
  const columns = Array.from(
    { length: 10 },
    (_, index) => `Column ${index + 1}`
  )
  await writeFile(
    harness.workspacePath("spaces/layout/docs/wide.md"),
    [
      "# Wide",
      "",
      `A long link https://example.com/${"segment/".repeat(16)}end keeps wrapping.`,
      "",
      `| ${columns.join(" | ")} |`,
      `| ${columns.map(() => "---").join(" | ")} |`,
      `| ${columns.map((name) => `${name} holds a longer value`).join(" | ")} |`,
      "",
    ].join("\n")
  )
})

test.afterAll(async () => {
  await harness?.stop()
})

test("a Doc reads the same in Markdown, in its saved preview, and once editable", async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto(appUrl("/spaces/layout/documents/plain"))
  await expect(page.locator("article.worktable-markdown")).toContainText(
    "Closing paragraph.",
    { timeout: 30_000 }
  )
  await page.evaluate(() => document.fonts.ready)
  const asMarkdown = await linePositions(page, "article.worktable-markdown")

  // Refuse collaboration until measured, so the saved preview stays up. The
  // client reconnects on its own once sockets are let through.
  let held = true
  await page.routeWebSocket(/.*/, (socket) => {
    if (held) socket.close()
    else socket.connectToServer()
  })
  await page.goto(appUrl("/spaces/layout/documents/rich"))
  await expect(page.locator("[data-document-preview]")).toContainText(
    "Closing paragraph.",
    { timeout: 30_000 }
  )
  await page.evaluate(() => document.fonts.ready)
  const asPreview = await linePositions(page, "[data-document-preview] article")

  held = false
  await expect(page.locator('[contenteditable="true"]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator("[data-document-preview]")).toHaveCount(0)
  const asEditor = await linePositions(page, ".bn-editor")

  expectSameLayout(asPreview, asEditor, "preview → editor")
  expectSameLayout(asMarkdown, asEditor, "Markdown → rich text")
})

test("block handles sit beside the first line of each block", async ({
  page,
}) => {
  await page.goto(appUrl("/spaces/layout/documents/rich"))
  await expect(page.locator('[contenteditable="true"]')).toBeVisible({
    timeout: 30_000,
  })
  for (const line of [
    "Layout title",
    "Opening paragraph",
    "Second level",
    "First bullet",
    "Open task",
    "Quoted line.",
    "const value",
    "Fourth level",
  ]) {
    const content = page
      .locator(".bn-editor .bn-inline-content")
      .filter({ hasText: line })
      .first()
    // Blocks below the fold must be on screen for the pointer to reach them.
    await content.scrollIntoViewIfNeeded()
    const box = await content.boundingBox()
    if (!box) throw new Error(`${line} is not visible`)
    await page.mouse.move(box.x + 24, box.y + 4)
    const handle = page.locator(".bn-side-menu button").last()
    await expect(handle).toBeVisible()
    await expect
      .poll(
        async () => {
          const icon = await handle.boundingBox()
          const center = await content.evaluate((element) => {
            const first = document
              .createTreeWalker(element, NodeFilter.SHOW_TEXT)
              .nextNode()
            if (!first) return Number.NaN
            const range = document.createRange()
            range.setStart(first, 0)
            range.setEnd(first, 1)
            const rect = range.getBoundingClientRect()
            return rect.top + rect.height / 2
          })
          return icon ? Math.abs(icon.y + icon.height / 2 - center) : Infinity
        },
        { message: `handle beside "${line}"` }
      )
      .toBeLessThanOrEqual(2)
  }
})

test("wide Markdown tables and long links stay inside the page on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(appUrl("/spaces/layout/documents/wide"))
  const table = page.locator(".worktable-markdown table")
  await expect(table).toBeVisible({ timeout: 30_000 })

  const scroll = await page
    .locator("[data-document-scroll-root]")
    .evaluate((root) => ({
      document: root.scrollWidth - root.clientWidth,
      table: (() => {
        const box = root.querySelector("table")?.parentElement
        return box ? box.scrollWidth - box.clientWidth : 0
      })(),
    }))
  expect(scroll.document).toBeLessThanOrEqual(0)
  expect(scroll.table).toBeGreaterThan(0)
})

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`Edit keeps the reader's place and every code fence at ${viewport.width}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setViewportSize(viewport)
    await page.goto(appUrl(`/spaces/layout/documents/long-${viewport.width}`))
    const markdownRoot = page.locator("[data-document-scroll-root]")
    await expect(markdownRoot).toContainText("Closing 30.", { timeout: 30_000 })
    await page.evaluate(() => document.fonts.ready)

    // Where a line sits from the top of the pane that scrolls the Doc.
    const lineTop = (root: string, text: string) =>
      page.locator(root).evaluate((element, text) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode as Text
          const start = node.data.indexOf(text)
          if (start < 0) continue
          const range = document.createRange()
          range.setStart(node, start)
          range.setEnd(node, start + 1)
          return (
            range.getBoundingClientRect().top -
            element.getBoundingClientRect().top
          )
        }
        return Number.NaN
      }, text)
    // Start reading at the code, at the top of the pane.
    await markdownRoot.evaluate((root) => {
      const pre = root.querySelector("pre")!
      root.scrollTop +=
        pre.getBoundingClientRect().top - root.getBoundingClientRect().top - 8
    })
    const before = await lineTop("[data-document-scroll-root]", "Reading here.")

    await page.getByRole("button", { name: "Edit" }).click()
    const editorRoot = ".worktable-editor-scroll-root"
    await expect(
      page.locator(`${editorRoot} [contenteditable="true"]`)
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(editorRoot)).toContainText("Closing 30.")
    await expect
      .poll(async () =>
        Math.abs((await lineTop(editorRoot, "Reading here.")) - before)
      )
      .toBeLessThanOrEqual(1.5)
    // The caret waits in the first block in view, the code.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.activeElement?.classList.contains("ProseMirror") &&
            getSelection()?.anchorNode?.parentElement?.closest("pre")
              ?.textContent
        )
      )
      .toContain("tree/")
    expect(errors).toEqual([])

    const exported = await fetch(
      `${harness.apiUrl}/api/spaces/layout/docs/long-${viewport.width}?format=markdown`
    ).then((response) => response.json() as Promise<{ markdown: string }>)
    expect(exported.markdown).toContain("```txt\ntree/")
    expect(exported.markdown).toContain("```made-up\nsource")
    expect(exported.markdown).toContain("```\nplain")
  })
}
