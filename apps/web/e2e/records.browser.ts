import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness
const base = "/api/spaces/inline-editing/records/tasks"
const recordId = "review-editing"

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(harness.apiUrl + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

async function data() {
  return (await request(`${base}/${recordId}`)).record.data
}

test.beforeAll(async () => {
  harness = await startWebHarness("record-editing")
  await request("/api/spaces", "POST", { name: "Inline Editing" })
  await request("/api/spaces/inline-editing/records", "POST", {
    id: "tasks",
    name: "Tasks",
    fields: {
      title: { type: "string", required: true },
      notes: { type: "text" },
      status: { type: "select", values: ["Planned", "Active", "Done"] },
      tags: { type: "multi_select", values: ["Design", "Product"] },
      done: { type: "boolean" },
      due: { type: "date" },
      website: { type: "url" },
      owner: { type: "person" },
      related: { type: "relation", references: "tasks", many: true },
      sources: { type: "document", many: true },
      metadata: { type: "json" },
    },
  })
  await request(base, "POST", { data: { title: "Review editing" } })
  await request(base, "POST", { data: { title: "Follow up" } })
})

test.afterAll(async () => {
  await harness?.stop()
})

test.beforeEach(async () => {
  await request(`${base}/${recordId}`, "PATCH", {
    data: {
      title: "Review editing",
      notes: "First line",
      status: "Planned",
      tags: ["Design"],
      done: false,
      due: "2026-10-15",
      website: "https://example.com",
      owner: null,
      related: [],
      sources: [],
      metadata: { priority: 1 },
    },
  })
})

test("detail text edits save directly, cancel, and retain rejected drafts for retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 1050 })
  await page.goto(
    `${harness.webUrl}/spaces/inline-editing/records/tasks?record=${recordId}`
  )
  const title = page.getByRole("button", { name: "Edit title", exact: true })
  await expect(title).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByRole("button", { name: "Edit", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Edit table cells" })
  ).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Edit title" })).toHaveCount(0)
  await title.focus()
  await page.keyboard.press("Enter")
  const input = page.getByRole("textbox", { name: "Edit title" })
  await input.fill("Discard this")
  await input.press("Escape")
  await expect(title).toBeFocused()
  expect((await data()).title).toBe("Review editing")

  await title.click()
  await input.fill("")
  await input.press("Enter")
  await expect(input).toBeVisible()
  await expect(input).toHaveAttribute("aria-invalid", "true")
  expect((await data()).title).toBe("Review editing")

  let rejectSave = true
  await page.route(`**${base}/${recordId}`, async (route) => {
    if (route.request().method() === "PATCH" && rejectSave) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Save unavailable" }),
      })
    } else await route.continue()
  })
  await input.fill("A better title")
  await input.press("Enter")
  await expect(input).toHaveValue("A better title")
  await expect(input).toHaveAttribute("aria-invalid", "true")
  expect((await data()).title).toBe("Review editing")
  rejectSave = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(title).toHaveText("A better title", { timeout: 30_000 })
  expect((await data()).title).toBe("A better title")

  await page.getByRole("button", { name: "Edit notes", exact: true }).click()
  const notes = page.getByRole("textbox", { name: "Edit notes" })
  await notes.fill("First line\nSecond line")
  await notes.press("Control+Enter")
  await expect(notes).toHaveCount(0)
  expect((await data()).notes).toBe("First line\nSecond line")
  await page.getByRole("button", { name: "Edit due", exact: true }).click()
  await page.getByLabel("Edit due", { exact: true }).fill("2026-10-20")
  await page.getByRole("heading", { name: "Properties", exact: true }).click()
  await expect.poll(async () => (await data()).due).toBe("2026-10-20")
  await expect(
    page.getByRole("link", { name: "Open Website", exact: true })
  ).toHaveAttribute("href", "https://example.com")
  const table = page.getByRole("table")
  await expect(
    table.getByRole("button", { name: "Edit status", exact: true })
  ).toHaveCount(0)
  await page
    .getByRole("button", { name: "Edit table cells", exact: true })
    .click()
  await expect(
    table.getByRole("button", { name: "Edit status", exact: true })
  ).toHaveCount(2)
  await page
    .getByRole("button", { name: "Stop editing table cells", exact: true })
    .click()
  await expect(
    table.getByRole("button", { name: "Edit status", exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Close record details" }).click()
  await page.getByRole("button", { name: "Edit table cells", exact: true }).click()
  const row = table.getByRole("row").filter({ hasText: "A better title" })
  await row.getByRole("button", { name: "Edit title", exact: true }).click()
  const tableInput = table.getByRole("textbox", { name: "Edit title" })
  rejectSave = true
  await tableInput.fill("Retried in the table")
  await request(base, "POST", { data: { title: "Arrived while editing" } })
  await expect(table.getByRole("button", { name: "Edit title", exact: true }).filter({ hasText: "Arrived while editing" })).toBeVisible()
  await expect(tableInput).toHaveValue("Retried in the table")
  await tableInput.press("Enter")
  await expect(tableInput).toHaveAttribute("aria-invalid", "true")
  rejectSave = false
  await table.getByRole("button", { name: "Retry", exact: true }).click()
  await expect.poll(async () => (await data()).title).toBe("Retried in the table")
  await expect(page.getByRole("button", { name: "Close record details" })).toBeHidden()
  await request(`${base}/arrived-while-editing`, "DELETE")
  await page.getByRole("button", { name: "Stop editing table cells", exact: true }).click()
  await page.reload()
  await expect(table.getByRole("cell", { name: "Retried in the table", exact: true })).toBeVisible({ timeout: 30_000 })
})

test("pickers open in one click, cancel drafts, and keep link navigation separate", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 1050 })
  await page.goto(
    `${harness.webUrl}/spaces/inline-editing/records/tasks?record=${recordId}`
  )
  await page.getByRole("button", { name: "Edit status", exact: true }).click()
  await page.getByRole("button", { name: "Active", exact: true }).click()
  await expect.poll(async () => (await data()).status).toBe("Active")
  const tags = page.getByRole("button", { name: "Edit tags", exact: true })
  await tags.click()
  await page.getByRole("button", { name: "Product", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(tags).toBeFocused()
  expect((await data()).tags).toEqual(["Design"])
  await tags.click()
  await page.getByRole("button", { name: "Product", exact: true }).click()
  await page.getByRole("heading", { name: "Properties", exact: true }).click()
  await expect
    .poll(async () => (await data()).tags)
    .toEqual(["Design", "Product"])

  let rejectTags = true
  await page.route(`**${base}/${recordId}`, async (route) => {
    if (
      route.request().method() === "PATCH" &&
      route.request().postDataJSON()?.data?.tags &&
      rejectTags
    ) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Tags unavailable" }),
      })
    } else await route.continue()
  })
  await tags.click()
  await page.getByRole("button", { name: "Design", exact: true }).click()
  await page.getByRole("heading", { name: "Properties", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Retry", exact: true })
  ).toBeVisible()
  expect((await data()).tags).toEqual(["Design", "Product"])
  await expect(
    page.getByRole("button", { name: "Design", exact: true })
  ).toHaveAttribute("aria-pressed", "false")
  rejectTags = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect.poll(async () => (await data()).tags).toEqual(["Product"])

  await page.getByRole("button", { name: "Toggle done", exact: true }).click()
  await expect.poll(async () => (await data()).done).toBe(true)
  await page.getByRole("button", { name: "Clear done", exact: true }).click()
  await expect.poll(async () => (await data()).done).toBeNull()

  await page.getByRole("button", { name: "More fields" }).click()
  await page.getByRole("button", { name: "Edit related", exact: true }).click()
  await page.getByRole("button", { name: "Follow up", exact: true }).click()
  await page.keyboard.press("Escape")
  expect((await data()).related).toEqual([])
  await page.getByRole("button", { name: "Edit related", exact: true }).click()
  await page.getByRole("button", { name: "Follow up", exact: true }).click()
  await page.getByRole("heading", { name: "Properties", exact: true }).click()
  await expect.poll(async () => (await data()).related).toEqual(["follow-up"])
  await page.getByRole("button", { name: "Edit related", exact: true }).click()
  await expect(page.getByPlaceholder("Search tasks…")).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Open Related", exact: true }).click()
  await expect(
    page
      .getByRole("dialog", { name: "Open Related" })
      .getByRole("link", { name: "Follow up", exact: true })
  ).toBeVisible()
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Edit sources", exact: true }).click()
  await page
    .getByPlaceholder("Search documents or enter a path…")
    .fill("notes/source")
  await page.getByRole("button", { name: /Link this path/ }).click()
  await page.keyboard.press("Escape")
  expect((await data()).sources).toEqual([])

  await page.getByRole("button", { name: "Edit metadata", exact: true }).click()
  await page.getByRole("textbox", { name: "Edit JSON value" }).fill("{broken")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(
    page.getByRole("textbox", { name: "Edit JSON value" })
  ).toHaveAttribute("aria-invalid", "true")
  await page
    .getByRole("textbox", { name: "Edit JSON value" })
    .fill('{"priority":2}')
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect
    .poll(async () => (await data()).metadata)
    .toEqual({ priority: 2 })
})

