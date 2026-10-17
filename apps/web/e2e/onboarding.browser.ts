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

test("a new owner names their Worktable, connects agents, hands one its first task and lands in its Space", async ({
  page,
}) => {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })

  await expect(
    page.getByRole("heading", { name: "Set up your Worktable" })
  ).toBeVisible()
  await page.getByLabel("Your name").fill("Alex")
  await page.getByLabel("Worktable").fill("Alex Worktable")
  await page.getByRole("radio", { name: /Just me/ }).click()
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(
    page.getByRole("heading", { name: "Connect your agent" })
  ).toBeVisible()
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("heading", { name: "Connect your agent" })
  ).toBeVisible()

  await page.getByRole("button", { name: /Claude Code, Codex/ }).click()
  await page.getByRole("combobox", { name: "CLI agent" }).click()
  await page.getByRole("option", { name: "ChatGPT / Codex" }).click()
  await page.getByLabel("Agent name").fill("My Codex")
  const cliPairing = await waitForPairingCreate(page, () =>
    page.getByRole("button", { name: "Create install command" }).click()
  )
  const codexToken = await completePairing(cliPairing, {
    hostname: "browser-devbox",
    client: "codex",
  })
  await expect(page.getByText("Connected.", { exact: true })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole("button", { name: "Add another agent" }).click()

  await page.getByRole("button", { name: /^OpenClaw/ }).click()
  await page.getByRole("combobox", { name: "Agent" }).click()
  await page.getByRole("option", { name: "Hermes" }).click()
  await page.getByLabel("Agent name").fill("Ada")
  const hermesPairing = await waitForPairingCreate(page, () =>
    page.getByRole("button", { name: "Create connection command" }).click()
  )
  await expect(page.getByText(/^hermes worktable connect /)).toBeVisible()
  await completePairing(hermesPairing, {
    hostname: "browser-hermes",
    installationId: "hci_browser_test_0987654321",
  })
  await expect(page.getByText("Connected.", { exact: true })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole("button", { name: "Continue" }).click()

  // The first agent connected gets the first task.
  await expect(
    page.getByRole("heading", { name: "What are you working on?" })
  ).toBeVisible()
  await page
    .getByLabel("What you're working on")
    .fill("Planning our spring launch: goals and timeline")
  await page.getByRole("button", { name: "Start" }).click()
  await expect(
    page.getByRole("heading", { name: "Over to My Codex" })
  ).toBeVisible()
  await expect(page.getByText(/^codex "In Worktable, make a Space/)).toBeVisible()
  await expect(page.getByText("Waiting for My Codex to start")).toBeVisible()

  // The agent's work shows up as it lands, pushed to the page.
  const agent = { Authorization: `Bearer ${codexToken}` }
  const space = await postJson<{ spaceId: string }>(
    "/api/spaces",
    { name: "Spring Launch" },
    codexToken
  )
  await expect(page.getByText("Created Spring Launch")).toBeVisible({
    timeout: 10_000,
  })
  const brief = await fetch(
    `${harness.apiUrl}/api/spaces/${space.spaceId}/docs`,
    {
      method: "POST",
      headers: { ...agent, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Spring Launch Brief" }),
    }
  )
  expect(brief.status).toBeLessThan(300)
  await expect(page.getByText("Wrote Spring Launch Brief")).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(page.getByRole("heading", { name: "You're set up" })).toBeVisible()
  await page.getByRole("button", { name: "Open Spring Launch" }).click()
  await expect(page).toHaveURL(/\/spaces\/spring-launch$/)
  await expect(page.locator("[data-worktable-app-shell]")).toBeVisible()
  // Getting Started sits in the sidebar with what's already done.
  await expect(
    page.getByRole("link", { name: /Getting Started\s*2\/6/ })
  ).toBeVisible()

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
      expect.objectContaining({ displayName: "My Codex" }),
      expect.objectContaining({
        target: expect.objectContaining({ adapter: "hermes" }),
        displayName: "Ada",
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
    .filter({ hasText: "Ada" })
    .getByRole("button", { name: "Edit" })
    .click()
  const editAgent = page.getByRole("dialog", { name: "Ada" })
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
    page.getByRole("heading", { name: "Set up your Worktable" })
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
  await settings
    .getByRole("button", { name: "Profile", exact: true })
    .click()
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
