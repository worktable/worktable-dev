import { gunzipSync } from "node:zlib"
import { expect, test, type Page } from "@playwright/test"
import { CLOUD_PLANS, type BillingStatus } from "@worktable/hosted-contract"
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
    plan: CLOUD_PLANS.team,
    access: "active",
    subscription: {
      status: "active",
      currentPeriodEnd: Date.UTC(2026, 7, 29),
      cancelAtPeriodEnd: false,
    },
    canCheckout: false,
    canManageBilling: true,
    canExport: true,
    canChangeTo: [],
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
          analyticsChoice: true,
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

async function openCloudAccount(
  page: Page,
  name: "Billing" | "Privacy" = "Billing"
): Promise<void> {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog")
  const section = settings.getByRole("button", { name, exact: true })
  await section.click()
  await expect(section).toHaveAttribute("aria-pressed", "true")
}

test("Signing out of Cloud confirms in-app before a CSRF-protected gateway sign-out", async ({
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

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  const primedStatus = await page.evaluate(async () => {
    const moduleUrl = "/src/lib/http.ts"
    const { authenticatedFetch } = await import(/* @vite-ignore */ moduleUrl)
    const response = await authenticatedFetch("/prime-csrf", { method: "POST" })
    return response.status
  })
  expect(primedStatus).toBe(204)
  await page
    .locator("[data-worktable-sidebar-root]")
    .getByRole("button", { name: /, Owner$/ })
    .click()
  await page.getByRole("menuitem", { name: "Sign Out" }).click()

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

test("Cloud Billing shows period-end cancellation and opens the CSRF-protected portal", async ({
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
  await settings.getByRole("button", { name: "Manage payment" }).click()
  await expect(
    page.getByRole("heading", { name: "Polar customer portal" })
  ).toBeVisible()
  expect(portalRequests.at(-1)).toEqual({
    method: "POST",
    csrf: "csrf-billing-portal",
  })
})

test("Cloud Billing opens a CSRF-protected checkout without re-entering signup", async ({
  page,
}) => {
  await mockCloudAccount(page, {
    plan: CLOUD_PLANS.team,
    access: "payment_required",
    canCheckout: true,
    canManageBilling: false,
    canExport: true,
    canChangeTo: [],
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

test("Cloud Billing keeps export available while billing access is locked", async ({
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
  await expect(settings.getByText("Locked", { exact: true })).toBeVisible()
  await settings.getByRole("button", { name: "Export" }).click()
  await expect(
    page.getByRole("heading", { name: "Workspace export ready" })
  ).toBeVisible()
  expect(exportMethod).toBe("GET")
})

test("Cloud analytics starts without a choice, filters SDK context, and remembers revocation", async ({
  page,
}) => {
  await mockCloudAccount(page)
  let preference: {
    version: number
    enabled: boolean
    updatedAt: number
  } | null = null
  const choices: unknown[] = []
  const events: Array<{ event: string; properties: Record<string, unknown> }> =
    []
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => false,
    })
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      get: () => undefined,
    })
  })
  await page.route("**/api/analytics/preference", async (route) => {
    if (route.request().method() === "POST") {
      const choice = route.request().postDataJSON()
      choices.push(choice)
      preference = {
        version: 1,
        enabled: choice.enabled,
        updatedAt: Date.now(),
      }
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        preference,
        distinctId: "workos:user_analytics",
        projectToken: "phc_browser_product_test",
        apiHost: "https://edge.worktable.dev",
        surface: "web",
        worktableId: "table_test",
        trafficType: "verification",
      }),
    })
  })
  await page.route("https://edge.worktable.dev/**", async (route) => {
    const request = route.request()
    if (request.method() === "POST") {
      let bytes = request.postDataBuffer()!
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes)
      const text = bytes.toString("utf8")
      const encoded = new URLSearchParams(text).get("data")
      let payload
      try {
        payload = JSON.parse(encoded ?? text)
      } catch {
        payload = JSON.parse(
          Buffer.from(encoded ?? text, "base64").toString("utf8")
        )
      }
      events.push(...(payload.batch ?? [payload]))
    }
    await route.fulfill({
      contentType: "application/json",
      body: "{}",
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
      },
    })
  })
  const opened = () =>
    events.filter((event) => event.event === "product:opened").length
  // An account without a recorded choice is measured by default.
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect.poll(opened).toBe(1)
  // A refusal recorded elsewhere stops collection on the next load.
  preference = { version: 1, enabled: false, updatedAt: 1000 }
  await openCloudAccount(page, "Privacy")
  const choice = page.getByRole("switch", { name: "Share usage analytics" })
  await expect(choice).not.toBeChecked()
  expect(opened()).toBe(1)
  await page.evaluate(() => {
    history.replaceState(null, "", "?email=private%40example.com#private-doc")
    document.title = "Private document title"
  })
  await choice.click()
  await expect(choice).toBeChecked()
  await expect.poll(opened).toBe(2)
  await expect
    .poll(() => events.map((event) => event.event))
    .toContain("$identify")
  for (const event of events) {
    expect(event.properties).toMatchObject({
      distinct_id: "workos:user_analytics",
      actor_type: "human",
      traffic_type: "verification",
      analytics_schema_version: 3,
    })
    for (const key of [
      "$current_url",
      "$referrer",
      "$pathname",
      "$initial_current_url",
      "$raw_user_agent",
    ])
      expect(event.properties).not.toHaveProperty(key)
  }
  for (const secret of [
    "private@example.com",
    "private-doc",
    "Private document title",
  ])
    expect(JSON.stringify(events)).not.toContain(secret)
  const count = events.length
  await choice.click()
  await expect(choice).not.toBeChecked()
  expect(choices).toEqual([{ enabled: true }, { enabled: false }])
  await openCloudAccount(page, "Privacy")
  await expect(choice).not.toBeChecked()
  expect(events).toHaveLength(count)
})
