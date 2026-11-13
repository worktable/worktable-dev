import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { JSDOM } from "jsdom"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { renderPublicHtmlProjection } from "./public-share-renderer.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { widgetsRouter } from "./routes/widgets.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const SPACE = "meta"
let root = ""
let app: Hono

const page = (body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${body}</body></html>`

const BODY = [
  '<p><svg data-icon="circle-check" class="ok" width="20"></svg> Shipped</p>',
  // Former names and other spellings still answer.
  '<p><svg data-icon="AlertTriangle" aria-label="Blocked"/> Blocked</p>',
  // The page's own drawing, a name the library lacks, and script text stay.
  '<svg data-icon="mine"><circle cx="5" cy="5" r="3"/></svg>',
  '<svg data-icon="tick-mark"></svg>',
  "<script>const tag = '<svg data-icon=\"x\"></svg>'</script>",
  '<!-- <svg data-icon="info"></svg> -->',
  // Markup inside another tag's attribute, other tags named svg-something,
  // and object properties are not icons.
  `<div title="<svg data-icon='info'></svg>">x</div>`,
  '<svg-icon data-icon="info"></svg-icon>',
  '<svg data-icon="toString"></svg>',
].join("")

async function frame(path: string): Promise<string> {
  const response = await app.request(
    `/api/spaces/${SPACE}/widgets/${path}/content?theme=light`
  )
  expect(response.status).toBe(200)
  return response.text()
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "worktable-html-icons-"))
  setWorkspaceRootOverride(join(root, "workspace"))
  setAppDirOverride(join(root, "app"))
  mkdirSync(join(root, "workspace"), { recursive: true })
  ensureWorkspaceManifest()
  app = new Hono()
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity())
    await next()
  })
  app.route("/api/spaces", spacesRouter)
  app.route("/api/spaces/:spaceId/widgets", widgetsRouter)
  const created = await app.request("/api/spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Meta" }),
  })
  expect(created.status).toBe(201)
})

afterEach(() => {
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  rmSync(root, { recursive: true, force: true })
})

describe("Icons in HTML Docs", () => {
  it("draws the icons a page names when it is served, and warns about names the library lacks", async () => {
    const created = (await dispatchOperation("html.create", {
      spaceId: SPACE,
      id: "status",
      name: "Status",
      html: page(BODY),
    })) as { warnings: Array<{ code: string; message: string }> }
    const unknown = created.warnings.filter((warning) =>
      warning.code.startsWith("html_icon")
    )
    expect(unknown.map((warning) => warning.code)).toEqual([
      "html_icon_unknown",
    ])
    // Only the names the library lacks, with close ones to try.
    expect(unknown[0]!.message).toMatch(
      /stays empty: "tick-mark" \(try [a-z-]+(, [a-z-]+)*\); "toString"[^;]*\.$/
    )

    const served = await frame("status")
    // The page's attributes stay; Worktable adds what's missing.
    expect(served).toContain(
      '<svg data-icon="circle-check" class="ok" width="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg> Shipped'
    )
    expect(served).toMatch(
      /<svg data-icon="AlertTriangle" aria-label="Blocked" [^>]*role="img"><path d="m21\.73 18-8-14/
    )
    expect(served).toContain(
      '<svg data-icon="mine"><circle cx="5" cy="5" r="3"/></svg>'
    )
    expect(served).toContain('<svg data-icon="tick-mark"></svg>')
    expect(served).toContain("const tag = '<svg data-icon=\"x\"></svg>'")
    expect(served).toContain('<!-- <svg data-icon="info"></svg> -->')
    expect(served).toContain(
      `<div title="<svg data-icon='info'></svg>">x</div><svg-icon data-icon="info"></svg-icon><svg data-icon="toString"></svg>`
    )

    // The scriptless share view keeps the drawing through its sanitizer.
    const shared = renderPublicHtmlProjection(page(BODY))
    expect(shared).toMatch(
      /<svg data-icon="circle-check"[^>]*viewBox="0 0 24 24"[^>]*><circle cx="12" cy="12" r="10"><\/circle><path d="m9 12 2 2 4-4"><\/path><\/svg>/
    )
  })

  it("draws the icons page code adds, from the names its scripts write out", async () => {
    // A Records-style tool: rows rendered by code, icons from a status map.
    const tool = page(
      `<ul id="rows"></ul><script>
const STATUS = { done: "CircleCheck", blocked: "circle-x" }
const arrow = (dir) => \`<svg data-icon="arrow-\${dir}"></svg>\`
window.render = (rows) => {
  document.getElementById("rows").innerHTML = rows
    .map((row) => '<li><svg data-icon="' + STATUS[row] + '"></svg>' + row + "</li>")
    .join("")
}
render(["done"])
const typo = '<svg data-icon="circle-chek"></svg>'
const other = '<div metadata-icon="not-an-icon"></div>'
</script>`
    )
    const created = (await dispatchOperation("html.create", {
      spaceId: SPACE,
      id: "tool",
      name: "Tool",
      html: tool,
    })) as { warnings: Array<{ code: string; message: string }> }
    // A data-icon name in code the library lacks is warned about; the
    // status map's other strings are not.
    expect(
      created.warnings
        .filter((warning) => warning.code === "html_icon_unknown")
        .map((warning) => warning.message)
    ).toEqual([expect.stringMatching(/stays empty: "circle-chek" \(try /)])

    // The live frame carries the drawings its code may need, run from the
    // script Worktable serves, ahead of the page's own.
    const served = await frame("tool")
    const script = served.match(
      /<script data-worktable-runtime="icons">([\s\S]*?)<\/script>/
    )?.[1]
    expect(script).toBeDefined()
    const dom = new JSDOM(
      tool.replace(
        "<head>",
        `<head><script>window.reports = []; window.worktable = { diagnostics: { report: (d) => window.reports.push(d.code) } }</script><script>${script}</script>`
      ),
      { runScripts: "dangerously" } as ConstructorParameters<typeof JSDOM>[1]
    )
    const { window } = dom
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    const icons = () =>
      [...window.document.querySelectorAll("#rows svg")].map(
        (svg) => `${svg.getAttribute("data-icon")}:${svg.children.length}`
      )
    await settle()
    expect(icons()).toEqual(["CircleCheck:2"])
    ;(window as unknown as { render(rows: string[]): void }).render([
      "blocked",
      "done",
    ])
    await settle()
    expect(icons()).toEqual(["circle-x:3", "CircleCheck:2"])
    // Code changing an icon's name redraws it; a name the page never writes
    // out clears it and is reported once.
    const first = window.document.querySelector("#rows svg")!
    first.setAttribute("data-icon", "circle-check")
    await settle()
    expect(icons()).toEqual(["circle-check:2", "CircleCheck:2"])
    // A framework writing the same name again leaves the page's own drawing.
    const drawing = window.document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    )
    drawing.setAttribute("data-icon", "mine")
    drawing.innerHTML = '<circle r="3"/>'
    window.document.body.append(drawing)
    await settle()
    drawing.setAttribute("data-icon", "mine")
    await settle()
    expect(drawing.children.length).toBe(1)
    for (const name of ["rocket", "circle-x", "rocket"]) {
      first.setAttribute("data-icon", name)
      await settle()
    }
    expect(icons()).toEqual(["rocket:0", "CircleCheck:2"])
    // A framework that empties a drawn icon gets it drawn again, once.
    window.document.querySelectorAll("#rows svg")[1]!.replaceChildren()
    await settle()
    expect(icons()).toEqual(["rocket:0", "CircleCheck:2"])
    expect((window as unknown as { reports: string[] }).reports).toEqual([
      "html_icon_not_on_page",
    ])

    // A page whose code never says data-icon gets no script.
    await dispatchOperation("html.create", {
      spaceId: SPACE,
      id: "plain",
      name: "Plain",
      html: page('<script>const mark = "circle-check"</script>'),
    })
    expect(await frame("plain")).not.toContain('data-worktable-runtime="icons"')
  })
})
