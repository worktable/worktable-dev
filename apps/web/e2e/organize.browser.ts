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
// temporary and stay out of everyday browsing, Home shows them aside until
// kept, Activity records what happened, and a pinned document leads its Space.
test("temporary documents stay aside until kept, and pinned documents lead the Space", async ({
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

  await page.goto(`${harness.webUrl}/spaces/organize`, {
    waitUntil: "domcontentloaded",
  })
  const row = page
    .getByRole("button", { name: /^(Expand|Collapse) Organize$/ })
    .locator("../..")
  await row.hover()
  await row.getByRole("button", { name: "New", exact: true }).click()
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Start as Temporary" })
  ).toHaveAttribute("aria-checked", "true")
  await page.getByRole("menuitem", { name: "Doc", exact: true }).click()
  await expect(page).toHaveURL(/documents\/untitled$/)

  await expect(
    page.getByRole("button", { name: /^Temporary\. Archives / })
  ).toBeVisible()
  await expect(
    page
      .getByRole("navigation", { name: "Temporary documents" })
      .getByRole("link", { name: "Untitled" })
  ).toBeVisible()

  await page.goto(`${harness.webUrl}/`)
  const recent = page.getByRole("region", { name: "Recent" })
  const temporary = page.getByRole("region", { name: "Temporary" })
  await expect(
    recent.getByRole("link", { name: /^Product brief/i })
  ).toBeVisible()
  await expect(recent.getByRole("link", { name: /^Untitled/ })).toHaveCount(0)
  await expect(temporary.getByRole("link", { name: "Untitled" })).toBeVisible()

  await temporary.getByRole("link", { name: "Untitled" }).hover()
  await temporary.getByRole("button", { name: "Keep", exact: true }).click()
  await expect(recent.getByRole("link", { name: /^Untitled/ })).toBeVisible()
  await expect(temporary).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Activity" })).toContainText(
    "You kept Untitled"
  )

  await recent.getByRole("link", { name: /^Untitled/ }).click()
  await expect(
    page.getByRole("button", { name: /^Temporary\. Archives / })
  ).toHaveCount(0)
  await expect(
    page
      .getByRole("navigation", { name: "Active documents" })
      .getByRole("link", { name: "Untitled" })
  ).toBeVisible()

  await page.getByRole("button", { name: "More actions" }).click()
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click()
  await expect(
    page
      .getByRole("navigation", { name: "Pinned" })
      .getByRole("link", { name: "Untitled" })
  ).toBeVisible()
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Organize", exact: true })
    .click()
  await expect(page).toHaveURL(/\/spaces\/organize$/)
  await expect(
    page
      .getByRole("region", { name: "Pinned" })
      .getByRole("link", { name: "Untitled" })
  ).toBeVisible()
})

test.describe("archive date editing", () => {
  test.use({ timezoneId: "America/Los_Angeles" })

  test("date changes are explicit, cancellable, and recoverable after a failed save", async ({
    page,
  }) => {
    const space = await page.request.post(`${harness.apiUrl}/api/spaces`, {
      data: { name: "Archive dates" },
    })
    expect(space.ok()).toBe(true)
    const archiveOn = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const created = await page.request.post(
      `${harness.apiUrl}/api/spaces/archive-dates/docs`,
      {
        data: {
          title: "Schedule",
          content: [],
          lifetime: "temporary",
          archiveOn,
        },
      }
    )
    expect(created.ok()).toBe(true)
    const endpoint = `${harness.apiUrl}/api/spaces/archive-dates/documents`
    const savedDate = async () => {
      const response = await page.request.get(endpoint)
      const { documents } = await response.json()
      return documents.find(
        (document: { path: string }) => document.path === "schedule"
      ).archiveOn
    }

    await page.goto(
      `${harness.webUrl}/spaces/archive-dates/documents/schedule`,
      {
        waitUntil: "domcontentloaded",
      }
    )
    const nextDate = await page.evaluate((iso) => {
      const next = new Date(iso)
      next.setDate(next.getDate() + 1)
      next.setHours(0, 0, 0, 0)
      return next.toISOString()
    }, archiveOn)
    const chip = page.getByRole("button", { name: /^Temporary\. Archives / })
    await chip.click()
    await page.getByRole("button", { name: "Change date", exact: true }).click()
    const save = page.getByRole("button", { name: "Save date", exact: true })
    await expect(save).toBeDisabled()
    const selected = page
      .getByRole("gridcell", { selected: true })
      .getByRole("button")
    await expect(selected).toBeFocused()
    await selected.press("ArrowRight")
    await page.keyboard.press("Enter")
    await expect(save).toBeEnabled()
    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Change date", exact: true })
    ).toBeFocused()
    expect(await savedDate()).toBe(archiveOn)

    await page.getByRole("button", { name: "Change date", exact: true }).click()
    await expect(save).toBeDisabled()
    await selected.press("ArrowRight")
    await page.keyboard.press("Enter")
    const lifetimeRoute = "**/api/spaces/archive-dates/documents/lifetime"
    await page.route(lifetimeRoute, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporarily unavailable" }),
      })
    )
    await save.click()
    await expect(
      page.getByText("Couldn’t change when this document archives.")
    ).toBeVisible()
    await expect(
      page.getByRole("dialog", { name: "Change archive date" })
    ).toBeVisible()
    await expect(save).toBeEnabled()
    expect(await savedDate()).toBe(archiveOn)

    await page.unroute(lifetimeRoute)
    await save.click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(await savedDate()).toBe(nextDate)
    const label = await page.evaluate(
      (iso) =>
        new Date(iso).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          ...(new Date(iso).getFullYear() !== new Date().getFullYear()
            ? { year: "numeric" as const }
            : {}),
        }),
      nextDate
    )
    await expect(chip).toHaveAccessibleName(`Temporary. Archives ${label}`)
    await page.reload()
    await expect(chip).toHaveAccessibleName(`Temporary. Archives ${label}`)
  })
})
