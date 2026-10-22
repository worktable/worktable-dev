import { expect, test, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
let temporary: string
let runtime: string
let workerSource: string
let workerBytes = 0

test.beforeAll(() => {
  temporary = mkdtempSync(join(tmpdir(), "worktable-isolated-tool-"))
  const worker = join(temporary, "worker.js")
  const frame = join(temporary, "frame.js")
  execFileSync(
    "bun",
    [
      "build",
      "packages/ui/src/tool-runtime/worker.ts",
      "--target=browser",
      "--format=iife",
      "--define=import.meta.url=globalThis.location.href",
      "--minify",
      `--outfile=${worker}`,
    ],
    { cwd: repository }
  )
  workerSource = readFileSync(worker, "utf8")
  workerBytes = Buffer.byteLength(workerSource)
  execFileSync(
    "bun",
    [
      "build",
      "apps/web/e2e/fixtures/isolated-tool.ts",
      "--target=browser",
      "--format=iife",
      "--minify",
      `--outfile=${frame}`,
    ],
    { cwd: repository, maxBuffer: 1024 * 1024 }
  )
  runtime = readFileSync(frame, "utf8")
})
test.afterAll(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
})

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return
  const frame = page
    .frames()
    .find((frame) => frame.url() === "https://tool.example.test/frame")
  if (!frame) return
  console.error(
    "Tool startup state:",
    await frame.evaluate(() => ({
      ready: document.readyState,
      root: document.querySelector("#tool")?.textContent,
      scripts: [...document.scripts].map((script) => ({
        type: script.type,
        src: script.src,
        characters: script.textContent?.length,
      })),
      host: typeof (window as unknown as { toolTest?: unknown }).toolTest,
    }))
  )
})

/** Real VM, worker and renderer. Only the existing data broker is a fixture.
 * This is not a deployed gateway or a DNS-channel acceptance test. */
