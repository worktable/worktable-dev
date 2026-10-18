import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"
import { htmlDocumentApiPath } from "../src/lib/html-document-api-path"

let harness: WebHarness
test.beforeAll(async () => {
  harness = await startWebHarness("version-history", { storageVersion: 2 })
  const created = await fetch(`${harness.apiUrl}/api/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "history", name: "History" }),
  })
  expect(created.ok).toBe(true)
})
test.afterAll(async () => {
  await harness?.stop()
})

for (const kind of ["doc", "html"] as const) {
  test(`${kind} history previews saved versions before restoring on desktop and mobile`, async ({
    page,
  }, testInfo) => {
    const path = `history-${kind}`
    const base = `${harness.apiUrl}/api/spaces/history/${kind === "doc" ? "docs" : "widgets"}`
    const endpoint = `${base}/${path}`
    const blocks = (text: string) => [
      { type: "heading", props: { level: 1 }, content: `History ${kind}` },
      { type: "paragraph", content: text },
    ]
    const created = await page.request.post(base, {
      data:
        kind === "doc"
          ? { title: `History ${kind}`, content: blocks("Original paragraph") }
          : {
              id: path,
              name: "History HTML",
              html: "<p>Original paragraph</p>",
            },
    })
    expect(created.ok()).toBe(true)
    expect(
      (
        await page.request.post(`${endpoint}/versions/checkpoint`, {
          data: { label: "Before review" },
        })
      ).ok()
    ).toBe(true)
    const saved = await page.request.get(`${endpoint}/versions?all=true`)
    const versionId = (await saved.json()).versions.find(
      (entry: { checkpoint?: { label?: string } }) =>
        entry.checkpoint?.label === "Before review"
    ).id as string
    expect(
      (
        await page.request.fetch(endpoint, {
          method: "PUT",
          data:
            kind === "doc"
              ? { content: blocks("Review paragraph") }
              : { name: "History HTML", html: "<p>Review paragraph</p>" },
        })
      ).ok()
    ).toBe(true)
    expect(
      (
        await page.request.post(`${endpoint}/versions/checkpoint`, {
          data: { label: "During review" },
        })
      ).ok()
    ).toBe(true)
    const changed = await page.request.fetch(endpoint, {
      method: "PUT",
      data:
        kind === "doc"
          ? { content: blocks("Latest paragraph") }
          : { name: "History HTML", html: "<p>Latest paragraph</p>" },
    })
    expect(changed.ok()).toBe(true)
    let snapshotReads = 0
    let rawHistoryReads = 0
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (
        request.method() === "GET" &&
        url.pathname.endsWith("/versions") &&
        url.searchParams.get("all") === "true"
      )
        rawHistoryReads += 1
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname.endsWith(`/versions/${versionId}`)
      )
        snapshotReads += 1
    })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${harness.webUrl}/spaces/history/documents/${path}`)
    await page
      .getByRole("button", { name: "More actions", exact: true })
      .click()
    await page
      .getByRole("menuitem", { name: "Version History", exact: true })
      .click()
    const history = page.getByRole("complementary", {
      name: "Version history",
      exact: true,
    })
    await expect(
      history.getByRole("button", { name: /^Current version/ })
    ).toBeVisible()
    await expect(
      history.getByRole("button", { name: "Saved", exact: true })
    ).toHaveAttribute("aria-pressed", "true")
    expect(rawHistoryReads).toBe(0)
    await history.getByRole("button", { name: /^Before review/ }).click()
    const preview = page.getByRole("region", {
      name: "Version preview",
      exact: true,
    })
    const previewText =
      kind === "doc" ? preview : preview.frameLocator("iframe")
    await expect(
      previewText.getByText("Original paragraph", { exact: true })
    ).toBeVisible()
    await expect(preview.locator('[contenteditable="true"]')).toHaveCount(0)
    await expect(history).toBeVisible()
    await expect(
      history.getByRole("button", { name: /^Before review/ })
    ).toHaveAttribute("aria-pressed", "true")
    // Both panes remain visible, and selecting another snapshot replaces its
    // content without changing the live document.
    const current =
      kind === "doc"
        ? page.getByRole("main").getByRole("textbox").first()
        : page.frameLocator('[data-worktable-widget-frame="true"]')
    await expect(
      current.getByText("Latest paragraph", { exact: true })
    ).toBeVisible()
    await history.getByRole("button", { name: /^During review/ }).click()
    await expect(
      previewText.getByText("Review paragraph", { exact: true })
    ).toBeVisible()
    await expect(
      previewText.getByText("Original paragraph", { exact: true })
    ).toBeHidden()
    await expect(
      current.getByText("Latest paragraph", { exact: true })
    ).toBeVisible()
    await history.getByRole("button", { name: /^Current version/ }).click()
    await history.getByRole("button", { name: /^Before review/ }).click()
    await expect(
      previewText.getByText("Original paragraph", { exact: true })
    ).toBeVisible()
    expect(snapshotReads).toBe(1)

    // Saving captures the live document in one click, with no required name.
    await history
      .getByRole("button", { name: "Save version", exact: true })
      .click()
    await expect(page.getByText("Version saved", { exact: true })).toBeVisible()
    await history.getByRole("button", { name: "Saved", exact: true }).click()
    await expect(
      history.getByRole("button", { name: /^Saved version/ })
    ).toBeVisible()
    const afterSave = await page.request.get(`${endpoint}/versions?all=true`)
    const savedId = (await afterSave.json()).versions[0].id as string
    const savedContent = await page.request.get(
      `${endpoint}/versions/${savedId}`
    )
    expect(
      JSON.stringify((await savedContent.json()).version.after.content)
    ).toContain("Latest paragraph")
    await page.screenshot({
      path: testInfo.outputPath(`history-${kind}-desktop.png`),
    })

    await page.setViewportSize({ width: 390, height: 844 })
    const drawer = page.getByRole("dialog", {
      name: "Version history",
      exact: true,
    })
    await drawer.getByRole("button", { name: /^Before review/ }).click()
    await expect(drawer).toBeHidden()
    await expect(
      previewText.getByText("Original paragraph", { exact: true })
    ).toBeVisible()
    await expect(preview.locator('[contenteditable="true"]')).toHaveCount(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBe(390)
    await page.screenshot({
      path: testInfo.outputPath(`history-${kind}-mobile.png`),
    })

    // A failed restore leaves the preview and current document intact; retry
    // uses the same selection and succeeds through the existing restore API.
    const restorePath =
      kind === "doc"
        ? `/api/spaces/history/docs/${path}`
        : htmlDocumentApiPath("history", path)
    const restoreRoute = `**${restorePath}/versions/*/restore`
    await page.route(restoreRoute, (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Document changed" }),
      })
    )
    await preview.getByRole("button", { name: "Restore", exact: true }).click()
    const confirm = page.getByRole("dialog", {
      name: "Restore this version?",
      exact: true,
    })
    await confirm.getByRole("button", { name: "Restore", exact: true }).click()
    await expect(
      page.getByText("Couldn’t restore this version", { exact: true })
    ).toBeVisible()
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.unroute(restoreRoute)
    await preview.getByRole("button", { name: "Restore", exact: true }).click()
    await confirm.getByRole("button", { name: "Restore", exact: true }).click()
    await expect(preview).toBeHidden()
    await expect(
      current.getByText("Original paragraph", { exact: true })
    ).toBeVisible()
    const retained = await page.request.get(`${endpoint}/versions?all=true`)
    expect(
      (await retained.json()).versions.some(
        (entry: { id: string }) => entry.id === savedId
      )
    ).toBe(true)
    // Reopening must keep the restored content rather than the old Yjs cache.
    await page.reload()
    await expect(
      current.getByText("Original paragraph", { exact: true })
    ).toBeVisible()

    // A document can be read-only inside an editable Space. The page's
    // capabilities govern both mutation controls, including snapshot restore.
    await page.route(
      /\/api\/spaces\/history\/documents\/page\?/,
      async (route) => {
        const response = await route.fetch()
        const json = await response.json()
        json.page.capabilities.edit = false
        await route.fulfill({ response, json })
      }
    )
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload()
    await page
      .getByRole("button", { name: "More actions", exact: true })
      .click()
    await page
      .getByRole("menuitem", { name: "Version History", exact: true })
      .click()
    await expect(
      history.getByRole("button", { name: "Save version", exact: true })
    ).toHaveCount(0)
    await history.getByRole("button", { name: /^Before review/ }).click()
    await expect(
      previewText.getByText("Original paragraph", { exact: true })
    ).toBeVisible()
    await expect(
      preview.getByRole("button", { name: "Restore", exact: true })
    ).toHaveCount(0)
  })
}
