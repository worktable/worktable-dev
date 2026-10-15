import { expect, test } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("organize", { storageVersion: 2 })
})
test.afterAll(async () => {
  await harness?.stop()
})

test("folder creation keeps Docs, drawings, and HTML docs in the chosen folder", async ({
  page,
}, testInfo) => {
  const endpoint = `${harness.apiUrl}/api/spaces/folder-creation`
  expect(
    (
      await page.request.post(`${harness.apiUrl}/api/spaces`, {
        data: { name: "Folder creation", id: "folder-creation" },
      })
    ).ok()
  ).toBe(true)
  expect(
    (
      await page.request.post(`${endpoint}/docs`, {
        data: { title: "Plans/Nested/Brief", content: [] },
      })
    ).ok()
  ).toBe(true)
  // The parent is both an HTML doc and a folder; its children use the same
  // creation menu as an ordinary folder.
  expect(
    (
      await page.request.post(`${endpoint}/widgets`, {
        data: { id: "plans", name: "Plans", html: "<p>Existing plan</p>" },
      })
    ).ok()
  ).toBe(true)
  // Portable content may retain mixed-case paths. Automatic drawing names
  // share their case-insensitive namespace with every document format.
  await writeFile(
    harness.workspacePath("spaces/folder-creation/docs/plans/nested/Sketch.md"),
    "# Existing sketch\n"
  )
  await page.goto(
    `${harness.webUrl}/spaces/folder-creation/documents/plans/nested/brief`
  )
  const nestedNew = page.getByRole("button", {
    name: "New in Nested",
    exact: true,
  })
  await nestedNew.click()
  for (const name of ["Doc", "Drawing", "HTML Doc"]) {
    await expect(
      page.getByRole("menuitem", { name, exact: true })
    ).toBeVisible()
  }
  await expect(
    page.getByRole("menuitem", { name: "Record Collection" })
  ).toHaveCount(0)
  await page
    .getByRole("menuitemcheckbox", { name: "Start as Temporary" })
    .click()
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Start as Temporary" })
  ).toHaveAttribute("aria-checked", "false")
  await page.screenshot({
    path: testInfo.outputPath("folder-menu-desktop.png"),
  })
  await page.getByRole("menuitem", { name: "Doc", exact: true }).click()
  await expect(page).toHaveURL(/documents\/plans\/nested\/untitled$/)

  await nestedNew.click()
  await page.getByRole("menuitem", { name: "Drawing", exact: true }).click()
  await page.getByLabel("Name", { exact: true }).fill("Sketch")
  await page.getByRole("button", { name: "Create drawing" }).click()
  await expect(page).toHaveURL(/documents\/plans\/nested\/sketch-2$/)
  await expect(page.getByLabel("Drawing canvas")).toBeVisible()

  await page.getByRole("button", { name: "New in Plans", exact: true }).click()
  await page.getByRole("menuitem", { name: "HTML Doc", exact: true }).click()
  await page.getByLabel("HTML doc name").fill("Status")
  const widgetRoute = "**/api/spaces/folder-creation/widgets"
  await page.route(widgetRoute, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Temporarily unavailable" },
    })
  )
  await page.getByRole("button", { name: "Create HTML doc" }).click()
  await expect(
    page.getByText("Failed to create HTML doc shell", { exact: true })
  ).toBeVisible()
  await expect(page.getByLabel("HTML doc name")).toHaveValue("Status")
  await page.unroute(widgetRoute)
  await page.getByRole("button", { name: "Create HTML doc" }).click()
  await expect(page).toHaveURL(/documents\/plans\/status$/)
  await expect(
    page
      .frameLocator("iframe[data-worktable-widget-frame]")
      .getByRole("heading", { name: "Status", exact: true })
  ).toBeVisible()

  const catalog = await page.request.get(`${endpoint}/documents`)
  const { documents } = await catalog.json()
  for (const path of [
    "plans/nested/untitled",
    "plans/nested/sketch-2",
    "plans/status",
  ]) {
    expect(
      documents.find((document: { path: string }) => document.path === path)
    ).toMatchObject({ lifetime: "durable" })
  }
  expect(
    documents.find(
      (document: { path: string }) => document.path === "plans/nested/Sketch"
    )
  ).toMatchObject({ format: { id: "worktable.markdown" } })
  await page.reload()
  await expect(
    page.getByRole("button", { name: "New in Plans", exact: true })
  ).toBeVisible()
  const spaceRow = page
    .getByRole("button", { name: "Collapse Folder creation", exact: true })
    .locator("../..")
  await spaceRow.getByRole("button", { name: "New", exact: true }).click()
  await expect(
    page.getByRole("menuitem", { name: "Record Collection" })
  ).toBeVisible()
  await page.keyboard.press("Escape")

  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole("button", { name: "Toggle sidebar", exact: true })
    .click()
  const folderNew = page.getByRole("button", {
    name: "New in Plans",
    exact: true,
  })
  await expect(folderNew.locator("..")).toHaveCSS("opacity", "1")
  await folderNew.click()
  await expect(
    page.getByRole("menuitem", { name: "Drawing", exact: true })
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("folder-menu-mobile.png") })
  // The harness is shared with the Home journey below; leave its recent and
  // temporary lists free of this journey's documents.
  expect((await page.request.delete(endpoint)).ok()).toBe(true)
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

  // A document opens straight from Home: its Space's overview, titled with
  // the Space's name, never mounts on the way.
  await page.evaluate(() => {
    const flags = window as unknown as { overviewMounted?: boolean }
    flags.overviewMounted = false
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          const headings = [
            ...(node.matches("h1") ? [node] : []),
            ...node.querySelectorAll("h1"),
          ]
          if (headings.some((h1) => h1.textContent?.trim() === "Organize")) {
            flags.overviewMounted = true
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await recent.getByRole("link", { name: /^Untitled/ }).click()
  await expect(page).toHaveURL(/\/spaces\/organize\/documents\/untitled$/)
  await expect(
    page.getByRole("button", { name: /^Temporary\. Archives / })
  ).toHaveCount(0)
  await expect(
    page
      .getByRole("navigation", { name: "Active documents" })
      .getByRole("link", { name: "Untitled" })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "More actions" })).toBeVisible()
  expect(
    await page.evaluate(
      () => (window as unknown as { overviewMounted?: boolean }).overviewMounted
    )
  ).toBe(false)

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

  // Opening a Space shows its real page while its details load: the title
  // and Activity column stay in place, and the pins fill in where they sit.
  await page.goto(`${harness.webUrl}/`)
  await expect(page.getByRole("region", { name: "Recent" })).toBeVisible()
  let releaseDetails!: () => void
  const detailsHeld = new Promise<void>((resolve) => {
    releaseDetails = resolve
  })
  await page.route(/\/api\/spaces\/organize(\?.*)?$/, async (route) => {
    await detailsHeld
    await route.continue()
  })
  await page
    .getByRole("button", { name: /^(Expand|Collapse) Organize$/ })
    .locator("../..")
    .getByRole("link", { name: "Organize", exact: true })
    .click()
  await expect(page).toHaveURL(/\/spaces\/organize$/)
  const title = page.getByRole("heading", { level: 1, name: "Organize" })
  const activity = page.getByRole("region", { name: "Activity" })
  await expect(title).toBeVisible()
  await expect(activity).toBeVisible()
  const titleBox = await title.boundingBox()
  const activityBox = await activity.boundingBox()
  expect(titleBox).not.toBeNull()
  expect(activityBox).not.toBeNull()
  await expect(
    page
      .getByRole("region", { name: "Pinned" })
      .getByRole("link", { name: "Untitled" })
  ).toHaveCount(0)
  releaseDetails()
  await expect(
    page
      .getByRole("region", { name: "Pinned" })
      .getByRole("link", { name: "Untitled" })
  ).toBeVisible()
  // Positions only: the Activity list may grow as its own entries load.
  const position = (box: { x: number; y: number } | null) =>
    box && { x: box.x, y: box.y }
  expect(position(await title.boundingBox())).toEqual(position(titleBox))
  expect(position(await activity.boundingBox())).toEqual(position(activityBox))
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
