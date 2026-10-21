import { expect, test, type Page, type WebSocketRoute } from "@playwright/test"
import {
  defaultSharingPolicy,
  type ShareLink,
  type SharingPolicyResponse,
} from "@worktable/types"
import { writeFile } from "node:fs/promises"
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
    workspacePortability: true,
    editorSettings: true,
    historySettings: true,
    softwareUpdates: false,
    updateChecks: false,
    documentSharing: true,
  },
} as const

async function createFixture(): Promise<void> {
  const headers = { "Content-Type": "application/json" }
  const space = await fetch(`${harness.apiUrl}/api/spaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Share Browser" }),
  })
  expect(space.status).toBe(201)

  await writeFile(
    harness.workspacePath("spaces/share-browser/docs/launch-plan.md"),
    "# Launch plan\n\nThe latest saved plan.\n"
  )

  const widget = await fetch(
    `${harness.apiUrl}/api/spaces/share-browser/widgets`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "status-card",
        name: "Status card",
        html: "<!doctype html><main><h1>On track</h1></main>",
      }),
    }
  )
  expect(widget.status).toBe(201)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function mockCloudSharing(
  page: Page,
  options: { createGate?: Promise<void>; sharingEnabled?: () => boolean } = {}
) {
  let share: { url: string; createdAt: string } | null = null
  const mutations: Array<{ method: string; body: unknown }> = []

  await page.route("**/api/system/deployment", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        options.sharingEnabled
          ? {
              ...cloudDeployment,
              mode: "self-managed",
              capabilities: {
                ...cloudDeployment.capabilities,
                documentSharing: options.sharingEnabled(),
              },
            }
          : cloudDeployment
      ),
    })
  )
  await page.route(/\/api\/shares(?:\?.*)?$/, async (route) => {
    const request = route.request()
    const method = request.method()
    if (method === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ share }),
      })
      return
    }

    const body = request.postDataJSON()
    mutations.push({ method, body })
    if (method === "POST") {
      await options.createGate
      share = {
        url: "https://share.worktable.cloud/s/workspace_browser/abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
        createdAt: "2026-08-08T00:00:00.000Z",
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ share }),
      })
      return
    }

    share = null
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    })
  })

  return mutations
}

test.beforeAll(async () => {
  harness = await startWebHarness("sharing-browser")
  await createFixture()
})

test.afterAll(async () => {
  await harness?.stop()
})

test("keeps confirmed policy saves cached and recovers a newer owner update during settlement", async ({
  page,
}) => {
  let current: SharingPolicyResponse = {
    policy: defaultSharingPolicy(),
    revision: 1,
    canEdit: true,
  }
  let policyReads = 0
  let linkReads = 0
  let holdRefresh = false
  const revisions: Array<string | undefined> = []
  const saveGate = deferred()
  const refreshGate = deferred()
  const sockets: WebSocketRoute[] = []
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    sockets.push(socket)
  })
  await page.route("**/api/system/deployment", (route) =>
    route.fulfill({
      json: {
        ...cloudDeployment,
        capabilities: {
          ...cloudDeployment.capabilities,
          sharingPreview: true,
          shareLinks: true,
        },
      },
    })
  )
  await page.route("**/api/shares/links/all**", (route) => {
    linkReads++
    return route.fulfill({ json: { links: [], spaces: [], nextCursor: null } })
  })
  await page.route("**/api/shares/policy", async (route) => {
    if (route.request().method() === "GET") {
      policyReads++
      if (holdRefresh) await refreshGate.promise
      await route.fulfill({ json: current })
      return
    }
    revisions.push(route.request().headers()["if-match"])
    const saved: SharingPolicyResponse = {
      policy: route.request().postDataJSON(),
      revision: current.revision + 1,
      canEdit: true,
    }
    current = saved
    if (revisions.length === 2) await saveGate.promise
    await route.fulfill({ json: saved })
  })
  try {
    await page.goto(appUrl("/spaces/share-browser/documents/launch-plan"), {
      waitUntil: "domcontentloaded",
    })
    await expect(
      page.getByRole("button", { name: "Share document" })
    ).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => sockets.length).toBeGreaterThan(0)
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("worktable:open-settings", {
          detail: { section: "links" },
        })
      )
    )
    const settings = page.getByRole("dialog")
    const paused = settings.getByRole("switch", { name: "Pause all links" })
    const passwords = settings.getByRole("switch", {
      name: "Require a password",
    })
    await expect(paused).not.toBeChecked()
    await expect(
      settings.getByText("No links yet", { exact: true })
    ).toBeVisible()
    const initialPolicyReads = policyReads
    const initialLinkReads = linkReads
    await paused.click()
    await expect.poll(() => linkReads).toBeGreaterThan(initialLinkReads)
    expect(policyReads).toBe(initialPolicyReads)
    await expect(paused).toBeChecked()

    await paused.click()
    await expect.poll(() => revisions.length).toBe(2)
    holdRefresh = true
    const linksBeforeExternalChange = linkReads
    current = {
      ...current,
      revision: 4,
      policy: { ...current.policy, requirePassword: true },
    }
    for (const socket of sockets)
      socket.send(JSON.stringify({ type: "share_policy_changed", revision: 4 }))
    await expect.poll(() => policyReads).toBe(initialPolicyReads + 1)
    await expect
      .poll(() => linkReads)
      .toBeGreaterThan(linksBeforeExternalChange)
    const linksBeforeSettlement = linkReads
    saveGate.resolve()
    await expect.poll(() => linkReads).toBeGreaterThan(linksBeforeSettlement)
    refreshGate.resolve()
    await expect(passwords).toBeChecked()

    await paused.click()
    await expect.poll(() => revisions.length).toBe(3)
    expect(revisions).toEqual(['"1"', '"2"', '"4"'])
    expect(current.policy.requirePassword).toBe(true)
  } finally {
    saveGate.resolve()
    refreshGate.resolve()
  }
})

test("creates, copies, and stops one Doc link from the persistent header action", async ({
  page,
  context,
  browserName,
}) => {
  let sharingEnabled = false
  const createGate = deferred()
  const mutations = await mockCloudSharing(page, {
    createGate: createGate.promise,
    sharingEnabled: () => sharingEnabled,
  })
  let copiedText = ""
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: harness.webUrl,
    })
  } else {
    // Playwright cannot grant clipboard permissions in Firefox or WebKit.
    // Chromium exercises the system clipboard; these engines mock that OS
    // boundary while keeping the full create/copy/stop interaction and bytes.
    await page.exposeFunction("recordShareClipboard", (text: string) => {
      copiedText = text
    })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: (text: string) =>
            (
              window as unknown as {
                recordShareClipboard: (text: string) => Promise<void>
              }
            ).recordShareClipboard(text),
        },
      })
    })
  }
  await page.goto(appUrl("/spaces/share-browser/documents/launch-plan"), {
    waitUntil: "domcontentloaded",
  })

  const shareButton = page.getByRole("button", { name: "Share document" })
  await expect(page.getByRole("button", { name: "More actions" })).toBeVisible({
    timeout: 30_000,
  })
  await expect(shareButton).toBeHidden()
  // Linked sharing that becomes available while the person is away shows when
  // they return to the tab; nothing polls for it meanwhile.
  sharingEnabled = true
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
  )
  await expect(shareButton).toBeVisible({ timeout: 30_000 })
  await shareButton.click()

  const dialog = page.getByRole("dialog", { name: "Share document" })
  await expect(
    dialog.getByText("Anyone with the link", { exact: true })
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Create link" }).click()
  await expect(dialog.getByRole("button", { name: "Creating…" })).toBeVisible()
  await expect(
    dialog.getByText("Anyone with the link", { exact: true })
  ).toBeVisible()
  await expect(
    dialog.getByRole("heading", { name: "Share document" })
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toBeVisible()

  createGate.resolve()

  const shareUrl = dialog.getByLabel("Share link")
  await expect(shareUrl).toHaveValue(/https:\/\/share\.worktable\.cloud\/s\//)
  await expect(dialog.getByText(/move or rename this document/i)).toBeVisible()
  await dialog.getByRole("button", { name: "Copy link" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  const clipboard =
    browserName === "chromium"
      ? await page.evaluate(() => navigator.clipboard.readText())
      : copiedText
  expect(clipboard).toBe(await shareUrl.inputValue())
  await dialog.getByRole("button", { name: "Done" }).click()
  await expect(shareButton).toHaveAttribute("title", "Share link active")

  await shareButton.click()
  await dialog.getByRole("button", { name: "Stop sharing" }).click()
  await expect(
    dialog.getByRole("heading", { name: "Stop this link?" })
  ).toBeVisible()
  await expect(shareUrl).toBeVisible()
  await dialog
    .getByRole("button", { name: "Stop sharing", exact: true })
    .click()
  await expect(dialog.getByText("Not shared")).toBeVisible()
  await expect(
    dialog.getByRole("button", { name: "Create link" })
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(shareButton).toHaveAttribute("title", "Share document")

  sharingEnabled = false
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
  )
  await expect(shareButton).toBeHidden({ timeout: 10_000 })

  expect(mutations).toEqual([
    {
      method: "POST",
      body: {
        kind: "doc",
        spaceId: "share-browser",
        artifactKey: "launch-plan",
      },
    },
    {
      method: "DELETE",
      body: {
        kind: "doc",
        spaceId: "share-browser",
        artifactKey: "launch-plan",
      },
    },
  ])
})

test("explains the inert shared-HTML boundary before creating a link", async ({
  page,
}) => {
  const mutations = await mockCloudSharing(page)
  await page.goto(appUrl("/spaces/share-browser/documents/status-card"), {
    waitUntil: "domcontentloaded",
  })

  const shareButton = page.getByRole("button", { name: "Share document" })
  await expect(shareButton).toBeVisible({ timeout: 30_000 })
  await shareButton.click()
  const dialog = page.getByRole("dialog", { name: "Share document" })
  await expect(
    dialog.getByText(/Records and links to other Worktable content/i)
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Create link" }).click()

  await expect
    .poll(() => mutations)
    .toContainEqual({
      method: "POST",
      body: {
        kind: "html",
        spaceId: "share-browser",
        artifactKey: "status-card",
      },
    })
})

test("creates and edits password links without retaining a password in the form", async ({
  page,
}, testInfo) => {
  const mutations: Array<{ method: string; body: Record<string, unknown> }> = []
  let links: ShareLink[] = []
  let requirePassword = false
  await page.route("**/api/system/deployment", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...cloudDeployment,
        capabilities: {
          ...cloudDeployment.capabilities,
          shareLinks: true,
          sharingPreview: true,
        },
      }),
    })
  )
  await page.route(
    "**/api/spaces/share-browser/documents/page?*",
    async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.page.sharing = { activeLinks: links.length, canCreate: true }
      body.page.capabilities.sharing = true
      await route.fulfill({ response, json: body })
    }
  )
  await page.route(
    /\/api\/shares\/links(?:\/[^/?]+)?(?:\?.*)?$/,
    async (route) => {
      const method = route.request().method()
      if (method === "GET") {
        await route.fulfill({
          json: {
            links,
            canCreate: true,
            policy: { ...defaultSharingPolicy(), requirePassword },
          },
        })
        return
      }
      const body = route.request().postDataJSON() as Record<string, unknown>
      mutations.push({ method, body })
      if (method === "POST") {
        const link: ShareLink = {
          id: "lnk_aaaaaaaaaaaaaaaaaaaaaa",
          spaceId: "share-browser",
          documentId: "doc_plan",
          kind: "doc",
          path: "launch-plan",
          title: "Launch plan",
          label: String(body.label),
          level: "view",
          createdBy: { id: "local:owner", name: "Owner" },
          createdAt: new Date().toISOString(),
          expiresAt: null,
          hasPassword: typeof body.password === "string",
          lastUsedAt: null,
          status: "active",
          tokenHint: "abcd",
          canManage: true,
          comments: {
            acceptComments: true,
            anonymousAllowed: false,
            showSharerName: false,
            visitorsSee: "own",
            autoPaused: false,
          },
        }
        links = [link]
        await route.fulfill({
          status: 201,
          json: {
            link,
            url: "https://share.example.test/s/workspace/" + "a".repeat(43),
          },
        })
      } else {
        const link = {
          ...links[0]!,
          label: String(body.label),
          ...(body.password !== undefined
            ? { hasPassword: body.password !== null }
            : {}),
        }
        links = [link]
        await route.fulfill({ json: { link } })
      }
    }
  )
  await page.goto(appUrl("/spaces/share-browser/documents/launch-plan"), {
    waitUntil: "domcontentloaded",
  })
  const share = page.getByRole("button", { name: "Share document" })
  await expect(share).toBeVisible({ timeout: 30_000 })
  await share.click()
  const dialog = page.getByRole("dialog", { name: "Share document" })
  await dialog.getByLabel("Label", { exact: true }).fill("Board")
  await dialog.getByRole("switch", { name: "Password", exact: true }).click()
  await dialog
    .getByLabel("Link password", { exact: true })
    .fill("test-only board password")
  await dialog.screenshot({
    path: testInfo.outputPath("password-link-form.png"),
  })
  await dialog.getByRole("button", { name: "Create link", exact: true }).click()
  await expect(
    dialog.getByText("Copy it now. It won’t be shown again.")
  ).toBeVisible()
  expect(mutations[0]?.body.password).toBe("test-only board password")
  const edit = async () => {
    await dialog.getByRole("button", { name: "Actions for Board" }).click()
    await page.getByRole("menuitem", { name: "Edit Link" }).click()
  }
  await edit()
  await expect(dialog.getByLabel("New password", { exact: true })).toHaveValue(
    ""
  )
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true })
  ).toBeHidden()
  expect(mutations[1]?.body).not.toHaveProperty("password")
  await edit()
  await dialog
    .getByLabel("New password", { exact: true })
    .fill("replacement test password")
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true })
  ).toBeHidden()
  expect(mutations[2]?.body.password).toBe("replacement test password")
  await edit()
  await dialog.getByRole("switch", { name: "Password", exact: true }).click()
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true })
  ).toBeHidden()
  expect(mutations[3]?.body.password).toBeNull()
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  requirePassword = true
  await share.click()
  await dialog.getByRole("button", { name: "New link", exact: true }).click()
  await expect(
    dialog.getByRole("switch", { name: "Password", exact: true })
  ).toBeChecked()
  await expect(
    dialog.getByRole("switch", { name: "Password", exact: true })
  ).toBeDisabled()
  await expect(
    dialog.getByLabel("Link password", { exact: true })
  ).toHaveAttribute("required", "")
  await expect(dialog.getByLabel("Link password", { exact: true })).toHaveValue(
    ""
  )
  await dialog.getByRole("button", { name: "Create link", exact: true }).click()
  expect(mutations).toHaveLength(4)
})
