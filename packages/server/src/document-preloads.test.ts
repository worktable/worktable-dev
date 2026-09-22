import { expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDocumentPreloads } from "./document-preloads.ts"

it("preloads only the selected renderer's static dependencies, deduplicating cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktable-preloads-"))
  try {
    await mkdir(join(root, ".vite"))
    await writeFile(
      join(root, ".vite/manifest.json"),
      JSON.stringify({
        "src/components/doc-document.tsx": {
          file: "assets/doc.js",
          imports: ["shared"],
          dynamicImports: ["mermaid"],
        },
        "_editor-abc.js": {
          name: "editor",
          file: "assets/editor.js",
          imports: ["shared"],
        },
        "src/components/html-document.tsx": {
          file: "assets/html.js",
          imports: ["unsafe"],
        },
        shared: {
          file: "assets/shared.js",
          imports: ["src/components/doc-document.tsx"],
        },
        mermaid: { file: "assets/mermaid.js" },
        unsafe: { file: "https://foreign.test/code.js" },
      })
    )
    expect(readDocumentPreloads(root)).toEqual({
      "rich-text": ["/assets/shared.js", "/assets/doc.js", "/assets/editor.js"],
      markdown: ["/assets/shared.js", "/assets/doc.js"],
      html: ["/assets/html.js"],
    })
    await rm(join(root, ".vite/manifest.json"))
    expect(readDocumentPreloads(root)).toEqual({
      "rich-text": [],
      markdown: [],
      html: [],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
