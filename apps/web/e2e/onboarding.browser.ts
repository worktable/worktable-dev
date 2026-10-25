import { expect, test, type Page } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

function appUrl(path = "/"): string {
  return new URL(path, harness.webUrl).href
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
  token?: string
): Promise<T> {
  const response = await fetch(`${harness.apiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${await response.text()}`
    )
  }
  return (await response.json()) as T
}

async function completePairing(
  created: { code: string },
  body: Record<string, unknown>
): Promise<string> {
  const redeemed = await postJson<{ token: string }>("/api/pairing/redeem", {
    code: created.code,
    ...body,
  })
  await postJson("/api/pairing/progress", {
    code: created.code,
    event: "config_written",
    detail: "Browser journey simulated the connector write.",
  })
  await postJson(
    "/api/pairing/complete",
    { code: created.code },
    redeemed.token
  )
  return redeemed.token
}

async function waitForPairingCreate(page: Page, click: () => Promise<void>) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/pairing"
  )
  await click()
  const result = await response
  expect(result.status()).toBe(201)
  return (await result.json()) as { code: string; id: string }
}

test.beforeAll(async () => {
  harness = await startWebHarness("onboarding-browser", {
    onboarding: "pending",
  })
})

test.afterAll(async () => {
  await harness?.stop()
})

