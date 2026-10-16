import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("runtime-routing-browser")
})

test.afterAll(async () => {
  await harness?.stop()
})

test("a selected Cloud Worktable survives hydration, navigation and direct reload", async ({ page }) => {
  const mount = "/t/teams-browser"
  // Model the gateway's mount without mocking the application or its API.
  // Start serves the normal root HTML; the browser hydrates at the public URL.
  await page.route(`**${mount}/**`, async (route) => {
    const upstream = new URL(route.request().url())
    upstream.pathname = upstream.pathname.slice(mount.length) || "/"
    const response = await route.fetch({ url: upstream.href })
    await route.fulfill({ response })
  })

  await page.goto(`${harness.webUrl}${mount}/?selected=1#home`, { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(`${harness.webUrl}${mount}/?selected=1#home`)

  const sidebar = page.locator("aside")
  const home = sidebar.getByRole("link", { name: "Home", exact: true })
  const threads = sidebar.getByRole("link", { name: "Threads", exact: true })
  await expect(home).toHaveAttribute("href", `${mount}/`)
  await expect(threads).toHaveAttribute("href", `${mount}/threads?location=all`)
  await threads.click()
  await expect(page).toHaveURL(`${harness.webUrl}${mount}/threads?location=all`)
  await expect(page.getByText("No threads yet", { exact: true })).toBeVisible()
  await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  await expect(page).toHaveURL(`${harness.webUrl}${mount}/threads?location=all`)
  await expect(page.getByText("No threads yet", { exact: true })).toBeVisible()
  await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0)
  await home.click()
  await expect(page).toHaveURL(`${harness.webUrl}${mount}/`)
})
