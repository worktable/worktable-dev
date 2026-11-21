import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { ownerIdentity } from "./auth.ts"
import { parseChangedFiles } from "./contents-background.ts"
import { closeDerivedStore, derivedStore } from "./derived-store.ts"
import { documentsRouter } from "./routes/documents.ts"
import { writeSpace } from "./store.ts"
import { previewTest } from "./test-support/synthetic-preview.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  writeWorkspaceManifest,
} from "./workspace.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"
import {
  drawWordPdf,
  printPolicy,
  WordRenditionError,
} from "./word-renditions.ts"

/**
 * A two-page Word file made for these tests: a bold title, a line, then a
 * page break and a second line.
 */
const PLAN_DOCX = Buffer.from(
  "UEsDBBQAAAAIAAAAdF3JTxqw6wAAAK4BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QvU7DMBDeeQrLK4odGBBCSTrwMwJDeYCTfUks7LPlc0v79jht6YAK4933q69b7YIXW8zsIvXyRrVSIJloHU29/Fi/NPdScAGy4CNhL/fIcjVcdet9QhZVTNzLuZT0oDWbGQOwigmpImPMAUo986QTmE+YUN+27Z02kQpSacriIYfuCUfY+CKed/V9LJLRsxSPR+KS1UtIyTsDpeJ6S/ZXSnNKUFV54PDsEl9XgtQXExbk74CT7q0uk51F8Q65vEKoLP0Vs9U2mk2oSvW/zYWecRydwbN+cUs5GmSukwevzkgARz/99WHu4RtQSwMEFAAAAAgAAAB0XbmBRHGwAAAAKgEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4J1TRN5pWgaEUJMuCKkrKgeIEjeNaB5KwqO3JwMDIAZG278/y233sDO5YUzGOwZNVQNBJ70yTjM4D8f1DkjKwikxe4cMFkzQ8VV7wlnkspMmExIpiEsMppzDntIkJ7QiVT6gK5PRRytyKaOmQciL0Eg3db2l8d0A/mGSXjGIvWqADEvAf2w/jkbiwcurRZd/nPhKFFlEjZnB3UdF1atdFRYob+nHi/wJUEsDBBQAAAAIAAAAdF0hCtmRHAEAABgCAAARAAAAd29yZC9kb2N1bWVudC54bWyNUU1PwzAMvfMrotxZtmp8qFq7225IoMEPSBv3Q2riKPEo5dfjpoKOE1xsPz/72XEOxw87iHcIsUdXyN1mKwW4Gk3v2kK+vZ5uH6WIpJ3RAzoo5ARRHsubw5gbrC8WHAlWcDEfC9kR+VypWHdgddygB8dcg8FqYhhaNWIwPmANMfIAO6hsu71XVvdOlixZoZlm72cTknlOrlLlQf0gKl8uOhCEYRJ+0G6maClI1v/WoPLUh0jC6xYENoI6SG2bP/qqIJifPL96bpVqETtDjc78Uy1CTcvSvj1/sh6faZdlez7zmHcc3z1yrJaCJ50mouf8fikJfdvRCiskQrviAZortgNtIBTyIUuwQaQr2F4owTROraup77ur9U/LL1BLAQIUAxQAAAAIAAAAdF3JTxqw6wAAAK4BAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAAAB0XbmBRHGwAAAAKgEAAAsAAAAAAAAAAAAAAIABHAEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAAAB0XSEK2ZEcAQAAGAIAABEAAAAAAAAAAAAAAIAB9QEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAEADAAAAAA==",
  "base64"
)

function sourceOf(bytes: Uint8Array) {
  return {
    size: bytes.byteLength,
    read: async (position: number, length: number) =>
      bytes.subarray(position, position + length),
  }
}

async function refusal(bytes: Uint8Array): Promise<string> {
  try {
    await drawWordPdf(sourceOf(bytes))
  } catch (error) {
    if (error instanceof WordRenditionError) return error.reason
    throw error
  }
  return "drawn"
}

