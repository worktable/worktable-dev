import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { renderPublicLivePage } from "../../../packages/ui/src/public-share-page"
import { buildWidgetShareRuntimeScript } from "../../../packages/server/src/widget-share-runtime"

const broker = readFileSync(
  new URL("../../../packages/ui/src/public-share-live.js", import.meta.url),
  "utf8"
)
const token = "T".repeat(43)
const pageUrl = `https://share.example.test/s/ws_synthetic/${token}`
const frameUrl = "https://html.example.test/frame"

for (const colorScheme of ["light", "dark"] as const) {
  test(`the live broker keeps visitor state separate and confirms external links in ${colorScheme} mode`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme })
    let teamValue = "first"
    let teamAllowed = true
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
      "https://share.example.test/s/ws_synthetic/bridge",
      async (route) => {
        const body = route.request().postDataJSON()
        calls.push({
          op: body.op,
          capability: route.request().headers()["x-worktable-share-capability"],
        })
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
            ? { records: [{ id: "opaque", data: { name: "Granted data" } }] }
            : body.op === "state.read"
              ? { state: { teamValue } }
              : {}
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
        body: `<!doctype html><html><head>${buildWidgetShareRuntimeScript()}<style>:root{color-scheme:light dark}body{padding:1rem;font-family:system-ui}button,a{margin-right:1rem}</style></head><body><h1>Report</h1><p id="records"></p><p id="state"></p><button id="save">Save preference</button><button id="read">Read state</button><a href="https://outside.example.test/report">External page</a><script>
      async function showState(){document.querySelector('#state').textContent=JSON.stringify(await worktable.state.get())}
      document.querySelector('#save').onclick=async()=>{await worktable.state.set('preference','own');await worktable.state.update(current=>({...current,otherPreference:'local'}));await showState()};
      document.querySelector('#read').onclick=showState;
      worktable.records.query('deals').then(rows=>document.querySelector('#records').textContent=rows[0].data.name);
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
    await page.goto(pageUrl)
    const frame = page.frameLocator("iframe")
    await expect(frame.locator("#records")).toHaveText("Granted data")
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
    expect(calls.filter((call) => call.op === "records.query")).toHaveLength(1)
    await page.screenshot({
      path: testInfo.outputPath(`live-prompt-${colorScheme}.png`),
    })
  })
}
