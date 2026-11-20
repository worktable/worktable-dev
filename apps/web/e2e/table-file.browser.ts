import { expect, test } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("table-file-browser")
  const folder = harness.workspacePath("spaces/welcome/docs/data")
  await mkdir(folder, { recursive: true })
  // Past the 1,000 rows the page used to stop at, with values a spreadsheet
  // would retype: a leading zero, a quoted comma, a line break.
  const rows = ["Code,Comment,Amount"]
  rows.push('007,"Split, then ""rush""",12.50')
  rows.push('008,"Line one\nLine two",3')
  for (let index = 3; index <= 3000; index += 1) {
    rows.push(`C${index},Row ${index},${index}`)
  }
  await writeFile(`${folder}/orders.csv`, rows.join("\n") + "\n")
})

test.afterAll(async () => {
  await harness?.stop()
})

test("a table file shows every row as written, with its header in view", async ({
  page,
}) => {
  await page.goto(
    new URL("/spaces/welcome/documents/data/orders.csv", harness.webUrl).href,
    { waitUntil: "domcontentloaded" }
  )
  const grid = page.getByLabel("orders.csv", { exact: true })
  await expect(grid).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("3,000 rows", { exact: true })).toBeVisible()

  const header = grid.getByRole("columnheader", { name: "Comment" })
  await expect(header).toBeVisible()
  // Exact text: nothing is typed or trimmed.
  await expect(grid.getByRole("cell", { name: "007", exact: true })).toBeVisible()
  await expect(
    grid.getByRole("cell", { name: 'Split, then "rush"', exact: true })
  ).toBeVisible()

  // The last row is drawn once scrolled to, and the header stays at the top.
  await grid.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const last = grid.getByRole("cell", { name: "Row 3000", exact: true })
  await expect(last).toBeVisible()
  const [headerBox, gridBox] = await Promise.all([
    header.boundingBox(),
    grid.boundingBox(),
  ])
  expect(headerBox && gridBox && headerBox.y - gridBox.y).toBe(0)
  // Only the rows in view are in the page, not all 3,000.
  expect(await grid.locator("tbody tr").count()).toBeLessThan(100)
})
