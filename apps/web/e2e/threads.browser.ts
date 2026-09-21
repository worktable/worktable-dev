import { readFile, writeFile } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness
let atlasToken: string

function appUrl(path = "/"): string {
  return new URL(path, harness.webUrl).href
}

async function pairOpenClaw(
  participantName: string,
  installationId: string
): Promise<string> {
  const created = await fetch(`${harness.apiUrl}/api/pairing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: {
        kind: "agent-adapter",
        adapter: "openclaw",
        participantName,
      },
    }),
  })
  expect(created.status).toBe(201)
  const pairing = (await created.json()) as { code: string }
  const redeemed = await fetch(`${harness.apiUrl}/api/pairing/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: pairing.code,
      hostname: "browser-test",
      installationId,
    }),
  })
  expect(redeemed.status).toBe(200)
  const redemption = (await redeemed.json()) as { token: string }
  const completed = await fetch(`${harness.apiUrl}/api/pairing/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${redemption.token}`,
    },
    body: JSON.stringify({ code: pairing.code }),
  })
  expect(completed.status).toBe(200)
  return redemption.token
}

async function chooseOption(
  page: Page,
  label: string,
  option: string
): Promise<void> {
  await page.getByRole("combobox", { name: label, exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

async function postThreadMessage(
  threadId: string,
  body: string,
  idempotencyKey: string
): Promise<string> {
  const response = await fetch(
    `${harness.apiUrl}/api/threads/${threadId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body,
        idempotencyKey,
        responseIdentityId: null,
        waitSeconds: 0,
      }),
    }
  )
  expect(response.ok).toBe(true)
  return ((await response.json()) as { messageId: string }).messageId
}

async function requestOwnerResponse(
  threadId: string,
  responseIdentityId: string
): Promise<void> {
  const response = await fetch(
    `${harness.apiUrl}/api/threads/${threadId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${atlasToken}`,
      },
      body: JSON.stringify({
        body: "Please respond before sending that request.",
        idempotencyKey: "browser-owner-response-request",
        responseIdentityId,
        waitSeconds: 0,
      }),
    }
  )
  expect(response.ok).toBe(true)
}

async function addHumanThreadMember(threadId: string): Promise<void> {
  const threadPath = harness.workspacePath("threads", `${threadId}.json`)
  const thread = JSON.parse(await readFile(threadPath, "utf8")) as {
    members: Array<{
      id: string
      kind: "human" | "agent" | "system"
      name: string
      addedAt: string
    }>
    identities: Array<{
      id: string
      memberId: string
      name: string
      default: boolean
      status: "active" | "inactive"
      createdAt: string
      updatedAt: string
    }>
  }
  const now = new Date().toISOString()
  thread.members.push({
    id: "ptc_browser_maya01",
    kind: "human",
    name: "Maya",
    addedAt: now,
  })
  thread.identities.push({
    id: "idt_browser_maya01",
    memberId: "ptc_browser_maya01",
    name: "Maya",
    default: true,
    status: "active",
    createdAt: now,
    updatedAt: now,
  })
  await writeFile(threadPath, `${JSON.stringify(thread, null, 2)}\n`)
}

test.beforeAll(async () => {
  harness = await startWebHarness("threads-browser")
  atlasToken = await pairOpenClaw("Atlas", "oci_browser_threads_atlas")
  await pairOpenClaw("Finn", "oci_browser_threads_finn")
})

test.afterAll(async () => {
  await harness?.stop()
})

test("keeps direct replies implicit and promotes one group mention", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  await page.goto(appUrl("/threads/"), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })

  await chooseOption(page, "Thread participant", "Atlas")
  let dropCreateResponse = true
  await page.route("**/api/threads", async (route) => {
    if (route.request().method() === "POST" && dropCreateResponse) {
      dropCreateResponse = false
      await route.fetch()
      await route.abort("failed")
      return
    }
    await route.continue()
  })
  await page
    .getByPlaceholder("Message Atlas…")
    .fill("A general Worktable thread")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  // The route above deliberately aborts the committed response. Start the
  // clean-console proof after that expected browser network error.
  consoleErrors.length = 0
  await page.getByRole("button", { name: "Try sending again" }).click()
  await expect(page).toHaveURL(/\/threads\/worktable\/thr_/)
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.apiUrl}/api/threads`)
      const payload = (await response.json()) as {
        threads: Array<{ lastMessage: { body: string } }>
      }
      return payload.threads.filter(
        (thread) => thread.lastMessage.body === "A general Worktable thread"
      ).length
    })
    .toBe(1)

  const threadId = new URL(page.url()).pathname.split("/").at(-1)!
  let releaseParticipants: (() => void) | undefined
  const participantsReady = new Promise<void>((resolve) => {
    releaseParticipants = resolve
  })
  let participantRouteMode: "hold" | "fail" | "pass" = "hold"
  let participantRequestCount = 0
  const composer = page.getByPlaceholder("Reply in this thread…")
  const composerGroup = page.getByRole("group", {
    name: "Write a message",
    exact: true,
  })
  await expect(composer).toBeEnabled()
  await page.route("**/api/threads/participants", async (route) => {
    participantRequestCount += 1
    await participantsReady
    if (participantRouteMode === "fail") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Participants temporarily unavailable" }),
      })
      return
    }
    await route.continue()
  })
  await pairOpenClaw("Scout", "oci_browser_threads_scout")
  await expect(composer).toBeDisabled()
  participantRouteMode = "fail"
  releaseParticipants?.()
  await expect.poll(() => participantRequestCount).toBeGreaterThanOrEqual(2)
  await expect(composer).toBeEnabled()
  await expect(
    composerGroup.getByRole("button", { name: /^Change / })
  ).toHaveCount(0)

  await composer.fill("A direct follow-up")
  await page.getByRole("button", { name: "Send message" }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(composer).toHaveValue("A direct follow-up")
  const failedRefreshRequestCount = participantRequestCount
  participantRouteMode = "pass"
  await page.getByRole("button", { name: "Try sending again" }).click()
  await expect
    .poll(() => participantRequestCount)
    .toBeGreaterThan(failedRefreshRequestCount)
  await page.unroute("**/api/threads/participants")
  // The failed refreshes above deliberately produce browser network errors.
  // Start the clean-console proof after the successful submission refresh.
  consoleErrors.length = 0
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.apiUrl}/api/threads/${threadId}`)
      const payload = (await response.json()) as {
        thread: {
          identities: Array<{ id: string; name: string }>
          messages: Array<{
            body: string
            responseRequest?: { identityId: string; status: string }
          }>
        }
      }
      const sent = payload.thread.messages.find(
        (candidate) => candidate.body === "A direct follow-up"
      )
      return {
        identityName: payload.thread.identities.find(
          (identity) => identity.id === sent?.responseRequest?.identityId
        )?.name,
        status: sent?.responseRequest?.status,
      }
    })
    .toEqual({ identityName: "Atlas", status: "open" })

  await composer.fill("Please ask @Fi")
  await page.getByRole("option", { name: "Finn", exact: true }).click()
  await composer.pressSequentially(" for a passive review.")
  const target = composerGroup.getByRole("button", {
    name: "Change Finn",
    exact: true,
  })
  await expect(target).toBeVisible()
  await target.click()
  await page.getByRole("menuitemradio", { name: "Atlas", exact: true }).click()
  await expect(
    composerGroup.getByRole("button", { name: "Change Atlas", exact: true })
  ).toBeVisible()
  await composerGroup
    .getByRole("button", { name: "Change Atlas", exact: true })
    .click()
  await page.getByRole("menuitemradio", { name: "Finn", exact: true }).click()
  await composerGroup
    .getByRole("button", { name: "Clear Finn", exact: true })
    .click()
  await expect(
    composerGroup.getByRole("button", { name: /^Change / })
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Send message" }).click()

  const message = page.locator('[data-slot="message"]').filter({
    hasText: "Please ask @Finn for a passive review.",
  })
  await expect(message).toBeVisible()
  await expect(composer).toHaveValue("")
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.apiUrl}/api/threads/${threadId}`)
      const payload = (await response.json()) as {
        thread: {
          identities: Array<{ id: string; name: string }>
          messages: Array<{
            body: string
            notifyIdentityIds: string[]
            responseRequest?: { identityId: string; status: string }
          }>
        }
      }
      const sent = payload.thread.messages.find((candidate) =>
        candidate.body.includes("passive review")
      )
      const identityNames = new Map(
        payload.thread.identities.map((identity) => [
          identity.id,
          identity.name,
        ])
      )
      return {
        mentioned: sent?.notifyIdentityIds.map((id) => identityNames.get(id)),
        assigned: sent?.responseRequest
          ? identityNames.get(sent.responseRequest.identityId)
          : null,
      }
    })
    .toEqual({ mentioned: ["Finn"], assigned: null })

  await addHumanThreadMember(threadId)
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.apiUrl}/api/threads/${threadId}`)
      const payload = (await response.json()) as {
        thread: { members: Array<{ name: string; kind: string }> }
      }
      return payload.thread.members.some(
        (member) => member.name === "Maya" && member.kind === "human"
      )
    })
    .toBe(true)

  await composer.fill("Please have @Ma")
  await page.getByRole("option", { name: "Maya", exact: true }).click()
  await composer.pressSequentially(" review the launch plan.")
  await expect(
    composerGroup.getByRole("button", { name: "Change Maya", exact: true })
  ).toBeVisible()
  const ownerIdentityId = await fetch(
    `${harness.apiUrl}/api/threads/${threadId}`
  )
    .then((response) => response.json())
    .then((payload: { viewerIdentityId: string }) => payload.viewerIdentityId)
  await requestOwnerResponse(threadId, ownerIdentityId)
  const responseRequest = page.locator('[data-slot="message"]').filter({
    hasText: "Please respond before sending that request.",
  })
  await expect(responseRequest).toBeVisible()
  await responseRequest.hover()
  await responseRequest
    .getByRole("button", { name: "Respond", exact: true })
    .click()
  await expect(
    composerGroup.getByRole("button", { name: "Change Maya", exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Send message" }).click()
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.apiUrl}/api/threads/${threadId}`)
      const payload = (await response.json()) as {
        thread: {
          identities: Array<{ id: string; name: string }>
          messages: Array<{
            body: string
            notifyIdentityIds: string[]
            responseRequest?: { identityId: string; status: string }
          }>
        }
      }
      const sent = payload.thread.messages.find((candidate) =>
        candidate.body.includes("review the launch plan")
      )
      const identityName = payload.thread.identities.find(
        (identity) => identity.id === sent?.responseRequest?.identityId
      )?.name
      return {
        mentioned: sent?.notifyIdentityIds.map(
          (id) =>
            payload.thread.identities.find((identity) => identity.id === id)
              ?.name
        ),
        assigned: identityName
          ? { identityName, status: sent?.responseRequest?.status }
          : null,
      }
    })
    .toEqual({ mentioned: ["Maya"], assigned: null })

  await message.hover()
  await message.getByRole("button", { name: "Reply", exact: true }).click()
  await composerGroup
    .getByRole("button", { name: "Remove reply", exact: true })
    .click()

  await message.hover()
  await message.getByRole("button", { name: "Assign", exact: true }).click()
  await page.getByRole("menuitemradio", { name: "Finn", exact: true }).click()
  await expect(
    message.getByRole("button", { name: "Assigned to Finn", exact: true })
  ).toBeVisible()
  await expect(message.getByText("@Finn", { exact: true })).toHaveClass(
    /bg-primary\/10/
  )

  await expect
    .poll(async () => {
      const response = await fetch(`${harness.apiUrl}/api/threads/${threadId}`)
      const payload = (await response.json()) as {
        thread: {
          identities: Array<{ id: string; name: string }>
          messages: Array<{
            body: string
            notifyIdentityIds: string[]
            responseRequest?: { identityId: string; status: string }
          }>
        }
      }
      const sent = payload.thread.messages.find((candidate) =>
        candidate.body.includes("passive review")
      )
      const identityNames = new Map(
        payload.thread.identities.map((identity) => [
          identity.id,
          identity.name,
        ])
      )
      return {
        mentioned: sent?.notifyIdentityIds.map((id) => identityNames.get(id)),
        assigned: sent?.responseRequest
          ? {
              name: identityNames.get(sent.responseRequest.identityId),
              status: sent.responseRequest.status,
            }
          : null,
      }
    })
    .toEqual({ mentioned: [], assigned: { name: "Finn", status: "open" } })

  for (let index = 1; index <= 6; index += 1) {
    await postThreadMessage(
      threadId,
      `Long conversation message ${index}. ${"This keeps enough realistic context in view to exercise transcript scrolling without coupling the test to presentation details. ".repeat(4)}`,
      `browser-scroll-context-${index}`
    )
  }
  await expect(
    page.getByText(/Long conversation message 6\./).last()
  ).toBeVisible({ timeout: 10_000 })

  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  await viewport.hover()
  await page.mouse.wheel(0, -10_000)
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeLessThan(20)

  await postThreadMessage(
    threadId,
    "An incoming message while the reader is above the live edge.",
    "browser-preserve-reading-position"
  )
  await expect(
    page.getByRole("button", { name: "Jump to latest", exact: true })
  ).toBeVisible({ timeout: 10_000 })
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeLessThan(
    20
  )
  await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click()
  await expect(
    page
      .getByLabel("Thread conversation")
      .getByText(
        "An incoming message while the reader is above the live edge.",
        { exact: true }
      )
  ).toBeVisible()

  expect(consoleErrors).toEqual([])
})
