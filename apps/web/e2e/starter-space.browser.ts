import { expect, test } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("starter-space-browser")
  const diagramDirectory = harness.workspacePath("spaces/welcome/docs/diagrams")
  await mkdir(diagramDirectory, { recursive: true })
  await writeFile(
    `${diagramDirectory}/system-map.excalidraw`,
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "worktable-browser-check",
      elements: [],
      appState: {},
      files: {},
    })
  )
})

test.afterAll(async () => {
  await harness?.stop()
})

test("every discovered document opens through the common page", async ({
  page,
}) => {
  await page.goto(new URL("/spaces/welcome", harness.webUrl).href, {
    waitUntil: "domcontentloaded",
  })
  const diagrams = page.getByRole("button", {
    name: "Diagrams",
    exact: true,
  })
  await expect(diagrams).toBeVisible({ timeout: 30_000 })
  await diagrams.click()

  const systemMap = page.getByRole("link", {
    name: "System Map",
    exact: true,
  })
  await expect(systemMap).toHaveAttribute(
    "href",
    "/spaces/welcome/documents/diagrams/system-map"
  )
  await systemMap.click()
  await expect(page).toHaveURL(
    /\/spaces\/welcome\/documents\/diagrams\/system-map$/
  )
  await expect(
    page.getByRole("heading", { name: "Preview unavailable" })
  ).toBeVisible()

  const sourceResponse = page.waitForResponse((response) =>
    response
      .url()
      .includes(
        "/api/spaces/welcome/documents/source?path=diagrams%2Fsystem-map"
      )
  )
  await page.getByRole("button", { name: "Download source" }).click()
  const source = await sourceResponse
  expect(source.status()).toBe(200)
  expect(source.headers()["content-disposition"]).toContain(
    "system-map.excalidraw"
  )

  await page.goto(
    new URL("/spaces/welcome/docs/ways-to-work", harness.webUrl).href,
    { waitUntil: "domcontentloaded" }
  )
  await expect(page).toHaveURL(/\/spaces\/welcome\/documents\/ways-to-work$/)
  await expect(
    page.getByRole("heading", { name: "Ways to Work", exact: true })
  ).toBeVisible({ timeout: 30_000 })

  await page.goto(
    new URL("/spaces/welcome/documents/WAYS-TO-WORK", harness.webUrl).href,
    { waitUntil: "domcontentloaded" }
  )
  await expect(page).toHaveURL(/\/spaces\/welcome\/documents\/ways-to-work$/)

  await page.route("**/api/spaces/welcome/documents/page?*", async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get("path") !== "ways-to-work") {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "This document alias cannot be resolved.",
        code: "CONFLICT",
      }),
    })
  })
  await page.goto(
    new URL("/spaces/welcome/documents/ways-to-work", harness.webUrl).href,
    { waitUntil: "domcontentloaded" }
  )
  await expect(
    page.getByRole("heading", { name: "Document path conflict" })
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByText("This document alias cannot be resolved.")
  ).toBeVisible()
})

test("the starter board renders Records and persists a status change", async ({
  page,
}) => {
  await page.goto(
    new URL("/spaces/welcome/documents/onboarding-board", harness.webUrl).href,
    { waitUntil: "domcontentloaded" }
  )

  const boardFrame = page.locator('iframe[title="Onboarding Board"]')
  await expect(boardFrame).toBeVisible({ timeout: 30_000 })
  const board = page.frameLocator('iframe[title="Onboarding Board"]')
  const cards = board.locator("article.card")
  await expect(cards).toHaveCount(5, { timeout: 10_000 })

  const firstGuideItem = cards.filter({
    hasText: "Explain the building blocks",
  })
  const status = firstGuideItem.getByRole("combobox")
  await expect(status).toHaveValue("Next")

  await status.selectOption("Ready")

  await expect
    .poll(async () => {
      const response = await fetch(
        `${harness.apiUrl}/api/spaces/welcome/records/onboarding-work/purpose-in-one-minute`
      )
      const body = (await response.json()) as {
        record?: { data?: { status?: string } }
      }
      return body.record?.data?.status
    })
    .toBe("Ready")

  await page.reload({ waitUntil: "domcontentloaded" })
  const reloadedCard = page
    .frameLocator('iframe[title="Onboarding Board"]')
    .locator("article.card")
    .filter({ hasText: "Explain the building blocks" })
  await expect(reloadedCard.getByRole("combobox")).toHaveValue("Ready")
})