for (const wakeMethod of ["webhook", "email"] as const)
  test(`Grok ${wakeMethod} setup waits for a reply and recovers after saving`, async ({
    page,
  }, testInfo) => {
    const candidate = {
      id: "oauth:grok:onboarding",
      displayName: "Grok Bot",
      participantId: "ptc_grokonboarding",
      emailSender: "wake.fixture@agents.worktable.dev",
    }
    let signedIn = false
    let linkReady = false
    let configured = false
    let checking = false
    let verified = false
    let notificationError: string | undefined
    let saves = 0
    let checks = 0
    await page.route("**/api/workspace", async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      const response = await route.fetch()
      await route.fulfill({
        response,
        json: { ...(await response.json()), onboarding: { status: "pending" } },
      })
    })
    await page.route("**/api/agent-connections", (route) =>
      route.fulfill({
        json: {
          connections: [],
          grokBotMcpUrl: linkReady ? "https://example.test/mcp" : null,
          grokBotCandidates: signedIn ? [candidate] : [],
          grokBots: configured
            ? [
                {
                  connectionId: candidate.id,
                  participantId: candidate.participantId,
                  enabled: true,
                  wakeMethod,
                  ...(wakeMethod === "email"
                    ? { emailAddress: "onboarding@mail.grokbot.com" }
                    : {}),
                  executionMinutes: 30,
                  status: verified
                    ? "ready"
                    : notificationError
                      ? "needs-attention"
                      : checking
                        ? "checking"
                        : "configured",
                  ...(notificationError ? { error: notificationError } : {}),
                  ...(verified ? { verifiedAt: "2026-10-22T00:00:00Z" } : {}),
                  ...(checking && !verified
                    ? {
                        probe: {
                          location: { kind: "worktable" },
                          threadId: "thr_grokcheck",
                          messageId: "msg_grokcheck",
                          identityId: "idt_grokcheck",
                        },
                      }
                    : {}),
                },
              ]
            : [],
        },
      })
    )
    await page.route("**/api/grok-bot/**", (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/retry")) {
        notificationError = undefined
        return route.fulfill({ json: { ok: true } })
      }
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON()
        expect(body).toMatchObject({
          wakeMethod,
          name: configured ? "Orbit" : "Comet",
          ...(!configured && wakeMethod === "email"
            ? { emailAddress: "onboarding@mail.grokbot.com" }
            : !configured
              ? { webhookKey: "grok-onboarding-secret" }
              : {}),
          enabled: true,
        })
        candidate.displayName = body.name
        configured = true
        saves += 1
        return route.fulfill({ json: { ok: true } })
      }
      checks += 1
      if (checks === 1)
        return route.fulfill({
          status: 503,
          json: { error: "Could not start the check" },
        })
      checking = true
      return route.fulfill({ json: { ok: true } })
    })
    if (wakeMethod === "email")
      await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
    await page.getByLabel("Your name").fill("Grok owner")
    await page.getByLabel("Worktable name").fill("Grok workspace")
    await page
      .getByRole("button", { name: "Create Worktable", exact: true })
      .click()
    await page.getByRole("button", { name: /^Always-on agents/ }).click()
    await page.getByRole("tab", { name: "Grok Bot", exact: true }).click()
    const options = page
      .getByRole("list")
      .filter({ hasText: "Connect Worktable" })
    await options.getByRole("button", { name: "Set up Worktable Link" }).click()
    await expect(
      options.getByRole("button", { name: "Sign in", exact: true })
    ).toBeVisible()
    await options
      .getByRole("button", { name: "Continue setup", exact: true })
      .click()
    await expect(
      page.getByText("Finish connecting Worktable Link first.")
    ).toBeVisible()
    await expect(
      options.getByText("Add this MCP server:", { exact: false })
    ).toHaveCount(0)
    linkReady = true
    await options
      .getByRole("button", { name: "Continue setup", exact: true })
      .click()
    await expect(
      options.getByText("Add this MCP server: https://example.test/mcp", {
        exact: true,
      })
    ).toBeVisible()
    await options.getByRole("button", { name: "Continue", exact: true }).click()
    signedIn = true
    await page
      .getByRole("button", { name: "Refresh connections", exact: true })
      .click()
    await expect(
      page.getByRole("combobox", { name: "Notify Grok using" })
    ).toHaveText(wakeMethod === "email" ? "Email" : "Webhook")
    // The recommendation is a starting choice; either method remains available.
    await page.getByRole("combobox", { name: "Notify Grok using" }).click()
    await page
      .getByRole("option", {
        name: wakeMethod === "email" ? /^Webhook/ : /^Email/,
      })
      .click()
    await page.getByRole("combobox", { name: "Notify Grok using" }).click()
    await page
      .getByRole("option", {
        name: wakeMethod === "email" ? /^Email/ : /^Webhook/,
      })
      .click()
    if (wakeMethod === "email") {
      await page
        .getByLabel("Bot email address", { exact: true })
        .fill("owner@example.test")
      await expect(
        options.getByRole("button", { name: "Continue", exact: true })
      ).toBeDisabled()
      await page
        .getByLabel("Bot email address", { exact: true })
        .fill("onboarding@mail.grokbot.com")
    } else {
      await page
        .getByLabel("Webhook URL", { exact: true })
        .fill(
          "grokbot://app/v1/sidebar?target=webhook-url&automation=worktable-inbox"
        )
      await page
        .getByLabel("Webhook key", { exact: true })
        .fill("grok-onboarding-secret")
      await expect(options.getByRole("alert")).toContainText("Grok shortcut")
      await expect(
        options.getByRole("button", { name: "Continue", exact: true })
      ).toBeDisabled()
      await page
        .getByLabel("Webhook URL", { exact: true })
        .fill("https://api2.cursor.sh/automations/webhook/onboarding_fixture")
      await page
        .getByLabel("Webhook key", { exact: true })
        .fill(
          "grokbot://app/v1/sidebar?target=webhook-key&automation=worktable-inbox"
        )
      await expect(
        page.getByLabel("Webhook key", { exact: true })
      ).toHaveAttribute("aria-invalid", "true")
      await expect(
        options.getByRole("button", { name: "Continue", exact: true })
      ).toBeDisabled()
      await page
        .getByLabel("Webhook key", { exact: true })
        .fill("grok-onboarding-secret")
      await expect(options.getByRole("alert")).toHaveCount(0)
    }
    expect(saves).toBe(0)
    await page.getByLabel("Bot name", { exact: true }).fill("Comet")
    await page.screenshot({ path: testInfo.outputPath("grok-setup.png") })
    await options.getByRole("button", { name: "Continue", exact: true }).click()
    await page
      .getByRole("button", { name: "Save and check", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Check connection", exact: true })
    ).toBeVisible()
    // Saving alone does not finish onboarding. The failed check keeps its saved credentials.
    await expect(
      page.getByRole("button", { name: "Continue", exact: true })
    ).toBeDisabled()
    await page
      .getByRole("button", { name: "Check connection", exact: true })
      .click()
    await expect(
      page.getByText("Waiting for Grok Bot to reply…", { exact: true })
    ).toBeVisible()
    notificationError =
      wakeMethod === "email"
        ? "Email notification failed (HTTP 401). Check the Bot address and Worktable connection."
        : "Grok Bot rejected the wake (HTTP 401). Check the routine URL and key."
    await page
      .getByRole("button", { name: "Refresh status", exact: true })
      .click()
    await expect(
      page.getByText("Connection needs attention", { exact: true })
    ).toBeVisible()
    await expect(
      page.getByText(notificationError, { exact: true })
    ).toBeVisible()
    await expect(
      page.getByText("Waiting for Grok Bot to reply…", { exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Continue", exact: true })
    ).toBeDisabled()
    await page.screenshot({
      path: testInfo.outputPath("grok-notification-failed.png"),
    })
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await expect(
      page.getByText("Waiting for Grok Bot to reply…", { exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Continue", exact: true })
    ).toBeDisabled()
    verified = true
    await page
      .getByRole("button", { name: "Refresh status", exact: true })
      .click()
    await expect(page.getByText("Connected", { exact: true })).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Continue", exact: true })
    ).toBeEnabled()
    expect(saves).toBe(1)
    expect(checks).toBe(2)
    await page.screenshot({ path: testInfo.outputPath("grok-connected.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(
      page.getByRole("button", { name: "Continue", exact: true })
    ).toBeVisible()
    const tabs = await page.getByRole("tablist").boundingBox()
    const status = await page
      .getByText("Connected", { exact: true })
      .boundingBox()
    expect(tabs).not.toBeNull()
    expect(status).not.toBeNull()
    expect(status!.y).toBeGreaterThanOrEqual(tabs!.y + tabs!.height)
    await page.screenshot({
      path: testInfo.outputPath("grok-connected-mobile.png"),
    })
    const connectionSettings = page.getByRole("button", {
      name: "Connection settings",
      exact: true,
    })
    await connectionSettings.click()
    await expect(connectionSettings).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByLabel("Bot name", { exact: true })).toHaveValue(
      "Comet"
    )
    await page.getByLabel("Bot name", { exact: true }).fill("Orbit")
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click()
    await expect(page.getByText("Orbit", { exact: true })).toBeVisible()
    expect(checks).toBe(2)
    await connectionSettings.click()
    await expect(connectionSettings).toHaveAttribute("aria-expanded", "false")
    await expect(page.getByLabel("Bot name", { exact: true })).not.toBeVisible()
    linkReady = false
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("button", { name: /^Always-on agents/ }).click()
    await page.getByRole("tab", { name: "Grok Bot", exact: true }).click()
    await page.getByText("Connection settings", { exact: true }).click()
    await page.getByRole("combobox", { name: "Notify Grok using" }).click()
    await page
      .getByRole("option", {
        name: wakeMethod === "email" ? "Webhook" : "Email",
      })
      .click()
    await expect(
      page.getByRole("button", { name: "Copy instructions", exact: true })
    ).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Remove routine", exact: true })
    ).toBeEnabled()
  })

test("Cloud coding agents are recognized on their own tab when they sign in", async ({
  page,
}) => {
  const mcpUrl = "https://cloud.example.test/api/mcp/w/wt_fixture"
  // As Cloud lists sign-in agents: by app name, with no known platform.
  const agent = (id: string, displayName: string) => ({
    id,
    authKind: "oauth",
    displayName,
    platform: "other",
    ownership: "personal",
    icon: null,
    access: { threads: true, read: true, edit: true },
    target: { kind: "mcp-client", clientId: null },
    mode: "on-demand",
    participant: null,
    machine: null,
    scopes: [],
    connectedAt: null,
    lastSeenAt: null,
    permissionGroups: null,
  })
  const connections = [agent("agt_chatgpt", "ChatGPT")]
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    await route.fulfill({
      response,
      json: { ...(await response.json()), onboarding: { status: "pending" } },
    })
  })
  await page.route("**/api/system/connection", async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        mcpAuthMode: "oauth",
        agentPairing: false,
        remoteMcpUrl: mcpUrl,
      },
    })
  })
  await page.route(
    (url) => url.pathname.endsWith("/api/agent-connections"),
    (route) => route.fulfill({ json: { connections } })
  )

  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await page.getByLabel("Your name").fill("Cloud owner")
  await page.getByLabel("Worktable name").fill("Cloud workspace")
  await page
    .getByRole("button", { name: "Create Worktable", exact: true })
    .click()
  await page.getByRole("button", { name: /^Coding agents/ }).click()
  await expect(
    page.getByText(
      "Run this in your terminal, then choose Allow access when your browser opens."
    )
  ).toBeVisible()
  await expect(page.getByText(`--client claude-code`)).toBeVisible()

  // Codex signs in while Claude Code's tab is on show: it isn't Claude Code.
  const poll = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/api/agent-connections")
  )
  connections.push(agent("agt_codex", "Codex"))
  await (await poll).response()
  await expect(page.getByText("Waiting for Claude Code")).toBeVisible()
  await expect(page.getByText(/is connected\./)).toHaveCount(0)

  // An agent already connected when the step opened isn't new, while one
  // that signed in since is recognized when its tab opens.
  await page.getByRole("tab", { name: "Codex", exact: true }).click()
  await expect(page.getByText("Codex is connected.")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Continue", exact: true })
  ).toBeEnabled()
})

