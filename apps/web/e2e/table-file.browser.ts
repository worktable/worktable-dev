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

test("a table file shows every row as written, and sorts and searches its view", async ({
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

  // The last row is drawn once scrolled to, and the header stays put.
  const headerTop = (await header.boundingBox())?.y
  await grid.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(grid.getByRole("cell", { name: "Row 3000", exact: true })).toBeVisible()
  expect((await header.boundingBox())?.y).toBe(headerTop)
  // Only the rows in view are in the page, not all 3,000.
  expect(await grid.locator("tbody tr").count()).toBeLessThan(100)

  // A number column sorts as numbers, largest first on the second click,
  // and each row keeps its number in the file.
  await grid.evaluate((element) => {
    element.scrollTop = 0
  })
  const amount = grid.getByRole("button", { name: "Amount", exact: true })
  await amount.click()
  await amount.click()
  const firstRow = grid.locator("tbody tr[aria-rowindex]").first()
  await expect(firstRow.getByRole("cell").nth(3)).toHaveText("3000")
  await expect(firstRow.getByRole("cell").first()).toHaveText("3000")

  // Search keeps the rows that match and says how many.
  await page.getByLabel("Search rows").fill("row 2999")
  await expect(page.getByText("1 of 3,000 rows", { exact: true })).toBeVisible()
  await expect(grid.getByRole("cell", { name: "Row 2999", exact: true })).toBeVisible()
})