test("rich-doc block handles remain usable after annotation composer closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto(
    new URL("/spaces/welcome/documents/ways-to-work", harness.webUrl).href,
    { waitUntil: "domcontentloaded" }
  )

  const editor = page.locator(".bn-editor")
  const firstBlock = editor.getByText(
    "Worktable is most useful when the shape of the work matches what you need to do. You do not need every feature for every project.",
    { exact: true }
  )
  const secondBlock = editor.getByRole("heading", {
    name: "Find what works",
    exact: true,
  })
  const thirdBlock = editor.getByRole("heading", {
    name: "How the pieces fit together",
    exact: true,
  })

  await expect(firstBlock).toBeVisible({ timeout: 30_000 })
  const secondBlockId = await secondBlock.evaluate((element) =>
    element.closest("[data-id]")?.getAttribute("data-id")
  )
  const thirdBlockId = await thirdBlock.evaluate((element) =>
    element.closest("[data-id]")?.getAttribute("data-id")
  )
  expect(secondBlockId).toBeTruthy()
  expect(thirdBlockId).toBeTruthy()

  await firstBlock.hover()
  await page.getByRole("button", { name: "Open block menu" }).click()
  await page.getByRole("menuitem", { name: "Annotate" }).click()
  await page.getByRole("button", { name: "Cancel" }).click()

  await secondBlock.hover()
  await page.getByRole("button", { name: "Open block menu" }).click()
  await page.getByRole("menuitem", { name: "Annotate" }).click()
  await page.getByPlaceholder("Write a comment...").fill("Second block note")
  const secondCreate = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/spaces/welcome/annotations")
  )
  await page
    .getByRole("button", { name: "Add Annotation", exact: true })
    .click()
  const secondResponse = await secondCreate
  expect(secondResponse.status()).toBe(200)
  expect(secondResponse.request().postDataJSON()).toMatchObject({
    target: { blockId: secondBlockId },
  })
  await page.getByRole("button", { name: "Close annotations" }).click()

  await thirdBlock.hover()
  await page.getByRole("button", { name: "Open block menu" }).click()
  await page.getByRole("menuitem", { name: "Annotate" }).click()
  await page.getByPlaceholder("Write a comment...").fill("Third block note")
  const thirdCreate = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/spaces/welcome/annotations")
  )
  await page
    .getByRole("button", { name: "Add Annotation", exact: true })
    .click()
  const thirdResponse = await thirdCreate
  expect(thirdResponse.status()).toBe(200)
  expect(thirdResponse.request().postDataJSON()).toMatchObject({
    target: { blockId: thirdBlockId },
  })
})