async function fixture(page: Page, source: string) {
  const outside: string[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error("Tool frame error:", error.message)
  })
  page.on("console", (message) => {
    if (message.type() === "error")
      console.error("Tool console:", message.text().slice(0, 1000))
  })
  page.on("requestfailed", (request) =>
    console.error(
      "Tool request failed:",
      request.url(),
      request.failure()?.errorText
    )
  )
  // WebKit also intercepts blob: workers with a catch-all route. Browser-owned
  // Blob loads must reach its loader; this fixture owns only HTTP endpoints.
  await page.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url())
    if (url.href === "https://member.example.test/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><button onclick="this.textContent='Still responsive'">Check page</button><iframe title="Tool" sandbox="allow-scripts" src="https://tool.example.test/frame"></iframe>`,
      })
    if (url.href === "https://tool.example.test/frame")
      return route.fulfill({
        contentType: "text/html",
        headers: {
          "Content-Security-Policy":
            "sandbox allow-scripts; default-src 'none'; script-src https://tool.example.test/runtime.js 'wasm-unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://member.example.test",
          "Referrer-Policy": "no-referrer",
        },
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="tool"></main><script type="application/json" id="tool-source">${JSON.stringify(source).replaceAll("<", "\\u003c")}</script><script type="application/json" id="tool-worker">${JSON.stringify(workerSource).replaceAll("<", "\\u003c")}</script><script src="https://tool.example.test/runtime.js" defer></script></body></html>`,
      })
    if (url.href === "https://tool.example.test/runtime.js")
      return route.fulfill({ contentType: "text/javascript", body: runtime })
    outside.push(url.href)
    return route.abort()
  })
  await page.goto("https://member.example.test/")
  return { frame: page.frameLocator('iframe[title="Tool"]'), outside, errors }
}

test("an opaque tool reads data and handles controls without browser capabilities or authored markup", async ({
  page,
}, info) => {
  const { frame, outside, errors } = await fixture(
    page,
    `
    const names = ['window','document','self','parent','fetch','XMLHttpRequest','WebSocket',
      'WebTransport','RTCPeerConnection','Worker','importScripts','indexedDB','localStorage','process','Bun'];
    if (names.some(name => typeof globalThis[name] !== 'undefined')) throw new Error('Ambient capability');
    if (worktable.ui.render.constructor('return typeof globalThis.document')() !== 'undefined') throw new Error('Host constructor');
    if (worktable.ui.getTheme() !== 'dark' || worktable.ui.getViewport().width <= 0 || worktable.ui.getViewport().height <= 0) throw new Error('Incorrect initial environment');
    const rows = await worktable.records.query('sales');
    let filter = '';
    let categories = [];
    let live = '';
    let status = 'Isolated';
    function render() { return worktable.ui.render({ tag: 'section', children: [
      { tag: 'h1', children: [status] },
      { tag: 'p', children: [rows[0].data.name] },
      { tag: 'p', children: [live] },
      { tag: 'label', children: ['Region', { tag: 'input', key: 'region', props: { value: filter }, on: { input: 'filter' } }] },
      { tag: 'label', children: ['Categories', { tag: 'select', key: 'categories', props: { multiple: true, 'aria-label': 'Categories' }, on: { change: 'categories' }, children: ['north', '東京'].map(value => ({ tag: 'option', props: { value, selected: categories.includes(value) }, children: [value] })) }] },
      { tag: 'p', children: ['Selected: ' + categories.join(', ')] },
      { tag: 'button', children: ['Test unsafe view'], on: { click: 'unsafe' } },
      { tag: 'button', children: ['Subscribe'], on: { click: 'subscribe' } },
      { tag: 'svg', props: { viewBox: '0 0 100 40', 'aria-label': 'Revenue' }, children: [
        { tag: 'path', props: { d: 'M0 40 L50 20 L100 0', stroke: '#2468ab', fill: 'none' } },
      ] },
    ] }); }
    worktable.ui.on('filter', async event => { filter = event.value; await worktable.state.set('region', filter); await render(); });
    worktable.ui.on('categories', async event => { categories = event.values; await worktable.state.set('categories', categories); await render(); });
    worktable.ui.on('unsafe', async () => {
      try { await worktable.ui.render({ tag: 'link', props: { rel: 'preconnect', href: 'https://outside.invalid' } }); }
      catch { status = 'Unsafe view rejected'; }
      await render();
    });
    worktable.ui.on('subscribe', () => worktable.records.subscribe('sales', {}, async rows => { live = rows[0].data.name; await render(); }));
    await render();
  `
  )
  await expect(
    frame.getByRole("heading", { name: "Isolated", exact: true })
  ).toBeVisible()
  expect(
    await page
      .frames()[1]!
      .evaluate(() =>
        (
          window as unknown as {
            toolTest: { rejectsOversizedSource: () => boolean }
          }
        ).toolTest.rejectsOversizedSource()
      )
  ).toBe(true)
  await expect(
    frame.getByText("Équipe 東京 <img src=//outside.invalid>", { exact: true })
  ).toBeVisible()
  await expect(frame.locator("img,link,style,iframe,object")).toHaveCount(0)
  await expect(frame.locator("svg path")).toHaveCount(1)
  const input = frame.getByLabel("Region")
  await input.fill("North")
  await expect(input).toHaveValue("North")
  await expect(input).toBeFocused()
  await expect
    .poll(() =>
      page.frames()[1]!.evaluate(
        () =>
          (
            window as unknown as {
              toolTest: { state: { state: { region: string } } }
            }
          ).toolTest.state.state.region
      )
    )
    .toBe("North")
  const categories = frame.getByLabel("Categories", { exact: true })
  await categories.press("Home")
  await expect(
    frame.getByText("Selected: north", { exact: true })
  ).toBeVisible()
  await categories.press("Shift+End")
  await expect(
    frame.getByText("Selected: north, 東京", { exact: true })
  ).toBeVisible()
  await frame.getByRole("button", { name: "Test unsafe view" }).click()
  await expect(
    frame.getByRole("heading", { name: "Unsafe view rejected" })
  ).toBeVisible()
  await frame.getByRole("button", { name: "Subscribe", exact: true }).click()
  await expect(frame.getByText("Live data", { exact: true })).toBeVisible()
  await page
    .frames()[1]!
    .evaluate(() =>
      (
        window as unknown as { toolTest: { close: () => void } }
      ).toolTest.close()
    )
  expect(
    await page.frames()[1]!.evaluate(
      () =>
        (
          window as unknown as {
            toolTest: { state: { subscribers: number } }
          }
        ).toolTest.state.subscribers
    )
  ).toBe(0)
  expect(outside).toEqual([])
  expect(errors).toEqual([])
  await info.attach("runtime-build", {
    contentType: "application/json",
    body: JSON.stringify({
      workerBytes,
      frameBytes: Buffer.byteLength(runtime),
    }),
  })
})

test("a runaway native operation leaves the page responsive and the worker is stopped", async ({
  page,
}) => {
  const { frame, errors } = await fixture(
    page,
    `
    worktable.ui.on('run', () => { /^(a+)+$/.test('a'.repeat(40) + '!'); });
    await worktable.ui.render({ tag: 'button', children: ['Run'], on: { click: 'run' } });
  `
  )
  await expect(
    frame.getByRole("button", { name: "Run", exact: true })
  ).toBeVisible()
  await frame.getByRole("button", { name: "Run", exact: true }).click()
  await page
    .getByRole("button", { name: "Check page" })
    .click({ timeout: 2000 })
  await expect(
    page.getByRole("button", { name: "Still responsive" })
  ).toBeVisible()
  await expect(
    frame.getByRole("heading", { name: "This tool stopped" })
  ).toBeVisible({ timeout: 6000 })
  expect(errors).toEqual([])
})