describe("Word files drawn as PDFs", () => {
  it("draws the viewer document with its own policy, less the sandbox, reading only from the page", () => {
    const policy = printPolicy(
      "sandbox allow-scripts; default-src 'none'; script-src 'sha256-x' 'wasm-unsafe-eval'; connect-src 'none'; font-src blob: data:; frame-src 'none'"
    )
    expect(policy).not.toContain("sandbox")
    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain("font-src blob: data: 'self'")
    expect(policy).toContain("script-src 'sha256-x' 'wasm-unsafe-eval'")
    expect(policy).toContain("frame-src 'none'")
  })

  previewTest(
    "draws each page of a Word file as a page of a PDF, and refuses what it can't read",
    async () => {
      const pdf = await drawWordPdf(sourceOf(PLAN_DOCX))
      const text = Buffer.from(pdf).toString("latin1")
      expect(text.startsWith("%PDF-")).toBe(true)
      expect(text.match(/\/Type\s*\/Page\b(?!s)/g)?.length).toBe(2)

      // An encrypted Word file is a compound file: never parsed.
      const encrypted = new Uint8Array(4096)
      encrypted.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
      expect(await refusal(encrypted)).toBe("encrypted")
      expect(
        await refusal(Buffer.from("This was never a Word file. ".repeat(40)))
      ).toBe("damaged")
    },
    120_000
  )
})

describe("a Word file's PDF in a Space", () => {
  const spaceId = "papers"
  let root: string
  let previousFiles: string | undefined
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worktable-word-renditions-"))
    setWorkspaceRootOverride(root)
    closeDerivedStore()
    writeWorkspaceManifest({ ...ensureWorkspaceManifest(), version: 2 })
    previousFiles = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: spaceId,
      name: "Papers",
      createdAt: "2026-11-21T00:00:00.000Z",
      updatedAt: "2026-11-21T00:00:00.000Z",
      createdBy: "test",
      settings: {},
    })
    await mkdir(join(root, "spaces", spaceId, "docs"), { recursive: true })
  })
  afterEach(async () => {
    if (previousFiles === undefined) delete process.env["WORKTABLE_FILES"]
    else process.env["WORKTABLE_FILES"] = previousFiles
    closeDerivedStore()
    setWorkspaceRootOverride(null)
    await rm(root, { recursive: true, force: true })
  })

  previewTest(
    "is drawn once after the file is written, then served for its version, a range of it too",
    async () => {
      await writeFile(join(root, "spaces", spaceId, "docs", "plan.docx"), PLAN_DOCX)
      noteSpaceChanged(spaceId)
      // Drawn in the background, before anyone opens it, and only once.
      expect(await parseChangedFiles(spaceId)).toBe(1)
      expect(await parseChangedFiles(spaceId)).toBe(0)
      const kept = derivedStore()
        .listing(spaceId)
        .filter((row) => row.kind === "rendition")
      expect(kept).toHaveLength(1)

      const server = new Hono()
      server.use("*", async (c, next) => {
        c.set("identity", ownerIdentity())
        return next()
      })
      server.route("/api/spaces/:spaceId/documents", documentsRouter)
      const get = (path: string, headers: Record<string, string> = {}) =>
        server.fetch(new Request(`http://localhost${path}`, { headers }))
      const { page } = (await (
        await get(`/api/spaces/${spaceId}/documents/page?path=plan.docx`)
      ).json()) as { page: { version?: string } }
      expect(page.version).toBeTruthy()
      const url = `/api/spaces/${spaceId}/documents/rendition?path=plan.docx&v=${encodeURIComponent(page.version!)}`
      const whole = await get(url)
      expect(whole.status).toBe(200)
      expect(whole.headers.get("Content-Type")).toBe("application/pdf")
      expect(whole.headers.get("Cache-Control")).toContain("immutable")
      const bytes = new Uint8Array(await whole.arrayBuffer())
      expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-")
      const part = await get(url, { Range: "bytes=0-9" })
      expect(part.status).toBe(206)
      expect(part.headers.get("Content-Range")).toBe(`bytes 0-9/${bytes.byteLength}`)
      expect(part.headers.get("ETag")).toBe(whole.headers.get("ETag"))

      // A version the file is no longer at has no PDF.
      expect((await get(`/api/spaces/${spaceId}/documents/rendition?path=plan.docx&v=gone`)).status).toBe(404)
    },
    180_000
  )
})
