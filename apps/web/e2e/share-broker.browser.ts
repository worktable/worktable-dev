import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { renderPublicLivePage } from "../../../packages/ui/src/public-share-page"
import { buildWidgetShareRuntimeScript } from "../../../packages/server/src/widget-share-runtime"

const broker = readFileSync(
  new URL("../../../packages/ui/src/public-share-live.js", import.meta.url),
  "utf8"
)
const token = "T".repeat(43)
const frameUrl = "https://html.example.test/frame"

for (const colorScheme of ["light", "dark"] as const) {
  test(`the live broker keeps visitor state separate and confirms external links in ${colorScheme} mode`, async ({
    page,
  }, testInfo) => {
    // Sharing accepts short identifiers and identifiers needing escaping,
    // including ones longer than 80 characters.
    const workspaceId =
      colorScheme === "light" ? "ws_cloud" : "workspace /é".repeat(9)
    const sharePath = `/s/${encodeURIComponent(workspaceId)}`
    const pageUrl = `https://share.example.test${sharePath}/${token}`
    const collection = "collection-" + "a".repeat(130)
    await page.clock.install()
    await page.emulateMedia({ colorScheme })
    let teamValue = "first"
    let teamAllowed = true
    let recordName = "Granted data"
    let changes: string[] = []
    let changesBusy = false
    let resultTooLarge = false
    let firstQuery = true
    let releaseInitial!: () => void
    let initialStarted!: () => void
    const initialResponse = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    const initialRequest = new Promise<void>((resolve) => {
      initialStarted = resolve
    })
    const calls: Array<{ op: string; capability: string | undefined }> = []
    await page.route(
      "https://share.example.test/gateway/assets/public-share-live.js",
      (route) =>
        route.fulfill({ contentType: "application/javascript", body: broker })
    )
    await page.route(/\/gateway\/assets\/.*\.woff2$/, (route) =>
      route.fulfill({ status: 404 })
    )
    await page.route(
      `https://share.example.test${sharePath}/bridge`,
      async (route) => {
        const body = route.request().postDataJSON()
        calls.push({
          op: body.op,
          capability: route.request().headers()["x-worktable-share-capability"],
        })
        const snapshot = recordName
        if (body.op === "records.query") {
          expect(body.collection).toBe(collection)
          if (resultTooLarge) {
            await route.fulfill({
              status: 400,
              json: {
                ok: false,
                error: {
                  code: "INVALID_QUERY",
                  message: "This result is too large.",
                },
              },
            })
            return
          }
        }
        if (body.op === "records.query" && firstQuery) {
          firstQuery = false
          initialStarted()
          await initialResponse
        }
        if (body.op === "changes") {
          if (changesBusy) {
            await route.fulfill({
              status: 503,
              headers: { "Retry-After": "2" },
              json: { ok: false, error: { code: "LINK_BUSY" } },
            })
            return
          }
          if (!body.since) {
            await initialRequest
            recordName = "Baseline change"
          }
        }
        if (body.op === "state.read" && !teamAllowed) {
          await route.fulfill({
            status: 403,
            json: {
              ok: false,
              error: {
                code: "LINK_FORBIDDEN",
                message: "This link can't read that.",
              },
            },
          })
          return
        }
        const result =
          body.op === "records.query"
            ? { records: [{ id: "opaque", data: { name: snapshot } }] }
            : body.op === "state.read"
              ? { state: { teamValue } }
              : { cursor: "baseline", collections: changes }
        await route.fulfill({ json: { ok: true, result } })
      }
    )
    await page.route(frameUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: {
          "Content-Security-Policy":
            "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors https://share.example.test",
        },
        body: `<!doctype html><html><head>${buildWidgetShareRuntimeScript()}<style>:root{color-scheme:light dark}body{padding:1rem;font-family:system-ui}button,a{margin-right:1rem}</style></head><body><h1>Report</h1><p id="records"></p><p id="state"></p><p id="query-error"></p><button id="save">Save preference</button><button id="read">Read state</button><button id="oversized">Read oversized result</button><a href="https://outside.example.test/report">External page</a><script>
      async function showState(){document.querySelector('#state').textContent=JSON.stringify(await worktable.state.get())}
      document.querySelector('#save').onclick=async()=>{await worktable.state.set('preference','own');await worktable.state.update(current=>({...current,otherPreference:'local'}));await showState()};
      document.querySelector('#read').onclick=showState;
      worktable.records.subscribe(${JSON.stringify(collection)},{},rows=>document.querySelector('#records').textContent=rows[0].data.name);
      document.querySelector('#oversized').onclick=()=>worktable.records.query(${JSON.stringify(collection)}).catch(error=>document.querySelector('#query-error').textContent=error.code);
      showState();
    </script></body></html>`,
      })
    )
    await page.route(pageUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: renderPublicLivePage(
          { title: "Report" },
          { url: frameUrl, poll: 30 },
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z"/></svg>'
        ),
      })
    )
    const baseline = page.waitForResponse(
      (response) =>
        response.url().endsWith("/bridge") &&
        response.request().postDataJSON()?.op === "changes"
    )
    await page.goto(pageUrl)
    const frame = page.frameLocator("iframe")
    // The change cursor includes B while the original read of A is still in
    // flight. Establishing the cursor marks the subscription for a refresh,
    // which waits for that read: one read at a time, then the newer data.
    await baseline
    expect(calls.filter((call) => call.op === "records.query")).toHaveLength(1)
    releaseInitial()
    await expect(frame.locator("#records")).toHaveText("Baseline change")
    const authored = page
      .frames()
      .find((candidate) => candidate !== page.mainFrame())!
    await expect(frame.locator("#state")).toHaveText(
      JSON.stringify({ teamValue: "first" })
    )
    await frame.getByRole("button", { name: "Save preference" }).click()
    await expect(frame.locator("#state")).toHaveText(
      JSON.stringify({
        teamValue: "first",
        preference: "own",
        otherPreference: "local",
      })
    )
    teamValue = "updated"
    await frame.getByRole("button", { name: "Read state" }).click()
    await expect(frame.locator("#state")).toHaveText(
      JSON.stringify({
        teamValue: "updated",
        preference: "own",
        otherPreference: "local",
      })
    )
    teamAllowed = false
    await frame.getByRole("button", { name: "Read state" }).click()
    await expect(frame.locator("#state")).toHaveText(
      JSON.stringify({ preference: "own", otherPreference: "local" })
    )
    await authored.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const done = (event: MessageEvent) => {
            if (event.source !== parent || event.data?.id !== "forgery-fence")
              return
            window.removeEventListener("message", done)
            resolve()
          }
          window.addEventListener("message", done)
          ;(document.querySelector("a") as HTMLAnchorElement).click()
          parent.postMessage(
            { type: "worktable.interaction", navigationToken: "forged" },
            "*"
          )
          parent.postMessage(
            {
              type: "worktable.share.open-link",
              url: "https://forged.example.test",
              navigationToken: "forged",
            },
            "*"
          )
          parent.postMessage(
            {
              type: "worktable.api.request",
              id: "forgery-fence",
              method: "GET",
              path: "/unsupported",
            },
            "*"
          )
        })
    )
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await frame.getByRole("link", { name: "External page" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByRole("dialog")).toContainText("outside.example.test")
    expect(
      page
        .frames()
        .find((candidate) => candidate !== page.mainFrame())
        ?.url()
    ).toBe(frameUrl)
    expect(calls.every((call) => call.capability === token)).toBe(true)
    expect(calls.filter((call) => call.op === "records.query")).toHaveLength(2)
    await expect
      .poll(() => calls.filter((call) => call.op === "changes").length)
      .toBeGreaterThan(0)
    // Receiving the request is earlier than applying its initial cursor.
    // Finish that network body, then let the parent's response task settle
    // before advancing the controlled poll clock (especially in Firefox).
    await (await baseline).finished()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => {
            channel.port1.close()
            channel.port2.close()
            resolve()
          }
          channel.port2.postMessage(null)
        })
    )
    recordName = "Related change"
    changes = ["teams"]
    // Production spreads a 30-second poll by +/-20%. Advance through its
    // maximum delay so this assertion does not depend on the random jitter.
    await page.clock.fastForward(36_001)
    await expect(frame.locator("#records")).toHaveText("Related change")
    expect(calls.filter((call) => call.op === "records.query")).toHaveLength(3)

    changesBusy = true
    const busyResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/bridge") && response.status() === 503
    )
    await page.clock.fastForward(36_001)
    await (await busyResponse).finished()
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    const beforeHidden = calls.filter((call) => call.op === "changes").length
    await page.clock.fastForward(25_001)
    expect(calls.filter((call) => call.op === "changes")).toHaveLength(
      beforeHidden
    )
    changesBusy = false
    recordName = "Resumed change"
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await expect(frame.locator("#records")).toHaveText("Resumed change")
    await page.clock.fastForward(600_001)
    const beforeIdle = calls.filter((call) => call.op === "changes").length
    await authored.evaluate(() => {
      // Emulate an accessibility activation: the native trusted click is
      // delivered, while the SDK does not observe a precursor key event.
      document.addEventListener(
        "keydown",
        (event) => event.stopPropagation(),
        true
      )
      ;(document.querySelector("#read") as HTMLButtonElement).click()
    })
    await page.clock.fastForward(36_001)
    expect(calls.filter((call) => call.op === "changes")).toHaveLength(
      beforeIdle
    )
    recordName = "Accessible change"
    await frame.getByRole("button", { name: "Read state", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(frame.locator("#records")).toHaveText("Accessible change")

    changes = []
    resultTooLarge = true
    const beforeOversized = calls.filter(
      (call) => call.op === "records.query"
    ).length
    await frame.getByRole("button", { name: "Read oversized result" }).click()
    await expect(frame.locator("#query-error")).toHaveText("INVALID_QUERY")
    await page.clock.fastForward(25_001)
    expect(calls.filter((call) => call.op === "records.query")).toHaveLength(
      beforeOversized + 1
    )
    await page.screenshot({
      path: testInfo.outputPath(`live-prompt-${colorScheme}.png`),
    })
  })
}
