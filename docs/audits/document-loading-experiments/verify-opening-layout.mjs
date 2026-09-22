// Creates/overwrites synthetic spacing fixtures. Use only an isolated review workspace.
// Holds application/editor chunks to inspect each handoff independently of machine speed.
import { chromium } from "playwright-core"
import { readFile, writeFile } from "node:fs/promises"
import assert from "node:assert/strict"
if (!process.env.AUDIT_FIXTURE_CONFIG)
  throw Error(
    "Set AUDIT_FIXTURE_CONFIG to an isolated fixture server config with root and url"
  )
const fixture = JSON.parse(await readFile(process.env.AUDIT_FIXTURE_CONFIG))
const origin = fixture.url,
  password = process.env.AUDIT_PASSWORD
const output = process.env.AUDIT_OUTPUT_PREFIX || "/tmp/worktable-spacing"
const b = await chromium.connectOverCDP(
  process.env.AUDIT_CDP || "http://127.0.0.1:18800"
)
const results = []
const heading =
  "A long document title that wraps onto several lines on a narrow screen"
const body =
  "The first paragraph stays anchored while the saved preview becomes a live document. Its wrapping should match too."
const text = (t) => [{ type: "text", text: t, styles: {} }]
const paragraph = (t, id) => ({ id, type: "paragraph", content: text(t) })
const blocks = [
  { id: "title", type: "heading", props: { level: 1 }, content: text(heading) },
  paragraph(body, "body"),
  ...Array.from({ length: 50 }, (_, i) =>
    paragraph(
      "A further paragraph for checking the scroll position " + i,
      "p" + i
    )
  ),
]
const setup = await b.newContext()
async function login(c) {
  if (!password) return
  const r = await c.request.post(origin + "/auth/login", {
    data: { password },
    headers: { Origin: origin },
  })
  assert(r.ok())
}
try {
  await login(setup)
  for (const [path, content] of [
    ["spacing-heading", blocks],
    ["spacing-paragraph", blocks.slice(1)],
  ]) {
    const r = await setup.request.put(
      origin + "/api/spaces/loading-audit/docs/" + path,
      { data: { content }, headers: { Origin: origin } }
    )
    assert(r.ok(), await r.text())
  }
  await writeFile(
    fixture.root + "/workspace/spaces/loading-audit/docs/spacing-markdown.md",
    "# " +
      heading +
      "\n\n" +
      body +
      "\n\n" +
      Array.from(
        { length: 50 },
        (_, i) => "A further paragraph for checking the scroll position " + i
      ).join("\n\n")
  )
  await setup.close()
  for (const width of [1440, 390])
    for (const path of [
      "spacing-heading",
      "spacing-paragraph",
      "spacing-markdown",
    ]) {
      const c = await b.newContext({ viewport: { width, height: 1000 } }),
        p = await c.newPage(),
        errors = []
      p.on("pageerror", (e) => errors.push(String(e)))
      await login(c)
      await p.addInitScript(() => {
        const Native = window.WebSocket
        window.__auditSockets = []
        window.WebSocket = class extends Native {
          constructor(...args) {
            super(...args)
            window.__auditSockets.push(this)
          }
        }
      })
      // Isolate geometry from font delivery. The user-data check uses real fonts separately.
      await p.route(
        /https:\/\/(api\.fontshare\.com|fonts\.googleapis\.com)\//,
        (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" })
      )
      let releaseMain, releaseEditor
      const mainGate = new Promise((r) => (releaseMain = r)),
        editorGate = new Promise((r) => (releaseEditor = r))
      await p.route("**/assets/main-*.js", async (r) => {
        await mainGate
        await r.continue().catch(() => {})
      })
      await p.route("**/assets/editor-*.js", async (r) => {
        await editorGate
        await r.continue().catch(() => {})
      })
      const measure = () =>
        p.evaluate(() => {
          const a =
            document.querySelector("#worktable-opening-preview article") ??
            document.querySelector("main [data-document-preview] article") ??
            document.querySelector("main .worktable-editor-content") ??
            document.querySelector("main article.worktable-markdown")
          const h = a?.querySelector("h1,h2,h3,p"),
            para = a?.querySelector("p")
          const rect = (el) => {
            if (!el) return null
            const r = el.getBoundingClientRect()
            return {
              top: r.top,
              textTop:
                r.top +
                parseFloat(getComputedStyle(el).paddingTop) +
                parseFloat(getComputedStyle(el).borderTopWidth),
              left: r.left,
              width: r.width,
              height: r.height,
              contentHeight:
                r.height -
                parseFloat(getComputedStyle(el).paddingTop) -
                parseFloat(getComputedStyle(el).paddingBottom),
              lineHeight: getComputedStyle(el).lineHeight,
              font: getComputedStyle(el).font,
              letterSpacing: getComputedStyle(el).letterSpacing,
              wordSpacing: getComputedStyle(el).wordSpacing,
              text: el.matches("h1,p") ? el.innerText : null,
            }
          }
          const pill = [
            ...document.querySelectorAll("[data-document-status]"),
          ].find((x) => {
            const r = x.getBoundingClientRect()
            return (
              document
                .elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
                ?.closest("[data-document-status]") === x
            )
          })
          return {
            article: rect(a),
            first: rect(h),
            paragraph: rect(para),
            pill: pill
              ? {
                  state: pill.getAttribute("data-document-status"),
                  ...rect(pill),
                }
              : null,
          }
        })
      let initial = null,
        pending = null
      try {
        await c.request.get(origin + "/spaces/loading-audit/documents/" + path)
        await p.goto(origin + "/spaces/loading-audit/documents/" + path, {
          waitUntil: "commit",
        })
        await p.bringToFront()
        await p.waitForFunction(
          () => {
            const a = document.querySelector(
              "#worktable-opening-preview article"
            )
            return a && getComputedStyle(a).paddingTop === "64px"
          },
          {},
          { timeout: 20000 }
        )
        initial = await measure()
        assert.equal(initial.first.top - initial.article.top, 64)
        assert.equal(initial.pill?.state, "opening")
        assert.equal(initial.pill.left, width < 768 ? 16 : 304)
        await p
          .locator("#worktable-opening-preview [data-document-preview]")
          .evaluate((e) => (e.scrollTop = 180))
        releaseMain()
        const rich = path !== "spacing-markdown"
        if (rich) {
          await p
            .locator("main [data-document-preview]")
            .waitFor({ timeout: 60000 })
          await p.waitForFunction(
            () =>
              !document.getElementById("worktable-opening-preview")
                ?.childElementCount
          )
          const clientPreview = p.locator("main [data-document-preview]")
          assert.equal(
            await clientPreview.evaluate((e) => e.scrollTop),
            180,
            "Initial HTML reading position reaches the client preview"
          )
          await clientPreview.evaluate((e) => (e.scrollTop = 0))
          await p.waitForTimeout(2100)
          pending = await measure()
          assert.equal(
            pending.pill?.state,
            "opening",
            "Do not hide or announce Synced before the editor mounts"
          )
          // Scroll in the preview after layout measurements, then verify handoff preserves it.
          await p.locator("main [data-document-preview]").evaluate((e) => {
            e.scrollTop = 180
            e.dispatchEvent(new Event("scroll", { bubbles: true }))
          })
        }
        releaseEditor()
        if (rich) {
          await p.waitForFunction(
            () => {
              const e = document.querySelector(
                ".bn-editor[contenteditable=true]"
              )
              return (
                e &&
                !e.closest("[inert]") &&
                !document.querySelector("[data-document-preview]")
              )
            },
            undefined,
            { timeout: 60000 }
          )
          const top = await p
            .locator(".worktable-editor-scroll-root")
            .evaluate((e) => e.scrollTop)
          assert(Math.abs(top - 180) < 2, "Reading scroll position preserved")
          await p
            .locator(".worktable-editor-scroll-root")
            .evaluate((e) => (e.scrollTop = 0))
        } else {
          await p
            .locator("main article.worktable-markdown")
            .waitFor({ timeout: 60000 })
          await p.waitForFunction(
            () => !document.querySelector("[data-document-preview]")
          )
          const scrollRoot = p.locator("main [data-document-scroll-root]")
          assert.equal(
            await scrollRoot.evaluate((e) => e.scrollTop),
            180,
            "Initial HTML reading position reaches the Markdown scroll container"
          )
          await scrollRoot.evaluate((e) => (e.scrollTop = 0))
        }
        const ready = await measure()
        assert.equal(ready.first.top - ready.article.top, 64)
        assert(
          Math.abs(initial.first.top - ready.first.top) < 1,
          "First block stays anchored"
        )
        assert(
          Math.abs(initial.first.contentHeight - ready.first.contentHeight) < 1,
          "First block retains line height/wrapping"
        )
        if (path === "spacing-heading")
          assert(
            Math.abs(initial.paragraph.textTop - ready.paragraph.textTop) < 1,
            "Body does not jump below the title"
          )
        if (rich) {
          assert.equal(ready.pill?.state, "synced")
          await p.waitForFunction(
            () => !document.querySelector("[data-document-status]"),
            undefined,
            { timeout: 5000 }
          )
        } else assert.equal(ready.pill, null)
        if (rich && path === "spacing-heading") {
          await c.setOffline(true)
          await p.evaluate(() =>
            window.__auditSockets.forEach((s) => s.close())
          )
          await p
            .locator("[data-document-status=offline]")
            .waitFor({ timeout: 10000 })
          await c.setOffline(false)
          await p
            .locator("[data-document-status=synced]")
            .waitFor({ timeout: 20000 })
          const first = p.locator(".bn-editor .bn-inline-content").first(),
            previous = await first.innerText()
          await first.click()
          await p.keyboard.press("End")
          await p.keyboard.type("x")
          await p.keyboard.press("Control+z")
          assert.equal(await first.innerText(), previous)
        }
        await p.screenshot({ path: `${output}-${width}-${path}.png` })
        assert.deepEqual(errors, [])
        results.push({
          width,
          path,
          initial,
          pending,
          ready,
          errors,
          passed: true,
        })
        console.log(
          JSON.stringify({
            width,
            path,
            passed: true,
            top: ready.first.top,
            bodyTop: ready.paragraph.top,
          })
        )
      } catch (error) {
        results.push({
          width,
          path,
          failure: String(error),
          initial,
          pending,
          errors,
          geometry: await measure().catch(() => null),
        })
        console.log(JSON.stringify(results.at(-1)))
        await p
          .screenshot({ path: `${output}-failure-${width}-${path}.png` })
          .catch(() => {})
      } finally {
        releaseMain()
        releaseEditor()
        await c.close()
        await writeFile(
          output + "-validation.json",
          JSON.stringify(results, null, 2)
        )
      }
    }
  assert(
    results.every((x) => x.passed),
    "One or more layout/status checks failed"
  )
} finally {
  await b.close()
}
