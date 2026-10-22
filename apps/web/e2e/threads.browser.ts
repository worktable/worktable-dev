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
  idempotencyKey: string,
  options: { responseIdentityId?: string; inReplyTo?: string } = {}
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
        ...options,
      }),
    }
  )
  expect(response.ok).toBe(true)
  return ((await response.json()) as { messageId: string }).messageId
}

async function participantId(name: string): Promise<string> {
  const response = await fetch(`${harness.apiUrl}/api/threads/participants`)
  expect(response.ok).toBe(true)
  const { participants } = (await response.json()) as {
    participants: Array<{ id: string; name: string }>
  }
  const participant = participants.find((candidate) => candidate.name === name)
  expect(participant).toBeDefined()
  return participant!.id
}

async function createThread(
  to: string,
  body: string,
  idempotencyKey: string,
  options: { expectsReply?: boolean } = {}
): Promise<string> {
  const response = await fetch(`${harness.apiUrl}/api/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to,
      body,
      idempotencyKey,
      waitSeconds: 0,
      ...options,
    }),
  })
  expect(response.ok).toBe(true)
  return ((await response.json()) as { threadId: string }).threadId
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

test("recovers committed creation and direct replies after participant refresh failure", async ({
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
        threads: Array<{ lastMessage: { excerpt: string } }>
      }
      return payload.threads.filter(
        (thread) => thread.lastMessage.excerpt === "A general Worktable thread"
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

  expect(consoleErrors).toEqual([])
})

test("mentions, response requests and live messages preserve the reader’s intent", async ({
  page,
}) => {
  // This journey starts from its own real thread. Creation and retry wiring are
  // owned above, so group interaction does not repeat that entire UI setup.
  const participantsResponse = await fetch(
    `${harness.apiUrl}/api/threads/participants`
  )
  expect(participantsResponse.ok).toBe(true)
  const { participants } = (await participantsResponse.json()) as {
    participants: Array<{ id: string; name: string }>
  }
  const atlas = participants.find((participant) => participant.name === "Atlas")
  expect(atlas).toBeDefined()
  const created = await fetch(`${harness.apiUrl}/api/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: atlas!.id,
      body: "A group interaction thread",
      idempotencyKey: "browser-group-interaction",
      waitSeconds: 0,
    }),
  })
  expect(created.ok).toBe(true)
  const { threadId } = (await created.json()) as { threadId: string }
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  await page.goto(appUrl(`/threads/worktable/${threadId}`), {
    waitUntil: "domcontentloaded",
  })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  const composer = page.getByPlaceholder("Reply in this thread…")
  const composerGroup = page.getByRole("group", {
    name: "Write a message",
    exact: true,
  })
  await expect(composer).toBeEnabled()
  consoleErrors.length = 0

  await composer.fill("Please ask @Fi")
  await page.getByRole("option", { name: "Finn", exact: true }).click()
  await composer.fill(`${await composer.inputValue()} for a passive review.`)
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
  await composer.fill(`${await composer.inputValue()} review the launch plan.`)
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
  await expect(message.getByText("@Finn", { exact: true })).toBeVisible()

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

test("long conversations open at the open request and keep every earlier message reachable in order", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const filler =
    "Each message carries a few lines of context so the conversation runs well past one screen. ".repeat(
      2
    )
  const threadId = await createThread(
    await participantId("Atlas"),
    `Long thread message 1. ${filler}`,
    "browser-long-thread",
    { expectsReply: false }
  )
  const { thread } = (await fetch(
    `${harness.apiUrl}/api/threads/${threadId}`
  ).then((response) => response.json())) as {
    thread: {
      messages: Array<{ id: string }>
      identities: Array<{ id: string; name: string }>
    }
  }
  const firstId = thread.messages[0]!.id
  const atlasIdentity = thread.identities.find(
    (identity) => identity.name === "Atlas"
  )!.id
  const messageIds = [firstId]
  for (let index = 2; index <= 60; index += 1) {
    messageIds.push(
      await postThreadMessage(
        threadId,
        `Long thread message ${index}. ${filler}`,
        `browser-long-thread-${index}`,
        // Half way through, the owner asks Atlas for a reply.
        index === 31 ? { responseIdentityId: atlasIdentity } : {}
      )
    )
  }
  messageIds.push(
    await postThreadMessage(
      threadId,
      "Back to where this started.",
      "browser-long-thread-reply",
      { inReplyTo: firstId }
    )
  )

  await page.goto(appUrl(`/threads/worktable/${threadId}`), {
    waitUntil: "domcontentloaded",
  })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  const conversation = page.getByRole("region", {
    name: "Thread conversation",
  })
  const message = (index: number) =>
    page.locator(`[id="thread-message-${messageIds[index - 1]}"]`)

  // The thread opens at its last request for a reply, which has more than a
  // screen of messages after it.
  await expect(message(31)).toBeInViewport()

  // Scrolling up reaches the first message, and every message is in order.
  await conversation.hover()
  await expect(async () => {
    await page.mouse.wheel(0, -4_000)
    await expect(message(1)).toBeInViewport({ timeout: 500 })
  }).toPass({ timeout: 20_000 })
  expect(
    await conversation
      .locator("[data-message-id]")
      .evaluateAll((items) =>
        items.map((item) => (item as HTMLElement).dataset["messageId"])
      )
  ).toEqual(messageIds)

  // Opened again, the reply jumps to the message it answers.
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(message(31)).toBeInViewport({ timeout: 30_000 })
  await conversation
    .getByRole("button", { name: /^Replying to You: Long thread message 1\./ })
    .click()
  await expect(message(1)).toBeInViewport()

  // At the live edge, a new message comes into view.
  await page
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click()
  await expect(message(61)).toBeInViewport()
  await postThreadMessage(
    threadId,
    "A newer message arrives at the live edge.",
    "browser-long-thread-live"
  )
  await expect(
    conversation.getByText("A newer message arrives at the live edge.", {
      exact: true,
    })
  ).toBeInViewport({ timeout: 10_000 })
})

