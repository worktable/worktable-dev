import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness
const directory = {
  signedIn: true,
  cloudOrigin: "https://cloud.example",
  device: "this-mac",
  worktables: [{ id: "hosted_team", name: "Team Worktable" }],
  linked: [],
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const trigger = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /Worktable menu$/ })

const teamRow = (page: import("@playwright/test").Page) =>
  page.getByRole("menuitem", { name: "Team Worktable", exact: true })

test.beforeAll(async () => {
  harness = await startWebHarness("worktable-menu-browser")
})

test.afterAll(async () => {
  await harness?.stop()
})

test("Desktop entries and Settings stay usable and focused while Cloud loads", async ({
  page,
}, info) => {
  const cloud = deferred()
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.setAttribute("data-worktable-desktop", "")
    })
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: async (command: string) =>
            command === "desktop_workspace_worktables"
              ? {
                  schemaVersion: 1,
                  device: "this-mac",
                  worktables: [
                    {
                      id: "ws_client",
                      name: "Client Work",
                      linked: false,
                      current: false,
                    },
                  ],
                }
              : null,
        },
      },
    })
  })
  await page.route("**/api/linked/worktables", async (route) => {
    await cloud.promise
    await route.fulfill({ json: directory })
  })
  try {
    await page.goto(harness.webUrl)
    await trigger(page).click()
    const local = page.getByRole("menuitem", {
      name: "Client Work",
      exact: true,
    })
    await expect(local).toBeVisible()
    await expect(
      page.getByRole("status", { name: "Loading Worktables" })
    ).toBeVisible()
    await local.focus()
    cloud.resolve()
    await expect(teamRow(page)).toBeVisible()
    await expect(local).toBeFocused()
    await expect(
      page.getByRole("status", { name: "Loading Worktables" })
    ).toHaveCount(0)
    await page.screenshot({
      path: info.outputPath("desktop-ready.png"),
      animations: "disabled",
    })
    await page.getByRole("menuitem", { name: "Worktable Settings" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
  } finally {
    cloud.resolve()
  }
})

test("intent warms one request; closing keeps it running and reopening uses the result", async ({
  page,
}, info) => {
  const cloud = deferred()
  let requests = 0
  await page.route("**/api/linked/worktables", async (route) => {
    requests++
    await cloud.promise
    await route.fulfill({ json: directory })
  })
  try {
    await page.goto(harness.webUrl)
    await expect(trigger(page)).toBeVisible()
    expect(requests).toBe(0)
    await trigger(page).hover()
    await expect.poll(() => requests).toBe(1)
    await trigger(page).focus()
    await page.keyboard.press("Enter")
    await expect(
      page.getByRole("status", { name: "Loading Worktables" })
    ).toBeVisible()
    await page.screenshot({
      path: info.outputPath("loading.png"),
      animations: "disabled",
    })
    await page.keyboard.press("Escape")
    const response = page.waitForResponse("**/api/linked/worktables")
    cloud.resolve()
    await response
    await trigger(page).click()
    await expect(teamRow(page)).toHaveAttribute(
      "href",
      "https://cloud.example/t/hosted_team/"
    )
    const settings = page.getByRole("menuitem", { name: "Worktable Settings" })
    await settings.focus()
    await page.keyboard.press("Escape")
    await trigger(page).click()
    await expect(teamRow(page)).toBeVisible()
    expect(requests).toBe(1)
  } finally {
    cloud.resolve()
  }
})

test("initial failure offers Retry, keeps the menu open during recovery, and retries on reopening", async ({
  page,
}, info) => {
  const first = deferred()
  const retry = deferred()
  let requests = 0
  await page.route("**/api/linked/worktables", async (route) => {
    requests++
    if (requests === 1) await first.promise
    if (requests === 2) await retry.promise
    await route.fulfill(
      requests < 3
        ? { status: 503, json: { error: "Cloud unavailable" } }
        : { json: directory }
    )
  })
  try {
    await page.goto(harness.webUrl)
    await trigger(page).click()
    await expect(page.getByRole("menu")).toBeVisible()
    first.resolve()
    await expect(
      page.getByText("Couldn’t load Worktables.", { exact: true })
    ).toBeVisible()
    await page.screenshot({
      path: info.outputPath("failure.png"),
      animations: "disabled",
    })
    await page.getByRole("menuitem", { name: "Retry", exact: true }).click()
    await expect(page.getByRole("menu")).toBeVisible()
    await expect(
      page.getByRole("status", { name: "Loading Worktables" })
    ).toBeVisible()
    retry.resolve()
    await expect(
      page.getByText("Couldn’t load Worktables.", { exact: true })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await trigger(page).click()
    await expect(teamRow(page)).toBeVisible()
    expect(requests).toBe(3)
  } finally {
    first.resolve()
    retry.resolve()
  }
})

test("refresh failure retains entries, but signing out discards the previous account's list", async ({
  page,
}) => {
  let enabled = true
  let user: { id: string; email: string } | null = {
    id: "cloud_owner",
    email: "owner@example.test",
  }
  let requests = 0
  await page.route("**/api/linked/worktables", (route) => {
    requests++
    return route.fulfill(
      requests === 1
        ? { json: directory }
        : { status: 503, json: { error: "Cloud unavailable" } }
    )
  })
  await page.route("**/api/linked", async (route) => {
    if (route.request().method() === "PATCH") enabled = !enabled
    await route.fulfill({
      json: {
        state: enabled ? "online" : "paused",
        enabled,
        cloudOrigin: "https://cloud.example",
        mcpUrl: "https://cloud.example/mcp",
        account: { user, signingIn: false },
      },
    })
  })
  await page.route("**/api/linked/subscriptions", (route) =>
    route.fulfill({ json: { worktables: [] } })
  )
  await page.route("**/api/linked/account", (route) => {
    user = null
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto(harness.webUrl)
  await trigger(page).click()
  await expect(teamRow(page)).toBeVisible()
  await page.getByRole("menuitem", { name: "Worktable Settings" }).click()
  const settings = page.getByRole("dialog")
  await settings
    .getByRole("button", { name: "Remote Access", exact: true })
    .click()
  await settings.getByRole("switch", { name: "Worktable Link" }).click()
  await expect.poll(() => requests).toBe(2)
  await page.keyboard.press("Escape")
  await trigger(page).click()
  await expect(teamRow(page)).toBeVisible()
  await expect(
    page.getByText("Couldn’t refresh Worktables.", { exact: true })
  ).toBeVisible()
  await page.getByRole("menuitem", { name: "Worktable Settings" }).click()
  await settings
    .getByRole("button", { name: "Remote Access", exact: true })
    .click()
  await settings.getByRole("button", { name: "Sign out", exact: true }).click()
  await expect(
    settings.getByText("Not signed in", { exact: true })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await trigger(page).click()
  await expect(teamRow(page)).toHaveCount(0)
  await expect(
    page.getByText("Couldn’t load Worktables.", { exact: true })
  ).toBeVisible()
})
