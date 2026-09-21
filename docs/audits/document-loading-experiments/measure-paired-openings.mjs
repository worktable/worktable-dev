// Three alternating cold-browser pairs against isolated production fixtures.
// Servers remain running. HTML throttles only the top page; use the proxy check
// for a constrained iframe. No speed claim should hide errors or failed runs.
import { chromium } from "playwright-core"
import { writeFile } from "node:fs/promises"
const before = process.env.AUDIT_BEFORE,
  editor = process.env.AUDIT_AFTER
if (!before || !editor)
  throw Error(
    "AUDIT_BEFORE and AUDIT_AFTER must identify isolated fixture servers"
  )
const lan = { password: process.env.AUDIT_PASSWORD }
const output = process.env.AUDIT_OUTPUT || "/tmp/worktable-paired-openings.json"
const b = await chromium.connectOverCDP(
  process.env.AUDIT_CDP || "http://127.0.0.1:18800"
)
const rows = []
async function run(label, origin, target, kind) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }),
    p = await ctx.newPage(),
    errors = []
  p.on("pageerror", (e) => errors.push(String(e)))
  const c = await ctx.newCDPSession(p)
  await c.send("Network.enable")
  await c.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 100,
    downloadThroughput: 1250000,
    uploadThroughput: 500000,
  })
  await c.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  const login = await ctx.request.post(origin + "/auth/login", {
    data: { password: lan.password },
    headers: { Origin: origin },
  })
  if (!login.ok()) throw Error("Login failed " + login.status())
  await p.bringToFront()
  await p.addInitScript(() => {
    if (window !== window.top) return
    localStorage.setItem("theme", "dark")
    window.__preview = null
    window.__long = []
    const obs = new MutationObserver(() => {
      if (!document.querySelector("[data-document-preview]")) return
      obs.disconnect()
      requestAnimationFrame(() => {
        window.__previewAvailable = performance.now()
        requestAnimationFrame(() => {
          window.__preview = performance.now()
        })
      })
    })
    obs.observe(document, { subtree: true, childList: true })
    new PerformanceObserver((l) =>
      window.__long.push(
        ...l
          .getEntries()
          .map((e) => ({ start: e.startTime, duration: e.duration }))
      )
    ).observe({ type: "longtask", buffered: true })
  })
  const t = Date.now()
  try {
    await p.goto(
      origin +
        (kind === "reader" ? "/" : "/spaces/loading-audit/documents/") +
        target,
      { waitUntil: "commit" }
    )
    if (kind === "reader")
      await p
        .locator("[data-document-preview] p")
        .first()
        .waitFor({ timeout: 60000 })
    else if (target === "html-audit") {
      await p
        .frameLocator("iframe[data-worktable-widget-frame]")
        .getByRole("heading", { name: "Audit HTML ready" })
        .waitFor({ timeout: 90000 })
      await p.waitForFunction(
        () => !document.querySelector('[aria-label="Opening document"]')
      )
    } else
      await p
        .locator(
          `.bn-editor .bn-block-outer[data-id="p-${Number(target.split("-")[1]) - 1}"]`
        )
        .waitFor({ timeout: 90000 })
    await p.waitForFunction(
      () =>
        !document.getElementById("worktable-opening-preview")?.childElementCount
    )
    const ready = Date.now() - t
    const data = await p.evaluate(() => ({
      stylesheets: [...document.styleSheets].map((s) => s.href).filter(Boolean),
      previewMs: window.__preview,
      previewAvailableMs: window.__previewAvailable,
      longtasks: window.__long,
      resources: performance
        .getEntriesByType("resource")
        .map((e) => ({
          path: new URL(e.name).pathname,
          start: e.startTime,
          duration: e.duration,
          bytes: e.encodedBodySize,
        })),
      navigation: performance.getEntriesByType("navigation")[0].toJSON(),
      paints: performance.getEntriesByType("paint").map((p) => p.toJSON()),
    }))
    rows.push({ label, target, kind, ready, errors, ...data })
    console.log(
      JSON.stringify({
        label,
        target,
        ready,
        previewMs: data.previewMs,
        errors,
      })
    )
    await writeFile(output, JSON.stringify(rows, null, 2))
  } catch (error) {
    rows.push({
      label,
      target,
      kind,
      elapsedMs: Date.now() - t,
      failure: String(error),
      errors,
    })
    console.log(JSON.stringify(rows.at(-1)))
    await writeFile(output, JSON.stringify(rows, null, 2))
  } finally {
    await ctx.close()
  }
}
try {
  for (const target of ["rich-10", "html-audit", "rich-2000"])
    for (let i = 1; i <= 3; i++)
      for (const [label, origin] of i % 2
        ? [
            ["before", before],
            ["after", editor],
          ]
        : [
            ["after", editor],
            ["before", before],
          ])
        await run(label + "-" + i, origin, target, "editor")
} finally {
  await b.close()
}
