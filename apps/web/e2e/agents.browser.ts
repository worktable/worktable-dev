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

test("a connected Grok account stays editable while another account is added", async ({
  page,
}, testInfo) => {
  const first = {
    id: "oauth:grok:first",
    displayName: "Comet",
    participantId: "ptc_comet",
    emailSender: "wake.first@agents.worktable.dev",
  }
  const second = {
    id: "oauth:grok:second",
    displayName: "Cursor",
    participantId: "ptc_orbit",
    emailSender: "wake.second@agents.worktable.dev",
  }
  const candidates = [first]
  const bots = [
    {
      connectionId: first.id,
      participantId: first.participantId,
      enabled: true,
      executionMinutes: 30,
      wakeMethod: "email",
      emailAddress: "comet@mail.grokbot.com",
      status: "ready",
      verifiedAt: "2026-10-23T00:00:00Z",
    },
  ]
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({ json: connection })
  )
  await page.route("**/api/agent-connections", (route) =>
    route.fulfill({
      json: {
        connections: [],
        grokBotMcpUrl: "https://example.test/mcp",
        grokBotCandidates: candidates,
        grokBots: bots,
      },
    })
  )
  await page.route("**/api/grok-bot/**", (route) => {
    expect(
      decodeURIComponent(new URL(route.request().url()).pathname)
    ).toContain(second.id)
    if (route.request().method() === "PUT") {
      expect(route.request().postDataJSON()).toMatchObject({
        name: "Orbit",
        wakeMethod: "email",
        emailAddress: "orbit@mail.grokbot.com",
      })
      second.displayName = "Orbit"
      bots.push({
        ...bots[0]!,
        connectionId: second.id,
        participantId: second.participantId,
        emailAddress: "orbit@mail.grokbot.com",
        status: "configured",
        verifiedAt: "",
      })
    } else {
      expect(new URL(route.request().url()).pathname).toMatch(/\/check$/)
      bots[1]!.status = "ready"
      bots[1]!.verifiedAt = "2026-10-23T01:00:00Z"
    }
    return route.fulfill({ json: { ok: true } })
  })
  await openAgents(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = page.getByRole("dialog")
  const connected = dialog.getByRole("region", { name: "Connected agents" })
  const comet = connected.getByRole("listitem").filter({ hasText: "Comet" })
  await comet.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(page.getByLabel("Bot name", { exact: true })).toHaveValue(
    "Comet"
  )
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await dialog.getByRole("button", { name: /^Always-on agents/ }).click()
  await dialog.getByRole("tab", { name: "Grok Bot", exact: true }).click()
  await expect(
    dialog.getByText("Send this in Grok Bot, then authorize Worktable.", {
      exact: true,
    })
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Continue", exact: true }).click()
  await dialog
    .getByRole("button", { name: "Refresh connections", exact: true })
    .click()
  await expect(
    dialog.getByRole("button", { name: "Refresh connections", exact: true })
  ).toBeVisible()
  candidates.push(second)
  await dialog
    .getByRole("button", { name: "Refresh connections", exact: true })
    .click()
  await dialog.getByLabel("Bot name", { exact: true }).fill("Orbit")
  await dialog
    .getByLabel("Bot email address", { exact: true })
    .fill("orbit@mail.grokbot.com")
  await dialog.getByRole("button", { name: "Continue", exact: true }).click()
  await dialog
    .getByRole("button", { name: "Save and check", exact: true })
    .click()
  const orbit = connected.getByRole("listitem").filter({ hasText: "Orbit" })
  await expect(orbit).toContainText("Connected")
  await expect(comet).toContainText("Connected")
  await orbit.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(page.getByLabel("Bot name", { exact: true })).toHaveValue(
    "Orbit"
  )
  await expect(
    page.getByLabel("Bot email address", { exact: true })
  ).toHaveValue("orbit@mail.grokbot.com")
  await page.screenshot({
    path: testInfo.outputPath("grok-connection-settings-mobile.png"),
  })
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await comet.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(page.getByLabel("Bot name", { exact: true })).toHaveValue(
    "Comet"
  )
  await expect(
    page.getByLabel("Bot email address", { exact: true })
  ).toHaveValue("comet@mail.grokbot.com")
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await page.screenshot({
    path: testInfo.outputPath("grok-multiple-accounts.png"),
  })
})

test("Cloud shows equivalent setup and inventory without touching local credential routes", async ({
  page,
}) => {
  let disconnected = false
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
        connections: disconnected
          ? []
          : [
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

  const quickConnect = dialog.getByRole("button", { name: /^Coding agents/ })
  await expect(quickConnect).toBeVisible()
  for (const disclosure of await dialog
    .locator('[data-slot="collapsible-trigger"]')
    .all()) {
    await expect(disclosure).toHaveAttribute("aria-expanded", "false")
  }
  await quickConnect.click()
  await expect(quickConnect).toHaveAttribute("aria-expanded", "true")
  await expect(
    dialog.getByRole("combobox", { name: "Cloud quick connect agent" })
  ).toBeVisible()
  await expect(
    dialog
      .getByRole("region", { name: "Connected agents" })
      .getByText("Claude", { exact: true })
  ).toBeVisible()
  await expect(dialog.getByText("Not used yet", { exact: true })).toBeVisible()
  await expect(
    dialog.getByRole("heading", { name: "Connected agents" })
  ).toBeVisible()
  await expect(dialog.getByRole("button", { name: "New token" })).toHaveCount(0)
  await dialog.getByRole("button", { name: /Connect any MCP agent/ }).click()
  await expect(dialog.getByRole("combobox")).toHaveCount(0)
  await expect(
    dialog
      .getByText(connection.remoteMcpUrl, { exact: true })
      .filter({ visible: true })
  ).toBeVisible()
  expect(forbiddenRequests).toEqual([])
  expect(page.url()).toBe(originalUrl)
  expect(topLevelNavigations).toBe(navigationsAfterOpen)
  await page.route("**/api/agent-connections?scope=workspace", (route) =>
    route.fulfill({
      json: {
        connections: [],
        grokBots: [
          {
            connectionId: "oauth:conn_app_claude:owner",
            participantId: "ptc_bot",
            status: "ready",
            enabled: true,
          },
        ],
      },
    })
  )
  await openAgents(page)
  await page.route("**/api/grok-bot/**", (route) =>
    route.fulfill({ status: 503, json: { error: "Cleanup unavailable" } })
  )
  await page.route(
    "**/api/agent-connections/oauth%3Aconn_app_claude",
    (route) => {
      expect(route.request().method()).toBe("DELETE")
      disconnected = true
      return route.fulfill({ json: { ok: true } })
    }
  )
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click()
  await expect(
    dialog.getByRole("button", { name: "Disconnect", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByText("Agent disconnected. Could not remove its Grok routine.", {
      exact: true,
    })
  ).toBeVisible()
  expect(disconnected).toBe(true)
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
  await page.route("**/api/tokens", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        tokens: [
          {
            id: "123456789abc",
            user: "owner",
            agent: "codex@studio-mac",
            scopes: ["docs:*"],
            workspace: "/tmp/worktable",
            createdAt: "2026-01-01T00:00:00Z",
            revokedAt: null,
            lastUsedAt: null,
          },
        ],
      }),
    })
  )

  await openAgents(page)
  const dialog = page.getByRole("dialog")

  const quickConnect = dialog.getByRole("button", {
    name: /^Coding agents/,
  })
  const alwaysOn = dialog.getByRole("button", {
    name: /^Always-on agents/,
  })
  const desktopApps = dialog.getByRole("button", {
    name: /^Chat apps/,
  })
  const accessTokens = dialog.getByRole("button", {
    name: /^Access tokens/,
  })
  const tokenRow = dialog.getByRole("row", { name: /studio-mac/ })

  await expect(
    dialog.getByRole("heading", { name: "Connected agents" })
  ).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Advanced" })).toBeVisible()
  await expect(accessTokens).toContainText("1 active token")
  for (const disclosure of await dialog
    .locator('[data-slot="collapsible-trigger"]')
    .all()) {
    await expect(disclosure).toHaveAttribute("aria-expanded", "false")
  }
  await expect(
    dialog.getByRole("button", { name: "Connect", exact: true })
  ).toBeHidden()
  await expect(tokenRow).toBeHidden()
  await expect(
    dialog.getByRole("link", { name: "Download extension" })
  ).toBeHidden()

  await quickConnect.click()
  await expect(quickConnect).toHaveAttribute("aria-expanded", "true")
  await expect(
    dialog.getByRole("button", { name: "Connect", exact: true })
  ).toBeVisible()

  await desktopApps.click()
  await expect(quickConnect).toHaveAttribute("aria-expanded", "false")
  await expect(desktopApps).toHaveAttribute("aria-expanded", "true")
  await expect(
    dialog.getByRole("button", { name: "Connect", exact: true })
  ).toBeHidden()
  await expect(
    dialog.getByRole("link", { name: "Download extension" })
  ).toBeVisible()

  await dialog.getByRole("tab", { name: "ChatGPT", exact: true }).click()
  await expect(
    dialog.getByRole("tab", { name: "ChatGPT", exact: true })
  ).toHaveAttribute("aria-selected", "true")
  await expect(
    dialog.getByRole("link", { name: "Download extension" })
  ).toBeHidden()

  await alwaysOn.click()
  await expect(desktopApps).toHaveAttribute("aria-expanded", "false")
  await expect(alwaysOn).toHaveAttribute("aria-expanded", "true")
  await expect(dialog.getByRole("button", { name: "Install" })).toBeVisible()
  await expect(dialog.getByText("Home Space", { exact: true })).toHaveCount(0)
  await expect(
    dialog.getByRole("button", { name: "Connect", exact: true })
  ).toBeVisible()

  await expect(accessTokens).toHaveAttribute("aria-expanded", "false")
  await expect(accessTokens).toContainText("1 active token")
  await expect(dialog.getByRole("button", { name: "New token" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Disconnect" })).toHaveCount(
    0
  )
  await accessTokens.click()
  await expect(tokenRow).toBeVisible()
  await accessTokens.click()
  await expect(accessTokens).toHaveAttribute("aria-expanded", "false")
  await expect(tokenRow).toBeHidden()
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

test("switching settings sections and setup disclosures preserves a one-time manual token", async ({
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
    const grant = route.request().postDataJSON()
    expect(grant.agent).toBe("My agent")
    expect(grant.scopes).toContain("docs:read")
    expect(grant.scopes).not.toContain("docs:write")
    expect(grant.scopes).not.toContain("docs:*")
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        token: "wt_123456789abc_manual-secret",
        metadata: {
          id: "123456789abc",
          user: "owner",
          agent: "My agent",
          scopes: grant.scopes,
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
    name: /Connect any MCP agent/,
  })
  const desktopApps = dialog.getByRole("button", {
    name: /^Chat apps/,
  })

  await manualInstall.click()
  await expect(dialog.getByRole("combobox")).toHaveCount(0)
  await expect(
    dialog
      .getByText(connection.remoteMcpUrl, { exact: true })
      .filter({ visible: true })
  ).toBeVisible()
  await dialog.getByRole("checkbox", { name: /^Edit workspace/ }).uncheck()
  await dialog.getByRole("button", { name: "Create access token" }).click()
  const oneTimeNotice = dialog.getByRole("note")
  await expect(oneTimeNotice).toBeVisible()
  await expect(
    dialog.getByText("wt_123456789abc_manual-secret", { exact: true })
  ).toBeVisible()

  await desktopApps.click()
  await expect(oneTimeNotice).toBeHidden()
  await manualInstall.click()
  await expect(oneTimeNotice).toBeVisible()

  await dialog.getByRole("button", { name: "General", exact: true }).click()
  await expect(oneTimeNotice).toBeHidden()
  await dialog.getByRole("button", { name: "Agents", exact: true }).click()
  await expect(oneTimeNotice).toBeVisible()
})

test("coding-agent selections keep their platform logos after connecting", async ({
  page,
}) => {
  test.setTimeout(60_000)
  await openAgents(page)
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: /^Coding agents/ }).click()
  const inventory = dialog.getByRole("region", {
    name: "Connected agents",
    exact: true,
  })
  for (const [client, label, logo] of [
    ["claude-code", "Claude Code", "claude.svg"],
    ["codex", "ChatGPT / Codex", "openai.svg"],
    ["cursor", "Cursor", "cursor.svg"],
    ["opencode", "opencode", "opencode.svg"],
    ["vscode", "VS Code", "vscode.svg"],
  ]) {
    await dialog
      .getByRole("combobox", { name: "Coding agent", exact: true })
      .click()
    await page.getByRole("option", { name: label, exact: true }).click()
    const response = page.waitForResponse(
      (item) =>
        item.request().method() === "POST" &&
        new URL(item.url()).pathname === "/api/pairing"
    )
    await dialog.getByRole("button", { name: "Connect", exact: true }).click()
    const createdResponse = await response
    expect(createdResponse.status()).toBe(201)
    const created = await createdResponse.json()
    expect(created.client).toBe(client)
    const redeemed = await fetch(`${harness.apiUrl}/api/pairing/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: created.code,
        client,
        hostname: "avatar-review",
      }),
    })
    expect(redeemed.ok).toBe(true)
    const { token } = await redeemed.json()
    const progress = await fetch(`${harness.apiUrl}/api/pairing/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: created.code, event: "config_written" }),
    })
    expect(progress.ok).toBe(true)
    const completed = await fetch(`${harness.apiUrl}/api/pairing/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: created.code }),
    })
    expect(completed.ok).toBe(true)
    const image = inventory.locator(`img[src="/agent-logos/${logo}"]`)
    await expect(image).toBeVisible()
    await expect
      .poll(() =>
        image.evaluate((element) => (element as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0)
  }
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
