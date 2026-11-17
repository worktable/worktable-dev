import { expect, test, type Page, type WebSocketRoute } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness
const spaceId = "document-connection"

test.beforeAll(async () => {
  harness = await startWebHarness(spaceId, { storageVersion: 2 })
  const create = async (path: string, method: string, body: unknown) => {
    const response = await fetch(`${harness.apiUrl}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(response.ok).toBe(true)
  }
  await create("/spaces", "POST", { id: spaceId, name: "Document connection" })
  await create(`/spaces/${spaceId}/widgets`, "POST", {
    id: "report",
    name: "Connection report",
    html: '<h1>Loaded report</h1><input aria-label="Unsaved input">',
  })
  await create(`/spaces/${spaceId}/docs/notes`, "PUT", {
    content: [{ type: "paragraph", content: "Loaded document" }],
  })
})

test.afterAll(async () => {
  await harness?.stop()
})

/** Interrupt the real Space stream; its normal reconnect starts a page check. */
async function connectionFailures(page: Page, path: string) {
  let socket: WebSocketRoute | undefined
  let failure: "network" | number | null = null
  let settled = 0
  await page.routeWebSocket(new RegExp(`/ws\\?spaceId=${spaceId}$`), (next) => {
    socket = next
    next.connectToServer()
  })
  await page.route(
    `**/api/spaces/${spaceId}/documents/page?path=${path}`,
    async (route) => {
      if (failure === "network") await route.abort("internetdisconnected")
      else if (failure !== null)
        await route.fulfill({
          status: failure,
          json: { error: "Page check unavailable" },
        })
      else await route.continue()
      settled += 1
    }
  )
  const recheck = async (next: typeof failure) => {
    failure = next
    const previous = settled
    await expect.poll(() => socket !== undefined).toBe(true)
    const current = socket!
    socket = undefined
    await current.close()
    await expect.poll(() => settled).toBeGreaterThan(previous)
  }
  return { recheck }
}

const url = (path: string) =>
  `${harness.webUrl}/spaces/${spaceId}/documents/${path}`
const frameSelector = "[data-worktable-widget-frame]"
const offline = (page: Page) => page.locator('[data-document-status="offline"]')

test("an HTML page keeps its frame and unsaved input through failed checks, but respects permanent errors", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const { recheck } = await connectionFailures(page, "report")
  await page.goto(url("report"))
  const input = page
    .frameLocator(frameSelector)
    .getByRole("textbox", { name: "Unsaved input" })
  await expect(input).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByRole("button", { name: "Comment", exact: true })
  ).toBeVisible()
  await input.fill("Keep this draft")
  const originalFrame = await page.locator(frameSelector).elementHandle()

  for (const failure of ["network", 503, 408, 429] as const) {
    await recheck(failure)
    await expect(offline(page)).toHaveCount(1)
    await expect(page.locator("[data-document-state]")).toHaveCount(0)
    expect(await originalFrame!.evaluate((node) => node.isConnected)).toBe(true)
    await expect(input).toHaveValue("Keep this draft")
    await recheck(null)
    await expect(offline(page)).toHaveCount(0)
    expect(await originalFrame!.evaluate((node) => node.isConnected)).toBe(true)
    await expect(input).toHaveValue("Keep this draft")
  }
  // Use the existing pill on a phone too, without covering the artifact.
  await page.setViewportSize({ width: 390, height: 844 })
  await recheck("network")
  await expect(offline(page)).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("html-offline-mobile.png"),
  })
  await expect(input).toHaveValue("Keep this draft")
  await recheck(null)
  await expect(offline(page)).toHaveCount(0)

  for (const status of [404, 403, 409]) {
    await recheck(status)
    await expect(page.locator("[data-document-state]")).toBeVisible()
    await expect(page.locator(frameSelector)).toHaveCount(0)
    // A later transport failure cannot resurrect a page that was refused.
    await recheck("network")
    await expect(page.locator("[data-document-state]")).toContainText(
      "Couldn’t open document"
    )
    await expect(page.locator(frameSelector)).toHaveCount(0)
    await recheck(null)
    await expect(input).toBeVisible({ timeout: 30_000 })
  }
})

test("a rich-text document keeps the same editor and uses one status pill during a failed check", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const { recheck } = await connectionFailures(page, "notes")
  await page.goto(url("notes"))
  const editor = page.locator('.bn-editor[contenteditable="true"]')
  await expect(editor).toContainText("Loaded document", { timeout: 60_000 })
  const originalEditor = await editor.elementHandle()
  await recheck("network")
  await expect(offline(page)).toHaveCount(1)
  await expect(editor).toContainText("Loaded document")
  expect(await originalEditor!.evaluate((node) => node.isConnected)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("document-offline.png") })
  await recheck(null)
  await expect(offline(page)).toHaveCount(0)
  expect(await originalEditor!.evaluate((node) => node.isConnected)).toBe(true)
})

test("a failed first open cannot admit a document from cached metadata", async ({
  page,
}) => {
  const { recheck } = await connectionFailures(page, "report")
  await page.goto(url("report"))
  await expect(
    page.frameLocator(frameSelector).getByText("Loaded report")
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Comment", exact: true })
  ).toBeVisible()
  await recheck("network")
  await expect(offline(page)).toHaveCount(1)
  // Visit another path, then return from the tab's cache with checks unavailable.
  await page
    .locator("aside")
    .getByRole("link", { name: "Notes", exact: true })
    .click()
  await expect(page.locator('.bn-editor[contenteditable="true"]')).toBeVisible({
    timeout: 60_000,
  })
  await page
    .locator("aside")
    .getByRole("link", { name: "Connection report", exact: true })
    .click()
  await expect(page.locator("[data-document-state]")).toContainText(
    "Couldn’t open document"
  )
  await expect(page.locator(frameSelector)).toHaveCount(0)
})
