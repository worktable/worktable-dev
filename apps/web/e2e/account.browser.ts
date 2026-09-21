import { expect, test, type Page } from "@playwright/test"
import {
  CLOUD_PERSONAL_PLAN,
  type BillingStatus,
} from "@worktable/hosted-contract"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

function appUrl(path = "/"): string {
  return new URL(path, harness.webUrl).href
}

const connection = {
  endpoint: "http://127.0.0.1:7480/mcp",
  reachable: true,
  authRequired: true,
  origin: "https://staging.example.test",
  remoteMcpUrl: "https://staging.example.test/api/mcp",
  originSource: "resource",
  originConfigured: true,
  mcpTokenRequired: true,
} as const

test.beforeAll(async () => {
  harness = await startWebHarness("account-browser")
})

test.afterAll(async () => {
  await harness?.stop()
})

function activeBilling(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    plan: CLOUD_PERSONAL_PLAN,
    access: "active",
    subscription: {
      status: "active",
      currentPeriodEnd: Date.UTC(2026, 7, 29),
      cancelAtPeriodEnd: false,
    },
    canCheckout: false,
    canManageBilling: true,
    canExport: true,
    ...overrides,
  }
}

async function mockCloudAccount(
  page: Page,
  billing = activeBilling()
): Promise<void> {
  await page.route("**/api/system/deployment", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
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
      }),
    })
  )
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...connection, mcpAuthMode: "oauth" }),
    })
  )
  await page.route("**/api/billing/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(billing),
    })
  )
}

async function openCloudAccount(page: Page): Promise<void> {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog")
  await settings.getByRole("button", { name: "Account", exact: true }).click()
  await expect(
    settings.getByText("Signed in on this browser", { exact: true })
  ).toBeVisible()
}

test("Cloud Account settings confirms in-app before a CSRF-protected gateway sign-out", async ({
  page,
}) => {
  let sessionRequests = 0
  const logoutRequests: Array<{ method: string; body: string | null }> = []
  const csrfTokens = ["csrf-previous-session", "csrf-current-session"]
  await mockCloudAccount(page)
  await page.route("**/gateway/session", (route) => {
    const csrfToken = csrfTokens[sessionRequests] ?? csrfTokens.at(-1)
    sessionRequests += 1
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        csrfToken,
        accessTokenExpiresAt: 1_900_000_000,
      }),
    })
  })
  await page.route("**/prime-csrf", (route) => {
    if (
      route.request().headers()["x-worktable-csrf"] === "csrf-previous-session"
    ) {
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ code: "CSRF_REQUIRED" }),
    })
  })
  await page.route("**/logout", async (route) => {
    const request = route.request()
    logoutRequests.push({ method: request.method(), body: request.postData() })
    await route.fulfill({
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: "<h1>You’re signed out</h1>",
    })
  })

  await openCloudAccount(page)
  const primedStatus = await page.evaluate(async () => {
    const moduleUrl = "/src/lib/http.ts"
    const { authenticatedFetch } = await import(/* @vite-ignore */ moduleUrl)
    const response = await authenticatedFetch("/prime-csrf", { method: "POST" })
    return response.status
  })
  expect(primedStatus).toBe(204)
  const settings = page.getByRole("dialog")
  await settings.getByRole("button", { name: "Sign out", exact: true }).click()

  await expect(
    page.getByRole("heading", { name: "Sign out of Worktable?" })
  ).toBeVisible()
  expect(sessionRequests).toBe(1)
  expect(logoutRequests).toEqual([])

  const confirmation = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Sign out of Worktable?" }),
  })
  await confirmation
    .getByRole("button", { name: "Sign out", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "You’re signed out" })
  ).toBeVisible()
  expect(sessionRequests).toBe(2)
  expect(logoutRequests).toEqual([
    { method: "POST", body: "csrf=csrf-current-session" },
  ])
})

test("Cloud Account settings falls back to the gateway confirmation when CSRF acquisition fails", async ({
  page,
}) => {
  const logoutMethods: string[] = []
  await mockCloudAccount(page)
  await page.route("**/gateway/session", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" })
  )
  await page.route("**/logout", async (route) => {
    logoutMethods.push(route.request().method())
    await route.fulfill({
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: "<h1>Gateway sign-out confirmation</h1>",
    })
  })

  await openCloudAccount(page)
  const settings = page.getByRole("dialog")
  await settings.getByRole("button", { name: "Sign out", exact: true }).click()
  const confirmation = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Sign out of Worktable?" }),
  })
  await confirmation
    .getByRole("button", { name: "Sign out", exact: true })
    .click()

  await expect(
    page.getByRole("heading", { name: "Gateway sign-out confirmation" })
  ).toBeVisible()
  expect(logoutMethods).toEqual(["GET"])
})

