import { expect, test, type Page } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

function appUrl(path = "/"): string {
  return new URL(path, harness.webUrl).href
}

const deployment = {
  mode: "self-managed",
  capabilities: {
    cloudAccount: false,
    workspaceName: true,
    workspacePath: true,
    workspaceUrl: true,
    editorSettings: true,
    historySettings: true,
    softwareUpdates: true,
    updateChecks: true,
  },
} as const

function versionResponse(
  checkStatus: "fresh" | "failed" | "unchecked",
  version: string | null = "9.9.9"
) {
  const now = new Date().toISOString()
  return {
    current: "1.2.3",
    canUpdate: true,
    hasEmbeddedInstaller: true,
    latest: version,
    updateAvailable: version !== null && version !== "1.2.3",
    checkedAt:
      checkStatus === "fresh"
        ? now
        : checkStatus === "unchecked"
          ? null
          : new Date(0).toISOString(),
    lastAttemptAt: now,
    checkTtlRemainingMs: checkStatus === "fresh" ? 6 * 60 * 60_000 : null,
    checkStatus,
  }
}

async function mockDeployment(page: Page): Promise<void> {
  await page.route("**/api/system/deployment", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(deployment),
    })
  )
}

test.beforeAll(async () => {
  harness = await startWebHarness("update-notifications-browser")
})

test.afterAll(async () => {
  await harness?.stop()
})

test("availability decorates Settings without hijacking its destination", async ({
  page,
}) => {
  await mockDeployment(page)
  await page.route("**/api/system/version**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(versionResponse("fresh")),
    })
  )

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 15_000 })
  await expect(page.getByText("Worktable 9.9.9 is available")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Review update" })
  ).toBeVisible()

  await page.getByRole("button", { name: "Settings, update available" }).click()
  const settings = page.getByRole("dialog")
  await expect(settings.getByRole("heading", { name: "General" })).toBeVisible()
  await expect(settings.getByText("Update", { exact: true })).toBeVisible()

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 15_000 })
  await expect(page.getByText("Worktable 9.9.9 is available")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Settings, update available" })
  ).toBeVisible()
})

test("a hidden tab does not repeat a release announced by another tab", async ({
  page,
}) => {
  await page.clock.install()
  await page.addInitScript(() => {
    let visibility: DocumentVisibilityState = "hidden"
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    })
    Object.defineProperty(window, "__setUpdateTestVisibility", {
      value: (next: DocumentVisibilityState) => {
        visibility = next
      },
    })
  })
  await mockDeployment(page)
  await page.route("**/api/system/version**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(versionResponse("fresh")),
    })
  )

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 15_000 })
  await expect(
    page.getByRole("button", { name: "Settings, update available" })
  ).toBeVisible()
  await page.evaluate(() => {
    localStorage.setItem("worktable-update-nudge-seen", "9.9.9")
    ;(
      window as Window & {
        __setUpdateTestVisibility: (state: DocumentVisibilityState) => void
      }
    ).__setUpdateTestVisibility("visible")
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await page.clock.runFor(250)
  await expect(page.getByText("Worktable 9.9.9 is available")).toHaveCount(0)
})

test("a slow System check still announces after the user leaves the section", async ({
  page,
}) => {
  let releaseLiveCheck: (() => void) | undefined
  let noteLiveCheckStarted: (() => void) | undefined
  const liveCheckGate = new Promise<void>((resolve) => {
    releaseLiveCheck = resolve
  })
  const liveCheckStarted = new Promise<void>((resolve) => {
    noteLiveCheckStarted = resolve
  })
  await mockDeployment(page)
  await page.route("**/api/system/version**", async (route) => {
    const cached =
      new URL(route.request().url()).searchParams.get("cached") === "1"
    if (cached) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(versionResponse("unchecked", null)),
      })
    }
    noteLiveCheckStarted?.()
    await liveCheckGate
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(versionResponse("fresh")),
    })
  })

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("worktable:open-settings", {
        detail: { section: "system" },
      })
    )
  })
  const settings = page.getByRole("dialog")
  await liveCheckStarted
  await settings.getByRole("button", { name: "General", exact: true }).click()
  await expect(settings.getByRole("heading", { name: "General" })).toBeVisible()
  releaseLiveCheck?.()

  await expect(page.getByText("Worktable 9.9.9 is available")).toBeVisible()
})