test("the full page and mobile drawer share direct editing while the table keeps its toggle", async ({
  page,
}) => {
  await page.goto(
    `${harness.webUrl}/spaces/inline-editing/records/tasks/${recordId}`
  )
  await page.getByRole("button", { name: "Edit title", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Edit title" })
    .fill("Full page title")
  await page.getByRole("textbox", { name: "Edit title" }).press("Enter")
  await expect(
    page.getByRole("heading", { name: "Full page title", exact: true })
  ).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(
    `${harness.webUrl}/spaces/inline-editing/records/tasks?record=${recordId}`
  )
  const drawer = page.getByRole("dialog", { name: "Record details", exact: true })
  await expect(drawer).toBeVisible()
  await drawer.getByRole("button", { name: "Edit status", exact: true }).click()
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await expect.poll(async () => (await data()).status).toBe("Done")
  await drawer.getByRole("button", { name: "Edit tags", exact: true }).click()
  await page.getByRole("button", { name: "Product", exact: true }).click()
  await page.keyboard.press("Escape")
  await expect(drawer).toBeVisible()
  expect((await data()).tags).toEqual(["Design"])
  await drawer.getByRole("button", { name: "Edit title", exact: true }).click()
  await drawer.getByRole("textbox", { name: "Edit title" }).fill("Mobile title")
  await drawer.getByRole("textbox", { name: "Edit title" }).press("Escape")
  await expect(drawer).toBeVisible()
  await expect(
    drawer.getByRole("heading", { name: "Full page title", exact: true })
  ).toBeVisible()
})

test("table view changes retain the scrolled columns while new rows resolve", async ({ page }) => {
  test.setTimeout(120_000)
  const browsingBase = "/api/spaces/inline-editing/records/browsing"
  await request("/api/spaces/inline-editing/records", "POST", {
    id: "browsing",
    name: "Browsing",
    fields: {
      title: { type: "string", required: true },
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`note${i}`, { type: "text" }])),
      status: { type: "select", values: ["Active", "Done"] },
      score: { type: "number" },
    },
  })
  for (let i = 1; i <= 36; i++) {
    await request(browsingBase, "POST", {
      data: { title: `Browse ${String(i).padStart(2, "0")}`, score: 37 - i, status: i % 2 ? "Active" : "Done" },
    })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${harness.webUrl}/spaces/inline-editing/records/browsing`)
  const table = page.getByRole("table")
  const scroller = table.locator("..")
  await expect(table.locator("tbody tr")).toHaveCount(36, { timeout: 60_000 })
  await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  const left = await scroller.evaluate((element) => element.scrollLeft)
  expect(left).toBeGreaterThan(500)

  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let requested!: () => void
  const started = new Promise<void>((resolve) => { requested = resolve })
  await page.route(`**${browsingBase}/query`, async (route) => {
    requested()
    await pending
    await route.continue()
  })
  const originalFirstRow = await table.locator("tbody tr").first().innerText()
  await table.getByRole("button", { name: "Score", exact: true }).click()
  await started
  try {
    await expect(page.getByRole("status")).toHaveText("Updating records…")
    await expect(table.locator("tbody tr")).toHaveCount(36)
    await expect(table.locator("tbody tr").first()).toHaveText(originalFirstRow, { useInnerText: true })
    expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)
    // Scrolling remains possible while the next view is loading.
    await scroller.evaluate((element) => { element.scrollTop = 300 })
  } finally {
    release()
  }
  await expect(page.getByRole("status")).toBeEmpty()
  await expect(table.locator("tbody tr").first()).toContainText("Browse 01")
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(300)
  await page.unroute(`**${browsingBase}/query`)

  // Background edits and the record inspector must leave the view in place too.
  await request(`${browsingBase}/browse-15`, "PATCH", { data: { status: "Done" } })
  await expect(table.locator('[data-record-id="browse-15"]')).toContainText("Done")
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(300)
  await table.locator('[data-record-id="browse-08"]').getByRole("cell").nth(8).click()
  await expect(page.getByRole("button", { name: "Close record details" })).toBeVisible()
  await page.getByRole("button", { name: "Close record details" }).click()
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(300)

  await page.getByRole("button", { name: "Add filter", exact: true }).click()
  await page.getByLabel("Filter field").click()
  await page.getByRole("option", { name: "Status", exact: true }).click()
  await page.getByRole("button", { name: "Active", exact: true }).click()
  await page.getByRole("button", { name: "Add filter", exact: true }).last().click()
  await expect(table.locator("tbody tr")).toHaveCount(17)
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)
  await page.getByRole("button", { name: "Remove Status filter", exact: true }).click()
  await expect(table.locator("tbody tr")).toHaveCount(36)
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)
})

test("empty and failed table searches preserve columns and recover without stale results", async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${harness.webUrl}/spaces/inline-editing/records/tasks`)
  const table = page.getByRole("table")
  const scroller = table.locator("..")
  await expect(table.locator("tbody tr")).toHaveCount(2, { timeout: 60_000 })
  await scroller.evaluate((element) => { element.scrollLeft = 600 })
  const left = await scroller.evaluate((element) => element.scrollLeft)
  const search = page.getByRole("textbox", { name: "Search records" })
  await search.fill("No such record")
  await expect(page.getByRole("heading", { name: "No matching records" })).toBeVisible()
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)
  await search.fill("")
  await expect(table.locator("tbody tr")).toHaveCount(2)
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)

  let fail = true
  await page.route(`**${base}/query`, async (route) => {
    if (fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) })
    else await route.continue()
  })
  await search.fill("Follow up")
  await expect(page.getByRole("alert")).toContainText("Couldn’t update records")
  await expect(page.getByRole("heading", { name: "No matching records" })).toHaveCount(0)
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)
  fail = false
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(table.locator("tbody tr")).toHaveCount(1)
  await expect(table.locator("tbody tr")).toContainText("Follow up")
  expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(left)

  // Keeping previous results is confined to this collection.
  await request("/api/spaces/inline-editing/records", "POST", {
    id: "other", name: "Other", fields: { title: { type: "string" } },
  })
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/records/other/query", async (route) => {
    await pending
    await route.continue()
  })
  await page.locator('a[href="/spaces/inline-editing/records/other"]').click()
  try {
    await expect(table.getByText("Follow up", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("status")).toHaveText("Updating records…")
  } finally {
    release()
  }
  await expect(page.getByRole("heading", { name: "No records yet" })).toBeVisible()
})