test("Cloud Account shows period-end cancellation and opens the CSRF-protected portal", async ({
  page,
}) => {
  const billing = activeBilling({
    subscription: {
      status: "active",
      currentPeriodEnd: Date.UTC(2026, 7, 29, 16, 45),
      cancelAtPeriodEnd: true,
    },
  })
  await mockCloudAccount(page, billing)
  await page.route("**/gateway/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        csrfToken: "csrf-billing-portal",
        accessTokenExpiresAt: 1_900_000_000,
      }),
    })
  )
  const portalRequests: Array<{ method: string; csrf?: string }> = []
  await page.route("**/api/billing/portal", (route) => {
    const request = {
      method: route.request().method(),
      csrf: route.request().headers()["x-worktable-csrf"],
    }
    portalRequests.push(request)
    if (request.csrf !== "csrf-billing-portal") {
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ code: "CSRF_REQUIRED" }),
      })
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ url: appUrl("/portal-destination") }),
    })
  })
  await page.route("**/portal-destination", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Polar customer portal</h1>",
    })
  )

  await openCloudAccount(page)
  const settings = page.getByRole("dialog")
  await expect(settings.getByText("Cancels at period end")).toBeVisible()
  await settings.getByRole("button", { name: "Manage billing" }).click()
  await expect(
    page.getByRole("heading", { name: "Polar customer portal" })
  ).toBeVisible()
  expect(portalRequests.at(-1)).toEqual({
    method: "POST",
    csrf: "csrf-billing-portal",
  })
})

test("Cloud Account opens a CSRF-protected checkout without re-entering signup", async ({
  page,
}) => {
  await mockCloudAccount(page, {
    plan: CLOUD_PERSONAL_PLAN,
    access: "payment_required",
    canCheckout: true,
    canManageBilling: false,
    canExport: true,
  })
  await page.route("**/gateway/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        csrfToken: "csrf-billing-checkout",
        accessTokenExpiresAt: 1_900_000_000,
      }),
    })
  )
  const checkoutRequests: Array<{ method: string; csrf?: string }> = []
  await page.route("**/api/billing/checkout", (route) => {
    const request = {
      method: route.request().method(),
      csrf: route.request().headers()["x-worktable-csrf"],
    }
    checkoutRequests.push(request)
    if (request.csrf !== "csrf-billing-checkout") {
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ code: "CSRF_REQUIRED" }),
      })
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ url: appUrl("/checkout-destination") }),
    })
  })
  await page.route("**/checkout-destination", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Polar checkout</h1>",
    })
  )

  await openCloudAccount(page)
  const settings = page.getByRole("dialog")
  await expect(settings.getByText("Payment required")).toBeVisible()
  await settings.getByRole("button", { name: "Subscribe" }).click()
  await expect(
    page.getByRole("heading", { name: "Polar checkout" })
  ).toBeVisible()
  expect(checkoutRequests.at(-1)).toEqual({
    method: "POST",
    csrf: "csrf-billing-checkout",
  })
})

test("Cloud Account distinguishes grace and complimentary access", async ({
  browser,
}) => {
  const gracePage = await browser.newPage()
  await mockCloudAccount(
    gracePage,
    activeBilling({
      access: "grace",
      subscription: {
        status: "past_due",
        currentPeriodEnd: Date.UTC(2026, 7, 29),
        cancelAtPeriodEnd: false,
        graceEndsAt: Date.UTC(2026, 8, 5),
      },
    })
  )
  await openCloudAccount(gracePage)
  const graceSettings = gracePage.getByRole("dialog")
  await expect(graceSettings.getByText("Payment due")).toBeVisible()
  await gracePage.close()

  const complimentaryPage = await browser.newPage()
  await mockCloudAccount(
    complimentaryPage,
    activeBilling({
      access: "complimentary",
      subscription: undefined,
      canManageBilling: false,
    })
  )
  await openCloudAccount(complimentaryPage)
  const complimentarySettings = complimentaryPage.getByRole("dialog")
  await expect(complimentarySettings.getByText("VIP")).toBeVisible()
  await expect(complimentarySettings.getByText("Boss tier")).toBeVisible()
  await expect(
    complimentarySettings.getByRole("button", { name: "Manage billing" })
  ).toHaveCount(0)
  await expect(
    complimentarySettings.getByRole("button", { name: "Export" })
  ).toHaveCount(0)
  await complimentaryPage.close()
})

test("Cloud Account keeps export available while billing access is locked", async ({
  page,
}) => {
  await mockCloudAccount(
    page,
    activeBilling({
      access: "locked",
      subscription: {
        status: "revoked",
        currentPeriodEnd: Date.UTC(2026, 7, 29),
        cancelAtPeriodEnd: false,
      },
      canCheckout: true,
    })
  )
  let exportMethod: string | null = null
  await page.route("**/api/workspace/export", (route) => {
    exportMethod = route.request().method()
    return route.fulfill({
      contentType: "text/html",
      body: "<h1>Workspace export ready</h1>",
    })
  })

  await openCloudAccount(page)
  const settings = page.getByRole("dialog")
  await expect(settings.getByText("Subscription expired")).toBeVisible()
  await settings.getByRole("button", { name: "Export" }).click()
  await expect(
    page.getByRole("heading", { name: "Workspace export ready" })
  ).toBeVisible()
  expect(exportMethod).toBe("GET")
})

test("local Settings omits the Cloud-only Account section", async ({
  page,
}) => {
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...connection, mcpAuthMode: "local-token" }),
    })
  )

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("button", { name: "Settings", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog")
  await expect(
    settings.getByRole("button", { name: "Account", exact: true })
  ).toHaveCount(0)
})