test("a new owner creates their Worktable, connects agents and finishes their first steps in Getting Started", async ({
  page,
}) => {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })

  await expect(
    page.getByRole("heading", { name: "Create your Worktable" })
  ).toBeVisible()
  await page.getByLabel("Your name").fill("Alex")
  await page.getByLabel("Worktable name").fill("Alex Worktable")
  await page.getByRole("button", { name: "Create Worktable" }).click()

  await expect(
    page.getByRole("heading", { name: "Connect your agent" })
  ).toBeVisible()
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("heading", { name: "Connect your agent" })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled()

  // Opening a row shows the first tab's command straight away.
  await waitForPairingCreate(page, () =>
    page.getByRole("button", { name: /Coding agents/ }).click()
  )
  await expect(page.getByText(/--client claude-code$/)).toBeVisible()
  const cliPairing = await waitForPairingCreate(page, () =>
    page.getByRole("tab", { name: "Codex" }).click()
  )
  await expect(page.getByText(/--client codex$/)).toBeVisible()
  const codexToken = await completePairing(cliPairing, {
    hostname: "browser-devbox",
    client: "codex",
  })
  await expect(page.getByText("Codex is connected.")).toBeVisible({
    timeout: 10_000,
  })

  await waitForPairingCreate(page, () =>
    page.getByRole("button", { name: /Always-on agents/ }).click()
  )
  await expect(page.getByText(/openclaw worktable connect /)).toBeVisible()
  const hermesPairing = await waitForPairingCreate(page, () =>
    page.getByRole("tab", { name: "Hermes" }).click()
  )
  await expect(page.getByText(/hermes worktable connect /)).toBeVisible()
  await completePairing(hermesPairing, {
    hostname: "browser-hermes",
    installationId: "hci_browser_test_0987654321",
  })
  await expect(
    page.getByText("Hermes is connected. Ask it for work in Threads.")
  ).toBeVisible({ timeout: 10_000 })

  // On this computer there is nobody to invite, so setup ends here.
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page).toHaveURL(/\/spaces\/welcome$/)
  await expect(
    page.getByRole("heading", { name: "Getting Started" })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: /Getting Started\s*1\/2/ })
  ).toBeVisible()
  await expect(
    page.getByText("Done when your agent saves its first doc.")
  ).toBeVisible()

  // The agent's first doc finishes the list, pushed to the page.
  const space = await postJson<{ spaceId: string }>(
    "/api/spaces",
    { name: "Spring Launch" },
    codexToken
  )
  const brief = await fetch(
    `${harness.apiUrl}/api/spaces/${space.spaceId}/docs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${codexToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Spring Launch Brief" }),
    }
  )
  expect(brief.status).toBeLessThan(300)
  await expect(page.getByText("Alex Worktable is set up.")).toBeVisible({
    timeout: 10_000,
  })

  const workspace = (await fetch(`${harness.apiUrl}/api/workspace`).then(
    (res) => res.json()
  )) as { name: string; onboarding: { status: string } }
  expect(workspace).toMatchObject({
    name: "Alex Worktable",
    onboarding: { status: "complete" },
  })
  expect(
    await fetch(`${harness.apiUrl}/api/profile`).then((res) => res.json())
  ).toMatchObject({ name: "Alex" })
  expect(
    await fetch(`${harness.apiUrl}/api/agent-connections`).then((res) =>
      res.json()
    )
  ).toMatchObject({
    connections: expect.arrayContaining([
      expect.objectContaining({ displayName: "Codex" }),
      expect.objectContaining({
        target: expect.objectContaining({ adapter: "hermes" }),
        displayName: "Hermes",
        platform: "hermes",
        access: { threads: true, read: true, edit: true },
      }),
    ]),
  })

  // The owner renames an always-on agent and narrows what it may do.
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const agentSettings = page.getByRole("dialog", { name: "Settings" })
  await agentSettings
    .getByRole("button", { name: "Agents", exact: true })
    .click()
  await agentSettings
    .getByRole("listitem")
    .filter({ hasText: "Hermes" })
    .getByRole("button", { name: "Edit" })
    .click()
  const editAgent = page.getByRole("dialog", { name: "Hermes" })
  await editAgent.getByLabel("Name").fill("Ada Lovelace")
  await editAgent.getByText("Edit workspace").click()
  await editAgent.getByRole("button", { name: "Save" }).click()
  await expect(editAgent).toHaveCount(0)
  await expect(
    agentSettings.getByText("Ada Lovelace", { exact: true })
  ).toBeVisible()
  expect(
    await fetch(`${harness.apiUrl}/api/agent-connections`).then((res) =>
      res.json()
    )
  ).toMatchObject({
    connections: expect.arrayContaining([
      expect.objectContaining({
        displayName: "Ada Lovelace",
        participant: expect.objectContaining({ name: "Ada Lovelace" }),
        access: { threads: true, read: true, edit: false },
      }),
    ]),
  })
  await page.keyboard.press("Escape")

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-worktable-app-shell]")).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Create your Worktable" })
  ).toHaveCount(0)

  let releaseProfile!: () => void
  const profileGate = new Promise<void>((resolve) => {
    releaseProfile = resolve
  })
  let profileIntercepted!: () => void
  const profileStarted = new Promise<void>((resolve) => {
    profileIntercepted = resolve
  })
  let delayProfile = true
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() === "GET" && delayProfile) {
      delayProfile = false
      profileIntercepted()
      const response = await route.fetch()
      await profileGate
      await route.fulfill({ response })
      return
    }
    await route.continue()
  })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog")
  await settings.getByRole("button", { name: "Profile", exact: true }).click()
  await profileStarted
  const displayName = settings.getByLabel("Display name")
  await displayName.fill("Name still being edited")
  const profileResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/profile"
  )
  releaseProfile()
  await profileResponse
  await expect(displayName).toHaveValue("Name still being edited")
})
