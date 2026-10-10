import { expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  readDocumentPreloads,
  readRoutePreloads,
  shellWithRoutePreloads,
} from "./document-preloads.ts"

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

it("starts each route with the entry's modules and its own, not the home page's", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktable-route-preloads-"))
  try {
    await mkdir(join(root, ".vite"))
    const route = (file: string, ...imports: string[]) => ({
      file: `assets/${file}.js`,
      imports: ["client.tsx", ...imports],
    })
    await writeFile(
      join(root, ".vite/manifest.json"),
      JSON.stringify({
        "client.tsx": {
          file: "assets/entry.js",
          isEntry: true,
          imports: ["_runtime.js"],
        },
        "_runtime.js": { file: "assets/runtime.js" },
        "_feed.js": { file: "assets/feed.js", imports: ["_runtime.js"] },
        "src/routes/index.tsx?tsr-split=component": route("home", "_feed.js"),
        "src/routes/login.tsx?tsr-split=component": route("login"),
        "src/routes/spaces/$spaceId.tsx?tsr-split=component": route(
          "space",
          "_feed.js"
        ),
        "src/routes/spaces/$spaceId/documents/$.tsx?tsr-split=component":
          route("document"),
        "src/components/app-sidebar.tsx": route("sidebar"),
      })
    )
    // As prerendered for "/": the entry's modules, then the home route's.
    const shell =
      '<html><head><meta charSet="utf-8"/>' +
      ["entry", "runtime", "home", "feed"]
        .map((file) => `<link rel="modulepreload" href="/assets/${file}.js"/>`)
        .join("") +
      '<link rel="icon" href="/favicon.ico"/></head><body></body></html>'
    const routes = readRoutePreloads(root)!
    const preloads = (path: string) => {
      const html = shellWithRoutePreloads(
        shell,
        routes.entry,
        routes.forPath(path).files
      )
      expect(html).toContain('<link rel="icon" href="/favicon.ico"/></head>')
      return [
        ...html.matchAll(/"modulepreload" href="\/assets\/(\w+)\.js"/g),
      ].map((match) => match[1])
    }
    expect(preloads("/")).toEqual([
      "entry",
      "runtime",
      "feed",
      "home",
      "sidebar",
    ])
    expect(preloads("/spaces/team/documents/notes.md")).toEqual([
      "entry",
      "runtime",
      "feed",
      "space",
      "document",
      "sidebar",
    ])
    expect(preloads("/login")).toEqual(["entry", "runtime", "login"])
    expect(preloads("/somewhere/else")).toEqual(["entry", "runtime", "sidebar"])

    await rm(join(root, ".vite/manifest.json"))
    expect(readRoutePreloads(root)).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
