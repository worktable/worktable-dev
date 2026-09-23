import { expect, test, type Page } from "@playwright/test"
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

async function openAgents(page: Page): Promise<void> {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  // The shell is server-rendered, so its buttons exist before React attaches
  // event handlers. Wait for the root hydration marker before clicking.
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Agents", exact: true })
    .click()
}

test.beforeAll(async () => {
  harness = await startWebHarness("agents-browser")
})

test.afterAll(async () => {
  await harness?.stop()
})

test("Cloud shows equivalent setup and inventory without touching local credential routes", async ({
  page,
}) => {
  const forbiddenRequests: string[] = []
  let topLevelNavigations = 0
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (
      path.startsWith("/api/tokens") ||
      path.startsWith("/api/pairing") ||
      path.startsWith("/connect.")
    ) {
      forbiddenRequests.push(path)
    }
  })
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) topLevelNavigations += 1
  })
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...connection, mcpAuthMode: "oauth" }),
    })
  )
  await page.route("**/api/agent-connections", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        connections: [
          {
            id: "oauth:conn_app_claude",
            authKind: "oauth",
            displayName: "Claude",
            target: { kind: "mcp-client", clientId: "conn_app_claude" },
            mode: "on-demand",
            participant: null,
            machine: null,
            scopes: ["docs:read"],
            connectedAt: null,
            lastSeenAt: null,
            permissionGroups: null,
          },
        ],
      }),
    })
  )

  await openAgents(page)
  const navigationsAfterOpen = topLevelNavigations
  const originalUrl = page.url()
  const dialog = page.getByRole("dialog")

  await expect(
    dialog.getByRole("button", { name: /^Coding agents/ })
  ).toHaveAttribute("aria-expanded", "true")
  await expect(dialog.getByText("Claude", { exact: true })).toBeVisible()
  await expect(dialog.getByText("Not used yet", { exact: true })).toBeVisible()
  await expect(
    dialog.getByRole("heading", { name: "Connected agents" })
  ).toBeVisible()
  await expect(dialog.getByRole("button", { name: "New token" })).toHaveCount(0)
  expect(forbiddenRequests).toEqual([])
  expect(page.url()).toBe(originalUrl)
  expect(topLevelNavigations).toBe(navigationsAfterOpen)
})

test("local setup uses one disclosure at a time and separates connection management", async ({
  page,
}) => {
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...connection, mcpAuthMode: "local-token" }),
    })
  )

  await openAgents(page)
  const dialog = page.getByRole("dialog")

  const quickConnect = dialog.getByRole("button", {
    name: /^Coding agents/,
  })
  const alwaysOn = dialog.getByRole("button", {
    name: /^OpenClaw/,
  })
  const desktopApps = dialog.getByRole("button", {
    name: /^Claude and ChatGPT/,
  })
  const manualInstall = dialog.getByRole("button", {
    name: /^Manual setup/,
  })
  const accessTokens = dialog.getByRole("button", {
    name: /^Access tokens/,
  })

  await expect(
    dialog.getByRole("heading", { name: "Connected agents" })
  ).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Advanced" })).toBeVisible()
  await expect(quickConnect).toHaveAttribute("aria-expanded", "true")
  await expect(dialog.getByRole("button", { name: "Connect" })).toBeVisible()
  await expect(desktopApps).toHaveAttribute("aria-expanded", "false")
  await expect(alwaysOn).toHaveAttribute("aria-expanded", "false")
  await expect(manualInstall).toHaveAttribute("aria-expanded", "false")
  await expect(
    dialog.getByRole("link", { name: "Download extension" })
  ).toBeHidden()

  await desktopApps.click()
  await expect(quickConnect).toHaveAttribute("aria-expanded", "false")
  await expect(desktopApps).toHaveAttribute("aria-expanded", "true")
  await expect(dialog.getByRole("button", { name: "Connect" })).toBeHidden()
  await expect(
    dialog.getByRole("link", { name: "Download extension" })
  ).toBeVisible()

  await dialog.getByRole("combobox", { name: "Desktop app" }).click()
  await page.getByRole("option", { name: "ChatGPT desktop" }).click()
  await expect(
    dialog.getByRole("combobox", { name: "Desktop app" })
  ).toHaveText("ChatGPT desktop")
  await expect(
    dialog.getByRole("link", { name: "Download extension" })
  ).toBeHidden()

  await alwaysOn.click()
  await expect(desktopApps).toHaveAttribute("aria-expanded", "false")
  await expect(alwaysOn).toHaveAttribute("aria-expanded", "true")
  await expect(dialog.getByRole("button", { name: "Install" })).toBeVisible()
  await expect(dialog.getByText("Home Space", { exact: true })).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Connect" })).toBeVisible()

  await expect(accessTokens).toHaveAttribute("aria-expanded", "false")
  await expect(
    dialog.getByText("No active tokens", { exact: true })
  ).toBeVisible()
  await expect(dialog.getByRole("button", { name: "New token" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Disconnect" })).toHaveCount(
    0
  )
  await accessTokens.click()
  await expect(dialog.getByText("No active access tokens.")).toBeVisible()
})

