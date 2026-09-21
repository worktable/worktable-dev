import { expect, test, type Page } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("drawing-input", { storageVersion: 2 })
})
test.afterAll(async () => {
  await harness?.stop()
})

async function pointer(
  page: Page,
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerType: "pen" | "touch",
  pointerId: number,
  x: number,
  y: number
) {
  await page.getByLabel("Drawing canvas").evaluate(
    (root, input) => {
      root.querySelector("canvas")!.dispatchEvent(
        new PointerEvent(input.type, {
          ...input,
          bubbles: true,
          cancelable: true,
          clientX: input.x,
          clientY: input.y,
          button: 0,
          buttons: input.type === "pointerup" ? 0 : 1,
          pressure: input.type === "pointerup" ? 0 : 0.7,
        })
      )
    },
    { type, pointerType, pointerId, x, y }
  )
}

// Owns the pointer-to-persisted-ink boundary: a lifted pen must finish its
// stroke, resting touch contacts must not swallow the next one, and autosave
// must neither move the paper nor run during a held stroke. One harness also
// exercises transient-save recovery through the real document writer.
test("ink stays continuous through pen lifts, resting palms, and autosave recovery", async ({
  page,
  request,
}) => {
  const space = await request.post(`${harness.apiUrl}/api/spaces`, {
    data: { name: "Drawing input", id: "drawing-input" },
  })
  expect(space.ok()).toBe(true)
  await page.goto(`${harness.webUrl}/spaces/drawing-input`)
  await page.getByRole("button", { name: "New", exact: true }).click()
  await page.getByRole("menuitem", { name: "New drawing", exact: true }).click()
  await page.getByLabel("Name", { exact: true }).fill("Scratchpad")
  await page.getByRole("button", { name: "Create drawing" }).click()
  await expect(page).toHaveURL(/documents\/drawings\/scratchpad$/)
  await expect(page.getByRole("status")).toHaveText("Saved", {
    timeout: 30_000,
  })
  const canvas = page.getByLabel("Drawing canvas")
  const initial = (await canvas.boundingBox())!
  await expect(
    page.getByRole("button", { name: "Save", exact: true })
  ).toHaveCount(0)
  await expect(canvas).toHaveCSS("user-select", "none")

  let attempts = 0
  let loseAcknowledgement = false
  let holdSave: Promise<void> | null = null
  await page.route("**/api/spaces/drawing-input/documents", async (route) => {
    if (route.request().method() === "PUT" && ++attempts === 1) {
      await route.fulfill({ status: 503, json: { error: "Temporary failure" } })
    } else if (route.request().method() === "PUT" && loseAcknowledgement) {
      loseAcknowledgement = false
      await route.fetch()
      await route.abort()
    } else {
      if (route.request().method() === "PUT" && holdSave) await holdSave
      await route.continue()
    }
  })
  await page.clock.install()
  const x = initial.x + 180
  const y = initial.y + 160
  await pointer(page, "pointerdown", "pen", 1, x, y)
  await page.clock.fastForward(1200)
  expect(attempts).toBe(0)
  await pointer(page, "pointermove", "pen", 1, x + 20, y)
  await pointer(page, "pointerdown", "touch", 2, x + 80, y + 80)
  await pointer(page, "pointerdown", "touch", 3, x + 100, y + 80)
  await pointer(page, "pointerup", "pen", 1, x + 40, y)
  // Quick strokes may have no pointermove at all: retain their final endpoint.
  await pointer(page, "pointerdown", "pen", 1, x, y + 30)
  await pointer(page, "pointerup", "pen", 1, x + 40, y + 30)
  await pointer(page, "pointerup", "touch", 2, x + 80, y + 80)
  await pointer(page, "pointerup", "touch", 3, x + 100, y + 80)
  await page.clock.fastForward(1000)
  await expect(page.getByRole("alert")).toBeVisible()
  expect(await canvas.boundingBox()).toEqual(initial)
  await page.clock.fastForward(2000)
  await expect(page.getByRole("status")).toHaveText("Saved")
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(await canvas.boundingBox()).toEqual(initial)

  const response = await request.get(
    `${harness.apiUrl}/api/spaces/drawing-input/documents/editable-source?path=drawings/scratchpad`
  )
  const source = JSON.parse(
    Buffer.from((await response.json()).source, "base64").toString()
  )
  const strokes = Object.values(source.snapshot.document.store) as Array<{
    props: { pts: number[]; done: boolean }
  }>
  expect(strokes).toHaveLength(2)
  for (const stroke of strokes) {
    expect(stroke.props.done).toBe(true)
    expect(stroke.props.pts.at(-3)).toBeCloseTo(40)
    expect(stroke.props.pts.filter((_, i) => i % 3 === 1)).toEqual(
      Array(stroke.props.pts.length / 3).fill(0)
    )
  }
  await page.reload()
  await expect(page.getByRole("status")).toHaveText("Saved", {
    timeout: 30_000,
  })
  const actions = () =>
    page.getByRole("button", { name: "Actions for Scratchpad", exact: true })
  await actions().click()
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click()
  await expect(
    page
      .getByRole("navigation", { name: "Archived documents" })
      .getByRole("link", { name: "Scratchpad", exact: true })
  ).toBeVisible()
  await actions().click()
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click()
  await expect(
    page
      .getByRole("navigation", { name: "Active documents" })
      .getByRole("link", { name: "Scratchpad", exact: true })
  ).toBeVisible()
  // A rename must wait for an in-flight save before moving the source.
  let releaseSave!: () => void
  holdSave = new Promise<void>((resolve) => {
    releaseSave = resolve
  })
  await pointer(page, "pointerdown", "pen", 1, x, y + 60)
  await pointer(page, "pointerup", "pen", 1, x + 40, y + 60)
  await page.clock.fastForward(1000)
  await expect(page.getByRole("status")).toHaveText("Saving…")
  await actions().click()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("renamed")
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Rename", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Renaming…", exact: true })
  ).toBeDisabled()
  releaseSave()
  holdSave = null
  await expect(page).toHaveURL(/documents\/drawings\/renamed$/)
  await expect(page.getByRole("status")).toHaveText("Saved")
  const moved = await request.get(
    `${harness.apiUrl}/api/spaces/drawing-input/documents/editable-source?path=drawings/renamed`
  )
  const movedSource = JSON.parse(
    Buffer.from((await moved.json()).source, "base64").toString()
  )
  expect(Object.keys(movedSource.snapshot.document.store)).toHaveLength(3)

  // Discard must cancel autosave even when reading the saved drawing is slow.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  let releaseRead!: () => void
  const holdRead = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const sourceUrl = "**/documents/editable-source?path=drawings%2Frenamed"
  await page.route(sourceUrl, async (route) => {
    await holdRead
    await route.continue()
  })
  await pointer(page, "pointerdown", "pen", 1, x, y + 90)
  await pointer(page, "pointerup", "pen", 1, x + 40, y + 90)
  const beforeDiscard = attempts
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "More actions", exact: true }).click()
  await page.clock.runFor(100)
  const reading = page.waitForRequest(sourceUrl)
  await page
    .getByRole("menuitem", { name: "Reload drawing", exact: true })
    .click()
  await reading
  await page.clock.fastForward(2000)
  expect(attempts).toBe(beforeDiscard)
  await page.clock.resume()
  releaseRead()
  await expect(page.getByRole("status")).toHaveText("Saved")
  await page.unroute(sourceUrl)
  await page.clock.fastForward(2000)
  expect(attempts).toBe(beforeDiscard)

  // The server may commit a stroke while its acknowledgement is lost. Opening
  // that saved source must remove the matching draft, not resurrect it later.
  loseAcknowledgement = true
  await pointer(page, "pointerdown", "pen", 1, x, y + 120)
  await pointer(page, "pointerup", "pen", 1, x + 40, y + 120)
  await page.clock.fastForward(1000)
  await expect(page.getByRole("alert")).toBeVisible()
  const drafts = () =>
    page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("worktable:drawing-draft:")
      )
    )
  expect(await drafts()).toHaveLength(1)
  page.once("dialog", (dialog) => dialog.accept())
  await page.reload()
  await expect(page.getByRole("status")).toHaveText("Saved")
  expect(await drafts()).toHaveLength(0)
})
