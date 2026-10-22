import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
let directory: string
let metadata: { path: string; policy: string }
let runtime: Buffer

test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "worktable-tool-docs-"))
  execFileSync(
    "bun",
    ["apps/web/e2e/fixtures/isolated-tool-docs.ts", directory],
    { cwd: repository }
  )
  metadata = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"))
  runtime = readFileSync(
    join(repository, "packages/ui/src/tool-runtime/generated/tool.bundle.js")
  )
})
test.afterAll(() => rmSync(directory, { recursive: true, force: true }))

for (const mode of ["member", "share"] as const) {
  test(`${mode} tools use the trusted document and native broker for data, actions and recovery`, async ({
    page,
  }) => {
    const calls: {
      path: string
      method: string
      body: unknown
      widgetId?: string
      spaceId?: string
    }[] = []
    const outside: string[] = []
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction(
      "toolRequest",
      (request: (typeof calls)[number]) => {
        calls.push(request)
        const path = request.path
        if (path.includes("/private/"))
          return {
            ok: false,
            status: 403,
            body: {
              code: "FORBIDDEN",
              error: "This collection is not granted.",
            },
          }
        return { ok: true, status: 200, body: {} }
      }
    )
    const parent = `<!doctype html><meta charset="utf-8"><style>iframe{width:100%;height:500px}</style><iframe title="Tool" sandbox="allow-scripts" src="https://tool.example.test/frame"></iframe><script>
      const frame = document.querySelector('iframe');
      let state = { region: 'west', published: 'current' };
      let visitorState = {};
      let queries = 0;
      window.addEventListener('message', async event => {
        if(event.source !== frame.contentWindow || event.data.type !== 'worktable.api.request')return;
        const d = event.data;
        let answer = await window.toolRequest({ path:d.path, method:d.method, body:d.body ? JSON.parse(d.body) : null, widgetId:d.widgetId, spaceId:d.spaceId });
        if(answer.ok) {
          if(d.path.endsWith('/state')) {
            if(d.method === 'PUT') {
              if('${mode}' === 'share') visitorState = JSON.parse(d.body).state;
              else state = JSON.parse(d.body).state;
            }
            answer.body = { state: { ...state, ...visitorState }, ...('${mode}' === 'share' ? { visitorState } : {}) };
          } else if(d.path.endsWith('/query')) {
            const current = ++queries;
            answer.body = { records: [{ data: { name: current === 1 ? 'Initial data' : 'Live data' } }] };
          } else answer.body = { record: { id: 'created', data: { name: 'New record' } } };
        }
        frame.contentWindow.postMessage({ type:'worktable.api.response', id:d.id, ...answer }, '*');
      });
    </script>`
    await page.route(/^https?:\/\//, async (route) => {
      const url = route.request().url()
      if (url === "https://member.example.test/")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: parent,
        })
      if (url === "https://tool.example.test/frame")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: readFileSync(join(directory, `${mode}.html`)),
          headers: { "Content-Security-Policy": metadata.policy },
        })
      if (url === `https://tool.example.test${metadata.path}`)
        return route.fulfill({
          contentType: "text/javascript; charset=utf-8",
          body: runtime,
        })
      outside.push(url)
      return route.abort()
    })
    await page.goto("https://member.example.test/")
    const frame = page.frameLocator('iframe[title="Tool"]')
    await expect(
      frame.getByRole("heading", { name: "Équipe 東京" })
    ).toBeVisible()
    await expect(frame.getByText("Initial data", { exact: true })).toBeVisible()
    await expect(frame.locator("link,img,[onload]")).toHaveCount(0)
    await frame.getByRole("button", { name: "Choose region" }).click()
    await expect(frame.getByText("Region: east", { exact: true })).toBeVisible()
    const writes = calls.filter((call) => call.method === "PUT")
    expect(writes).toHaveLength(2)
    expect(writes[1]!.body).toEqual({
      state:
        mode === "share"
          ? { region: "east", count: 1 }
          : { region: "east", published: "current", count: 1 },
    })
    await frame.getByRole("button", { name: "Create record" }).click()
    await expect(
      frame.getByText(
        mode === "member" ? "Record created" : "Write unavailable",
        { exact: true }
      )
    ).toBeVisible()
    expect(
      calls.filter(
        (call) => call.method === "POST" && !call.path.endsWith("/query")
      )
    ).toHaveLength(mode === "member" ? 1 : 0)
    await frame.getByRole("button", { name: "Watch records" }).click()
    await expect(frame.getByText("Live data", { exact: true })).toBeVisible()
    await frame.getByRole("button", { name: "Read denied data" }).click()
    await expect(
      frame.getByText("Access refused", { exact: true })
    ).toBeVisible()
    await expect(frame.getByRole("status")).toHaveText(
      "This collection is not granted."
    )
    expect(
      calls.every((call) =>
        mode === "share"
          ? call.path.startsWith("/link/") && !call.widgetId && !call.spaceId
          : call.path.startsWith(
              "/api/spaces/demo/widgets/__document/dG9vbHMvc2FsZXM/"
            ) &&
            call.widgetId === "tools/sales" &&
            call.spaceId === "demo"
      )
    ).toBe(true)
    expect(outside).toEqual([])
    expect(errors).toEqual([])
    await info.attach(`isolated-${mode}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    })
  })
}
