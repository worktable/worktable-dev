// ============================================================
// Pictures of files
// ============================================================
//
// A picture of a plain file: an image scaled down, or one page of a PDF. The
// file type table's `picture` policy says which files have one. Both are
// drawn in the sandboxed preview browser, never in this process: a separate
// process with no network, no workers and a deadline (rule 12 in
// docs/files.md). The page is handed the file's bytes at one revision, a
// piece at a time as it asks for them, so a large PDF is never held whole
// here or pushed whole into the browser.
//
// What bounds a picture:
// - An image is drawn only within the byte limit, and decoded only when its
//   header declares a size within the pixel limits. This process reads the
//   header alone, at most 1 MiB, before anything decodes the image, so a
//   call holds little here however many arrive at once.
// - A PDF is parsed by pdf.js with scripts, forms and network off; the
//   images inside it are held to the same pixel limit.
// - A picture is drawn within the preview pixel limit and returned within
//   the preview byte limit, drawn smaller when it would pass either.
// - Each maker has an off switch. A file with no picture says why, and
//   still reads and downloads as before.

import { readFile } from "node:fs/promises"
import { imageSize } from "image-size"
import type { Page } from "playwright-core"
import {
  FILE_TYPES,
  fileTypeFor,
  fileTypePolicy,
  MAX_DOCUMENT_PREVIEW_BYTES,
  MAX_DOCUMENT_PREVIEW_PIXELS,
  type FileSurfacePolicies,
} from "@worktable/types"
import { avifDeclaredSizes } from "./agent-image-conversion.ts"
import { withPreviewPage } from "./document-preview-browser.ts"
import {
  PDF_PREVIEW_ASSETS,
  PDF_RENDERER_VERSION,
} from "./generated/pdf-preview-assets.ts"

/** The largest image a picture is made of. */
export const PICTURE_IMAGE_MAX_BYTES = 32 * 1024 * 1024
/** How much of an image is read here to find the size its header declares. */
const IMAGE_HEADER_MAX_BYTES = 1024 * 1024
/** The most this process reads from a file in one piece. */
const SERVER_READ_BYTES = 256 * 1024
/** The widest or tallest image decoded, in pixels. */
const IMAGE_MAX_SIDE = 8192
/** The most pixels an image decoded for a picture holds, a PDF's own images included. */
const IMAGE_MAX_PIXELS = 40_000_000
/** How wide a picture is drawn when no width is asked for. */
const DEFAULT_WIDTH = 1200
/** How long one picture may take. */
const DEADLINE_MS = 30_000
/** The most the page is handed in one read. */
const READ_PIECE_BYTES = 1024 * 1024

const ORIGIN = "https://worktable-preview.invalid"
const IMAGE_RENDERER_VERSION = "worktable-image-1"

export type FilePictureKind = FileSurfacePolicies["picture"]

/** What a picture of a file of this name is made from, by the file type table. */
export function filePictureKind(name: string): FilePictureKind {
  return fileTypePolicy(fileTypeFor(name), "picture")
}

/** A file at one revision: its name, its size, and its bytes by range. */
export interface FilePictureSource {
  name: string
  size: number
  /** Up to `length` bytes from `position`, of the one revision. */
  read(position: number, length: number): Promise<Uint8Array>
}

export interface FilePictureOptions {
  /** A PDF's page, from 1. */
  page?: number
  /** The picture's width in pixels. An image is never drawn larger than it is. */
  width?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** PNG, which agents take, or WebP, smaller, for pictures in lists. */
  format?: "png" | "webp"
  /** Made for a list nobody waits on: it waits until no one else does. */
  background?: boolean
}

export interface FilePicture {
  mimeType: "image/png" | "image/webp"
  bytes: Uint8Array
  width: number
  height: number
  rendererVersion: string
  /** For a PDF: the page drawn, and how many it has. */
  page?: number
  pageCount?: number
  warnings?: string[]
}

export type FilePictureRefusal =
  | "no-picture"
  | "off"
  | "too-large"
  | "password"
  | "damaged"
  | "no-page"

