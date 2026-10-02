import { expect, test, type Page } from "@playwright/test"
import { emptyQuickdrawDocument } from "@worktable/types"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("drawing-input")
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
  // The renderer can mount after its container during a route handoff. Wait
  // for the actual input surface, as a user must, before dispatching a stroke.
  await page
    .getByLabel("Drawing canvas")
    .locator("canvas.qd-canvas")
    .evaluate(
      (canvas, input) => {
        canvas.dispatchEvent(
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
  // A failed optional font must not block opening or the existing save journey.
  await page.route("https://api.fontshare.com/**", (route) => route.abort())
  await page.route("**/worktable-preview/fonts/**", (route) => route.abort())
  const space = await request.post(`${harness.apiUrl}/api/spaces`, {
    data: { name: "Drawing input", id: "drawing-input" },
  })
  expect(space.ok()).toBe(true)
  await page.goto(`${harness.webUrl}/spaces/drawing-input`)
  await page
    .getByRole("button", { name: /^(Expand|Collapse) Drawing input$/ })
    .locator("../..")
    .getByRole("button", { name: "New", exact: true })
    .click()
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
  await expect(page.getByRole("status")).toHaveText("Saved", {
    timeout: 30_000,
  })
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
  // The address updates before the retained page hands off to the destination.
  // Wait for the renamed editor's own source read before observing its Saved
  // state or installing the slow-read interception used by the next scenario.
  const renamedSource = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith("/documents/editable-source?path=drawings%2Frenamed") &&
      response.status() === 200
  )
  releaseSave()
  holdSave = null
  await expect(page).toHaveURL(/documents\/drawings\/renamed$/, {
    timeout: 30_000,
  })
  await renamedSource
  await expect(page.getByRole("status")).toHaveText("Saved", {
    timeout: 30_000,
  })
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
  await expect(page.getByRole("status")).toHaveText("Saved", {
    timeout: 30_000,
  })
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
  await expect(page.getByRole("status")).toHaveText("Saved", {
    timeout: 30_000,
  })
  expect(await drafts()).toHaveLength(0)
})