test("a long thread list keeps its order and place when a thread opens", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const atlas = await participantId("Atlas")
  for (let index = 1; index <= 80; index += 1) {
    const title = `List thread ${String(index).padStart(3, "0")}`
    await createThread(atlas, title, `browser-list-thread-${index}`)
  }

  await page.goto(appUrl("/threads"), { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  const list = page.getByRole("navigation", { name: "Threads" })
  const oldest = list.getByRole("link", { name: /List thread 001/ })
  await list.hover()
  await expect(async () => {
    await page.mouse.wheel(0, 4_000)
    await expect(oldest).toBeInViewport({ timeout: 500 })
  }).toPass({ timeout: 20_000 })

  // Recreated rows keep their height while scrolling back through the list.
  // In particular, timestamps must not briefly grow from one line to two.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 915 })
    const changedRows = await list.evaluate(async (nav) => {
      const scroller = nav.parentElement!
      const firstRow = nav.querySelector<HTMLElement>("[data-index]")!
      const rowHeight = firstRow.getBoundingClientRect().height
      const changes: number[] = []
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (!nav.contains(entry.target)) continue
          if (
            Math.abs(entry.target.getBoundingClientRect().height - rowHeight) >
            1
          ) {
            changes.push(Number((entry.target as HTMLElement).dataset.index))
          }
        }
      })
      const observeRows = () => {
        for (const row of nav.querySelectorAll("[data-index]")) {
          observer.observe(row)
        }
      }
      const mutations = new MutationObserver(observeRows)
      mutations.observe(nav, { childList: true, subtree: true })
      observeRows()
      try {
        scroller.scrollTop = scroller.scrollHeight
        while (scroller.scrollTop > 0) {
          scroller.scrollTop = Math.max(0, scroller.scrollTop - 350)
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
        }
        return changes
      } finally {
        observer.disconnect()
        mutations.disconnect()
      }
    })
    expect(changedRows).toEqual([])
  }
  await page.setViewportSize({ width: 1280, height: 915 })
  await expect(async () => {
    await page.mouse.wheel(0, 4_000)
    await expect(oldest).toBeInViewport({ timeout: 500 })
  }).toPass({ timeout: 20_000 })

  // Newer threads stay above older ones.
  const shown = (await list.getByRole("listitem").allTextContents())
    .map((text) => text.match(/List thread (\d{3})/)?.[1])
    .filter((number): number is string => number !== undefined)
    .map(Number)
  expect(shown.length).toBeGreaterThan(3)
  expect(shown).toEqual([...shown].sort((left, right) => right - left))

  await oldest.click()
  await expect(
    page
      .getByRole("region", { name: "Thread conversation" })
      .getByText("List thread 001", { exact: true })
  ).toBeVisible()
  await expect(oldest).toHaveAttribute("aria-current", "page")
  await expect(oldest).toBeInViewport()

  // Tab moves from a row to the row below it.
  await list.getByRole("link", { name: /List thread 002/ }).focus()
  await page.keyboard.press("Tab")
  await expect(oldest).toBeFocused()

  // On a phone the open thread replaces the list; going back returns to the
  // same place in it.
  await page.setViewportSize({ width: 412, height: 915 })
  await expect(list).toBeHidden()
  await page
    .getByRole("banner")
    .getByRole("button", { name: "List thread 001", exact: true })
    .click()
  await page
    .getByRole("dialog", { name: "Page", exact: true })
    .getByRole("link", { name: "Threads", exact: true })
    .click()
  await expect(oldest).toBeInViewport()
})
