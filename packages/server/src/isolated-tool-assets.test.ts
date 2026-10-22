import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import {
  isolatedToolAsset,
  isolatedToolManifest,
} from "./isolated-tool-assets.ts"
import { isolatedToolCsp } from "@worktable/ui/tool-runtime/document"

test("the tool policy names its trusted runtime and denies embedding without a parent", () => {
  const policy = isolatedToolCsp({
    assetOrigin: "https://tools.example.test",
    parentOrigin: null,
  })
  expect(policy).toContain(
    `script-src https://tools.example.test${isolatedToolManifest.path} 'wasm-unsafe-eval'`
  )
  expect(policy).toContain("frame-ancestors 'none'")
  expect(policy).toContain("connect-src 'none'")
  expect(policy).not.toContain("script-src 'unsafe-inline'")
})

test("immutable tool assets have one content address across identity, gzip, HEAD and conditional reads", async () => {
  const url = `https://workspace.invalid${isolatedToolManifest.path}`
  const response = isolatedToolAsset(new Request(url))!
  const bytes = Buffer.from(await response.arrayBuffer())
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    isolatedToolManifest.hash
  )
  const compressed = isolatedToolAsset(
    new Request(url, { headers: { "Accept-Encoding": "gzip" } })
  )!
  expect(compressed.headers.get("Content-Encoding")).toBe("gzip")
  expect(
    gunzipSync(Buffer.from(await compressed.arrayBuffer())).equals(bytes)
  ).toBe(true)
  expect(
    isolatedToolAsset(
      new Request(url, { headers: { "Accept-Encoding": "gzip;q=0" } })
    )!.headers.get("Content-Encoding")
  ).toBeNull()
  const head = isolatedToolAsset(new Request(url, { method: "HEAD" }))!
  expect(await head.text()).toBe("")
  expect(head.headers.get("ETag")).toBe(response.headers.get("ETag"))
  expect(head.headers.get("Cache-Control")).toContain("immutable")
  expect(head.headers.get("Access-Control-Allow-Origin")).toBe("*")
  const cached = isolatedToolAsset(
    new Request(url, {
      headers: { "If-None-Match": response.headers.get("ETag")! },
    })
  )!
  expect(cached.status).toBe(304)
  expect(await cached.text()).toBe("")
  expect(
    isolatedToolAsset(
      new Request(url.replace(isolatedToolManifest.hash, "0".repeat(64)))
    )
  ).toBeNull()
})
