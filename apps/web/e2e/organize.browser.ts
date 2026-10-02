import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("organize", { storageVersion: 2 })
})
test.afterAll(async () => {
  await harness?.stop()
})

// Owns the organization journey a person relies on: new documents start
// temporary and stay out of everyday browsing, Keep brings one back, Home
// lists recent durable work, and a pinned document becomes a Space's start.
test("temporary documents stay aside until kept, and pinned documents start the Space", async ({
  page,
}) => {
  const space = await page.request.post(`${harness.apiUrl}/api/spaces`, {
    data: { name: "Organize", id: "organize" },
  })
  expect(space.ok()).toBe(true)
  const durable = await page.request.post(
    `${harness.apiUrl}/api/spaces/organize/docs`,
    { data: { title: "Product brief", content: [] } }
  )
  expect(durable.ok()).toBe(true)

  await page.goto(`${harness.webUrl}/spaces/organize`)
  const row = page
    .getByRole("button", { name: /^(Expand|Collapse) Organize$/ })
    .locator("../..")
  await row.hover()
  await row.getByRole("button", { name: "New", exact: true }).click()
  await expect(
    page.getByRole("menuitemcheckbox", { name: "New documents are temporary" })
  ).toHaveAttribute("aria-checked", "true")
  await page.getByRole("menuitem", { name: "New doc", exact: true }).click()
  await expect(page).toHaveURL(/documents\/untitled$/)

  const chip = page.getByRole("button", { name: /^Temporary\. Archives / })
  await expect(chip).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "Temporary documents" }).getByRole("link", { name: "Untitled" })
  ).toBeVisible()

  await page.goto(`${harness.webUrl}/`)
  const recent = page.locator("section").filter({ hasText: "Recent" }).first()
  const untitled = recent.getByRole("link", { name: /^Untitled / })
  await expect(recent.getByRole("link", { name: /^Product brief /i })).toBeVisible()
  await expect(untitled).toHaveCount(0)
  await recent.getByRole("button", { name: "Include temporary" }).click()
  await expect(untitled).toBeVisible()

  await untitled.click()
  await page.getByRole("button", { name: /^Temporary\. Archives / }).click()
  await page.getByRole("button", { name: "Keep", exact: true }).click()
  await expect(page.getByRole("button", { name: /^Temporary\. Archives / })).toHaveCount(0)
  await expect(
    page.getByRole("navigation", { name: "Active documents" }).getByRole("link", { name: "Untitled" })
  ).toBeVisible()

  await page.getByRole("button", { name: "More actions" }).click()
  await page.getByRole("menuitem", { name: "Pin to Start here" }).click()
  await page.getByRole("link", { name: "Organize", exact: true }).click()
  await expect(page).toHaveURL(/\/spaces\/organize$/)
  await expect(
    page.getByRole("region", { name: "Start here" }).getByRole("link", { name: "Untitled" })
  ).toBeVisible()
})
