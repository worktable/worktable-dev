// Constrains the sandboxed iframe response as well as the parent page.
// Only isolated HTTP fixtures are supported. Auth occurs outside the timer.
import { chromium } from "playwright-core"
import { startThrottledFixtureProxy } from "./throttled-fixture-proxy.mjs"
import { writeFile } from "node:fs/promises"
const before = process.env.AUDIT_BEFORE,
  after = process.env.AUDIT_AFTER,
  password = process.env.AUDIT_PASSWORD
if (!before || !after)
  throw Error(
    "AUDIT_BEFORE and AUDIT_AFTER must identify isolated HTTP fixture servers"
  )
const output = process.env.AUDIT_OUTPUT || "/tmp/worktable-proxy-html.json"
const b = await chromium.connectOverCDP(
    process.env.AUDIT_CDP || "http://127.0.0.1:18800"
  ),
  rows = []
try {
  for (let i = 1; i <= 2; i++)
    for (const [label, origin] of i % 2
      ? [
          ["before", before],
          ["after", after],
        ]
      : [
          ["after", after],
          ["before", before],
        ]) {
      const proxy = await startThrottledFixtureProxy(origin)
      const ctx = await b.newContext({
        viewport: { width: 1280, height: 900 },
        proxy: { server: proxy.url },
      })
      const p = await ctx.newPage(),
        errors = []
      p.on("pageerror", (e) => errors.push(String(e)))
      try {
        const login = await fetch(origin + "/auth/login", {
          method: "POST",
          body: JSON.stringify({ password }),
          headers: { Origin: origin, "Content-Type": "application/json" },
        })
        if (!login.ok) throw Error("login " + login.status)
        await ctx.addCookies(
          login.headers.getSetCookie().map((raw) => {
            const part = raw.split(";")[0],
              split = part.indexOf("=")
            return {
              name: part.slice(0, split),
              value: part.slice(split + 1),
              url: origin,
              httpOnly: true,
              sameSite: "Lax",
            }
          })
        )
        const c = await ctx.newCDPSession(p)
        await c.send("Emulation.setCPUThrottlingRate", { rate: 4 })
        await p.bringToFront()
        const start = Date.now()
        await p.goto(origin + "/spaces/loading-audit/documents/html-audit", {
          waitUntil: "commit",
        })
        await p
          .frameLocator("iframe[data-worktable-widget-frame]")
          .getByRole("heading", { name: "Audit HTML ready" })
          .waitFor({ timeout: 90000 })
        await p.waitForFunction(
          () => !document.querySelector('[aria-label="Opening document"]')
        )
        const readyMs = Date.now() - start
        const data = await p.evaluate(() => ({
          resources: performance
            .getEntriesByType("resource")
            .map((e) => ({
              path: new URL(e.name).pathname,
              start: e.startTime,
              duration: e.duration,
              bytes: e.encodedBodySize,
            })),
          navigation: performance.getEntriesByType("navigation")[0].toJSON(),
        }))
        const frame = p.frames().find((f) => f !== p.mainFrame())
        const frameNavigation = await frame.evaluate(() =>
          performance.getEntriesByType("navigation")[0].toJSON()
        )
        if (frameNavigation.responseEnd < 400)
          throw Error("Frame escaped proxy delay")
        rows.push({
          label: label + "-" + i,
          readyMs,
          errors,
          frameNavigation,
          ...data,
        })
        console.log(
          JSON.stringify({
            label,
            i,
            readyMs,
            frameResponseMs: frameNavigation.responseEnd,
            errors,
          })
        )
      } catch (error) {
        rows.push({ label: label + "-" + i, failure: String(error), errors })
        console.log(String(error))
      } finally {
        await ctx.close()
        await proxy.close()
        await writeFile(
          output,
          JSON.stringify(
            {
              profile:
                "Loopback HTTP proxy: 400 ms request latency, shared 1.6 Mbps response budget, 0.75 Mbps request body budget; main page 4x CPU; WebSocket bodies unthrottled after delayed handshake. Static HTML fixture has no external resources.",
              runs: rows,
            },
            null,
            2
          )
        )
      }
    }
} finally {
  await b.close()
}
