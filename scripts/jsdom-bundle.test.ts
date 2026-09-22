import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { jsdomBundlePlugin } from "./jsdom-bundle"

test("the compiled BlockNote DOM runtime includes its stylesheet without build-machine lookups", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-portable-dom-"))
  try {
    const require = createRequire(import.meta.resolve("@blocknote/server-util"))
    const jsdom = require.resolve("jsdom")
    const entry = join(root, "entry.ts")
    const executable = join(root, "dom-runtime")
    writeFileSync(
      entry,
      `
      import { JSDOM } from ${JSON.stringify(jsdom)}
      const dom = new JSDOM('<p>Portable document</p>')
      const p = dom.window.document.querySelector('p')
      console.log(JSON.stringify({ text: p.textContent, display: dom.window.getComputedStyle(p).display }))
      dom.window.close()
    `
    )
    const result = await Bun.build({
      entrypoints: [entry],
      compile: { outfile: executable },
      plugins: [jsdomBundlePlugin],
    })
    expect(result.success).toBe(true)
    const bytes = readFileSync(executable)
    expect(
      bytes.includes(Buffer.from(resolve(import.meta.dir, "..") + "/"))
    ).toBe(false)
    expect(bytes.includes(Buffer.from("xhr-sync-worker.js"))).toBe(false)
    const child = Bun.spawn([executable], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      text: "Portable document",
      display: "block",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
