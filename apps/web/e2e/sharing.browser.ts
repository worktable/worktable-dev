import { expect, test, type Page } from "@playwright/test"
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
  sharingEnabled = true
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