/** Why a file has no picture. The file itself is untouched and still reads. */
export class FilePictureError extends Error {
  readonly code: FilePictureRefusal
  readonly pageCount?: number
  constructor(code: FilePictureRefusal, message: string, pageCount?: number) {
    super(message)
    this.name = "FilePictureError"
    this.code = code
    if (pageCount !== undefined) this.pageCount = pageCount
  }
}

/** `WORKTABLE_PICTURES_PDF=off` or `WORKTABLE_PICTURES_IMAGE=off` turns a maker off. */
function makerEnabled(kind: "pdf" | "image"): boolean {
  return (
    process.env[`WORKTABLE_PICTURES_${kind.toUpperCase()}`]
      ?.trim()
      .toLowerCase() !== "off"
  )
}

type PageResult =
  | {
      ok: true
      data: string
      width: number
      height: number
      pageCount?: number
      shrunk: boolean
    }
  | { ok: false; code: "password" | "damaged" | "no-page"; pageCount?: number }

/**
 * A picture of a file: an image scaled to `width`, or a PDF's `page`.
 * Throws FilePictureError when it has none, with why.
 */
export async function renderFilePicture(
  source: FilePictureSource,
  options: FilePictureOptions = {}
): Promise<FilePicture> {
  const kind = filePictureKind(source.name)
  if (kind === "none")
    throw new FilePictureError("no-picture", "No preview for this file type.")
  const width = options.width ?? DEFAULT_WIDTH
  const mimeType = options.format === "webp" ? "image/webp" : "image/png"
  if (kind === "image") {
    if (options.page !== undefined && options.page !== 1)
      throw new FilePictureError("no-page", "An image has one page.", 1)
    if (!makerEnabled("image"))
      throw new FilePictureError("off", "Pictures of images are turned off.")
    const type = await checkedImageType(source)
    const result = await inPicturePage(source, options, (page) =>
      page.evaluate(drawImage, {
        size: source.size,
        type,
        width,
        maxSide: IMAGE_MAX_SIDE,
        maxSourcePixels: IMAGE_MAX_PIXELS,
        maxPixels: MAX_DOCUMENT_PREVIEW_PIXELS,
        maxBytes: MAX_DOCUMENT_PREVIEW_BYTES,
        piece: READ_PIECE_BYTES,
        mimeType,
      })
    )
    return picture(result, IMAGE_RENDERER_VERSION, mimeType)
  }
  if (!makerEnabled("pdf"))
    throw new FilePictureError("off", "Pictures of PDF pages are turned off.")
  const pageNumber = options.page ?? 1
  const result = await inPicturePage(source, options, (page) =>
    page.evaluate(drawPdfPage, {
      origin: ORIGIN,
      size: source.size,
      pageNumber,
      width,
      maxPixels: MAX_DOCUMENT_PREVIEW_PIXELS,
      maxImagePixels: IMAGE_MAX_PIXELS,
      maxBytes: MAX_DOCUMENT_PREVIEW_BYTES,
      piece: READ_PIECE_BYTES,
      mimeType,
    })
  )
  return {
    ...picture(result, PDF_RENDERER_VERSION, mimeType),
    page: pageNumber,
  }
}

function picture(
  result: PageResult,
  rendererVersion: string,
  mimeType: FilePicture["mimeType"]
): FilePicture {
  if (!result.ok) {
    if (result.code === "password")
      throw new FilePictureError(
        "password",
        "This PDF needs a password, so it has no preview."
      )
    if (result.code === "no-page")
      throw new FilePictureError(
        "no-page",
        `This file has ${result.pageCount} ${result.pageCount === 1 ? "page" : "pages"}.`,
        result.pageCount
      )
    throw new FilePictureError("damaged", "Couldn't draw a preview of this file.")
  }
  return {
    mimeType,
    bytes: new Uint8Array(Buffer.from(result.data, "base64")),
    width: result.width,
    height: result.height,
    rendererVersion,
    ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
    ...(result.shrunk
      ? {
          warnings: [
            `Drawn ${result.width} pixels wide to fit the image limit.`,
          ],
        }
      : {}),
  }
}

