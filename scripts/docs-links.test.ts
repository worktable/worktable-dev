import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkDocsLinks } from "./docs-links.ts"

test("checks built targets and anchors through redirects without requesting external sites", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-doc-links-"))
  try {
    for (const path of ["guide", "old"]) mkdirSync(join(root, path))
    writeFileSync(
      join(root, "index.html"),
      '<a href="/old/#setup">Valid</a><a href="/guide/#missing">Missing anchor</a><img src="/missing.png"><a href="/..%2foutside.html">Outside</a><a href="https://example.invalid/">External</a>'
    )
    writeFileSync(
      join(root, "old/index.html"),
      '<meta http-equiv="refresh" content="0;url=/guide/">'
    )
    writeFileSync(join(root, "guide/index.html"), '<h2 id="setup">Setup</h2>')
    const result = await checkDocsLinks(root)
    expect(result.errors).toEqual([
      "/: /guide/#missing (Missing anchor #missing)",
      "/: /missing.png (Missing file)",
      "/: /..%2foutside.html (Path leaves the site)",
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
