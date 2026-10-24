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
const DAY = 86_400_000

const COMMENTS = {
  acceptComments: true,
  autoPaused: false,
} as const

/** A link as the server returns it, the nth made in a journey. */
function mockLink(
  index: number,
  target: { kind: "doc" | "html"; path: string },
  body: Record<string, unknown>
): ShareLink {
  return {
    id: `lnk_${String(index).padStart(22, "a")}`,
    spaceId: "share-browser",
    documentId: "doc_shared",
    kind: target.kind,
    path: target.path,
    title: target.path,
    label: String(body.label ?? ""),
    level: "view",
    createdBy: { id: "local:owner", name: "Owner" },
    createdAt: new Date(Date.now() + index).toISOString(),
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
    hasPassword: typeof body.password === "string",
    lastUsedAt: null,
    status: "active",
    tokenHint: "abcd",
    url: index === 0 ? SHARED_URL : `${SHARED_URL.slice(0, -1)}${index}`,
    canManage: true,
    comments: { ...COMMENTS },
  }
}

/** Applies a PATCH body as the server would. */
function patched(link: ShareLink, body: Record<string, unknown>): ShareLink {
  const next: ShareLink = { ...link }
  if (typeof body.label === "string") next.label = body.label
  if (body.expiresAt !== undefined)
    next.expiresAt = body.expiresAt as string | null
  if (body.password !== undefined) next.hasPassword = body.password !== null
  if (body.grant !== undefined) {
    if (body.grant) next.grant = body.grant as ShareLink["grant"]
    else delete next.grant
  }
  return next
}

type Mutation = { method: string; path: string; body: Record<string, unknown> }

/** A Cloud Worktable's link routes. */
async function mockSharing(
  page: Page,
  options: {
    createGate?: Promise<void>
    sharingEnabled?: () => boolean
    policy?: () => Partial<ReturnType<typeof defaultSharingPolicy>>
    links?: ShareLink[]
  } = {}
) {
  const state = { links: options.links ?? [], made: 0 }
  const mutations: Mutation[] = []

  await page.route("**/api/system/deployment", (route) =>
    route.fulfill({
      json: {
        ...cloudDeployment,
        capabilities: {
          ...cloudDeployment.capabilities,
          documentSharing: options.sharingEnabled?.() ?? true,
          shareLinks: true,
        },
      },
    })
  )
  await page.route(
    /\/api\/spaces\/share-browser\/documents\/page\?/,
    async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      body.page.sharing = {
        activeLinks: state.links.filter((link) => link.status === "active")
          .length,
        canCreate: true,
      }
      body.page.capabilities.sharing = true
      await route.fulfill({ response, json: body })
    }
  )
  await page.route(
    /\/api\/shares\/links(?:\/lnk_[^/?]+)?(?:\?.*)?$/,
    async (route) => {
      const request = route.request()
      const method = request.method()
      if (method === "GET") {
        await route.fulfill({
          json: {
            links: state.links,
            canCreate: true,
            policy: { ...defaultSharingPolicy(), ...options.policy?.() },
          },
        })
        return
      }
      const path = new URL(request.url()).pathname
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
      mutations.push({ method, path, body })
      if (method === "POST") {
        await options.createGate
        const link = mockLink(
          state.made++,
          body.target as { kind: "doc" | "html"; path: string },
          body
        )
        state.links = [link, ...state.links]
        await route.fulfill({ status: 201, json: { link, url: link.url } })
        return
      }
      const id = path.split("/").at(-1)
      const current = state.links.find((link) => link.id === id)!
      const link =
        method === "DELETE"
          ? { ...current, status: "revoked" as const }
          : patched(current, body)
      state.links =
        method === "DELETE"
          ? state.links.filter((candidate) => candidate.id !== id)
          : state.links.map((candidate) =>
              candidate.id === id ? link : candidate
            )
      await route.fulfill({ json: { link } })
    }
  )

  return { state, mutations }
}

/** Ignores the moment a journey's assertion ran, to the nearest day. */
function daysFromNow(iso: unknown): number {
  return Math.round((Date.parse(String(iso)) - Date.now()) / DAY)
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
    // The page may still be asking for itself as the test ends.
    await page.unrouteAll({ behavior: "ignoreErrors" })
  }
})

