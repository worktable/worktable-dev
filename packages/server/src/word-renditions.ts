// ============================================================
// Word files drawn as PDFs, for reading
// ============================================================
//
// A Word file reads fastest as a PDF: the PDF viewer shows its first page
// from a small piece of it, finds text and lists its pages, where drawing
// the Word file itself takes a phone several seconds on every open. So the
// server draws each version of a Word file once, with the same Word viewer
// the app has (Extend, apps/web/src/viewer-frames/word/frame.ts), in the
// sandboxed preview browser, prints it to a PDF and keeps that in the
// derived store. Everyone who opens that version reads the kept PDF.
//
// The preview browser is the boundary, as for every file it draws: a
// separate process with no network and no workers, holding this one file,
// with a deadline. The viewer document is served to it under its own
// policy, less the sandbox, so it can read the file and its own files from
// the page's routes; nothing else answers. A host whose preview browser
// can't start has no renditions, and its people read Word files in the
// viewer frame in their own browser instead.
//
// What a version's drawing ends in is kept: its PDF, or that the file is
// encrypted, damaged or too large, so it isn't drawn again on every open. A
// busy or missing browser, a deadline, or no room to keep it are answered
// as they are and tried again on the next open.

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve, sep } from "node:path"
import type { Page } from "playwright-core"
import { fileTypeFor, fileTypePolicy } from "@worktable/types"
import { derivedStore, type DerivedKey } from "./derived-store.ts"
import { sweepDerivedOutput } from "./derived-sweep.ts"
import { resolveCurrentFile } from "./document-page-service.ts"
import {
  previewBrowserFailed,
  withPreviewPage,
} from "./document-preview-browser.ts"
import { contentHashOf, OpenFileRevision, type PinnedFile } from "./file-revision.ts"
import { StorageLimitError, admitStorageWrite } from "./storage-limit.ts"
import { viewerEnabled, viewerFrameFiles } from "./viewer-frames.ts"

/** The largest Word file drawn; the viewer frame keeps the same limit. */
export const WORD_RENDITION_MAX_BYTES = 32 * 1024 * 1024
/** The largest PDF kept for one. */
const PDF_MAX_BYTES = 64 * 1024 * 1024
/** How long one drawing may take, its wait for the browser included. */
const DEADLINE_MS = 30_000
/** The most this process reads from the file in one piece. */
const READ_PIECE_BYTES = 256 * 1024

const ORIGIN = "https://worktable-word.invalid"
const MAKER = "word-pdf"
const MAKER_VERSION = 1

export type WordRenditionRefusal = "encrypted" | "damaged" | "too-large"

/**
 * Why a Word file has no PDF. "kept" refusals belong to the file at that
 * version; "busy" may pass, and is tried again on the next open.
 */
export class WordRenditionError extends Error {
  readonly reason: WordRenditionRefusal | "busy" | "none"
  constructor(reason: WordRenditionError["reason"], message: string) {
    super(message)
    this.name = "WordRenditionError"
    this.reason = reason
  }
}

/** Whether Word files are drawn as PDFs on this host now. */
export function wordRenditionsAvailable(): boolean {
  return (
    viewerEnabled("word") &&
    process.env["WORKTABLE_WORD_PDF"]?.trim().toLowerCase() !== "off" &&
    !previewBrowserFailed()
  )
}

/** Whether a file of this name is a Word file the viewer shows. */
export function isWordFile(name: string): boolean {
  return fileTypePolicy(fileTypeFor(name), "page") === "word"
}

export interface WordRendition {
  bytes: Uint8Array
  /** The PDF's SHA-256, hex, which its ETag names. */
  sha256: string
}

/** A file at one revision: its size, and its bytes by range. */
interface RenditionSource {
  size: number
  read(position: number, length: number): Promise<Uint8Array>
}

/** The policy the viewer document is drawn under in the preview browser. */
export function printPolicy(csp: string): string {
  return csp
    .split("; ")
    .filter((directive) => !directive.startsWith("sandbox"))
    .map((directive) => {
      // The page's own routes give it the file and its own files.
      if (directive.startsWith("connect-src ")) return "connect-src 'self'"
      if (directive.startsWith("font-src ")) return `${directive} 'self'`
      return directive
    })
    .join("; ")
}

