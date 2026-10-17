import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("sidebar-organization", { storageVersion: 2 })
})
test.afterAll(async () => {
  await harness?.stop()
})

test("a person's groups and pins are their own, and the sidebar stays as they left it", async ({
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
  const named = (name: string) =>
    sidebar.getByRole("button", { name, exact: true })

  // They start from the groups Spaces already name.
  await expect(named("Research")).toBeVisible({ timeout: 30_000 })

  const saved = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/profile/navigation") &&
        response.request().method() === "PUT" &&
        response.ok()
    )

  await named("Beta").hover()
  const pinned = saved()
  await sidebar.getByRole("button", { name: "Pin Beta" }).click()
  await pinned
  await expect(sidebar.getByText("Pinned", { exact: true })).toBeVisible()

  const listed = sidebar
    .locator(".group\\/space", { has: named("Beta") })
    .last()
  await listed.hover()
  await listed.locator("button[aria-haspopup='menu']").last().click()
  await page.getByRole("menuitem", { name: "Change Group" }).hover()
  await page.getByRole("menuitem", { name: "New Group" }).click()
  await page.getByLabel("Name").fill("Clients")
  const grouped = saved()
  await page.getByRole("button", { name: "Create" }).click()
  await grouped
  await expect(named("Clients")).toBeVisible()

  // What is open stays on this device: a folded section and an open Space.
  await named("Research").click()
  await expect(named("Alpha")).toHaveCount(0)
  await named("Beta").last().click()
  await expect(named("Beta").last()).toHaveAttribute("aria-expanded", "true")
  await expect(sidebar.getByRole("link", { name: "Space Home" })).toBeVisible()

  await page.reload()
  await expect(named("Clients")).toBeVisible({ timeout: 30_000 })
  await expect(named("Beta")).toHaveCount(2)
  await expect(named("Beta").last()).toHaveAttribute("aria-expanded", "true")
  await expect(named("Alpha")).toHaveCount(0)

  // None of it changed the Spaces themselves.
  const spaces = (await (
    await page.request.get(`${harness.apiUrl}/api/spaces`)
  ).json()) as { spaces: { id: string; group?: string }[] }
  expect(spaces.spaces.find((space) => space.id === "alpha")?.group).toBe("research")
  expect(spaces.spaces.find((space) => space.id === "beta")).not.toHaveProperty("group")
})
