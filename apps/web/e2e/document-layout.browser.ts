import { expect, test, type Page } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

const blocks = [
  { type: "heading", props: { level: 1 }, text: "Layout title" },
  { type: "paragraph", text: "Opening paragraph that sits below the title." },
  { type: "heading", props: { level: 2 }, text: "Second level" },
  { type: "paragraph", text: "Body text between headings." },
  { type: "heading", props: { level: 4 }, text: "Fourth level" },
  { type: "paragraph", text: "Closing paragraph." },
]

function appUrl(path: string): string {
  return new URL(path, harness.webUrl).href
}

/** Viewport position of the first character of each text, in order. */
async function textTops(page: Page, root: string): Promise<number[]> {
  return page.locator(root).evaluate(
    (element, texts) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      while (walker.nextNode()) nodes.push(walker.currentNode as Text)
      return texts.map((text) => {
        const node = nodes.find((candidate) => candidate.data.startsWith(text))
        if (!node) return Number.NaN
        const range = document.createRange()
        range.setStart(node, 0)
        range.setEnd(node, 1)
        return range.getBoundingClientRect().top
      })
    },
    blocks.map((block) => block.text)
  )
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
    body: JSON.stringify({
      content: blocks.map(({ type, props, text }) => ({
        type,
        props,
        content: [{ type: "text", text, styles: {} }],
      })),
    }),
  })
  expect(doc.ok).toBe(true)
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

test("a rich doc keeps its layout when it becomes editable, with handles beside each line", async ({
  page,
}) => {
  test.setTimeout(120_000)
  // Refuse collaboration until measured, so the saved preview stays up. The
  // client reconnects on its own once sockets are let through.
  let held = true
  const release = () => {
    held = false
  }
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
  const before = await textTops(page, "[data-document-preview] article")

  release()
  await expect(page.locator('[contenteditable="true"]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator("[data-document-preview]")).toHaveCount(0)
  const after = await textTops(page, ".bn-editor")
  // Later blocks still differ until the preview shares the editor's styles;
  // the title and opening paragraph must not move.
  for (const index of [0, 1]) {
    expect(Math.abs(after[index] - before[index])).toBeLessThanOrEqual(1)
  }

  for (const { text } of blocks) {
    const content = page
      .locator(".bn-editor .bn-inline-content")
      .filter({ hasText: text })
    const box = await content.boundingBox()
    if (!box) throw new Error(`${text} is not visible`)
    await page.mouse.move(box.x + 24, box.y + 4)
    const handle = page.locator(".bn-side-menu button").last()
    await expect(handle).toBeVisible()
    await expect
      .poll(
        async () => {
          const icon = await handle.boundingBox()
          const line = await content.evaluate((element) => {
            const text = document
              .createTreeWalker(element, NodeFilter.SHOW_TEXT)
              .nextNode()
            if (!text) return Number.NaN
            const range = document.createRange()
            range.setStart(text, 0)
            range.setEnd(text, 1)
            const rect = range.getBoundingClientRect()
            return rect.top + rect.height / 2
          })
          return icon ? Math.abs(icon.y + icon.height / 2 - line) : Infinity
        },
        { message: `handle beside "${text}"` }
      )
      .toBeLessThanOrEqual(2)
  }
  release()
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