test("local Desktop Settings manages the two skill targets from allowed operations", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: Array<{ command: string; args?: unknown }> = []
    let removed = false
    const statuses = () => [
      {
        targetId: "claude",
        label: "Claude",
        state: removed ? "not-installed" : "current",
        detail: removed
          ? "Worktable skills are not installed in this folder."
          : "Installed skills match this Worktable release.",
        targetRoot: "/Users/test/.claude/skills",
        resolvedTargetRoot: "/Users/test/.claude/skills",
        sourcePackageDigest: "package-v1",
        installedPackageDigest: removed ? null : "package-v1",
        missingSkills: [],
        modifiedSkills: [],
        allowedOperations: removed ? ["install"] : ["remove"],
      },
      {
        targetId: "agents",
        label: "Other agents",
        state: "conflict",
        detail: "Worktable won’t overwrite skill folders it does not manage.",
        targetRoot: "/Users/test/.agents/skills",
        resolvedTargetRoot: "/Users/test/.agents/skills",
        sourcePackageDigest: "package-v1",
        installedPackageDigest: null,
        missingSkills: [],
        modifiedSkills: [],
        allowedOperations: [],
      },
    ]
    Object.assign(window, {
      __desktopSkillCalls: calls,
      __TAURI__: {
        core: {
          invoke: async (command: string, args?: unknown) => {
            calls.push({ command, args })
            if (command === "desktop_agent_skills_status") {
              return { schemaVersion: 2, statuses: statuses() }
            }
            if (command === "desktop_agent_skills_preview") {
              const status = statuses().find(
                (item) =>
                  item.targetId === (args as { targetId: string }).targetId
              )
              return {
                schemaVersion: 2,
                preview: {
                  planId: "a".repeat(64),
                  allowed: true,
                  action: "remove",
                  changes: ["Remove six unchanged Worktable skill folders."],
                  status,
                },
              }
            }
            if (command === "desktop_agent_skills_apply") {
              removed = true
              const statusAfter = statuses().find(
                (item) => item.targetId === "claude"
              )
              return {
                schemaVersion: 2,
                result: { applied: true, statusAfter },
              }
            }
            throw new Error(`Unexpected Desktop command: ${command}`)
          },
        },
      },
    })
  })
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...connection, mcpAuthMode: "local-token" }),
    })
  )

  await openAgents(page)
  const dialog = page.getByRole("dialog")
  const skillDisclosure = dialog.getByRole("button", {
    name: "Local agent skills 1 needs attention",
  })
  await expect(skillDisclosure).toHaveAttribute("aria-expanded", "false")
  await skillDisclosure.click()
  const claude = dialog.getByRole("group", { name: "Claude" })
  await expect(claude.getByText("Installed", { exact: true })).toBeVisible()
  const agents = dialog.getByRole("group", { name: "Other agents" })
  await expect(agents.getByText("Can’t install", { exact: true })).toBeVisible()
  await expect(
    agents.getByRole("button", {
      name: "Remove Worktable skills for Other agents",
    })
  ).toHaveCount(0)
  await claude
    .getByRole("button", { name: "Remove Worktable skills for Claude" })
    .click()

  const confirmation = page.getByRole("dialog", {
    name: "Remove Worktable skills for Claude?",
  })
  await expect(
    confirmation.getByText("Remove six unchanged Worktable skill folders.")
  ).toBeVisible()
  await expect(
    confirmation.getByText("Your agent connections won’t be affected.")
  ).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __desktopSkillCalls: Array<{ command: string }>
          }
        ).__desktopSkillCalls.filter(
          ({ command }) => command === "desktop_agent_skills_apply"
        ).length
    )
  ).toBe(0)

  await confirmation.getByRole("button", { name: "Remove skills" }).click()
  await expect(claude.getByText("Not installed", { exact: true })).toBeVisible()
  await expect(
    page.getByText("Worktable skills for Claude removed.")
  ).toBeVisible()
})