/**
 * An image's media type, once its bytes are within the byte limit and its
 * header declares a size within the pixel limits. The decoder allocates for
 * the size a file declares: one past the limits never reaches it.
 */
async function checkedImageType(source: FilePictureSource): Promise<string> {
  if (source.size > PICTURE_IMAGE_MAX_BYTES)
    throw new FilePictureError(
      "too-large",
      "This image is too large to preview."
    )
  const type = fileTypeFor(source.name)!
  let sizes: Array<{ width: number; height: number }> | null
  if (type === "avif") {
    const meta = await avifMetaBox(source)
    sizes = meta && avifDeclaredSizes(meta)
  } else {
    try {
      const declared = imageSize(
        await readRange(
          source,
          0,
          Math.min(source.size, IMAGE_HEADER_MAX_BYTES)
        )
      )
      // The bytes must be the type the name says: nothing is sniffed wider.
      sizes =
        declared.type === (type === "jpeg" ? "jpg" : type)
          ? [{ width: declared.width, height: declared.height }]
          : null
    } catch {
      sizes = null
    }
  }
  if (!sizes)
    throw new FilePictureError("damaged", "Couldn't draw a preview of this file.")
  if (
    !sizes.every(
      ({ width, height }) =>
        width > 0 &&
        height > 0 &&
        width <= IMAGE_MAX_SIDE &&
        height <= IMAGE_MAX_SIDE &&
        width * height <= IMAGE_MAX_PIXELS
    )
  )
    throw new FilePictureError(
      "too-large",
      "This image is too large to preview."
    )
  return FILE_TYPES[type].mediaType
}

/** Bytes `begin` to `end` of a file, read a bounded piece at a time. */
async function readRange(
  source: FilePictureSource,
  begin: number,
  end: number
): Promise<Uint8Array> {
  const bytes = new Uint8Array(end - begin)
  for (let position = begin; position < end; ) {
    const chunk = await source.read(
      position,
      Math.min(SERVER_READ_BYTES, end - position)
    )
    if (chunk.byteLength === 0) throw new Error("Short read")
    bytes.set(chunk, position - begin)
    position += chunk.byteLength
  }
  return bytes
}

/**
 * An AVIF's `meta` box, which declares its picture sizes, found by reading
 * the file's top-level box headers alone: the picture data beside it is
 * never read here. Null when there is none within the header limit.
 */
async function avifMetaBox(
  source: FilePictureSource
): Promise<Uint8Array | null> {
  for (let at = 0, boxes = 0; at + 8 <= source.size && boxes < 64; boxes += 1) {
    const header = await readRange(source, at, Math.min(source.size, at + 16))
    const view = new DataView(header.buffer)
    let size = view.getUint32(0)
    if (size === 1) {
      if (header.byteLength < 16) return null
      const large = view.getBigUint64(8)
      if (large > BigInt(source.size - at)) return null
      size = Number(large)
    } else if (size === 0) {
      size = source.size - at
    }
    if (size < 8 || size > source.size - at) return null
    if (String.fromCharCode(...header.subarray(4, 8)) === "meta")
      return size <= IMAGE_HEADER_MAX_BYTES
        ? readRange(source, at, at + size)
        : null
    at += size
  }
  return null
}

/**
 * Runs `task` in a preview page that can read the file's bytes, a piece at
 * a time, and load pdf.js from this server's own copy. A read that fails
 * here, such as one of a file that changed, fails the picture at once with
 * that error, whatever the page would have made of it.
 */
