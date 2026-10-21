import { expect, test, type Page } from "@playwright/test"
import { defaultSharingPolicy, type ShareLink } from "@worktable/types"
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

test("creates, copies, and stops one Doc link from the persistent header action", async ({
  page,
  context,
}) => {
  let sharingEnabled = false
  const createGate = deferred()
  const mutations = await mockCloudSharing(page, {
    createGate: createGate.promise,
    sharingEnabled: () => sharingEnabled,
  })
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: harness.webUrl,
  })
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
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "https://share.worktable.cloud/s/"
  )
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
          mode: "scoped" as const,
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
                    ...(laterSchema
                      ? Object.fromEntries([
                          ...Array.from({ length: 7 }, (_, index) => [
                            `group-${index}`,
                            {
                              type: "select",
                              name: `Group ${index}`,
                              values: ["A", "B"],
                            },
                          ]),
                          ...Array.from({ length: 13 }, (_, index) => [
                            `measure-${index}`,
                            { type: "number", name: `Measure ${index}` },
                          ]),
                        ])
                      : {}),
                  },
                  createdAt: at,
                  updatedAt: at,
                  createdBy: "test",
                  metadata: {},
                },
              },
              counts: { deals: 2 },
              sentences: ["Anyone with this link can read 2 Deals records."],
              fixedReads: body.observe
                ? {
                    deals: [
                      { id: "read-1", query: { fields: ["name"] }, params: {} },
                    ],
                  }
                : {},
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
              stateReadable: true,
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
    const mode = dialog.getByRole("combobox", { name: "Read mode for Deals" })
    await mode.click()
    await page.getByRole("option", { name: "Totals", exact: true }).click()
    await expect(
      dialog.getByText(
        "Only totals are returned. Individual records stay hidden."
      )
    ).toBeVisible()
    await mode.click()
    await page.getByRole("option", { name: "Records", exact: true }).click()
    await dialog.getByRole("checkbox", { name: "Name", exact: true }).click()
    await dialog.getByRole("checkbox", { name: "Amount", exact: true }).click()
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
    await mode.click()
    await expect(
      page.getByRole("option", { name: "Saved reads", exact: true })
    ).toBeEnabled()
    await page.keyboard.press("Escape")
    await expect(dialog).toBeVisible()
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
    laterSchema = true
    await dialog.getByLabel("Label", { exact: true }).fill("Board")
    await dialog.getByRole("button", { name: "Save", exact: true }).click()
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true })
    ).toBeHidden()
    expect(mutations[1]).not.toHaveProperty("grant")
    await dialog.getByRole("button", { name: "Actions for Board" }).click()
    await page.getByRole("menuitem", { name: "Edit Link" }).click()
    await dialog
      .getByRole("checkbox", { name: "gone (unavailable)", exact: true })
      .click()
    await dialog
      .getByRole("checkbox", {
        name: "removed-field (unavailable)",
        exact: true,
      })
      .click()
    await mode.click()
    await page.getByRole("option", { name: "Totals", exact: true }).click()
    for (let index = 0; index < 6; index++)
      await dialog
        .getByRole("checkbox", { name: `Group ${index}`, exact: true })
        .click()
    await expect(
      dialog.getByRole("checkbox", { name: "Group 6", exact: true })
    ).toBeDisabled()
    for (let index = 0; index < 12; index++)
      await dialog
        .getByRole("checkbox", { name: `Measure ${index}`, exact: true })
        .click()
    await expect(
      dialog.getByRole("checkbox", { name: "Measure 12", exact: true })
    ).toBeDisabled()
    await dialog
      .getByRole("button", { name: "Check access", exact: true })
      .click()
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true })
    ).toBeEnabled()
    const finalGrant = checks.at(-1)!.grant as typeof initialGrant
    expect(finalGrant.collections).not.toHaveProperty("gone")
  })
}
