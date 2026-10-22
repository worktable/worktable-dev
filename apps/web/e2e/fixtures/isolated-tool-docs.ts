import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  isolatedToolFrame,
  isolatedToolCsp,
} from "@worktable/ui/tool-runtime/document"
import { isolatedToolSource } from "../../../../packages/server/src/isolated-tool-source.ts"
import { isolatedToolManifest } from "../../../../packages/server/src/isolated-tool-assets.ts"

const destination = process.argv[2]!
mkdirSync(destination, { recursive: true })
for (const mode of ["member", "share"] as const) {
  const source = `
  let status = '';
  let data = await worktable.records.query('sales');
  let state = await worktable.state.get();
  const render = () => worktable.ui.render({ tag: 'section', children: [
    { tag: 'h1', children: ['Équipe 東京'] },
    { tag: 'p', children: [data[0].data.name] },
    { tag: 'p', children: ['Region: ' + state.region] },
    { tag: 'p', children: [status] },
    { tag: 'button', children: ['Choose region'], on: { click: 'state' } },
    { tag: 'button', children: ['Create record'], on: { click: 'create' } },
    { tag: 'button', children: ['Watch records'], on: { click: 'watch' } },
    { tag: 'button', children: ['Read denied data'], on: { click: 'denied' } },
  ] });
  worktable.ui.on('state', async () => { await worktable.state.set('region', 'east'); state = await worktable.state.update(value => ({ ...value, count: (value.count || 0) + 1 })); await render(); });
  worktable.ui.on('create', async () => { try { await worktable.records.create('sales', { name: 'New record' }); status = 'Record created'; } catch { status = 'Write unavailable'; } await render(); });
  worktable.ui.on('watch', () => worktable.records.subscribe('sales', async rows => { data = rows; await render(); }));
  worktable.ui.on('denied', async () => { try { await worktable.records.query('private'); } catch { status = 'Access refused'; } await render(); });
  await render();
  `
  const html = `<link rel="preconnect" href="https://outside.invalid"><body onload="fetch('https://outside.invalid')"><script type="application/worktable">${source}</script><img src="https://outside.invalid">`
  const program = isolatedToolSource(html)!
  writeFileSync(
    join(destination, `${mode}.html`),
    isolatedToolFrame(
      program,
      {
        mode,
        ...(mode === "member"
          ? {
              spaceId: "demo",
              widgetId: "tools/sales",
              apiBase: "/api/spaces/demo/widgets/__document/dG9vbHMvc2FsZXM",
            }
          : {}),
      },
      { theme: "dark", fontStyles: "" }
    )
  )
}
writeFileSync(
  join(destination, "metadata.json"),
  JSON.stringify({
    path: isolatedToolManifest.path,
    policy: isolatedToolCsp({
      assetOrigin: "https://tool.example.test",
      parentOrigin: "https://member.example.test",
    }),
  })
)
