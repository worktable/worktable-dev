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

const SHARED_URL =
  "https://share.worktable.cloud/s/workspace_browser/abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"

/** A Cloud Worktable whose pages carry their links, as without the preview. */
async function mockCloudSharing(
  page: Page,
  options: { createGate?: Promise<void>; sharingEnabled?: () => boolean } = {}
) {
  let links: ShareLink[] = []
  const created: Array<Record<string, unknown>> = []

  await page.route("**/api/system/deployment", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...cloudDeployment,
        capabilities: {
          ...cloudDeployment.capabilities,
          documentSharing: options.sharingEnabled?.() ?? true,
          shareLinks: true,
          sharingPreview: false,
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
  await page.route(/\/api\/shares\/links(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: { links, canCreate: true, policy: defaultSharingPolicy() },
      })
      return
    }
    const body = route.request().postDataJSON() as Record<string, unknown>
    created.push(body)
    await options.createGate
    const target = body.target as { kind: "doc" | "html"; path: string }
    const link: ShareLink = {
      id: "lnk_aaaaaaaaaaaaaaaaaaaaaa",
      spaceId: "share-browser",
      documentId: "doc_shared",
      kind: target.kind,
      path: target.path,
      title: target.path,
      label: String(body.label ?? ""),
      level: "view",
      createdBy: { id: "local:owner", name: "Owner" },
      createdAt: new Date().toISOString(),
      expiresAt: null,
      hasPassword: false,
      lastUsedAt: null,
      status: "active",
      tokenHint: SHARED_URL.slice(-4),
      url: SHARED_URL,
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
    await route.fulfill({ status: 201, json: { link, url: SHARED_URL } })
  })

  return created
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
  // The page's link summary, as a server that can share sends it.
  await page.route(
    "**/api/spaces/share-browser/documents/page?*",
    async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.page.sharing = { activeLinks: 0, canCreate: true }
      body.page.capabilities.sharing = true
      await route.fulfill({ response, json: body })
    }
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

test("creates a Doc link from the header action and copies it again later", async ({
  page,
  context,
  browserName,
}) => {
  let sharingEnabled = false
  const createGate = deferred()
  const created = await mockCloudSharing(page, {
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
    // boundary while keeping the full create and copy interaction and bytes.
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
  const clipboard = () =>
    browserName === "chromium"
      ? page.evaluate(() => navigator.clipboard.readText())
      : Promise.resolve(copiedText)
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
  await dialog.getByRole("button", { name: "Create link", exact: true }).click()
  createGate.resolve()
  await expect(dialog.getByText(SHARED_URL)).toBeVisible()
  await expect(dialog.getByText(/shown again/i)).toHaveCount(0)
  await dialog.getByRole("button", { name: "Copy", exact: true }).click()
  expect(await clipboard()).toBe(SHARED_URL)
  await dialog.getByRole("button", { name: "Done", exact: true }).click()

  // Opened again, the link's URL is still there to copy.
  if (browserName === "chromium")
    await page.evaluate(() => navigator.clipboard.writeText(""))
  else copiedText = ""
  await shareButton.click()
  await expect(dialog.getByText(SHARED_URL)).toHaveCount(0)
  await dialog.getByRole("button", { name: "Actions for Untitled link" }).click()
  await page.getByRole("menuitem", { name: "Copy Link" }).click()
  await expect.poll(clipboard).toBe(SHARED_URL)

  expect(created).toEqual([
    expect.objectContaining({
      target: { kind: "doc", spaceId: "share-browser", path: "launch-plan" },
    }),
  ])
  // Without the preview, a link carries no password, level or live data.
  expect(created[0]).not.toHaveProperty("password")
  expect(created[0]).not.toHaveProperty("grant")
  expect(created[0]).not.toHaveProperty("level")
})

test("explains the inert shared-HTML boundary before creating a link", async ({
  page,
}) => {
  const created = await mockCloudSharing(page)
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
  await dialog.getByRole("button", { name: "Create link", exact: true }).click()

  await expect
    .poll(() => created)
    .toContainEqual(
      expect.objectContaining({
        target: { kind: "html", spaceId: "share-browser", path: "status-card" },
      })
    )
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
    dialog.getByText("https://share.example.test/s/workspace/" + "a".repeat(43))
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
  // Existing reserved access is preserved by an ordinary metadata edit.
  // Creating new links still offers only the supported levels.
  requirePassword = false
  links = [{ ...links[0]!, level: "use" }]
  await page.reload({ waitUntil: "networkidle" })
  await share.click()
  await edit()
  await expect(
    dialog.getByRole("combobox", { name: "Access", exact: true })
  ).toContainText("Can use")
  await dialog.getByLabel("Label", { exact: true }).fill("Board renamed")
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true })
  ).toBeHidden()
  expect(mutations[4]?.body.label).toBe("Board renamed")
  expect(mutations[4]?.body).not.toHaveProperty("level")
})