for (const { clockDirection, checkedAtOffset } of [
  { clockDirection: "behind the server", checkedAtOffset: 24 * 60 * 60_000 },
  { clockDirection: "ahead of the server", checkedAtOffset: -24 * 60 * 60_000 },
]) {
  test(`server freshness survives a browser clock ${clockDirection}`, async ({
    page,
  }) => {
    await mockDeployment(page)
    await page.route("**/api/system/version**", (route) => {
      const response = versionResponse("fresh")
      if (new URL(route.request().url()).searchParams.get("cached") !== "1") {
        response.checkedAt = new Date(
          Date.now() + checkedAtOffset
        ).toISOString()
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(response),
      })
    })

    await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
    await expect(page.locator("body")).toHaveClass(/loaded/, {
      timeout: 15_000,
    })
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("worktable:open-settings", {
          detail: { section: "system" },
        })
      )
    })
    const settings = page.getByRole("dialog")
    await expect(
      settings.getByRole("button", { name: "Update to 9.9.9" })
    ).toBeVisible()
  })
}

test("a manual API failure hides a previously confirmed update action", async ({
  page,
}) => {
  let liveGets = 0
  await mockDeployment(page)
  await page.route("**/api/system/version**", (route) => {
    const forced = route.request().method() === "POST"
    if (forced) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Release check unavailable." }),
      })
    }
    const cached =
      new URL(route.request().url()).searchParams.get("cached") === "1"
    const response = versionResponse("fresh")
    if (!cached) {
      liveGets += 1
      if (liveGets === 1) {
        response.checkedAt = new Date(
          Date.now() - 6 * 60 * 60_000 + 6_000
        ).toISOString()
        response.checkTtlRemainingMs = 6_000
      }
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(response),
    })
  })

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("worktable:open-settings", {
        detail: { section: "system" },
      })
    )
  })
  const settings = page.getByRole("dialog")
  await expect(
    settings.getByRole("button", { name: "Update to 9.9.9" })
  ).toBeVisible()

  await settings.getByRole("button", { name: "Check again" }).click()
  await expect(
    settings.getByText("Couldn’t check for updates. Release check unavailable.")
  ).toBeVisible()
  await expect(
    settings.getByRole("button", { name: /Update to|Update now/ })
  ).toHaveCount(0)

  // The scheduled live GET succeeds after the near-expiry first result. It
  // supersedes the failed manual POST and must clear that obsolete error.
  await expect(
    settings.getByRole("button", { name: "Update to 9.9.9" })
  ).toBeVisible({ timeout: 10_000 })
  await expect(
    settings.getByText("Couldn’t check for updates.", { exact: false })
  ).toHaveCount(0)
})

test("an open update panel expires an old release check before offering an update", async ({
  page,
}) => {
  await page.clock.install()
  let liveChecks = 0
  await mockDeployment(page)
  await page.route("**/api/system/version**", (route) => {
    const cached =
      new URL(route.request().url()).searchParams.get("cached") === "1"
    if (cached) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(versionResponse("fresh")),
      })
    }

    liveChecks += 1
    if (liveChecks > 1) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Release check unavailable." }),
      })
    }
    const response = versionResponse("fresh")
    response.checkedAt = new Date(
      Date.now() - 6 * 60 * 60_000 + 6_000
    ).toISOString()
    response.checkTtlRemainingMs = 6_000
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(response),
    })
  })

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("worktable:open-settings", {
        detail: { section: "system" },
      })
    )
  })
  const settings = page.getByRole("dialog")
  await expect(
    settings.getByRole("button", { name: "Update to 9.9.9" })
  ).toBeVisible()

  await page.clock.runFor(6_500)
  await expect(settings.getByRole("button", { name: "Retry" })).toBeVisible({
    timeout: 10_000,
  })
  await expect(
    settings.getByRole("button", { name: /Update to|Update now/ })
  ).toHaveCount(0)
  const checksAfterFailure = liveChecks
  expect(checksAfterFailure).toBeGreaterThanOrEqual(2)
  await page.clock.runFor(500)
  expect(liveChecks).toBe(checksAfterFailure)
})

