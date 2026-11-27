import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("runtime-routing-browser")
  const create = async (path: string, body: unknown) => {
    const response = await fetch(`${harness.apiUrl}/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(201)
  }
  await create("/spaces", { name: "Mounted Tools" })
  await create("/spaces/mounted-tools/records", {
    id: "tasks", name: "Tasks", fields: { name: { type: "text" } },
  })
  await create("/spaces/mounted-tools/records/tasks", { data: { name: "Initial task" } })
  await create("/spaces/mounted-tools/widgets", {
    id: "report", name: "Mounted report",
    permissions: { records: { tasks: { read: true, create: true } }, state: { read: true, write: true } },
    html: `<!doctype html><main><p id="summary">Loading report</p><p id="choice"></p><form id="add"><input name="name" value="Added task"><button>Add task</button></form></main><script>
      async function render() {
        const rows = await worktable.records.query('tasks');
        const state = await worktable.state.get();
        document.querySelector('#summary').textContent = rows.length + ' tasks';
        document.querySelector('#choice').textContent = state.view || 'All';
      }
      // A form reaches the page's own submit handler.
      document.querySelector('#add').addEventListener('submit', async (event) => {
        event.preventDefault();
        await worktable.records.create('tasks', {name: new FormData(event.target).get('name')});
        await worktable.state.set('view', 'Open');
        await render();
        worktable.ui.notify('Task added', {tone: 'success'});
      });
      render();
    </script>`,
  })
})

test.afterAll(async () => {
  await harness?.stop()
})

test("a selected Cloud Worktable survives hydration, navigation and direct reload", async ({ page }) => {
  const mount = "/t/teams-browser"
  await page.route(`${harness.webUrl}/api/**`, (route) => route.fulfill({
    status: 409,
    json: { code: "WORKTABLE_REQUIRED", error: "Choose a Worktable" },
  }))
  // Model the gateway's mount without mocking the application or its API.
  // Start serves the normal root HTML; the browser hydrates at the public URL.
  await page.route(`**${mount}/**`, async (route) => {
    const upstream = new URL(route.request().url())
    upstream.pathname = upstream.pathname.slice(mount.length) || "/"
    // Reconnect a reset read in this test proxy without replaying mutations.
    const response = await route.fetch({
      url: upstream.href,
      maxRetries: route.request().method() === "GET" ? 1 : 0,
    })
    await route.fulfill({ response })
  })

  await page.goto(`${harness.webUrl}${mount}/?selected=1#home`, { waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(`${harness.webUrl}${mount}/?selected=1#home`)

  const sidebar = page.locator("aside")
  const home = sidebar.getByRole("link", { name: "Home", exact: true })
  const threads = sidebar.getByRole("link", { name: "Threads", exact: true })
  await expect(home).toHaveAttribute("href", `${mount}/`)
  await expect(threads).toHaveAttribute("href", `${mount}/threads?location=all`)
  await threads.click()
  await expect(page).toHaveURL(`${harness.webUrl}${mount}/threads?location=all`)
  await expect(page.getByText("No threads yet", { exact: true })).toBeVisible()
  await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 })
  await expect(page).toHaveURL(`${harness.webUrl}${mount}/threads?location=all`)
  await expect(page.getByText("No threads yet", { exact: true })).toBeVisible()
  await expect(page.getByText("Not Found", { exact: true })).toHaveCount(0)
  await home.click()
  await expect(page).toHaveURL(`${harness.webUrl}${mount}/`)

  await page.goto(`${harness.webUrl}${mount}/spaces/mounted-tools/documents/report`, { waitUntil: "domcontentloaded" })
  const tool = page.frameLocator('iframe[title="Mounted report"]')
  await expect(tool.locator("#summary")).toHaveText("1 tasks")
  await tool.getByRole("button", { name: "Add task", exact: true }).click()
  await expect(tool.locator("#summary")).toHaveText("2 tasks")
  await expect(tool.locator("#choice")).toHaveText("Open")
  // The page's own message shows as one of the app's toasts.
  await expect(page.getByText("Task added", { exact: true })).toBeVisible()
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(tool.locator("#summary")).toHaveText("2 tasks")
  await expect(tool.locator("#choice")).toHaveText("Open")
  // The page's background reads (the sidebar, for one) keep passing through
  // the mount proxy after the last check; a fetch still in flight when the
  // test ends would otherwise fail it.
  await page.unrouteAll({ behavior: "ignoreErrors" })
})
