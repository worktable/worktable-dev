import { expect, test, type Page } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

const OPENCLAW_FIRST_MESSAGE =
  "Help me decide what to set up first in Worktable. Ask me about what I’m working on, then suggest a useful first Space and the three notes it should contain."

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
): Promise<void> {
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

test("new owner can name, connect multiple real agent identities, leave an OpenClaw reply pending, and resume", async ({
  page,
}) => {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })

  await expect(
    page.getByRole("heading", { name: "Set up your Worktable" })
  ).toBeVisible()
  await page.getByLabel("Your name").fill("Alex")
  await page.getByLabel("Worktable name").fill("Alex Worktable")
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(
    page.getByRole("heading", { name: "Connect your Agents" })
  ).toBeVisible()
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("heading", { name: "Connect your Agents" })
  ).toBeVisible()

  await page.getByRole("button", { name: /CLI agents/ }).click()
  await page.getByRole("combobox", { name: "CLI agent" }).click()
  await page.getByRole("option", { name: "ChatGPT / Codex" }).click()
  await page.getByLabel("Agent name").fill("My Codex")
  const cliPairing = await waitForPairingCreate(page, () =>
    page.getByRole("button", { name: "Create install command" }).click()
  )
  await expect(
    page.getByRole("button", { name: "Copy install command" })
  ).toBeVisible()
  await completePairing(cliPairing, {
    hostname: "browser-devbox",
    client: "codex",
  })
  await expect(page.getByText("Connected.", { exact: true })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole("button", { name: "Add another agent" }).click()

  await page.getByRole("button", { name: /Claude or ChatGPT/ }).click()
  await page.getByRole("combobox", { name: "App" }).click()
  await page.getByRole("option", { name: "ChatGPT" }).click()
  await expect(
    page.getByText("Open ChatGPT desktop Settings → MCP servers.")
  ).toBeVisible()
  await page.getByLabel("Agent name").fill("Writing ChatGPT")
  let releaseTokenRequest!: () => void
  const tokenRequestGate = new Promise<void>((resolve) => {
    releaseTokenRequest = resolve
  })
  let tokenRequestStarted!: () => void
  const tokenRequestPending = new Promise<void>((resolve) => {
    tokenRequestStarted = resolve
  })
  let holdTokenRequest = true
  await page.route("**/api/tokens", async (route) => {
    if (route.request().method() === "POST" && holdTokenRequest) {
      holdTokenRequest = false
      tokenRequestStarted()
      await tokenRequestGate
    }
    await route.continue()
  })
  const mintedResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/tokens"
  )
  await page.getByRole("button", { name: "Generate access token" }).click()
  await tokenRequestPending
  await expect(
    page.getByRole("button", { name: "Finish later" })
  ).toBeDisabled()
  releaseTokenRequest()
  const minted = (await (await mintedResponse).json()) as { token: string }
  const used = await fetch(`${harness.apiUrl}/api/spaces`, {
    headers: { Authorization: `Bearer ${minted.token}` },
  })
  expect(used.status).toBe(200)
  await expect(
    page.getByRole("button", { name: "Add another agent" })
  ).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Add another agent" }).click()

  await page.getByRole("button", { name: /^OpenClaw/ }).click()
  await page.getByLabel("Agent name").fill("Atlas")
  const openClawPairing = await waitForPairingCreate(page, () =>
    page.getByRole("button", { name: "Create connection command" }).click()
  )
  await expect(
    page.getByRole("button", { name: "Copy connection command" })
  ).toBeVisible()
  await completePairing(openClawPairing, {
    hostname: "browser-openclaw",
    installationId: "oci_browser_test_1234567890",
  })
  await expect(page.getByText("Connected.", { exact: true })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole("button", { name: "Add another agent" }).click()

  await page.getByRole("button", { name: /^OpenClaw/ }).click()
  await page.getByLabel("Agent name").fill("Ada")
  const secondOpenClawPairing = await waitForPairingCreate(page, () =>
    page.getByRole("button", { name: "Create connection command" }).click()
  )
  await completePairing(secondOpenClawPairing, {
    hostname: "browser-openclaw-2",
    installationId: "oci_browser_test_0987654321",
  })
  await expect(page.getByText("Connected.", { exact: true })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole("button", { name: "Continue" }).click()

  await expect(
    page.getByRole("heading", { name: "Your Worktable is ready" })
  ).toBeVisible()
  const atlasStarter = page.getByRole("region", {
    name: "Start a Thread with Atlas",
  })
  const adaStarter = page.getByRole("region", {
    name: "Start a Thread with Ada",
  })
  await expect(atlasStarter).toBeVisible()
  await expect(adaStarter).toBeVisible()
  let dropStarterResponse = true
  await page.route("**/api/threads", async (route) => {
    if (route.request().method() === "POST" && dropStarterResponse) {
      dropStarterResponse = false
      await route.fetch()
      await route.abort("failed")
      return
    }
    await route.continue()
  })
  await atlasStarter.getByRole("button", { name: "Start Thread" }).click()
  await expect(atlasStarter.getByText("Failed to fetch")).toBeVisible()
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("heading", { name: "Your Worktable is ready" })
  ).toBeVisible()
  await atlasStarter.getByRole("button", { name: "Start Thread" }).click()
  await adaStarter.getByRole("button", { name: "Start Thread" }).click()
  await expect(
    page.getByText(
      "Thread started. Finish setup now and check Threads whenever you’re ready."
    )
  ).toHaveCount(2)
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.apiUrl}/api/threads`)
      const payload = (await response.json()) as {
        threads: Array<{ lastMessage: { body: string } }>
      }
      return payload.threads.filter(
        (thread) => thread.lastMessage.body === OPENCLAW_FIRST_MESSAGE
      ).length
    })
    .toBe(2)
  await page.getByRole("button", { name: "Finish setup" }).click()

  await expect(page.locator("[data-worktable-app-shell]")).toBeVisible()
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
    await fetch(`${harness.apiUrl}/api/tokens`).then((res) => res.json())
  ).toMatchObject({
    tokens: expect.arrayContaining([
      expect.objectContaining({
        agent: "Writing ChatGPT",
        lastUsedAt: expect.any(String),
      }),
    ]),
  })
  expect(
    await fetch(`${harness.apiUrl}/api/agent-connections`).then((res) =>
      res.json()
    )
  ).toMatchObject({
    connections: expect.arrayContaining([
      expect.objectContaining({ displayName: "My Codex" }),
      expect.objectContaining({
        target: expect.objectContaining({ adapter: "openclaw" }),
        participant: expect.objectContaining({ name: "Atlas" }),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ adapter: "openclaw" }),
        participant: expect.objectContaining({ name: "Ada" }),
      }),
    ]),
  })

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
    .getByRole("button", { name: "Appearance", exact: true })
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
