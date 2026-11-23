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
  await create(`/spaces/${spaceId}/widgets`, "POST", {
    id: "deck",
    name: "Deck",
    html: placePage("First version"),
  })
  await create(`/spaces/${spaceId}/widgets`, "POST", {
    id: "gallery",
    name: "Gallery",
    html: galleryPage(),
  })
  await create(`/spaces/${spaceId}/docs/notes`, "PUT", {
    content: [{ type: "paragraph", content: "Loaded document" }],
  })
})

/** A page that keeps its slide in the address and is taller than the pane. */
function placePage(version: string) {
  return `<!doctype html><html><head><title>Deck</title></head><body>
<p id="version">${version}</p><p id="slide"></p><button id="next">Next</button>
<div style="height:4000px"></div>
<script>
function at() { return parseInt(location.hash.slice(1), 10) || 1 }
function show() { document.getElementById("slide").textContent = "Slide " + at() }
document.getElementById("next").onclick = function () { history.replaceState(null, "", "#" + (at() + 1)); show() }
show()
</script></body></html>`
}

/** Pictures to look at, and pictures the page uses for something else. */
function galleryPage() {
  const image = (alt: string, size: number, attributes = "") =>
    `<img alt="${alt}" ${attributes} src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${size * 1.5}' height='${size}'%3E%3Crect width='100%25' height='100%25' fill='%23369'/%3E%3C/svg%3E">`
  return `<!doctype html><html><head><title>Gallery</title></head><body>
${image("Harbor", 120)}${image("Badge", 16)}${image("Hills", 120)}
<a href="#linked">${image("Linked", 120)}</a>
${image("Card", 120, 'id="card" style="cursor:pointer"')}
<p id="status"></p>
<script>
document.getElementById("card").addEventListener("click", function () {
  document.getElementById("status").textContent = "Card opened"
})
</script></body></html>`
}

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
    .getByRole("navigation", { name: "Active documents", exact: true })
    .getByRole("link", { name: "Notes", exact: true })
    .click()
  await expect(page.locator('.bn-editor[contenteditable="true"]')).toBeVisible({
    timeout: 60_000,
  })
  await page
    .getByRole("navigation", { name: "Active documents", exact: true })
    .getByRole("link", { name: "Connection report", exact: true })
    .click()
  await expect(page.locator("[data-document-state]")).toContainText(
    "Couldn’t open document"
  )
  await expect(page.locator(frameSelector)).toHaveCount(0)
})

test("a new version of an open HTML page opens where the reader was", async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto(url("deck"))
  const frame = page.frameLocator(frameSelector)
  const slide = frame.locator("#slide")
  await expect(slide).toHaveText("Slide 1", { timeout: 30_000 })
  await frame.getByRole("button", { name: "Next" }).click()
  await frame.getByRole("button", { name: "Next" }).click()
  await expect(slide).toHaveText("Slide 3")
  const scrollY = async () =>
    (await (await page.locator(frameSelector).elementHandle())!.contentFrame())!
      .evaluate(() => Math.round(window.scrollY))
  await (await (await page.locator(frameSelector).elementHandle())!.contentFrame())!
    .evaluate(() => window.scrollTo(0, 1800))
  await expect.poll(scrollY).toBe(1800)

  // An agent saves a new version while the page is open.
  const widget = `${harness.apiUrl}/api/spaces/${spaceId}/widgets/deck`
  const source = await page.request.get(`${widget}/content?format=raw`)
  const revision = source.headers()["etag"]?.replace(/"/g, "")
  const saved = await page.request.fetch(widget, {
    method: "PUT",
    data: { name: "Deck", html: placePage("Second version"), expectedRevision: revision },
  })
  expect(saved.ok()).toBe(true)
  await expect(frame.locator("#version")).toHaveText("Second version", {
    timeout: 30_000,
  })
  await expect(slide).toHaveText("Slide 3")
  await expect.poll(scrollY).toBe(1800)

  // The place belongs to this view of the page: opening it again starts over.
  await page.goto(url("deck"))
  await expect(page.frameLocator(frameSelector).locator("#slide")).toHaveText(
    "Slide 1",
    { timeout: 30_000 }
  )
})
test("Print PDF prints the open HTML page, not the app around it", async ({
  page,
}) => {
  test.setTimeout(120_000)
  // Count print calls in every document instead of opening a print dialog.
  await page.addInitScript(() => {
    const count = window as unknown as { printed?: number }
    count.printed = 0
    window.print = () => {
      count.printed = (count.printed ?? 0) + 1
    }
  })
  await page.goto(url("report"))
  const input = page
    .frameLocator(frameSelector)
    .getByRole("textbox", { name: "Unsaved input" })
  await expect(input).toBeVisible({ timeout: 30_000 })
  const printed = async () => {
    const frame = await (
      await page.locator(frameSelector).elementHandle()
    )!.contentFrame()
    return {
      page: await frame!.evaluate(
        () => (window as unknown as { printed?: number }).printed ?? 0
      ),
      app: await page.evaluate(
        () => (window as unknown as { printed?: number }).printed ?? 0
      ),
    }
  }

  await page.getByRole("button", { name: "More actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Print PDF", exact: true }).click()
  await expect.poll(printed).toEqual({ page: 1, app: 0 })

  // Ctrl+P prints the page from the app and from inside the page.
  await page.keyboard.press("Control+p")
  await expect.poll(printed).toEqual({ page: 2, app: 0 })
  await input.click()
  await input.press("Control+p")
  await expect.poll(printed).toEqual({ page: 3, app: 0 })
})

test("a picture on an HTML page opens full screen, and on to the page's other pictures", async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto(url("gallery"))
  const frame = page.frameLocator(frameSelector)
  await frame.getByRole("img", { name: "Harbor" }).click({ timeout: 30_000 })
  const harbor = page.getByRole("dialog", { name: "Harbor" })
  await expect(harbor).toBeVisible()
  // The badge, the link and the page's own button are left out.
  await expect(harbor.getByText("1 of 2")).toBeVisible()
  await harbor.getByRole("button", { name: "Next image" }).click()
  await expect(page.getByRole("dialog", { name: "Hills" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()

  // Pictures the page uses for something else keep their click.
  await frame.getByRole("img", { name: "Card" }).click()
  await expect(frame.locator("#status")).toHaveText("Card opened")
  await frame.getByRole("img", { name: "Linked" }).click()
  await expect
    .poll(async () =>
      (await (await page.locator(frameSelector).elementHandle())!.contentFrame())!
        .evaluate(() => location.hash)
    )
    .toBe("#linked")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})