test("a failed release check offers Retry but never a blind update", async ({
  page,
}) => {
  let forceChecks = 0
  await mockDeployment(page)
  await page.route("**/api/system/version**", (route) => {
    const forced = route.request().method() === "POST"
    if (forced) forceChecks += 1
    if (forced && forceChecks === 1) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Release check unavailable." }),
      })
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        forced ? versionResponse("fresh") : versionResponse("failed", "9.9.8")
      ),
    })
  })

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("worktable:open-settings", {
        detail: { section: "system" },
      })
    )
  })
  const settings = page.getByRole("dialog")
  await expect(
    settings.getByText("Worktable couldn’t confirm", { exact: false })
  ).toBeVisible()
  await expect(settings.getByRole("button", { name: "Retry" })).toBeVisible()
  await expect(
    settings.getByRole("button", { name: /Update to|Update now/ })
  ).toHaveCount(0)

  await settings.getByRole("button", { name: "Retry" }).click()
  await expect(
    settings.getByText("Couldn’t check for updates. Release check unavailable.")
  ).toBeVisible()
  await expect(
    settings.getByRole("button", { name: /Update to|Update now/ })
  ).toHaveCount(0)

  await settings.getByRole("button", { name: "Retry" }).click()
  await expect(
    settings.getByRole("button", { name: "Update to 9.9.9" })
  ).toBeVisible()
  expect(forceChecks).toBe(2)
})

test("a previous update result cannot reload the page before the next update finishes", async ({
  page,
}) => {
  await page.clock.install()
  let updateStarted = false
  let updateCompleted = false
  let updatePostCompleted = false
  let navigations = 0
  let releaseUpdatePost: (() => void) | undefined
  const updatePostGate = new Promise<void>((resolve) => {
    releaseUpdatePost = resolve
  })
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations += 1
  })
  await mockDeployment(page)
  await page.route("**/api/system/version**", (route) => {
    const response = versionResponse("fresh")
    if (updateCompleted) {
      response.current = "9.9.9"
      response.updateAvailable = false
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(response),
    })
  })
  await page.route("**/api/system/update", async (route) => {
    if (route.request().method() === "POST") {
      updateStarted = true
      await updatePostGate
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          state: "running",
          from: "1.2.3",
          to: "9.9.9",
          startedAt: new Date().toISOString(),
        }),
      })
      updatePostCompleted = true
      return
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        updateCompleted
          ? {
              state: "succeeded",
              from: "1.2.3",
              to: "9.9.9",
              finishedAt: new Date().toISOString(),
            }
          : updateStarted
            ? { state: "running", from: "1.2.3", to: "9.9.9" }
            : {
                state: "succeeded",
                from: "1.2.2",
                to: "1.2.3",
                finishedAt: new Date().toISOString(),
              }
      ),
    })
  })
  await page.route("**/health", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        service: "worktable",
        version: updateCompleted ? "9.9.9" : "1.2.3",
        uptime: 10,
        desktopConnection: {
          protocolVersion: 1,
          provider: "selfHosted",
        },
      }),
    })
  )

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("worktable:open-settings", {
        detail: { section: "system" },
      })
    )
  })
  const settings = page.getByRole("dialog")
  await expect(
    settings.getByRole("button", { name: "Update to 9.9.9" })
  ).toBeVisible()

  const navigationBeforeUpdate = navigations
  await settings.getByRole("button", { name: "Update to 9.9.9" }).click()
  await expect(
    settings.getByText("Downloading and applying v9.9.9…")
  ).toBeVisible()

  // The old terminal marker used to schedule a reload after 1.5 seconds, even
  // though the new operation had already replaced it with `running`.
  await expect.poll(() => updateStarted).toBe(true)
  await page.clock.runFor(1_750)
  expect(navigations).toBe(navigationBeforeUpdate)
  await expect(settings).toBeVisible()

  releaseUpdatePost?.()
  await expect.poll(() => updatePostCompleted).toBe(true)
  updateCompleted = true
  // Cross the two-second health polling boundary and let the success effect
  // schedule its one-shot reload.
  await page.clock.runFor(300)
  await expect(
    settings.getByText("Updated. Reloading Worktable…")
  ).toBeVisible()
  await page.clock.runFor(1_750)
  await expect.poll(() => navigations).toBe(navigationBeforeUpdate + 1)
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 15_000 })

  // A terminal marker from the completed operation must not trigger another
  // reload in the fresh page session.
  await page.clock.runFor(1_750)
  expect(navigations).toBe(navigationBeforeUpdate + 1)
  await expect(page.getByRole("dialog")).toHaveCount(0)
})
