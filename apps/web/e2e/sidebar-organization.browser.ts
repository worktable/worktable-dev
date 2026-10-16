import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("sidebar-organization", { storageVersion: 2 })
})
test.afterAll(async () => {
  await harness?.stop()
})

test("a person's groups, pins and focus are their own and stay after a reload", async ({
  page,
}) => {
  for (const space of [
    { id: "alpha", name: "Alpha", group: "research" },
    { id: "beta", name: "Beta" },
  ]) {
    expect(
      (await page.request.post(`${harness.apiUrl}/api/spaces`, { data: space })).ok()
    ).toBe(true)
  }
  await page.goto(new URL("/", harness.webUrl).href)
  const sidebar = page.locator("[data-worktable-sidebar-root]")

  // They start from the groups Spaces already name.
  await expect(
    sidebar.getByRole("button", { name: "Research", exact: true })
  ).toBeVisible({ timeout: 30_000 })

  await sidebar.getByRole("link", { name: "Beta" }).hover()
  await sidebar.getByRole("button", { name: "Pin Beta" }).click()
  await expect(sidebar.getByText("Pinned", { exact: true })).toBeVisible()

  await sidebar.getByRole("link", { name: "Beta" }).last().hover()
  await sidebar
    .locator(".group\\/space", { has: page.getByRole("link", { name: "Beta" }) })
    .last()
    .locator("button[aria-haspopup='menu']")
    .last()
    .click()
  await page.getByRole("menuitem", { name: "Change Group" }).hover()
  await page.getByRole("menuitem", { name: "New Group" }).click()
  await page.getByLabel("Name").fill("Clients")
  await page.getByRole("button", { name: "Create" }).click()
  await expect(sidebar.getByRole("button", { name: "Clients", exact: true })).toBeVisible()

  await sidebar.getByRole("button", { name: "Showing all Spaces" }).click()
  await page.getByRole("menuitem", { name: "Clients" }).click()
  await expect(sidebar.getByRole("link", { name: "Alpha" })).toHaveCount(0)

  await page.reload()
  await expect(
    sidebar.getByRole("button", { name: "Showing Clients" })
  ).toBeVisible({ timeout: 30_000 })
  await expect(sidebar.getByRole("link", { name: "Beta" })).toHaveCount(2)
  await expect(sidebar.getByRole("link", { name: "Alpha" })).toHaveCount(0)

  // None of it changed the Spaces themselves.
  const spaces = (await (
    await page.request.get(`${harness.apiUrl}/api/spaces`)
  ).json()) as { spaces: { id: string; group?: string }[] }
  expect(spaces.spaces.find((space) => space.id === "alpha")?.group).toBe("research")
  expect(spaces.spaces.find((space) => space.id === "beta")).not.toHaveProperty("group")
})
