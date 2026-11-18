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

/** The app choices; picking one folds them into its card. */
function apps(page: Page) {
  return page.getByRole("dialog").getByRole("group", { name: "Apps" })
}

async function pick(page: Page, app: string) {
  await apps(page).getByRole("button", { name: app, exact: true }).click()
  // The apps fold away into the card's header.
  await expect(apps(page)).toBeHidden()
  return page.getByRole("dialog").getByRole("region", { name: `Connect ${app}` })
}

/** Plays the agent's machine: redeems a pairing code and finishes it. */
async function completePairing(code: string, body: Record<string, unknown>) {
  const redeemed = await fetch(`${harness.apiUrl}/api/pairing/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, ...body }),
  })
  expect(redeemed.ok).toBe(true)
  const { token } = await redeemed.json()
  const progress = await fetch(`${harness.apiUrl}/api/pairing/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, event: "config_written" }),
  })
  expect(progress.ok).toBe(true)
  const completed = await fetch(`${harness.apiUrl}/api/pairing/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ code }),
  })
  expect(completed.ok).toBe(true)
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
  const grokCard = await pick(page, "Grok Bot")
  await expect(grokCard.locator("img").first()).toHaveAttribute(
    "src",
    "/agent-logos/grok-bot.svg"
  )
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
  // Grok Bot is one app, whichever account connects.
  await grokCard.getByRole("button", { name: "Change", exact: true }).click()
  await expect(
    apps(page).getByRole("button", { name: "Grok Bot", exact: true })
  ).toHaveCount(1)
  await pick(page, "Grok Bot")
  await expect(
    connected.getByRole("listitem").filter({ hasText: "Orbit" })
  ).toHaveCount(1)
  await expect(
    dialog.getByRole("textbox", { name: "Bot name", exact: true })
  ).toHaveCount(0)
  await expect(comet).toContainText("Connected")
  await orbit.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(page.getByLabel("Bot name", { exact: true })).toHaveValue(
    "Orbit"
  )
  await expect(
    page.getByLabel("Bot email address", { exact: true })
  ).toHaveValue("orbit@mail.grokbot.com")
  await page.getByLabel("Bot name", { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({
    path: testInfo.outputPath("grok-connection-settings-mobile.png"),
    animations: "disabled",
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
  await expect(
    page.getByRole("dialog", { name: "Comet", exact: true })
  ).not.toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath("grok-multiple-accounts.png"),
    animations: "disabled",
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

  // Every app shows at once, the most used first and Other last.
  const tiles = apps(page).getByRole("button")
  const order = [
    "Claude",
    "ChatGPT",
    "Claude Code",
    "Codex",
    "OpenClaw",
    "Hermes",
    "Grok Bot",
    "Cursor",
    "Gemini",
    "Gemini CLI",
    "Antigravity",
    "Perplexity",
    "Other",
  ]
  await expect(tiles).toHaveCount(order.length)
  for (const [index, name] of order.entries())
    await expect(tiles.nth(index)).toHaveAccessibleName(name)
  await expect(
    dialog
      .getByRole("region", { name: "Connected Agents" })
      .getByText("Claude", { exact: true })
  ).toBeVisible()
  await expect(dialog.getByText("Not used yet", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "New token" })).toHaveCount(0)

  // Claude's plugin comes first; leaving for Claude opens a new tab.
  const claude = await pick(page, "Claude")
  await expect(apps(page)).toBeHidden()
  await expect(
    claude.getByText(
      "In Claude, go to Plugins, Add, Add marketplace, and paste this. Then add Worktable and sign in."
    )
  ).toBeVisible()
  await expect(claude.getByText("Through Worktable Cloud")).toBeVisible()
  await expect(
    claude.getByRole("link", { name: "Open Claude", exact: true })
  ).toHaveAttribute("target", "_blank")
  await expect(claude.getByText("Waiting for Claude")).toBeVisible()
  // The connector, for any plan, waits under Other Ways.
  await claude.getByRole("button", { name: "Other Ways" }).click()
  await expect(
    claude.getByRole("link", { name: "Add Connector", exact: true })
  ).toHaveAttribute("target", "_blank")
  await claude.getByRole("button", { name: "Change", exact: true }).click()
  await expect(apps(page)).toBeVisible()

  const grok = await pick(page, "Grok Bot")
  await expect(
    grok.getByText("Send this in Grok Bot, then authorize Worktable.", {
      exact: true,
    })
  ).toBeVisible()
  await grok.getByRole("button", { name: "Change", exact: true }).click()
  const other = await pick(page, "Other")
  await expect(
    other.getByText(connection.remoteMcpUrl, { exact: true })
  ).toBeVisible()
  // Manual Setup names where each link goes.
  const manual = dialog.getByRole("region", { name: "Manual Setup" })
  await expect(manual.getByText("Skills and the connection")).toBeVisible()
  await expect(
    manual.getByRole("link", { name: "GitHub", exact: true })
  ).toHaveAttribute("target", "_blank")
  await expect(
    manual.getByRole("link", { name: "Guide", exact: true })
  ).toHaveAttribute("target", "_blank")
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
  let cleanupRequests = 0
  let disconnectAttempts = 0
  await page.route("**/api/grok-bot/**", (route) => {
    cleanupRequests++
    expect(new URL(route.request().url()).searchParams.get("disconnect")).toBe(
      "1"
    )
    return route.fulfill({
      status: 503,
      json: { error: "Cleanup unavailable" },
    })
  })
  await page.route(
    "**/api/agent-connections/oauth%3Aconn_app_claude",
    (route) => {
      expect(route.request().method()).toBe("DELETE")
      if (++disconnectAttempts === 1)
        return route.fulfill({
          status: 503,
          json: { error: "Disconnect unavailable" },
        })
      disconnected = true
      return route.fulfill({ json: { ok: true } })
    }
  )
  // Disconnect lives in the agent's dialog and asks first.
  await dialog.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = page.getByRole("dialog", { name: "Grok Bot", exact: true })
  await editor.getByRole("button", { name: "Disconnect", exact: true }).click()
  const confirm = page.getByRole("dialog", { name: "Disconnect Grok Bot?" })
  await confirm.getByRole("button", { name: "Disconnect", exact: true }).click()
  await expect(
    page.getByText("Disconnect unavailable", { exact: true })
  ).toBeVisible()
  expect(cleanupRequests).toBe(0)
  await expect(
    confirm.getByRole("button", { name: "Disconnect", exact: true })
  ).toBeEnabled()
  await confirm.getByRole("button", { name: "Disconnect", exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(
    page.getByText("Agent disconnected. Could not remove its Grok routine.", {
      exact: true,
    })
  ).toBeVisible()
  expect(disconnected).toBe(true)
})

test("on Cloud, Done finishes the agent that signed in, so picking the app again waits for the next one", async ({
  page,
}) => {
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
  const connections: ReturnType<typeof agent>[] = []
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({ json: { ...connection, mcpAuthMode: "oauth" } })
  )
  await page.route("**/api/agent-connections", (route) =>
    route.fulfill({ json: { connections } })
  )

  await openAgents(page)
  let other = await pick(page, "Other")
  await expect(other.getByText("Waiting for your agent")).toBeVisible()
  connections.push(agent("agt_opencode", "OpenCode"))
  await expect(other.getByLabel("Name", { exact: true })).toHaveValue(
    "OpenCode"
  )
  await other.getByRole("button", { name: "Done", exact: true }).click()

  other = await pick(page, "Other")
  await expect(other.getByText("Waiting for your agent")).toBeVisible()
  connections.push(agent("agt_vscode", "VS Code"))
  await expect(other.getByLabel("Name", { exact: true })).toHaveValue("VS Code")
})

test("on this computer, each app says how it connects here, and Manual Setup says what works", async ({
  page,
}) => {
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({
      contentType: "application/json",
      // A local install with a password reports itself reachable; opened on
      // this computer, it's still this computer.
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
  // The Gemini app and Perplexity connect from their own servers.
  await expect(
    apps(page).getByRole("button", { name: "Gemini", exact: true })
  ).toHaveCount(0)
  await expect(
    apps(page).getByRole("button", { name: "Perplexity", exact: true })
  ).toHaveCount(0)

  const claudeCode = await pick(page, "Claude Code")
  await expect(claudeCode.getByText("On this computer")).toBeVisible()
  // One command: the skills install only once the connection works.
  await expect(claudeCode.locator("code")).toHaveText(
    /^curl -fsSL http:\/\/127\.0\.0\.1:\d+\/connect\.sh \| sh -s -- [A-Z0-9]{5}-[A-Z0-9]{5} --client claude-code && curl -fsSL https:\/\/worktable\.dev\/install-skills \| sh -s -- --target claude$/
  )
  await claudeCode.getByRole("button", { name: "Change", exact: true }).click()

  const openclaw = await pick(page, "OpenClaw")
  await expect(
    openclaw.getByText("Run this in your terminal.", { exact: true })
  ).toBeVisible()
  await openclaw.getByRole("button", { name: "Change", exact: true }).click()

  // Claude reaches this Worktable through Worktable Link; the Desktop
  // extension stays one step away.
  const claude = await pick(page, "Claude")
  await expect(claude.getByText("Through Worktable Link")).toBeVisible()
  await expect(claude.getByText("Turn on Worktable Link")).toBeVisible()
  await claude.getByRole("button", { name: "Other Ways" }).click()
  await expect(
    claude.getByRole("region", { name: "Desktop Extension" })
  ).toBeVisible()

  const manual = dialog.getByRole("region", { name: "Manual Setup" })
  await expect(
    manual.getByText("Skills and the connection, through Worktable Link")
  ).toBeVisible()
  await expect(
    manual.getByRole("link", { name: "Download", exact: true })
  ).toHaveCount(2)

  const accessTokens = dialog.getByRole("button", { name: /^Access tokens/ })
  await expect(accessTokens).toContainText("1 active token")
  await accessTokens.click()
  await expect(dialog.getByRole("row", { name: /studio-mac/ })).toBeVisible()
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

test("a one-time token made for an agent survives changing apps and settings sections, its first use connects it, and it joins the list on Done", async ({
  page,
}) => {
  // Time runs as usual, but a quiet stretch can pass without a real wait.
  await page.clock.install()
  // A loopback-only Worktable takes bare local calls, but the agent still
  // gets a token: it names the agent and tells this card it arrived.
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...connection,
        reachable: false,
        originConfigured: false,
        mcpTokenRequired: false,
        mcpAuthMode: "local-token",
      }),
    })
  )
  // The agent exists from the moment its token is made.
  const minted = {
    id: "manual-fixture",
    authKind: "local-token",
    displayName: "My agent",
    platform: "other",
    icon: null,
    access: { threads: true, read: true, edit: true },
    target: { kind: "mcp-client", clientId: null },
    mode: "on-demand",
    participant: null,
    machine: null,
    scopes: ["*"],
    connectedAt: null,
    lastSeenAt: null,
    permissionGroups: null,
  }
  let made = false
  await page.route("**/api/agent-connections", async (route) => {
    if (route.request().method() === "GET") {
      if (!made) return route.continue()
      const response = await route.fetch()
      const listed = await response.json()
      return route.fulfill({
        response,
        json: { ...listed, connections: [...listed.connections, minted] },
      })
    }
    if (route.request().method() !== "POST") return route.continue()
    made = true
    const grant = route.request().postDataJSON()
    expect(grant.client).toBeNull()
    // It connects with the default access; narrowing comes once it's in.
    expect(grant.access).toEqual({ threads: true, read: true, edit: true })
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        token: "wt_123456789abc_manual-secret",
        connection: minted,
      }),
    })
  })
  let used = false
  let tokenReads = 0
  await page.route("**/api/tokens", (route) => {
    if (route.request().method() !== "GET") return route.continue()
    tokenReads++
    return route.fulfill({
      json: {
        tokens: [
          {
            id: "123456789abc",
            user: "owner",
            agent: null,
            scopes: ["*"],
            workspace: "/tmp/worktable",
            createdAt: new Date().toISOString(),
            revokedAt: null,
            lastUsedAt: used ? new Date().toISOString() : null,
          },
        ],
      },
    })
  })

  await openAgents(page)
  const dialog = page.getByRole("dialog")
  const secret = dialog.getByText("wt_123456789abc_manual-secret", {
    exact: true,
  })
  const openToken = async () => {
    const other = await pick(page, "Other")
    await other.getByRole("button", { name: "Other Ways" }).click()
    return other.getByRole("region", { name: "Access Token" })
  }

  const token = await openToken()
  await expect(
    token.getByText(connection.endpoint, { exact: true })
  ).toBeVisible()
  const relisted = page.waitForResponse(
    (item) =>
      item.request().method() === "GET" &&
      new URL(item.url()).pathname === "/api/agent-connections" &&
      made
  )
  await token.getByRole("button", { name: "Create Token" }).click()
  await expect(secret).toBeVisible()
  // The list, read again with the new agent in it, stays as it was while the
  // card is open.
  await relisted
  const listedAgent = dialog
    .getByRole("region", { name: "Connected Agents", exact: true })
    .getByText("My agent", { exact: true })
  await expect(listedAgent).toHaveCount(0)

  await dialog.getByRole("button", { name: "Change", exact: true }).click()
  await expect(secret).toBeHidden()
  await openToken()
  await expect(secret).toBeVisible()

  // Another section keeps Agents mounted, but it stops waiting for the agent.
  await dialog.getByRole("button", { name: "General", exact: true }).click()
  await expect(secret).toBeHidden()
  const readsWhileAway = tokenReads
  await page.clock.runFor(4_000)
  expect(tokenReads).toBe(readsWhileAway)
  await dialog.getByRole("button", { name: "Agents", exact: true }).click()
  await expect(secret).toBeVisible()

  used = true
  const card = dialog.getByRole("region", { name: "Connect Other" })
  // It looks again every few seconds.
  await expect(card.getByRole("img", { name: "Connected" })).toBeVisible({
    timeout: 10_000,
  })
  await expect(secret).toBeHidden()
  await expect(listedAgent).toHaveCount(0)
  await card.getByRole("button", { name: "Done", exact: true }).click()
  await expect(listedAgent).toBeVisible()
})

test("an agent connected from its card is named and narrowed there, keeps its logo, and nothing moves", async ({
  page,
}) => {
  test.setTimeout(90_000)
  await openAgents(page)
  const dialog = page.getByRole("dialog")
  const inventory = dialog.getByRole("region", {
    name: "Connected Agents",
    exact: true,
  })
  for (const [app, client, label, logo] of [
    ["Claude Code", "claude-code", "Claude Code", "claude-code.svg"],
    ["Codex", "codex", "Codex CLI", "codex.svg"],
    ["Cursor", "cursor", "Cursor", "cursor.svg"],
    ["Other", "opencode", "opencode", "opencode.svg"],
    ["Other", "vscode", "VS Code", "vscode.svg"],
  ] as const) {
    const response = page.waitForResponse(
      (item) =>
        item.request().method() === "POST" &&
        new URL(item.url()).pathname === "/api/pairing"
    )
    const card = await pick(page, app)
    const createdResponse = await response
    expect(createdResponse.status()).toBe(201)
    const created = await createdResponse.json()
    expect(created.client).toBe(app === "Other" ? null : client)
    const before = (await card.boundingBox())?.y
    await completePairing(created.code, { client, hostname: "avatar-review" })

    // Connected in the same card, with the name Worktable gave it.
    const name = card.getByLabel("Name", { exact: true })
    await expect(name).toHaveValue(label)
    // Connecting moves nothing above the card.
    expect((await card.boundingBox())?.y).toBe(before)
    const saved = () =>
      page.waitForResponse(
        (item) =>
          item.request().method() === "PATCH" &&
          new URL(item.url()).pathname.startsWith("/api/agent-connections/")
      )
    let renamed: ReturnType<typeof saved> | null = null
    if (app === "Claude Code") {
      const narrowed = saved()
      await card.getByText("Edit workspace").click()
      expect((await narrowed).ok()).toBe(true)
      // A new name saves when the field is left, even straight for Done.
      renamed = saved()
      await name.fill("Studio Claude")
    }
    await card.getByRole("button", { name: "Done", exact: true }).click()
    await expect(apps(page)).toBeVisible()
    if (renamed) {
      expect((await renamed).ok()).toBe(true)
      expect(
        await fetch(`${harness.apiUrl}/api/agent-connections`).then((res) =>
          res.json()
        )
      ).toMatchObject({
        connections: expect.arrayContaining([
          expect.objectContaining({
            displayName: "Studio Claude",
            access: { threads: true, read: true, edit: false },
          }),
        ]),
      })
    }
    const image = inventory.locator(`img[src="/agent-logos/${logo}"]`)
    await expect(image.first()).toBeVisible()
    await expect
      .poll(() =>
        image
          .first()
          .evaluate((element) => (element as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0)
  }
  await expect(
    inventory.getByText("Studio Claude", { exact: true })
  ).toBeVisible()

  // Any agent can wear another app's logo, found by searching for it.
  const vscode = inventory
    .getByRole("listitem")
    .filter({ has: page.locator('img[src="/agent-logos/vscode.svg"]') })
  await vscode.getByRole("button", { name: "Edit", exact: true }).click()
  const editor = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("button", { name: "Save", exact: true }) })
  await editor.getByPlaceholder("Search icons...").fill("claude")
  await editor.getByRole("button", { name: "Claude", exact: true }).click()
  await editor.getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(
    inventory.locator('img[src="/agent-logos/claude.svg"]')
  ).toBeVisible()
  await expect(vscode).toHaveCount(0)
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

test("Move Here asks before moving ChatGPT into this Worktable, which connects it here with auto-reply", async ({
  page,
}) => {
  const chatgpt = "https://chatgpt.com/oauth/client.json"
  let here = false
  const moves: unknown[] = []
  const choices = () => ({
    apps: [
      {
        clientId: chatgpt,
        name: "ChatGPT",
        family: "chatgpt",
        changeUrl: "https://cloud.example.test/gateway/worktables/app?app=chatgpt",
        worktable: here
          ? { id: `wl_${"b".repeat(32)}`, name: "Notes", here: true }
          : { id: "hosted_one", name: "Studio", here: false },
      },
    ],
    appsUrl: "https://cloud.example.test/gateway/worktables/apps",
  })
  await page.route("**/api/system/connection", (route) =>
    route.fulfill({ json: { ...connection, mcpAuthMode: "local-token" } })
  )
  await page.route("**/api/linked", (route) =>
    route.fulfill({ json: { enabled: true, state: "online", account: { user: null } } })
  )
  await page.route("**/api/app-choices", async (route) => {
    if (route.request().method() === "POST") {
      moves.push(route.request().postDataJSON())
      here = true
    }
    await route.fulfill({ json: choices() })
  })
  // ChatGPT reaches this Worktable through Link once it works here.
  await page.route("**/api/agent-connections", (route) => {
    if (route.request().method() !== "GET") return route.continue()
    return route.fulfill({
      json: {
        connections: here
          ? [
              {
                id: "acn_link_chatgpt",
                authKind: "oauth",
                displayName: "ChatGPT",
                platform: "chatgpt",
                icon: null,
                access: null,
                target: { kind: "mcp-client", clientId: chatgpt },
                mode: "on-demand",
                participant: null,
                machine: null,
                scopes: [],
                connectedAt: null,
                lastSeenAt: null,
                permissionGroups: null,
                link: { manageUrl: "https://cloud.example.test/gateway/worktables/apps" },
                autoReply: { kind: "chat", state: "off" },
              },
            ]
          : [],
      },
    })
  })

  await openAgents(page)
  const card = await pick(page, "ChatGPT")
  await expect(card.getByText("Works in Studio")).toBeVisible()

  // It asks first, and Cancel leaves ChatGPT where it was.
  await card.getByRole("button", { name: "Move Here" }).click()
  const confirm = page.getByRole("dialog", { name: "Move ChatGPT here?" })
  await expect(confirm).toContainText(
    "It stops working in Studio, including any auto-reply there."
  )
  await confirm.getByRole("button", { name: "Cancel" }).click()
  expect(moves).toEqual([])
  await expect(card.getByText("Works in Studio")).toBeVisible()

  // Confirming moves it here, naming only the app, and it is connected:
  // Cloud holds its access, and auto-reply is one paste away.
  await card.getByRole("button", { name: "Move Here" }).click()
  await page
    .getByRole("dialog", { name: "Move ChatGPT here?" })
    .getByRole("button", { name: "Move Here" })
    .click()
  expect(moves).toEqual([{ clientId: chatgpt }])
  await expect(page.getByText("ChatGPT now works here.")).toBeVisible()
  await expect(card.getByRole("img", { name: "Connected" })).toBeVisible()
  await expect(card.getByText("Paste it into a Work chat")).toBeVisible()
  await expect(
    card.getByRole("link", { name: "Manage in Cloud" })
  ).toHaveAttribute("target", "_blank")
  await card.getByRole("button", { name: "Done", exact: true }).click()
  await expect(apps(page)).toBeVisible()
})