test("creates, copies, edits and revokes Doc links from the header action", async ({
  page,
  context,
  browserName,
}) => {
  let sharingEnabled = false
  const createGate = deferred()
  const { mutations } = await mockSharing(page, {
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
  const clearClipboard = async () => {
    if (browserName === "chromium")
      await page.evaluate(() => navigator.clipboard.writeText(""))
    else copiedText = ""
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

  const dialog = page.getByRole("dialog", { name: "Share “Launch plan”" })
  await expect(
    dialog.getByText("Anyone with the link can view this document")
  ).toBeVisible()
  // With no link yet, the settings it will have show first, and one button
  // makes it.
  await expect(dialog.getByRole("textbox")).toHaveCount(0)
  const expires = dialog.getByRole("button", { name: /^Expires/ })
  await expect(expires).toContainText("14 days")
  await expect(dialog.getByRole("button", { name: /^Password/ })).toContainText(
    "Off"
  )
  await dialog.getByRole("button", { name: "Create Link", exact: true }).click()
  createGate.resolve()
  const url = dialog.getByRole("textbox", { name: "Link", exact: true })
  await expect(url).toHaveValue(SHARED_URL)
  await dialog.getByRole("button", { name: "Copy", exact: true }).click()
  expect(await clipboard()).toBe(SHARED_URL)
  expect(daysFromNow(mutations[0]?.body.expiresAt)).toBe(14)
  // Under the default policy, a link is view-only with no live data, and has
  // no password unless one is set.
  expect(mutations[0]?.body).toMatchObject({
    target: { kind: "doc", spaceId: "share-browser", path: "launch-plan" },
    label: "",
    level: "view",
  })
  expect(mutations[0]?.body).not.toHaveProperty("password")
  expect(mutations[0]?.body).not.toHaveProperty("grant")
  await dialog.getByRole("button", { name: "Done", exact: true }).click()

  // Opened again, the link is still there to copy, from its menu too.
  await clearClipboard()
  await shareButton.click()
  await expect(url).toHaveValue(SHARED_URL)
  const actions = dialog.getByRole("button", { name: "Link actions" })
  await actions.click()
  await page.getByRole("menuitem", { name: "Copy Link" }).click()
  await expect.poll(clipboard).toBe(SHARED_URL)

  // Its settings change it in place.
  await expires.click()
  await dialog.getByRole("combobox", { name: "Expires", exact: true }).click()
  await page.getByRole("option", { name: "30 days", exact: true }).click()
  await expect.poll(() => mutations[1]?.method).toBe("PATCH")
  expect(daysFromNow(mutations[1]?.body.expiresAt)).toBe(30)
  await expect(url).toHaveValue(SHARED_URL)

  // A link for someone in particular has a label and lives under More links.
  const more = dialog.getByRole("button", { name: /^More links/ })
  await more.click()
  await dialog.getByRole("button", { name: "New Link", exact: true }).click()
  await dialog.getByLabel("Label", { exact: true }).fill("Board")
  await dialog.getByRole("button", { name: "Create Link", exact: true }).click()
  const others = dialog.getByRole("list", { name: "Other links" })
  await expect(others.getByRole("listitem")).toHaveText([/^Board/])
  await expect(more).toContainText("1")
  expect(mutations[2]?.body).toMatchObject({ label: "Board" })
  expect(daysFromNow(mutations[2]?.body.expiresAt)).toBe(14)

  await dialog.getByRole("button", { name: "Actions for Board" }).click()
  await page.getByRole("menuitem", { name: "Revoke Link" }).click()
  await page
    .getByRole("dialog", { name: "Revoke this link?" })
    .getByRole("button", { name: "Revoke", exact: true })
    .click()
  await expect(others).toHaveCount(0)
  expect(mutations[3]).toMatchObject({
    method: "DELETE",
    path: expect.stringMatching(/\/lnk_a+1$/),
  })
  await expect(url).toHaveValue(SHARED_URL)
})

test("explains the inert shared-HTML boundary before creating a link", async ({
  page,
}) => {
  const { mutations } = await mockSharing(page)
  await page.goto(appUrl("/spaces/share-browser/documents/status-card"), {
    waitUntil: "domcontentloaded",
  })

  const shareButton = page.getByRole("button", { name: "Share document" })
  await expect(shareButton).toBeVisible({ timeout: 30_000 })
  await shareButton.click()
  const dialog = page.getByRole("dialog", { name: "Share “Status card”" })
  await expect(
    dialog.getByText("Anyone with the link can use this tool")
  ).toBeVisible()
  await expect(
    dialog.getByText(/Records and links to other Worktable content/i)
  ).toBeVisible()
  await dialog.getByRole("button", { name: "Create Link", exact: true }).click()

  await expect
    .poll(() => mutations.map((mutation) => mutation.body.target))
    .toContainEqual({
      kind: "html",
      spaceId: "share-browser",
      path: "status-card",
    })
})

test("creates and edits password links without retaining a password in the form", async ({
  page,
}, testInfo) => {
  let requirePassword = true
  const { mutations } = await mockSharing(page, {
    policy: () => ({ requirePassword }),
  })
  await page.goto(appUrl("/spaces/share-browser/documents/launch-plan"), {
    waitUntil: "domcontentloaded",
  })
  const share = page.getByRole("button", { name: "Share document" })
  await expect(share).toBeVisible({ timeout: 30_000 })
  await share.click()
  const dialog = page.getByRole("dialog", { name: "Share “Launch plan”" })
  // A Worktable that requires passwords asks for one before the first link.
  const passwordSwitch = dialog.getByRole("switch", {
    name: "Ask for a password",
    exact: true,
  })
  await expect(passwordSwitch).toBeChecked()
  await expect(passwordSwitch).toBeDisabled()
  const newPassword = dialog.getByLabel("Link password", { exact: true })
  await expect(newPassword).toHaveAttribute("required", "")
  // Closing the row doesn't let the link through without its password.
  const passwordRow = dialog.getByRole("button", { name: /^Password/ })
  await passwordRow.click()
  await expect(newPassword).toBeHidden()
  await dialog.getByRole("button", { name: "Create Link", exact: true }).click()
  await expect(newPassword).toBeFocused()
  expect(mutations).toHaveLength(0)
  await newPassword.fill("test-only board password")
  await dialog.screenshot({
    path: testInfo.outputPath("password-link-form.png"),
  })
  await dialog.getByRole("button", { name: "Create Link", exact: true }).click()
  await expect(
    dialog.getByRole("textbox", { name: "Link", exact: true })
  ).toHaveValue(SHARED_URL)
  expect(mutations[0]?.body).toMatchObject({
    label: "",
    password: "test-only board password",
  })

  // The link's Password row changes it in place; a blank field keeps it.
  const openPassword = async () => {
    if ((await passwordRow.getAttribute("aria-expanded")) !== "true")
      await passwordRow.click()
  }
  const save = dialog.getByRole("button", { name: "Save", exact: true })
  await openPassword()
  const replacement = dialog.getByLabel("New password", { exact: true })
  await expect(replacement).toHaveValue("")
  await expect(save).toBeHidden()
  await replacement.fill("replacement test password")
  await save.click()
  await expect(save).toBeHidden()
  await expect(replacement).toHaveValue("")
  expect(mutations[1]?.body).toEqual({ password: "replacement test password" })

  // Once passwords are optional, one can be removed and another link made with one.
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  requirePassword = false
  await share.click()
  await openPassword()
  await passwordSwitch.click()
  await expect.poll(() => mutations[2]?.body).toEqual({ password: null })
  await expect(passwordRow).toContainText("Off")

  await dialog.getByRole("button", { name: /^More links/ }).click()
  await dialog.getByRole("button", { name: "New Link", exact: true }).click()
  await dialog.getByLabel("Label", { exact: true }).fill("Board")
  await passwordSwitch.last().click()
  await dialog
    .getByLabel("Link password", { exact: true })
    .fill("test-only second password")
  await dialog.getByRole("button", { name: "Create Link", exact: true }).click()
  await expect(
    dialog.getByRole("list", { name: "Other links" }).getByRole("listitem")
  ).toHaveText([/^BoardPassword/])
  expect(mutations[3]?.body).toMatchObject({
    label: "Board",
    password: "test-only second password",
  })
  // Editing a link never changes what it allows.
  for (const mutation of mutations.filter((entry) => entry.method === "PATCH"))
    expect(mutation.body).not.toHaveProperty("level")
})

for (const appearance of [
  { colorScheme: "light" as const, width: 1280, height: 900 },
  { colorScheme: "dark" as const, width: 390, height: 844 },
]) {
  test(`shows and narrows a tool's live data in ${appearance.colorScheme} mode`, async ({
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
    const suggested = {
      version: 1 as const,
      collections: {
        deals: { rows: null, fields: ["name"], timestamps: false },
      },
      limits: { rowsPerQuery: 200, queriesPerMinute: 120, rowsPerHour: 10_000 },
      state: "visitor" as const,
    }
    const checks: Array<Record<string, unknown>> = []
    const { mutations } = await mockSharing(page, {
      policy: () => ({ liveLinks: true }),
      links: [
        mockLink(
          0,
          { kind: "html", path: "status-card" },
          { expiresAt: new Date(Date.now() + 14 * DAY).toISOString() }
        ),
      ],
    })
    // Access checks, which the link routes leave alone.
    await page.route("**/api/shares/links/access", async (route) => {
      const body = route.request().postDataJSON()
      checks.push(body)
      // Right after a tool changes, the first check is refused.
      if (checks.length === 1) {
        await route.fulfill({
          status: 503,
          json: { error: "Changed", code: "LINK_PREVIEW_CHANGED" },
        })
        return
      }
      const grant = body.grant ?? suggested
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
          sentences: [],
          warnings: [],
          issues: [],
          stateReadable: true,
        },
      })
    })
    await page.goto(appUrl("/spaces/share-browser/documents/status-card"), {
      waitUntil: "domcontentloaded",
    })
    const openShare = async () => {
      if (appearance.width < 640) {
        await page
          .locator("[data-worktable-app-header]")
          .getByRole("button", { name: "Status card", exact: true })
          .click()
        await page
          .getByRole("dialog", { name: "Page", exact: true })
          // With a link open it reads "Share" and "Link active".
          .getByRole("button", { name: /^Share/ })
          .click()
      } else await page.getByRole("button", { name: "Share document" }).click()
    }
    await openShare()
    const dialog = page.getByRole("dialog", { name: "Share “Status card”" })
    const live = dialog.getByRole("button", { name: /^Live data/ })
    await expect(live).toContainText("Off")
    await live.click()
    expect(checks).toHaveLength(0)
    await dialog
      .getByRole("switch", { name: "Show live data", exact: true })
      .click()

    // The refused check is asked again, then the suggested access is saved.
    await expect(
      dialog.getByText("Visitors can read all 2 Deals, except:")
    ).toBeVisible()
    expect(checks).toHaveLength(2)
    expect(checks[1]).toMatchObject({
      observe: true,
      linkId: "lnk_aaaaaaaaaaaaaaaaaaaaa0",
    })
    expect(mutations[0]?.body).toEqual({ grant: suggested })
    await expect(live).toContainText("2 Deals")
    const hidden = dialog.getByRole("list", { name: "Hidden from Deals" })
    await expect(hidden.getByRole("listitem")).toHaveText(["Amount", "Secret"])
    await expect(
      dialog.getByRole("button", { name: "View as Visitor", exact: true })
    ).toBeEnabled()
    await dialog.screenshot({
      path: testInfo.outputPath(`live-data-${appearance.colorScheme}.png`),
    })

    await dialog
      .getByRole("button", { name: "Hide Fields", exact: true })
      .click()
    await expect(
      dialog.getByRole("checkbox", { name: "Name", exact: true })
    ).toBeChecked()
    await dialog.getByRole("checkbox", { name: "Amount", exact: true }).click()
    await dialog.getByRole("button", { name: "Save", exact: true }).click()
    await expect(hidden.getByRole("listitem")).toHaveText(["Secret"])
    expect(
      (mutations[1]?.body.grant as typeof suggested).collections.deals.fields
    ).toEqual(["name", "amount"])

    // Opened again, the saved access is checked once its section opens.
    await dialog.getByRole("button", { name: "Done", exact: true }).click()
    await openShare()
    await expect(live).toContainText("On")
    await live.click()
    await expect(live).toContainText("2 Deals")
    expect(checks.at(-1)).toMatchObject({
      observe: false,
      linkId: "lnk_aaaaaaaaaaaaaaaaaaaaa0",
    })
    await dialog
      .getByRole("switch", { name: "Show live data", exact: true })
      .click()
    await expect(live).toContainText("Off")
    expect(mutations.at(-1)?.body).toEqual({ grant: null })
  })
}
