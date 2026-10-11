import { expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import {
  PRODUCT_FONT_PATH,
  PRODUCT_FONT_STYLE_ID,
  productFontFaceCss,
} from "@worktable/ui/lib/fonts"
import { createAppShell } from "./app-shell.ts"

it("serves each route's shell with the installed body font, compressed and revalidated", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktable-app-shell-"))
  try {
    await mkdir(join(root, ".vite"))
    await writeFile(
      join(root, ".vite/manifest.json"),
      JSON.stringify({
        "client.tsx": { file: "assets/entry.js", isEntry: true },
        "src/routes/index.tsx?tsr-split=component": { file: "assets/home.js" },
      })
    )
    const shellPath = join(root, "_shell.html")
    const write = (title: string) =>
      writeFile(
        shellPath,
        `<html><head><title>${title}</title>` +
          '<link rel="modulepreload" href="/assets/entry.js"/>' +
          '<link rel="modulepreload" href="/assets/home.js"/>' +
          `<style id="${PRODUCT_FONT_STYLE_ID}">${productFontFaceCss(PRODUCT_FONT_PATH)}</style>` +
          "</head><body>" +
          "<p>Worktable</p>".repeat(100) +
          "</body></html>"
      )
    await write("First")
    let font: string | null = "abc123"
    const shell = createAppShell(root, shellPath, () => font)

    const versioned = `${PRODUCT_FONT_PATH}?v=abc123`
    const document = shell.html("/spaces/team/documents/notes.md")
    expect(document).toContain(
      `<link rel="preload" href="${versioned}" as="font" type="font/woff2" crossorigin=""/>`
    )
    expect(document).toContain(`src:url("${versioned}")`)
    expect(document).not.toContain("/assets/home.js")
    expect(shell.html("/")).toContain("/assets/home.js")

    const request = (headers: HeadersInit, method = "GET") =>
      new Request("http://localhost/spaces/team", { headers, method })
    const brotli = shell.response(
      "/spaces/team",
      request({ "accept-encoding": "gzip, br" })
    )
    expect(brotli.headers.get("content-encoding")).toBe("br")
    expect(brotli.headers.get("cache-control")).toBe("no-cache")
    expect(brotli.headers.get("vary")).toBe("Accept-Encoding")
    const expected = shell.html("/spaces/team")
    expect(
      brotliDecompressSync(Buffer.from(await brotli.arrayBuffer())).toString()
    ).toBe(expected)
    const gzip = shell.response(
      "/spaces/team",
      request({ "accept-encoding": "gzip" })
    )
    expect(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString()).toBe(
      expected
    )
    expect(await shell.response("/spaces/team", request({})).text()).toBe(
      expected
    )
    const etag = brotli.headers.get("etag")!
    expect(
      shell.response(
        "/spaces/team",
        request({ "accept-encoding": "br", "if-none-match": etag })
      ).status
    ).toBe(304)
    const head = shell.response(
      "/spaces/team",
      request({ "accept-encoding": "br" }, "HEAD")
    )
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0)
    expect(await head.text()).toBe("")

    // Without an installed font, fallbacks render and nothing is requested.
    font = null
    const fallback = shell.html("/spaces/team")
    expect(fallback).toContain(`<style id="${PRODUCT_FONT_STYLE_ID}"></style>`)
    expect(fallback).not.toContain(PRODUCT_FONT_PATH)

    // A rebuilt shell replaces the served pages.
    await write("Second")
    expect(shell.html("/spaces/team")).toContain("<title>Second</title>")
    expect(
      shell.response(
        "/spaces/team",
        request({ "accept-encoding": "br", "if-none-match": etag })
      ).status
    ).toBe(200)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