for (const appearance of [
  { colorScheme: "light" as const, width: 1280, height: 900 },
  { colorScheme: "dark" as const, width: 390, height: 844 },
]) {
  test(`checks live link access before sharing in ${appearance.colorScheme} mode`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: appearance.width,
      height: appearance.height,
    })
    await page.emulateMedia({ colorScheme: appearance.colorScheme })
    await page.addInitScript(
      (theme) => localStorage.setItem("theme", theme),
      appearance.colorScheme
    )
    const at = new Date().toISOString()
    const initialGrant = {
      version: 1 as const,
      collections: {
        deals: {
          rows: null,
          fields: ["name"],
          timestamps: false,
        },
      },
      limits: { rowsPerQuery: 200, queriesPerMinute: 120, rowsPerHour: 10_000 },
      state: "visitor" as const,
    }
    let links: ShareLink[] = []
    const mutations: Array<Record<string, unknown>> = []
    const checks: Array<Record<string, unknown>> = []
    let laterSchema = false
    await page.route("**/api/system/deployment", (route) =>
      route.fulfill({
        json: {
          ...cloudDeployment,
          capabilities: {
            ...cloudDeployment.capabilities,
            shareLinks: true,
            sharingPreview: true,
          },
        },
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
        const request = route.request()
        if (new URL(request.url()).pathname.endsWith("/access")) {
          const body = request.postDataJSON()
          checks.push(body)
          const grant = body.grant ?? initialGrant
          await route.fulfill({
            json: {
              grant,
              effectiveGrant: grant,
              collections: {
                deals: {
                  version: 1,
                  kind: "worktable.recordSchema",
                  id: "deals",
                  name: "Deals",
                  fields: {
                    name: { type: "text", name: "Name" },
                    amount: { type: "number", name: "Amount" },
                    secret: { type: "text", name: "Secret" },
                  },
                  createdAt: at,
                  updatedAt: at,
                  createdBy: "test",
                  metadata: {},
                },
              },
              counts: { deals: 2 },
              sentences: ["Anyone with this link can read 2 Deals records."],
              warnings: body.observe
                ? [
                    {
                      code: "later_reads",
                      message: "Later filters may need other fields.",
                    },
                  ]
                : [],
              issues:
                Object.hasOwn(grant.collections, "gone") ||
                grant.collections.deals?.fields.includes("removed-field")
                  ? [
                      {
                        collectionId: "deals",
                        message: "Some saved access is no longer available.",
                      },
                    ]
                  : [],
              stateReadable: !laterSchema,
            },
          })
          return
        }
        if (request.method() === "GET") {
          await route.fulfill({
            json: {
              links,
              canCreate: true,
              policy: { ...defaultSharingPolicy(), liveLinks: true },
            },
          })
          return
        }
        const body = request.postDataJSON()
        mutations.push(body)
        const link: ShareLink = {
          id: "lnk_aaaaaaaaaaaaaaaaaaaaaa",
          spaceId: "share-browser",
          documentId: "doc_status",
          kind: "html",
          path: "status-card",
          title: "Status card",
          label: String(body.label),
          level: "view",
          grant:
            laterSchema && request.method() === "PATCH" && !body.grant
              ? (() => {
                  const saved = links[0]!.grant!
                  return {
                    ...saved,
                    collections: {
                      ...saved.collections,
                      deals: {
                        ...saved.collections.deals!,
                        fields: [
                          ...saved.collections.deals!.fields,
                          "removed-field",
                        ],
                      },
                      gone: { ...saved.collections.deals!, fields: [] },
                    },
                  }
                })()
              : (body.grant ?? links[0]?.grant),
          createdBy: { id: "local:owner", name: "Owner" },
          createdAt: at,
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          hasPassword: false,
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
      }
    )
    await page.goto(appUrl("/spaces/share-browser/documents/status-card"), {
      waitUntil: "domcontentloaded",
    })
    if (appearance.width < 640) {
      await page
        .locator("[data-worktable-app-header]")
        .getByRole("button", { name: "Status card", exact: true })
        .click()
      await page
        .getByRole("dialog", { name: "Page", exact: true })
        .getByRole("button", { name: "Share", exact: true })
        .click()
    } else await page.getByRole("button", { name: "Share document" }).click()
    const dialog = page.getByRole("dialog", { name: "Share document" })
    await dialog.getByRole("switch", { name: "Live tool", exact: true }).click()
    await expect(
      dialog.getByRole("heading", { name: "What this link opens" })
    ).toBeVisible()
    await expect(
      dialog.getByText("Anyone with this link can read 2 Deals records.")
    ).toBeVisible()
    expect(checks[0]?.observe).toBe(true)
    await expect(
      dialog.getByRole("checkbox", { name: "Name", exact: true })
    ).toBeChecked()
    await dialog.getByRole("checkbox", { name: "Amount", exact: true }).click()
    await dialog
      .getByRole("checkbox", { name: "Read team saved state", exact: true })
      .click()
    await expect(
      dialog.getByRole("button", { name: "Create link", exact: true })
    ).toBeDisabled()
    await dialog
      .getByRole("button", { name: "Check access", exact: true })
      .click()
    await expect(
      dialog.getByRole("button", { name: "Create link", exact: true })
    ).toBeEnabled()
    expect(checks[1]?.observe).toBe(true)
    await expect(
      dialog.getByText("Later filters may need other fields.")
    ).toBeVisible()
    if (appearance.width >= 640)
      await expect(
        dialog.getByRole("button", { name: "Close", exact: true })
      ).toBeInViewport()
    await dialog.screenshot({
      path: testInfo.outputPath(`live-access-${appearance.colorScheme}.png`),
    })
    await dialog
      .getByRole("button", { name: "Create link", exact: true })
      .click()
    await expect(
      dialog.getByRole("button", { name: "View as visitor", exact: true })
    ).toBeVisible()
    expect(mutations[0]).not.toHaveProperty("expiresAt")
    expect(
      (mutations[0]?.grant as typeof initialGrant).collections.deals.fields
    ).toEqual(["name", "amount"])
    await dialog
      .getByRole("button", { name: "Actions for Untitled link" })
      .click()
    await page.getByRole("menuitem", { name: "Edit Link" }).click()
    await expect
      .poll(() => checks.at(-1)?.linkId)
      .toBe("lnk_aaaaaaaaaaaaaaaaaaaaaa")
    laterSchema = true
    await dialog.getByLabel("Label", { exact: true }).fill("Board")
    await dialog.getByRole("button", { name: "Save", exact: true }).click()
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true })
    ).toBeHidden()
    expect(mutations[1]).not.toHaveProperty("grant")
    await dialog.getByRole("button", { name: "Actions for Board" }).click()
    await page.getByRole("menuitem", { name: "Edit Link" }).click()
    const teamState = dialog.getByRole("checkbox", {
      name: "Read team saved state",
      exact: true,
    })
    await expect(teamState).toBeChecked()
    await expect(teamState).toBeEnabled()
    await teamState.click()
    await dialog
      .getByRole("checkbox", { name: "gone (unavailable)", exact: true })
      .click()
    await dialog
      .getByRole("checkbox", {
        name: "removed-field (unavailable)",
        exact: true,
      })
      .click()
    await dialog
      .getByRole("button", { name: "Check access", exact: true })
      .click()
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true })
    ).toBeEnabled()
    const finalGrant = checks.at(-1)!.grant as typeof initialGrant
    expect(finalGrant.collections).not.toHaveProperty("gone")
    expect(finalGrant.state).toBe("visitor")
  })
}