// The editor must follow agent saves while idle, preserving the reader's view,
// and retain local ink when an external save races a gesture.
test("agent saves refresh an idle canvas and preserve active local ink", async ({
  page,
  request,
}) => {
  const spaceId = "drawing-agent"
  const path = "drawings/architecture"
  expect(
    (
      await request.post(`${harness.apiUrl}/api/spaces`, {
        data: { name: "Drawing agent", id: spaceId },
      })
    ).ok()
  ).toBe(true)
  const source = emptyQuickdrawDocument("Architecture")
  source.snapshot.document.store.box = {
    id: "box",
    typeName: "shape",
    type: "geo",
    x: 0,
    y: 0,
    rot: 0,
    z: 1,
    props: {
      w: 240,
      h: 120,
      geo: "rectangle",
      color: "blue",
      size: "s",
      fill: "solid",
      dash: "solid",
      label: "API iii WWW",
      font: "sans",
    },
  }
  const endpoint = `${harness.apiUrl}/api/spaces/${spaceId}/documents`
  const created = await request.post(endpoint, {
    data: {
      path,
      source: JSON.stringify(source),
      encoding: "utf8",
      format: { id: "worktable.quickdraw", sourceVersion: 1 },
    },
  })
  expect(created.ok()).toBe(true)
  let revision = (await created.json()).sourceRevision
  const update = async (title: string) => {
    source.title = title
    const result = await request.put(endpoint, {
      data: {
        path,
        source: JSON.stringify(source),
        encoding: "utf8",
        expectedRevision: revision,
      },
    })
    expect(result.ok()).toBe(true)
    revision = (await result.json()).sourceRevision
  }
  // Keep required font responses pending through opening, edits and recovery.
  // The browser must use fallback text rather than freeze the drawing.
  let releaseFonts!: () => void
  const pendingFonts = new Promise<void>((resolve) => {
    releaseFonts = resolve
  })
  const fontRequests = new Set<string>()
  await page.route("https://api.fontshare.com/**", (route) => route.abort())
  await page.route("**/worktable-preview/fonts/**", async (route) => {
    fontRequests.add(route.request().url())
    await pendingFonts
    await route.continue()
  })
  try {
    await page.goto(`${harness.webUrl}/spaces/${spaceId}/documents/${path}`, {
      waitUntil: "domcontentloaded",
    })
    await expect(page.getByRole("status")).toHaveText("Saved", {
      timeout: 30_000,
    })
    const canvas = page.getByLabel("Drawing canvas")
    const ink = canvas.locator("canvas.qd-canvas")
    await expect.poll(() => fontRequests.size).toBeGreaterThan(0)
    // This English-only board must not request the entire script collection.
    expect(fontRequests.size).toBeLessThan(5)
    await canvas.hover({ position: { x: 300, y: 200 } })
    await page.mouse.wheel(80, 60)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const before = await ink.evaluate((element) =>
      (element as HTMLCanvasElement).toDataURL()
    )
    await update("Architecture reviewed")
    await expect(
      page
        .getByRole("banner")
        .getByText("Architecture reviewed", { exact: true })
    ).toBeVisible()
    const after = await ink.evaluate((element) =>
      (element as HTMLCanvasElement).toDataURL()
    )
    expect(after).toBe(before)
    const box = source.snapshot.document.store.box!
    if (box.typeName === "shape" && box.type === "geo")
      box.props.color = "green"
    await update("Architecture approved")
    await expect
      .poll(() =>
        ink.evaluate((element) => (element as HTMLCanvasElement).toDataURL())
      )
      .not.toBe(before)

    const bounds = (await canvas.boundingBox())!
    const x = bounds.x + 180
    const y = bounds.y + 170
    const readSaved = async () => {
      const response = await request.get(
        `${endpoint}/editable-source?path=${encodeURIComponent(path)}`
      )
      const result = await response.json()
      revision = result.sourceRevision
      return JSON.parse(Buffer.from(result.source, "base64").toString())
    }
    // A saved local gesture remains undoable after an unrelated agent edit.
    // Redo also survives a later external refresh; neither rewinds the agent.
    await pointer(page, "pointerdown", "pen", 19, x, y + 50)
    await pointer(page, "pointerup", "pen", 19, x + 60, y + 50)
    await expect(page.getByRole("status")).toHaveText("Saved", {
      timeout: 30_000,
    })
    source.snapshot = (await readSaved()).snapshot
    await update("Architecture with local ink")
    await expect(
      page
        .getByRole("banner")
        .getByText("Architecture with local ink", { exact: true })
    ).toBeVisible()
    await canvas.getByRole("button", { name: /Undo/ }).click()
    await expect(page.getByRole("status")).toHaveText("Saved", {
      timeout: 30_000,
    })
    const undone = await readSaved()
    expect(Object.keys(undone.snapshot.document.store)).toEqual(["box"])
    expect(undone.snapshot.document.store.box.props.color).toBe("green")
    expect(undone.title).toBe("Architecture with local ink")
    source.snapshot = undone.snapshot
    await update("Architecture before redo")
    await expect(
      page
        .getByRole("banner")
        .getByText("Architecture before redo", { exact: true })
    ).toBeVisible()
    await canvas.getByRole("button", { name: /Redo/ }).click()
    await expect(page.getByRole("status")).toHaveText("Saved", {
      timeout: 30_000,
    })
    const redone = await readSaved()
    expect(Object.keys(redone.snapshot.document.store)).toHaveLength(2)
    expect(redone.title).toBe("Architecture before redo")
    await canvas.getByRole("button", { name: /Undo/ }).click()
    await expect(page.getByRole("status")).toHaveText("Saved", {
      timeout: 30_000,
    })
    source.snapshot = (await readSaved()).snapshot

    await pointer(page, "pointerdown", "pen", 20, x, y)
    await pointer(page, "pointermove", "pen", 20, x + 35, y)
    await update("Architecture from agent")
    await pointer(page, "pointerup", "pen", 20, x + 60, y)
    await expect(page.getByRole("alert")).toContainText("changed elsewhere")
    await expect(
      page.getByRole("button", { name: "Save a copy", exact: true })
    ).toBeVisible()
    const saved = await request.get(
      `${endpoint}/editable-source?path=${encodeURIComponent(path)}`
    )
    const persisted = JSON.parse(
      Buffer.from((await saved.json()).source, "base64").toString()
    )
    expect(Object.keys(persisted.snapshot.document.store)).toEqual(["box"])
    // Copy recovers the local stroke without overwriting the agent's document.
    await page.getByRole("button", { name: "Save a copy", exact: true }).click()
    await expect(page).toHaveURL(/architecture-copy-/)
    await expect(page.getByRole("status")).toHaveText("Saved", {
      timeout: 30_000,
    })
    const copyPath = new URL(page.url()).pathname.split("/documents/")[1]!
    const copy = await request.get(
      `${endpoint}/editable-source?path=${encodeURIComponent(copyPath)}`
    )
    const copySource = JSON.parse(
      Buffer.from((await copy.json()).source, "base64").toString()
    )
    expect(Object.keys(copySource.snapshot.document.store)).toHaveLength(2)
    const beforeFont = await ink.evaluate((element) =>
      (element as HTMLCanvasElement).toDataURL()
    )
    releaseFonts()
    await page.evaluate(() => document.fonts.ready)
    await expect
      .poll(() =>
        ink.evaluate((element) => (element as HTMLCanvasElement).toDataURL())
      )
      .not.toBe(beforeFont)
    // Re-measuring text does not create an edit, a save, or an undo entry.
    await expect(page.getByRole("status")).toHaveText("Saved")
    const afterFont = await request.get(
      `${endpoint}/editable-source?path=${encodeURIComponent(copyPath)}`
    )
    expect(
      JSON.parse(
        Buffer.from((await afterFont.json()).source, "base64").toString()
      )
    ).toEqual(copySource)
    expect(fontRequests.size).toBeLessThan(5)
  } finally {
    releaseFonts()
  }
})
