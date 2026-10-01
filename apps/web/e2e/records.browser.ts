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
  await tableInput.press("Enter")
  await expect(tableInput).toHaveAttribute("aria-invalid", "true")
  rejectSave = false
  await table.getByRole("button", { name: "Retry", exact: true }).click()
  await expect.poll(async () => (await data()).title).toBe("Retried in the table")
  await expect(page.getByRole("button", { name: "Close record details" })).toBeHidden()
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