/**
 * Draws a Word file as a PDF in the preview browser. Throws
 * WordRenditionError when it can't.
 */
export async function drawWordPdf(
  source: RenditionSource,
  options: { signal?: AbortSignal; background?: boolean } = {}
): Promise<Uint8Array> {
  if (source.size > WORD_RENDITION_MAX_BYTES)
    throw new WordRenditionError("too-large", "This Word file is too large to preview.")
  const viewer = await viewerFrameFiles("word")
  if (!viewer)
    throw new WordRenditionError("busy", "The Word viewer isn't in this build.")
  const deadline = new AbortController()
  // Held by a timer this call owns: Bun 1.3 can collect an unreferenced
  // AbortSignal.timeout before it fires.
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Drawing timed out", "TimeoutError")),
    DEADLINE_MS
  )
  try {
    return await withPreviewPage(
      "image",
      (page) => drawIn(page, source, viewer),
      {
        signal: options.signal
          ? AbortSignal.any([options.signal, deadline.signal])
          : deadline.signal,
        background: options.background ?? false,
      }
    )
  } catch (error) {
    if (error instanceof WordRenditionError) throw error
    throw new WordRenditionError(
      "busy",
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    clearTimeout(timer)
  }
}

async function drawIn(
  page: Page,
  source: RenditionSource,
  viewer: { html: string; csp: string; files: string }
): Promise<Uint8Array> {
  const files = resolve(viewer.files)
  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request()
    if (request.method() !== "GET") return route.abort()
    const path = new URL(request.url()).pathname
    if (path === "/word")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        headers: { "Content-Security-Policy": printPolicy(viewer.csp) },
        body: viewer.html,
      })
    if (path === "/file")
      return route.fulfill({
        contentType: "application/octet-stream",
        body: Buffer.from(await readWhole(source)),
      })
    // The viewer's own files, by kind and plain name, as the app's route
    // serves them: nothing beside them.
    const match = /^\/files\/([a-z][a-z_-]{0,31})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(path)
    const target = match && !match[2]!.includes("..") ? resolve(files, match[1]!, match[2]!) : null
    if (target?.startsWith(files + sep)) {
      // The engine crosses to the browser compressed, less than half its size:
      // routed bytes cross a slow pipe.
      const packed = target.endsWith(".wasm")
        ? await readFile(`${target}.gz`).catch(() => null)
        : null
      return route.fulfill({
        contentType: target.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
        // A routed response isn't decoded by its encoding: the page unpacks it.
        ...(packed ? { headers: { "X-Worktable-Packed": "gzip" } } : {}),
        body: packed ?? (await readFile(target).catch(() => Buffer.alloc(0))),
      })
    }
    return route.abort()
  })
  await page.goto(`${ORIGIN}/word?print&theme=light`, { waitUntil: "load" })
  const ended = await page
    .waitForFunction(() => document.documentElement.dataset.print, null, {
      timeout: DEADLINE_MS,
      polling: 100,
    })
    .then((handle) => handle.jsonValue() as Promise<string>)
  if (ended === "password")
    throw new WordRenditionError("encrypted", "This Word file is password protected.")
  if (ended === "too-large")
    throw new WordRenditionError("too-large", "This Word file is too large to preview.")
  if (ended === "damaged")
    throw new WordRenditionError("damaged", "Couldn't read this Word file.")
  if (ended !== "ready")
    throw new WordRenditionError("busy", "Couldn't draw this Word file now.")
  const pdf = await page.pdf({
    preferCSSPageSize: true,
    printBackground: true,
    outline: true,
    tagged: true,
  })
  if (pdf.byteLength > PDF_MAX_BYTES)
    throw new WordRenditionError("too-large", "This Word file is too large to preview.")
  return new Uint8Array(pdf)
}

/** The whole file, read a bounded piece at a time. */
async function readWhole(source: RenditionSource): Promise<Uint8Array> {
  const bytes = new Uint8Array(source.size)
  for (let position = 0; position < source.size; ) {
    const chunk = await source.read(
      position,
      Math.min(READ_PIECE_BYTES, source.size - position)
    )
    if (chunk.byteLength === 0) throw new Error("Short read")
    bytes.set(chunk, position)
    position += chunk.byteLength
  }
  return bytes
}