test("switching setup disclosures preserves a one-time manual token", async ({
  page,
}) => {
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...connection, mcpAuthMode: "local-token" }),
    })
  )
  await page.route("**/api/tokens", (route) => {
    if (route.request().method() !== "POST") return route.continue()
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        token: "wt_123456789abc_manual-secret",
        metadata: {
          id: "123456789abc",
          user: "owner",
          agent: "claude-code",
          scopes: ["docs:*"],
          workspace: "/tmp/worktable",
          createdAt: new Date().toISOString(),
          revokedAt: null,
          lastUsedAt: null,
        },
      }),
    })
  })

  await openAgents(page)
  const dialog = page.getByRole("dialog")
  const manualInstall = dialog.getByRole("button", {
    name: /^Manual setup/,
  })
  const desktopApps = dialog.getByRole("button", {
    name: /^Claude and ChatGPT/,
  })

  await manualInstall.click()
  await dialog
    .getByRole("button", { name: "Generate connection token" })
    .click()
  const oneTimeNotice = dialog.getByRole("note")
  await expect(oneTimeNotice).toBeVisible()

  await desktopApps.click()
  await expect(oneTimeNotice).toBeHidden()
  await manualInstall.click()
  await expect(oneTimeNotice).toBeVisible()
})

test("a failed connection refetch preserves a newly minted one-time token", async ({
  page,
}) => {
  let connectionRequests = 0
  await page.route("**/api/system/connection", (route) => {
    connectionRequests += 1
    if (connectionRequests === 1) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...connection, mcpAuthMode: "local-token" }),
      })
    }
    return route.fulfill({ status: 503, body: "temporarily unavailable" })
  })
  await page.route("**/api/tokens", (route) => {
    if (route.request().method() !== "POST") return route.continue()
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        token: "wt_123456789abc_one-time-secret",
        metadata: {
          id: "123456789abc",
          user: "owner",
          agent: null,
          scopes: ["*"],
          workspace: "/tmp/worktable",
          createdAt: new Date().toISOString(),
          revokedAt: null,
          lastUsedAt: null,
        },
      }),
    })
  })

  await openAgents(page)
  const settings = page.getByRole("dialog")
  await settings.getByRole("button", { name: "New token" }).click()
  const tokenDialog = page.getByRole("dialog", { name: "New access token" })
  await tokenDialog.getByText("Full access (*)", { exact: true }).click()
  await tokenDialog.getByRole("button", { name: "Create token" }).click()

  await expect(
    page.getByRole("dialog", { name: "Token created" })
  ).toBeVisible()
  await expect
    .poll(() => connectionRequests, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(3)
  await expect(
    page.getByText("Copy this token now. It won’t be shown again.")
  ).toBeVisible()
  await expect(
    settings.getByText("Couldn’t read the agent connection settings.")
  ).toHaveCount(0)
})
