import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resetViewerFramesForTests,
  viewerEnabled,
  viewerFileResponse,
  viewerFrameResponse,
} from "./viewer-frames.ts"

const POLICY = "sandbox allow-scripts; default-src 'none'; connect-src 'none'"
let dir: string

function writeViewer(policy: unknown) {
  mkdirSync(join(dir, "pdf/files/cmaps"), { recursive: true })
  writeFileSync(
    join(dir, "pdf/frame.html"),
    "<!doctype html><title>PDF</title>"
  )
  writeFileSync(join(dir, "pdf/policy.json"), JSON.stringify(policy))
  writeFileSync(join(dir, "pdf/files/cmaps/Adobe-Japan1-0.bcmap"), "cmap")
  writeFileSync(join(dir, "secret.txt"), "outside the viewer's files")
}
const get = (path: string) => new Request(`http://worktable.test${path}`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "viewer-frames-"))
  process.env["WORKTABLE_VIEWERS_DIR"] = dir
  resetViewerFramesForTests()
})
afterEach(() => {
  delete process.env["WORKTABLE_VIEWERS_DIR"]
  delete process.env["WORKTABLE_VIEWER_PDF"]
  resetViewerFramesForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe("viewer frames", () => {
  it("sends a frame only under the policy that takes its origin away", async () => {
    writeViewer({ csp: POLICY })
    const frame = await viewerFrameResponse("pdf", get("/api/viewers/pdf"))
    expect(frame.status).toBe(200)
    expect(frame.headers.get("Content-Security-Policy")).toBe(POLICY)
    expect(frame.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(await frame.text()).toContain("<title>PDF</title>")
    // A build this server can't name is checked again, never kept for good.
    expect(frame.headers.get("Cache-Control")).toBe("private, no-cache")
    const again = await viewerFrameResponse(
      "pdf",
      new Request("http://worktable.test/api/viewers/pdf", {
        headers: { "If-None-Match": frame.headers.get("ETag")! },
      })
    )
    expect(again.status).toBe(304)

    // No policy, or one that would leave the frame the app's origin: no frame.
    for (const policy of [{}, { csp: "default-src 'none'" }, "not an object"]) {
      writeViewer(policy)
      const refused = await viewerFrameResponse("pdf", get("/api/viewers/pdf"))
      expect(refused.status).toBe(404)
    }
    expect(
      (await viewerFrameResponse("docx", get("/api/viewers/docx"))).status
    ).toBe(404)
  })

  it("serves a viewer's own files by plain name, and nothing beside them", async () => {
    writeViewer({ csp: POLICY })
    const file = await viewerFileResponse(
      "pdf",
      "cmaps",
      "Adobe-Japan1-0.bcmap",
      get("/")
    )
    expect(file.status).toBe(200)
    expect(await file.text()).toBe("cmap")
    expect(file.headers.get("Content-Type")).toBe("application/octet-stream")
    for (const [kind, name] of [
      ["cmaps", "missing.bcmap"],
      ["..", "secret.txt"],
      ["cmaps", "../../secret.txt"],
      ["cmaps", "..%2F..%2Fsecret.txt"],
      ["cmaps", ".hidden"],
      ["CMAPS/..", "secret.txt"],
    ] as const) {
      expect(
        (await viewerFileResponse("pdf", kind, name, get("/"))).status
      ).toBe(404)
    }
  })

  it("sends a viewer's engine compressed to a browser that takes it", async () => {
    writeViewer({ csp: POLICY })
    mkdirSync(join(dir, "pdf/files/wasm"), { recursive: true })
    writeFileSync(join(dir, "pdf/files/wasm/engine.wasm"), "engine")
    writeFileSync(join(dir, "pdf/files/wasm/engine.wasm.br"), "small engine")
    const accepted = await viewerFileResponse(
      "pdf",
      "wasm",
      "engine.wasm",
      new Request("http://worktable.test/", {
        headers: { "Accept-Encoding": "gzip, br" },
      })
    )
    expect(accepted.headers.get("Content-Encoding")).toBe("br")
    expect(accepted.headers.get("Vary")).toBe("Accept-Encoding")
    expect(await accepted.text()).toBe("small engine")
    const plain = await viewerFileResponse(
      "pdf",
      "wasm",
      "engine.wasm",
      get("/")
    )
    expect(plain.headers.get("Content-Encoding")).toBeNull()
    expect(await plain.text()).toBe("engine")
  })

  it("turns a viewer off without a release", async () => {
    writeViewer({ csp: POLICY })
    process.env["WORKTABLE_VIEWER_PDF"] = "off"
    expect(viewerEnabled("pdf")).toBe(false)
    expect(
      (await viewerFrameResponse("pdf", get("/api/viewers/pdf"))).status
    ).toBe(404)
    expect(
      (
        await viewerFileResponse(
          "pdf",
          "cmaps",
          "Adobe-Japan1-0.bcmap",
          get("/")
        )
      ).status
    ).toBe(404)
  })
})