async function inPicturePage(
  source: FilePictureSource,
  options: FilePictureOptions,
  task: (page: Page) => Promise<PageResult>
): Promise<PageResult> {
  const deadline = new AbortController()
  // Held by a timer this call owns: Bun 1.3 can collect an unreferenced
  // AbortSignal.timeout before it fires.
  const timer = setTimeout(
    () =>
      deadline.abort(new DOMException("Picture timed out", "TimeoutError")),
    Math.min(options.timeoutMs ?? DEADLINE_MS, DEADLINE_MS)
  )
  // A read that fails here ends the picture at once, with that error.
  let failRead!: (error: unknown) => void
  const readFailed = new Promise<never>((_, reject) => (failRead = reject))
  readFailed.catch(() => undefined)
  // A parser that asks for the same bytes over and over is stopped.
  let budget = source.size * 4 + 8 * READ_PIECE_BYTES
  try {
    return await withPreviewPage(
      "image",
      async (page) => {
        await page.exposeFunction(
          "worktableReadFile",
          async (begin: unknown, end: unknown) => {
            try {
              if (
                typeof begin !== "number" ||
                typeof end !== "number" ||
                !Number.isSafeInteger(begin) ||
                !Number.isSafeInteger(end) ||
                begin < 0 ||
                end <= begin ||
                end > source.size ||
                end - begin > READ_PIECE_BYTES
              )
                throw new Error("Invalid read")
              budget -= end - begin
              if (budget < 0) throw new Error("Read budget exceeded")
              return Buffer.from(
                await readRange(source, begin, end)
              ).toString("base64")
            } catch (error) {
              failRead(error)
              throw error
            }
          }
        )
        await page.route(`${ORIGIN}/**`, async (route) => {
          const url = new URL(route.request().url())
          if (route.request().method() !== "GET") return route.abort()
          if (url.pathname === "/")
            return route.fulfill({
              contentType: "text/html",
              body: '<!doctype html><meta charset="utf-8"><title>Picture</title>',
            })
          const asset = PDF_PREVIEW_ASSETS[url.pathname]
          if (asset)
            return route.fulfill({
              contentType: asset.type,
              body: await readFile(new URL(asset.url, import.meta.url)),
            })
          return route.abort()
        })
        await page.goto(ORIGIN, { waitUntil: "load" })
        return Promise.race([task(page), readFailed])
      },
      {
        signal: options.signal
          ? AbortSignal.any([options.signal, deadline.signal])
          : deadline.signal,
        background: options.background ?? false,
      }
    )
  } finally {
    clearTimeout(timer)
  }
}

declare global {
  interface Window {
    worktableReadFile(begin: number, end: number): Promise<string>
  }
}

// The two functions below run in the preview page, not here: each is sent
// to it as source, so they use nothing from this module.

async function drawImage(input: {
  size: number
  type: string
  width: number
  maxSide: number
  maxSourcePixels: number
  maxPixels: number
  maxBytes: number
  piece: number
  mimeType: string
}): Promise<PageResult> {
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (let at = 0; at < input.size; at += input.piece) {
    const binary = atob(
      await window.worktableReadFile(at, Math.min(input.size, at + input.piece))
    )
    const part = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1)
      part[index] = binary.charCodeAt(index)
    parts.push(part)
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob(parts, { type: input.type }))
  } catch {
    return { ok: false, code: "damaged" }
  }
  try {
    if (
      bitmap.width === 0 ||
      bitmap.height === 0 ||
      bitmap.width > input.maxSide ||
      bitmap.height > input.maxSide ||
      bitmap.width * bitmap.height > input.maxSourcePixels
    )
      return { ok: false, code: "damaged" }
    // Never drawn larger than it is, nor past the picture's pixel limit,
    // which a tall image scaled by its width alone would pass.
    const wanted = Math.min(1, input.width / bitmap.width)
    let scale = wanted
    const area = bitmap.width * bitmap.height * scale * scale
    if (area > input.maxPixels) scale *= Math.sqrt(input.maxPixels / area)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const width = Math.max(1, Math.round(bitmap.width * scale))
      // Rounding never takes it past the pixel limit.
      const height = Math.max(
        1,
        Math.min(
          Math.round(bitmap.height * scale),
          Math.floor(input.maxPixels / width)
        )
      )
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext("2d")
      if (!context) return { ok: false, code: "damaged" }
      context.imageSmoothingQuality = "high"
      context.drawImage(bitmap, 0, 0, width, height)
      const blob = await canvas.convertToBlob({
        type: input.mimeType,
        quality: 0.85,
      })
      if (blob.size <= input.maxBytes) {
        const output = new Uint8Array(await blob.arrayBuffer())
        let text = ""
        for (let index = 0; index < output.length; index += 0x8000)
          text += String.fromCharCode(...output.subarray(index, index + 0x8000))
        return {
          ok: true,
          data: btoa(text),
          width,
          height,
          shrunk: scale < wanted * 0.999,
        }
      }
      scale *= 0.7
    }
    return { ok: false, code: "damaged" }
  } finally {
    bitmap.close()
  }
}