// One drawing per version, however many open it at once.
const drawing = new Map<string, Promise<WordRendition>>()

/**
 * The PDF of a Word file at its current version, drawn first when none is
 * kept. `revision` names the version the reader's page loaded; a file no
 * longer at it has none. Throws WordRenditionError.
 */
export async function wordRendition(input: {
  spaceId: string
  path: string
  revision?: string
  /** Drawn for nobody waiting: after anything someone waits for. */
  background?: boolean
  /** Ends a drawing this call starts, keeping nothing. */
  signal?: AbortSignal
}): Promise<WordRendition> {
  if (!wordRenditionsAvailable())
    throw new WordRenditionError("busy", "Word files aren't drawn as PDFs here now.")
  const resolved = await resolveCurrentFile({
    spaceId: input.spaceId,
    path: input.path,
    ...(input.revision ? { revision: input.revision } : {}),
  })
  if (resolved.kind !== "file")
    throw new WordRenditionError("none", "No such Word file at this version.")
  const { current } = resolved
  if (!isWordFile(current.path))
    throw new WordRenditionError("none", "This file isn't a Word file.")
  const viewer = await viewerFrameFiles("word")
  if (!viewer)
    throw new WordRenditionError("busy", "The Word viewer isn't in this build.")
  const key: DerivedKey = {
    spaceId: input.spaceId,
    documentId: current.documentId,
    version: await contentHashOf(current.pinned),
    kind: "rendition",
    // The viewer as built: a new viewer draws every file again.
    variant: /'sha256-([^']+)'/.exec(viewer.csp)?.[1] ?? "",
    maker: MAKER,
    makerVersion: MAKER_VERSION,
  }
  const store = derivedStore()
  const kept = store.getRendition(key)
  if (kept?.state === "ready" && kept.bytes && kept.sha256)
    return { bytes: kept.bytes, sha256: kept.sha256 }
  if (kept && kept.state !== "ready")
    throw new WordRenditionError(
      kept.state === "refused" && kept.reason !== "failed" && kept.reason !== "unsupported"
        ? kept.reason
        : "damaged",
      kept.message
    )
  const id = JSON.stringify([key.documentId, key.version, key.variant])
  let running = drawing.get(id)
  if (!running) {
    running = drawAndKeep(key, current.pinned, {
      background: input.background ?? false,
      ...(input.signal ? { signal: input.signal } : {}),
    }).finally(
      () => drawing.delete(id)
    )
    drawing.set(id, running)
  }
  return running
}

async function drawAndKeep(
  key: DerivedKey,
  pinned: PinnedFile,
  options: { background: boolean; signal?: AbortSignal }
): Promise<WordRendition> {
  const opened = await OpenFileRevision.open(pinned.path, pinned.revision)
  let bytes: Uint8Array
  try {
    bytes = await drawWordPdf(
      { size: opened.size, read: (position, length) => opened.read(position, length) },
      options
    )
  } catch (error) {
    // What the file is at this version holds for good: keep it.
    if (error instanceof WordRenditionError && error.reason !== "busy" && error.reason !== "none")
      keep(key, { state: "refused", reason: error.reason, message: error.message })
    throw error
  } finally {
    await opened.close()
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  keep(key, { state: "ready", mimeType: "application/pdf", bytes })
  return { bytes, sha256 }
}

/** Keeps how drawing a version ended, when there is room for it. */
function keep(
  key: DerivedKey,
  result: Parameters<ReturnType<typeof derivedStore>["putRendition"]>[1]
): void {
  let room
  try {
    room = admitStorageWrite(1024 + (result.bytes?.byteLength ?? 0), { files: 0 })
  } catch (error) {
    // No room: answered now, drawn again on the next open.
    if (error instanceof StorageLimitError) return
    throw error
  }
  try {
    const store = derivedStore()
    store.putRendition(key, result)
    store.keepOnlyVersion(key.spaceId, key.documentId, key.version)
  } finally {
    room.release()
  }
  // A file deleted while it was drawn keeps nothing.
  void sweepDerivedOutput(key.spaceId).catch(() => {})
}
