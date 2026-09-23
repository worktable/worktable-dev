import { expect, test, type Page } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

async function openPortability(page: Page) {
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  const settings = page.getByRole("button", { name: "Settings", exact: true })
  await expect(settings).toBeVisible({ timeout: 30_000 })
  await settings.click()
  await page
    .getByRole("button", { name: "Import & Export", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Import & Export", exact: true })
  ).toBeVisible()
}

test.beforeAll(async () => {
  harness = await startWebHarness("workspace-portability-browser")
})

test.afterAll(async () => {
  await harness?.stop()
})

// Browser boundary: a real second tab must discard its session-scoped drafts
// and reload after a destructive clear. Server tests cover archive and reset rules.
test("clearing a workspace discards stale drafts and reloads another tab", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000)
  await page.goto(harness.webUrl, { waitUntil: "domcontentloaded" })
  await openPortability(page)
  const other = await context.newPage()
  await other.goto(harness.webUrl, { waitUntil: "domcontentloaded" })
  await expect(other.getByRole("button", { name: /^Settings/ })).toBeVisible({
    timeout: 30_000,
  })
  const before = await (
    await page.request.get(`${harness.apiUrl}/api/workspace`)
  ).json()
  const draftKey = `worktable:thread-drafts:v1:${encodeURIComponent(before.id)}:${before.contentEpoch}`
  await other.evaluate((key) => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        drafts: {
          unsent: { value: "Draft from before clear", updatedAt: Date.now() },
        },
      })
    )
  }, draftKey)
  await expect
    .poll(() =>
      other.evaluate(
        (id) => sessionStorage.getItem(`worktable-content-epoch:${id}`),
        before.id
      )
    )
    .toBe(before.contentEpoch)
  await page
    .getByRole("button", { name: "Clear workspace", exact: true })
    .click()
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: /^Clear / }) })
  const confirm = dialog.getByRole("button", {
    name: "Clear workspace",
    exact: true,
  })
  await expect(confirm).toBeDisabled()
  const input = page.locator("#workspace-clear-confirmation")
  await expect(input).toBeEnabled({ timeout: 15_000 })
  await input.fill("wrong")
  await expect(confirm).toBeDisabled()
  await input.fill(`CLEAR ${before.name}`)
  await expect(confirm).toBeEnabled()
  let reloads = 0
  other.on("framenavigated", (frame) => {
    if (frame === other.mainFrame()) reloads++
  })
  await confirm.click()
  await expect
    .poll(
      async () => {
        const response = await page.request
          .get(`${harness.apiUrl}/api/workspace/clear/current`)
          .catch(() => null)
        return response?.ok()
          ? (await response.json()).job?.state
          : "reconnecting"
      },
      { timeout: 30_000 }
    )
    .toBe("complete")
  const after = await (
    await page.request.get(`${harness.apiUrl}/api/workspace`)
  ).json()
  // A visible home tab has no content socket and can miss a fast replacement's
  // intermediate states. Its background poll must refresh without a focus event.
  await expect.poll(() => reloads, { timeout: 20_000 }).toBeGreaterThan(0)
  await expect
    .poll(
      () =>
        other.evaluate(
          (id) => sessionStorage.getItem(`worktable-content-epoch:${id}`),
          before.id
        ),
      { timeout: 20_000 }
    )
    .toBe(after.contentEpoch)
  expect(
    await other.evaluate((key) => sessionStorage.getItem(key), draftKey)
  ).toBeNull()
  // A restored tab can start with storage from before the clear. It must finish
  // loading the new workspace as well as discard the obsolete draft.
  const restored = await context.newPage()
  await restored.addInitScript(({ id, epoch, key }) => {
    const epochKey = `worktable-content-epoch:${id}`
    if (sessionStorage.getItem(epochKey) !== null) return
    sessionStorage.setItem(epochKey, epoch)
    sessionStorage.setItem(key, JSON.stringify({
      version: 1,
      drafts: {
        unsent: { value: "Draft from before clear", updatedAt: Date.now() },
      },
    }))
  }, { id: before.id, epoch: before.contentEpoch, key: draftKey })
  await restored.goto(harness.webUrl, { waitUntil: "domcontentloaded" })
  await openPortability(restored)
  await expect.poll(
    () => restored.evaluate((key) => sessionStorage.getItem(key), draftKey),
    { timeout: 20_000 }
  ).toBeNull()
})
