import { expect, test, type Page } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

function appUrl(path = "/"): string {
  return new URL(path, harness.webUrl).href
}

const cloudDeployment = {
  mode: "cloud",
  capabilities: {
    cloudAccount: true,
    workspaceName: true,
    workspacePath: false,
    workspaceUrl: false,
    editorSettings: true,
    historySettings: true,
    softwareUpdates: false,
    updateChecks: false,
  },
} as const

const cloudConnection = {
  mcpAuthMode: "oauth",
  endpoint: "http://127.0.0.1:7480/mcp",
  remoteMcpUrl: "https://app.worktable.cloud/api/mcp",
  reachable: true,
  authRequired: true,
  mcpTokenRequired: true,
  origin: "https://app.worktable.cloud",
  originSource: "resource",
  originConfigured: true,
} as const

async function mockCloud(page: Page): Promise<void> {
  await page.route("**/api/system/deployment", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(cloudDeployment),
    })
  )
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(cloudConnection),
    })
  )
  await page.route("**/api/system/version", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        current: "1.2.3",
        canUpdate: false,
        hasEmbeddedInstaller: false,
        latest: null,
        updateAvailable: false,
        checkedAt: null,
      }),
    })
  )
}

async function openSettings(page: Page) {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  const settingsButton = page.getByRole("button", {
    name: "Settings",
    exact: true,
  })
  await expect(settingsButton).toBeVisible({ timeout: 30_000 })
  await settingsButton.click()
  return page.getByRole("dialog")
}

test.beforeAll(async () => {
  harness = await startWebHarness("settings-deployment-browser")
})

test.afterAll(async () => {
  await harness?.stop()
})

test("Settings opens and remains navigable while a section is still loading", async ({
  page,
}) => {
  let releaseSection!: () => void
  const sectionReady = new Promise<void>((resolve) => {
    releaseSection = resolve
  })
  await page.route(
    "**/components/settings/sections/general.tsx*",
    async (route) => {
      await sectionReady
      await route.continue()
    }
  )
  try {
    const settings = await openSettings(page)
    await expect(
      settings.getByRole("navigation", { name: "Settings" })
    ).toBeVisible()
    await expect(settings.getByRole("status")).toHaveText("Loading General…")
    await settings.getByRole("button", { name: "Editor", exact: true }).click()
    await expect(
      settings.getByText("Spellcheck", { exact: true })
    ).toBeVisible()
    await settings.getByRole("button", { name: "General", exact: true }).click()
    releaseSection()
    await expect(settings.getByLabel("Name", { exact: true })).toBeVisible()
    await settings.getByRole("button", { name: "Close", exact: true }).click()
    await expect(settings).toBeHidden()
  } finally {
    releaseSection()
  }
})

test("Cloud composes relevant sections and saves human preferences", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 360 })
  const settingsPatches: unknown[] = []
  const workspacePatches: unknown[] = []
  let cachedVersionRequests = 0
  let updateStatusRequests = 0

  await mockCloud(page)
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/api/system/settings" && request.method() === "PUT") {
      settingsPatches.push(request.postDataJSON())
    }
    if (url.pathname === "/api/workspace" && request.method() === "PUT") {
      workspacePatches.push(request.postDataJSON())
    }
    if (
      url.pathname === "/api/system/version" &&
      url.searchParams.has("cached")
    ) {
      cachedVersionRequests += 1
    }
    if (url.pathname === "/api/system/update") updateStatusRequests += 1
  })

  const settings = await openSettings(page)
  await expect(
    settings.getByRole("button", { name: "Account", exact: true })
  ).toBeVisible()
  const about = settings.getByRole("button", { name: "About", exact: true })
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("worktable:open-settings", {
        detail: { section: "system" },
      })
    )
  })
  await expect(about).toBeInViewport()
  await expect(
    settings.getByRole("heading", { name: "About", exact: true }).first()
  ).toBeVisible()
  await expect(settings.getByText("Product", { exact: true })).toBeVisible()
  await expect(
    settings.getByText("Worktable Cloud", { exact: true })
  ).toBeVisible()
  await expect(settings.getByText("v1.2.3", { exact: true })).toBeVisible()
  await expect(
    settings.getByText("https://app.worktable.cloud", { exact: true })
  ).toBeVisible()
  await expect(
    settings.getByText("Worktable Cloud is updated automatically.")
  ).toBeVisible()
  await expect(settings.getByText("Software update")).toHaveCount(0)
  await expect(
    settings.getByText("Check for updates automatically")
  ).toHaveCount(0)
  await expect(
    settings
      .locator('[data-settings-section="system"]')
      .getByText("Worktable folder", { exact: true })
  ).toHaveCount(0)
  await expect(
    settings.getByRole("button", { name: "System", exact: true })
  ).toHaveCount(0)

  await page.setViewportSize({ width: 1280, height: 720 })
  await settings.getByRole("button", { name: "General", exact: true }).click()
  const name = settings.getByLabel("Name", { exact: true })
  await name.fill("Cloud Settings Browser")
  await name.press("Enter")
  await expect
    .poll(() => workspacePatches)
    .toContainEqual({
      name: "Cloud Settings Browser",
    })
  for (const text of [
    "Worktable URL",
    "Worktable folder",
    "WORKTABLE_RESOURCE_URL",
    "worktable setup",
    "Unknown.",
  ]) {
    await expect(settings.getByText(text, { exact: false })).toHaveCount(0)
  }

  await settings.getByRole("button", { name: "Editor", exact: true }).click()
  await settings.locator('[data-slot="switch"]').click()
  await expect
    .poll(() => settingsPatches)
    .toContainEqual({
      editor: { spellcheck: true },
    })

  await settings.getByRole("button", { name: "History", exact: true }).click()
  await settings.getByRole("combobox").click()
  await page.getByRole("option", { name: "Keep last 50 per doc" }).click()
  const confirm = page.getByRole("dialog", { name: "Delete older versions?" })
  await confirm.getByRole("button", { name: "Delete older versions" }).click()
  await expect
    .poll(() => settingsPatches)
    .toContainEqual({
      history: { retention: { mode: "count", maxPerDoc: 50 } },
    })

  expect(cachedVersionRequests).toBe(0)
  expect(updateStatusRequests).toBe(0)
})

test("self-managed Settings retain local controls and normalize Account requests", async ({
  page,
}) => {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("button", { name: "Settings", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("worktable:open-settings", {
        detail: { section: "account" },
      })
    )
  })
  const settings = page.getByRole("dialog")
  await expect(settings.getByRole("heading", { name: "General" })).toBeVisible()
  await expect(
    settings.getByRole("button", { name: "Account", exact: true })
  ).toHaveCount(0)
  await expect(
    settings.getByText("Worktable URL", { exact: true })
  ).toBeVisible()
  await expect(
    settings
      .locator('[data-settings-section="general"]')
      .getByText("Worktable folder", { exact: true })
  ).toBeVisible()

  await settings.getByRole("button", { name: "System", exact: true }).click()
  await expect(
    settings.getByText("Software update", { exact: true })
  ).toBeVisible()
  await expect(
    settings.getByText("Check for updates automatically", { exact: true })
  ).toBeVisible()
})

test("Cloud mobile settings keeps the Account section reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockCloud(page)
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("button", { name: "Settings", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: /^Toggle sidebar/ }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog")
  await settings.getByRole("button", { name: "Account", exact: true }).click()
  await expect(
    settings.getByText("Signed in on this browser", { exact: true })
  ).toBeVisible()
})