async function drawPdfPage(input: {
  origin: string
  size: number
  pageNumber: number
  width: number
  maxPixels: number
  maxImagePixels: number
  maxBytes: number
  piece: number
  mimeType: string
}): Promise<PageResult> {
  const read = async (begin: number, end: number) => {
    const bytes = new Uint8Array(end - begin)
    for (let at = begin; at < end; at += input.piece) {
      const binary = atob(
        await window.worktableReadFile(at, Math.min(end, at + input.piece))
      )
      for (let index = 0; index < binary.length; index += 1)
        bytes[at - begin + index] = binary.charCodeAt(index)
    }
    return bytes
  }
  const pdfjs = await import(`${input.origin}/pdfjs/pdf.mjs`)
  // A preview page has no workers, so pdf.js parses on the page's own
  // thread, in the parser it loads from here.
  pdfjs.GlobalWorkerOptions.workerSrc = `${input.origin}/pdfjs/pdf.worker.mjs`
  const transport = new pdfjs.PDFDataRangeTransport(input.size, null)
  transport.requestDataRange = (begin: number, end: number) => {
    read(begin, end).then(
      (chunk) => transport.onDataRange(begin, chunk),
      () => transport.abort()
    )
  }
  const loading = pdfjs.getDocument({
    range: transport,
    length: input.size,
    // Small ranges: a PDF that lists its pages flat has every page looked
    // at as it opens, and larger ranges would then pull in most of the file.
    rangeChunkSize: 64 * 1024,
    disableAutoFetch: true,
    disableStream: true,
    disableWorkerRendering: true,
    enableXfa: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    standardFontDataUrl: `${input.origin}/pdfjs/standard_fonts/`,
    cMapUrl: `${input.origin}/pdfjs/cmaps/`,
    cMapPacked: true,
    wasmUrl: `${input.origin}/pdfjs/wasm/`,
    iccUrl: `${input.origin}/pdfjs/iccs/`,
    maxImageSize: input.maxImagePixels,
    verbosity: 0,
  })
  try {
    let pdf
    try {
      pdf = await loading.promise
    } catch (error) {
      return {
        ok: false,
        code:
          (error as { name?: string } | null)?.name === "PasswordException"
            ? "password"
            : "damaged",
      }
    }
    const pageCount: number = pdf.numPages
    if (input.pageNumber > pageCount)
      return { ok: false, code: "no-page", pageCount }
    const pdfPage = await pdf.getPage(input.pageNumber)
    const natural = pdfPage.getViewport({ scale: 1 })
    const wanted = input.width / natural.width
    let scale = wanted
    const area = natural.width * natural.height * scale * scale
    if (area > input.maxPixels) scale *= Math.sqrt(input.maxPixels / area)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const viewport = pdfPage.getViewport({ scale })
      const canvas = document.createElement("canvas")
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      await pdfPage.render({ canvas, viewport }).promise
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, input.mimeType, 0.85)
      )
      if (!blob) return { ok: false, code: "damaged", pageCount }
      if (blob.size <= input.maxBytes) {
        const output = new Uint8Array(await blob.arrayBuffer())
        let text = ""
        for (let index = 0; index < output.length; index += 0x8000)
          text += String.fromCharCode(...output.subarray(index, index + 0x8000))
        return {
          ok: true,
          data: btoa(text),
          width: canvas.width,
          height: canvas.height,
          pageCount,
          shrunk: scale < wanted * 0.999,
        }
      }
      scale *= 0.7
    }
    return { ok: false, code: "damaged", pageCount }
  } catch {
    return { ok: false, code: "damaged" }
  } finally {
    await loading.destroy().catch(() => undefined)
  }
}