test("nested HTML docs recover from move conflicts, archive with folders, and remain searchable", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.goto(new URL("/spaces/welcome", harness.webUrl).href, {
    waitUntil: "domcontentloaded",
  })
  await expect(
    page.getByRole("link", { name: "Ways to Work", exact: true })
  ).toBeVisible({ timeout: 30_000 })

  const created = await page.request.post(
    `${harness.apiUrl}/api/spaces/welcome/widgets`,
    {
      data: {
        id: "plans/live-status",
        name: "Live Status",
        html: `<!doctype html><!-- mention <head> here --><head><script>const forgedNavigationToken="forged-navigation-token";const rawNavigationId="raw-navigation-attempt";try{Object.defineProperty(Navigator.prototype,"userActivation",{configurable:true,get:()=>({isActive:true})})}catch{}const originalFunctionCall=Function.prototype.call;Function.prototype.call=function(thisArg,...args){if(thisArg===navigator.userActivation)return true;return Reflect.apply(originalFunctionCall,this,args)};setTimeout(()=>{parent.postMessage({type:"worktable.navigation.handshake",widgetId:"plans/live-status",spaceId:"welcome",navigationToken:forgedNavigationToken},"*");parent.postMessage({type:"worktable.navigation.open-document",id:rawNavigationId,widgetId:"plans/live-status",spaceId:"welcome",path:"plans/move-note",navigationToken:forgedNavigationToken},"*");void worktable.navigation.openDocument("plans/move-note").catch(()=>{});document.querySelector("#automatic-navigation-result").textContent="Automatic navigation attempted"},0)</script></head><body><main><h1>Ready now</h1><p>The heliograph beacon is online.</p><p id="automatic-navigation-result">Checking automatic navigation…</p><button type="button">Open move note</button><button type="button">Open then leave</button></main><script>const buttons=document.querySelectorAll("button");buttons[0].addEventListener("click",()=>{void worktable.navigation.openDocument("plans/move-note")});buttons[1].addEventListener("click",()=>{void worktable.navigation.openDocument("plans/move-note");location.href="/iframe-navigation"})</script></body>`,
      },
    }
  )
  expect(created.status()).toBe(201)
  const nestedDoc = await page.request.put(
    `${harness.apiUrl}/api/spaces/welcome/docs/plans/move-note`,
    {
      data: {
        content: [
          {
            type: "heading",
            props: { level: 1 },
            content: [{ type: "text", text: "Move Note", styles: {} }],
            children: [],
          },
        ],
      },
    }
  )
  expect(nestedDoc.status()).toBe(200)

  const plans = page.getByRole("button", { name: "Plans", exact: true })
  await expect(plans).toBeVisible({ timeout: 10_000 })
  await plans.click()
  const treeLink = page.getByRole("link", {
    name: "Live Status",
    exact: true,
  })
  await expect(treeLink).toBeVisible()
  await treeLink.click()

  await expect(page).toHaveURL(
    /\/spaces\/welcome\/documents\/plans\/live-status$/
  )
  const frame = page.frameLocator('iframe[title="Live Status"]')
  await expect(frame.getByRole("heading", { name: "Ready now" })).toBeVisible({
    timeout: 30_000,
  })
  await expect(frame.getByText("Automatic navigation attempted")).toBeVisible()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(page).toHaveURL(
    /\/spaces\/welcome\/documents\/plans\/live-status$/
  )

  let releaseFrameResolution = () => {}
  const frameResolutionHeld = new Promise<void>((resolve) => {
    releaseFrameResolution = resolve
  })
  let releaseFrameNavigation = () => {}
  const frameNavigationHeld = new Promise<void>((resolve) => {
    releaseFrameNavigation = resolve
  })
  await page.route(
    "**/api/spaces/welcome/documents/resolve?*",
    async (route) => {
      await frameResolutionHeld
      await route.continue()
    }
  )
  await page.route("**/iframe-navigation", async (route) => {
    await frameNavigationHeld
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><h1>Replacement frame</h1>",
    })
  })
  const frameResolution = page.waitForResponse((response) =>
    response.url().includes("/api/spaces/welcome/documents/resolve?")
  )
  const frameResolutionStarted = page.waitForRequest((request) =>
    request.url().includes("/api/spaces/welcome/documents/resolve?")
  )
  const frameNavigationStarted = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/iframe-navigation"
  )
  await frame.getByRole("button", { name: "Open then leave" }).click()
  await Promise.all([frameResolutionStarted, frameNavigationStarted])
  releaseFrameResolution()
  expect((await frameResolution).status()).toBe(200)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(page).toHaveURL(
    /\/spaces\/welcome\/documents\/plans\/live-status$/
  )
  releaseFrameNavigation()
  await expect(
    frame.getByRole("heading", { name: "Replacement frame" })
  ).toBeVisible()
  await page.unroute("**/iframe-navigation")
  await page.unroute("**/api/spaces/welcome/documents/resolve?*")
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(frame.getByRole("heading", { name: "Ready now" })).toBeVisible({
    timeout: 30_000,
  })

  let releaseResolution = () => {}
  const resolutionHeld = new Promise<void>((resolve) => {
    releaseResolution = resolve
  })
  await page.route(
    "**/api/spaces/welcome/documents/resolve?*",
    async (route) => {
      await resolutionHeld
      await route.continue()
    }
  )
  const delayedResolution = page.waitForResponse((response) =>
    response.url().includes("/api/spaces/welcome/documents/resolve?")
  )
  const resolutionStarted = page.waitForRequest((request) =>
    request.url().includes("/api/spaces/welcome/documents/resolve?")
  )
  await frame.getByRole("button", { name: "Open move note" }).click()
  await resolutionStarted
  await page.getByRole("link", { name: "Ways to Work", exact: true }).click()
  await expect(page).toHaveURL(/\/spaces\/welcome\/documents\/ways-to-work$/)
  releaseResolution()
  expect((await delayedResolution).status()).toBe(200)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(page).toHaveURL(/\/spaces\/welcome\/documents\/ways-to-work$/)
  await page.unroute("**/api/spaces/welcome/documents/resolve?*")
  await treeLink.click()
  await expect(page).toHaveURL(
    /\/spaces\/welcome\/documents\/plans\/live-status$/
  )
  await expect(frame.getByRole("heading", { name: "Ready now" })).toBeVisible()

  await treeLink.locator("..").getByRole("button").click()
  await page.getByRole("menuitem", { name: "Rename" }).click()
  const renameDialog = page.getByRole("dialog", { name: "Rename Doc" })
  const pathInput = renameDialog.getByRole("textbox", { name: "New path" })
  await pathInput.fill("onboarding-board")
  await renameDialog.getByRole("button", { name: "Rename" }).click()
  await expect(
    page.getByText("Failed to rename HTML doc", { exact: true })
  ).toBeVisible()
  await expect(renameDialog).toBeVisible()
  await expect(pathInput).toHaveValue("onboarding-board")

  await pathInput.fill("plans/live-status-renamed")
  await renameDialog.getByRole("button", { name: "Rename" }).click()
  await expect(renameDialog).toBeHidden()
  await expect(page).toHaveURL(
    /\/spaces\/welcome\/documents\/plans\/live-status-renamed$/
  )
  await expect(frame.getByRole("heading", { name: "Ready now" })).toBeVisible()

  let racePage = await page.context().newPage()
  await racePage.routeWebSocket(/\/ws(?:\?|$)/, (socket) => socket.close())
  await racePage.goto(
    new URL("/spaces/welcome/documents/ways-to-work", harness.webUrl).href,
    { waitUntil: "domcontentloaded" }
  )
  await expect(
    racePage.getByRole("link", { name: "Ways to Work", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await racePage.getByRole("button", { name: "Plans", exact: true }).click()
  await expect(
    racePage.getByRole("link", { name: "Live Status", exact: true })
  ).toBeVisible()

  await racePage.getByRole("link", { name: "Live Status", exact: true }).click()
  await expect(racePage).toHaveURL(
    /\/spaces\/welcome\/documents\/plans\/live-status-renamed$/
  )
  await expect(
    racePage
      .frameLocator('iframe[title="Live Status"]')
      .getByRole("heading", { name: "Ready now" })
  ).toBeVisible()
  await racePage
    .getByRole("link", { name: "Ways to Work", exact: true })
    .click()
  await expect(racePage).toHaveURL(
    /\/spaces\/welcome\/documents\/ways-to-work$/
  )
  await expect(
    racePage.getByRole("link", { name: "Live Status", exact: true })
  ).toBeVisible()

  const racedPath = "**/api/spaces/welcome/documents/page?*"
  let movedDuringRead = false
  let releaseMovedRead!: () => void
  const movedReadReleased = new Promise<void>((resolve) => {
    releaseMovedRead = resolve
  })
  await racePage.route(racedPath, async (route) => {
    const url = new URL(route.request().url())
    if (
      route.request().method() !== "GET" ||
      url.searchParams.get("path") !== "plans/live-status-renamed" ||
      movedDuringRead
    ) {
      await route.continue()
      return
    }
    const successfulOldRead = await route.fetch()
    expect(successfulOldRead.status()).toBe(200)
    movedDuringRead = true
    const racingMove = await racePage.request.post(
      `${harness.apiUrl}/api/spaces/welcome/widgets/plans/live-status-renamed/move`,
      { data: { newPath: "plans/live-status-final" } }
    )
    expect(racingMove.status()).toBe(200)
    await route.fulfill({ response: successfulOldRead })
    releaseMovedRead()
  })
  await racePage
    .getByRole("link", { name: "Live Status", exact: true })
    .evaluate((element) => (element as HTMLElement).click())
  // The injected move is fixture setup. Start the UI assertion only after the
  // held old response has been released, not while our own API call is running.
  await movedReadReleased
  await expect(racePage).toHaveURL(
    /\/spaces\/welcome\/documents\/plans\/live-status-final$/
  )
  await expect(racePage.getByText("HTML doc not found.")).toBeHidden()
  await expect(
    racePage
      .frameLocator('iframe[title="Live Status"]')
      .getByRole("heading", { name: "Ready now" })
  ).toBeVisible()
  expect(movedDuringRead).toBe(true)
  await racePage.unroute(racedPath)

  const moveNoteLink = racePage.getByRole("link", {
    name: "Move Note",
    exact: true,
  })
  await moveNoteLink.click()
  await expect(racePage).toHaveURL(
    /\/spaces\/welcome\/documents\/plans\/move-note$/
  )
  await expect(
    racePage.getByRole("heading", { name: "Move Note", exact: true })
  ).toBeVisible()
  await racePage
    .getByRole("link", { name: "Ways to Work", exact: true })
    .click()
  await expect(racePage).toHaveURL(
    /\/spaces\/welcome\/documents\/ways-to-work$/
  )

  let docMovedDuringRead = false
  let releaseMovedDocRead!: () => void
  const movedDocReadReleased = new Promise<void>((resolve) => {
    releaseMovedDocRead = resolve
  })
  await racePage.route(racedPath, async (route) => {
    const url = new URL(route.request().url())
    if (
      route.request().method() !== "GET" ||
      url.searchParams.get("path") !== "plans/move-note" ||
      docMovedDuringRead
    ) {
      await route.continue()
      return
    }
    const successfulOldRead = await route.fetch()
    expect(successfulOldRead.status()).toBe(200)
    docMovedDuringRead = true
    const racingMove = await racePage.request.post(
      `${harness.apiUrl}/api/spaces/welcome/docs/plans/move-note/rename`,
      { data: { newPath: "plans/move-note-final", scope: "document" } }
    )
    expect(racingMove.status()).toBe(200)
    await route.fulfill({ response: successfulOldRead })
    releaseMovedDocRead()
  })
  await moveNoteLink.evaluate((element) => (element as HTMLElement).click())
  await movedDocReadReleased
  await expect(racePage).toHaveURL(
    /\/spaces\/welcome\/documents\/plans\/move-note-final$/
  )
  await expect(
    racePage.getByRole("heading", { name: "Move Note", exact: true })
  ).toBeVisible()
  expect(docMovedDuringRead).toBe(true)
  await racePage.unroute(racedPath)

  // The stale-read scenario deliberately disables broadcasts. Folder/archive
  // interactions below use an ordinary connected tab, as a user would.
  await racePage.close()
  racePage = await page.context().newPage()

  const promoted = await racePage.request.post(
    `${harness.apiUrl}/api/spaces/welcome/widgets/plans/live-status-final/move`,
    { data: { newPath: "plans" } }
  )
  expect(promoted.status()).toBe(200)
  await racePage.goto(
    new URL("/spaces/welcome/documents/plans", harness.webUrl).href,
    { waitUntil: "domcontentloaded" }
  )
  const dualRoleLink = racePage.getByRole("link", {
    name: "Live Status",
    exact: true,
  })
  await expect(dualRoleLink).toBeVisible({ timeout: 30_000 })
  await racePage
    .getByRole("button", { name: "Actions for Live Status" })
    .click()
  await racePage.getByRole("menuitem", { name: "Rename folder" }).click()
  const folderDialog = racePage.getByRole("dialog", {
    name: "Rename Folder",
  })
  await folderDialog.getByRole("textbox", { name: "New name" }).fill("roadmaps")
  const folderMove = racePage.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/spaces/welcome/documents/move-folder")
  )
  const movedFolderPage = racePage.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      response.request().method() === "GET" &&
      url.pathname === "/api/spaces/welcome/documents/page" &&
      url.searchParams.get("path") === "roadmaps"
    )
  })
  await folderDialog.getByRole("button", { name: "Rename" }).click()
  expect((await folderMove).status()).toBe(200)
  expect((await movedFolderPage).status()).toBe(200)
  await expect(folderDialog).toBeHidden()
  await expect(racePage).toHaveURL(/\/spaces\/welcome\/documents\/roadmaps$/)
  await expect(
    racePage
      .frameLocator('iframe[title="Live Status"]')
      .getByRole("heading", { name: "Ready now" })
  ).toBeVisible()
  await expect(
    racePage.getByRole("link", { name: "Move Note", exact: true })
  ).toBeVisible()

  const activeDocuments = racePage.getByRole("navigation", {
    name: "Active documents",
    exact: true,
  })
  await activeDocuments
    .getByRole("button", { name: "Actions for Live Status" })
    .click()
  const liveStatusMenu = racePage.getByRole("menu", {
    name: "Actions for Live Status",
  })
  await liveStatusMenu
    .getByRole("menuitem", { name: "Archive HTML doc" })
    .click()
  const archivedHtmlNotice = racePage.getByText(/This HTML doc is archived/)
  await expect(archivedHtmlNotice).toBeVisible()

  const archivedDocuments = racePage.getByRole("navigation", {
    name: "Archived documents",
    exact: true,
  })
  await expect(
    archivedDocuments.getByRole("link", {
      name: "Live Status",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    activeDocuments.getByRole("link", { name: "Move Note", exact: true })
  ).toBeVisible()
  await expect(
    activeDocuments.getByRole("link", { name: "Live Status", exact: true })
  ).toHaveCount(0)
  await archivedDocuments
    .getByRole("button", { name: "Actions for Live Status" })
    .click()
  await liveStatusMenu
    .getByRole("menuitem", { name: "Restore HTML doc" })
    .click()
  await expect(archivedHtmlNotice).toBeHidden()
  await expect(
    activeDocuments.getByRole("link", { name: "Live Status", exact: true })
  ).toBeVisible()
  await expect(
    archivedDocuments.getByRole("link", {
      name: "Live Status",
      exact: true,
    })
  ).toHaveCount(0)

  await activeDocuments
    .getByRole("button", { name: "Actions for Live Status" })
    .click()
  await liveStatusMenu.getByRole("menuitem", { name: "Archive folder" }).click()
  await expect(archivedHtmlNotice).toBeVisible()
  await expect(
    archivedDocuments.getByRole("link", {
      name: "Live Status",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    archivedDocuments.getByRole("link", { name: "Move Note", exact: true })
  ).toBeVisible()
  await expect(
    activeDocuments.getByRole("link", { name: "Live Status", exact: true })
  ).toHaveCount(0)
  await expect(
    activeDocuments.getByRole("link", { name: "Move Note", exact: true })
  ).toHaveCount(0)

  await archivedDocuments
    .getByRole("button", { name: "Actions for Live Status" })
    .click()
  await liveStatusMenu.getByRole("menuitem", { name: "Restore folder" }).click()
  await expect(archivedHtmlNotice).toBeHidden()
  await expect(
    activeDocuments.getByRole("link", { name: "Live Status", exact: true })
  ).toBeVisible()
  await expect(
    activeDocuments.getByRole("link", { name: "Move Note", exact: true })
  ).toBeVisible()
  await expect(
    archivedDocuments.getByRole("link", {
      name: "Live Status",
      exact: true,
    })
  ).toHaveCount(0)
  await expect(
    archivedDocuments.getByRole("link", { name: "Move Note", exact: true })
  ).toHaveCount(0)
  await racePage.close()

  await page.getByRole("link", { name: "Ways to Work", exact: true }).click()
  await expect(page).toHaveURL(/\/spaces\/welcome\/documents\/ways-to-work$/)

  await page
    .getByRole("textbox", { name: "Search workspace" })
    .fill("heliograph")
  const searchResult = page.getByRole("link", {
    name: /Live Status/i,
  })
  await expect(searchResult).toBeVisible()
  await searchResult.click()

  await expect(page).toHaveURL(/\/spaces\/welcome\/documents\/roadmaps$/)
  await expect(
    frame.getByText("The heliograph beacon is online.")
  ).toBeVisible()
  const popupPromise = page.waitForEvent("popup")
  await page.getByRole("button", { name: "More actions" }).click()
  await page.getByRole("menuitem", { name: "Open in new tab" }).click()
  const popup = await popupPromise
  await expect(popup).toHaveURL(/\/spaces\/welcome\/documents\/roadmaps$/)
  const popupFrame = popup.frameLocator('iframe[title="Live Status"]')
  await expect(
    popupFrame.getByRole("heading", { name: "Ready now" })
  ).toBeVisible({ timeout: 30_000 })
  await popupFrame.getByRole("button", { name: "Open move note" }).click()
  await expect(popup).toHaveURL(
    /\/spaces\/welcome\/documents\/roadmaps\/move-note-final$/
  )
  await expect(popup.getByRole("heading", { name: "Move Note" })).toBeVisible()
  await popup.close()
})

test("HTML documents become readable from the runtime ready signal", async ({
  page,
}) => {
  // Disable only the parent's iframe load fallback. The real sandboxed runtime
  // must reveal the document through its source- and token-checked ready message.
  await page.addInitScript(() => {
    if (window !== window.top) return
    document.addEventListener(
      "load",
      (event) => {
        if (
          event.target instanceof HTMLIFrameElement &&
          event.target.hasAttribute("data-worktable-widget-frame")
        ) {
          document.documentElement.dataset.frameLoadIntercepted = "true"
          event.stopImmediatePropagation()
        }
      },
      true
    )
  })
  const created = await page.request.post(
    `${harness.apiUrl}/api/spaces/welcome/widgets`,
    {
      data: {
        id: "runtime-ready",
        name: "Runtime ready",
        html: "<!doctype html><body><h1>Readable parsed markup</h1></body>",
      },
    }
  )
  expect(created.ok(), await created.text()).toBe(true)
  await page.goto(
    new URL("/spaces/welcome/documents/runtime-ready", harness.webUrl).href,
    { waitUntil: "domcontentloaded" }
  )
  const frame = page.frameLocator("iframe[data-worktable-widget-frame]")
  await expect(
    frame.getByRole("heading", { name: "Readable parsed markup" })
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.locator("html")).toHaveAttribute(
    "data-frame-load-intercepted",
    "true"
  )
  await expect(
    page.getByRole("status", { name: "Opening document" })
  ).toBeHidden()
})
