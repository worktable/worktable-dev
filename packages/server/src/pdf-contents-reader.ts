// ============================================================
// A PDF's contents: its text, page by page
// ============================================================
//
// Runs in the contents worker only (contents-worker.ts), from the PDF's
// bytes alone. Two engines, both memory-safe:
//
// - pdf.js (Mozilla, the engine the viewer and pictures use) opens the file
//   and reads each page's text. It says plainly when a file is encrypted or
//   damaged, and tells a page that is only a picture from an empty one.
// - pdf-inspector (Firecrawl, Rust as WebAssembly) reads the same pages as
//   Markdown that keeps headings and tables, which most of a long PDF's
//   sense is in. A page it reads, and whose Markdown holds the words pdf.js
//   read there, uses its Markdown; any other page keeps pdf.js's text.
//
// Scripts, forms and attachments inside a PDF are never run or read, eval is
// off, and nothing is fetched. Text from pictures (OCR) isn't read, and the
// output says which pages that leaves out.

import { initSync, processPdf } from "@firecrawl/pdf-inspector-wasm"
import inspectorWasm from "@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm" with { type: "file" }
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs"
import { OPS, VerbosityLevel, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import {
  ReaderRefused,
  type ContentsGap,
  type ContentsPart,
  type ParsingReader,
} from "./contents-protocol.ts"
import { CONTENTS_READER_VERSIONS } from "./contents-reader-versions.ts"
import { PDF_PREVIEW_ASSETS } from "./generated/pdf-preview-assets.ts"

/** The most pages read; past it, the output says which were left out. */
export const PDF_MAX_PAGES = 5_000

// pdf.js parses on this thread: the worker process is the isolation.
;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

let inspectorReady = false
async function inspector(): Promise<typeof processPdf> {
  if (!inspectorReady) {
    initSync({ module: await Bun.file(inspectorWasm).arrayBuffer() })
    inspectorReady = true
  }
  return processPdf
}

const BUNDLED_FOLDERS: Record<string, string> = {
  cMapUrl: "cmaps",
  standardFontDataUrl: "standard_fonts",
  wasmUrl: "wasm",
}

/**
 * What pdf.js asks for besides the file (character maps for text in fonts
 * a PDF doesn't carry, standard fonts, image decoders), from the bundle:
 * never fetched, never read from a path the file names.
 */
export class BundledPdfData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const folder = BUNDLED_FOLDERS[kind]
    const asset = folder ? PDF_PREVIEW_ASSETS[`/pdfjs/${folder}/${filename}`] : undefined
    if (!asset) throw new Error(`pdf.js asked for ${kind} ${filename}, which isn't bundled`)
    return new Uint8Array(await Bun.file(asset.url).arrayBuffer())
  }
}

const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject,
])

const PICTURE_PAGE =
  "This page is a picture with no text layer. Worktable doesn't read text from pictures."

/**
 * pdf-inspector's Markdown, split at its page marks, by page number. A mark
 * counts only on a line of its own and only when it moves forward through
 * the file's pages, so a mark written as text inside a page doesn't start
 * one.
 */
function markdownPages(markdown: string | undefined, pageCount: number): Map<number, string> {
  const pages = new Map<number, string>()
  if (!markdown) return pages
  const marks: { page: number; start: number; end: number }[] = []
  for (const mark of markdown.matchAll(/(^|\n)<!-- Page (\d+) -->\n?/g)) {
    const page = Number(mark[2])
    if (page <= (marks.at(-1)?.page ?? 0) || page > pageCount) continue
    marks.push({ page, start: mark.index! + mark[1]!.length, end: mark.index! + mark[0].length })
  }
  marks.forEach((mark, index) => {
    pages.set(mark.page, markdown.slice(mark.end, marks[index + 1]?.start ?? markdown.length).trim())
  })
  return pages
}

/** Words of a text, for telling whether two readings are of one page. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Which pages' Markdown can be trusted to be that page: it holds the first
 * words pdf.js read there, and no page after it that has text lacks a mark
 * of its own (pdf-inspector marks only pages that start with a line of
 * text, so a page holding only a table runs into the page before it).
 */
function trustedPages(structured: Map<number, string>, plain: string[]): Set<number> {
  const trusted = new Set<number>()
  for (const [page, markdown] of structured) {
    const opening = words(plain[page - 1] ?? "").slice(0, 4)
    const found = new Set(words(markdown))
    if (opening.every((word) => found.has(word))) trusted.add(page)
  }
  for (let page = 1; page <= plain.length; page += 1) {
    if (structured.has(page) || plain[page - 1] === "") continue
    // An unmarked page with text: its content may sit in the last marked page.
    for (let before = page - 1; before >= 1; before -= 1) {
      if (structured.has(before)) {
        trusted.delete(before)
        break
      }
    }
  }
  return trusted
}

export const pdfReader: ParsingReader = {
  version: CONTENTS_READER_VERSIONS.pdf,
  async read(bytes) {
    let loading: ReturnType<typeof getDocument> | undefined
    let document
    try {
      loading = getDocument({
        // pdf.js may take the buffer over; the second engine reads its own copy.
        data: bytes.slice(),
        isEvalSupported: false,
        enableXfa: false,
        disableFontFace: true,
        useSystemFonts: false,
        stopAtErrors: false,
        verbosity: VerbosityLevel.ERRORS,
        // pdf.js 6 asks one factory for character maps, fonts and decoders.
        BinaryDataFactory: BundledPdfData,
        useWorkerFetch: false,
        cMapPacked: true,
      } as Parameters<typeof getDocument>[0])
      document = await loading.promise
    } catch (error) {
      await loading?.destroy().catch(() => {})
      const name = (error as { name?: string }).name
      if (name === "PasswordException") {
        throw new ReaderRefused(
          "encrypted",
          "This PDF is password protected, so Worktable can't read its text. It still downloads."
        )
      }
      throw new ReaderRefused(
        "damaged",
        "This PDF is damaged, so Worktable can't read its text. It still downloads."
      )
    }

    const pageCount = document.numPages
    const pagesRead = Math.min(pageCount, PDF_MAX_PAGES)
    const plain: string[] = []
    const pictures = new Set<number>()
    for (let number = 1; number <= pagesRead; number += 1) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .trim()
      plain.push(text)
      if (text === "") {
        const operators = await page.getOperatorList()
        if (operators.fnArray.some((op) => IMAGE_OPS.has(op))) pictures.add(number)
      }
      page.cleanup()
    }
    const info = (await document.getMetadata().catch(() => null))?.info as
      | { Title?: unknown }
      | undefined
    await loading.destroy()

    // The structure engine is a better reading where it reads a page at all;
    // a file it can't read keeps the plain text.
    let structured = new Map<number, string>()
    try {
      const pages = pagesRead < pageCount ? Array.from({ length: pagesRead }, (_, index) => index + 1) : undefined
      structured = markdownPages(
        (await inspector())(bytes, {
          includePageMarkers: true,
          includeImages: false,
          ...(pages ? { pages } : {}),
        }).markdown,
        pagesRead
      )
    } catch {
      // Plain text for every page.
    }
    const trusted = trustedPages(structured, plain)

    const parts: ContentsPart[] = []
    const gaps: ContentsGap[] = []
    for (let number = 1; number <= pagesRead; number += 1) {
      const markdown = trusted.has(number) ? structured.get(number) : undefined
      parts.push({
        label: `Page ${number}`,
        text: markdown && markdown.length > 0 ? markdown : plain[number - 1]!,
      })
      if (pictures.has(number)) gaps.push({ where: `Page ${number}`, why: PICTURE_PAGE })
    }
    if (pagesRead < pageCount) {
      gaps.push({
        where: `Pages ${pagesRead + 1} to ${pageCount}`,
        why: `Worktable reads the first ${PDF_MAX_PAGES} pages of a PDF.`,
      })
    }
    const title = typeof info?.Title === "string" ? info.Title.trim() : ""
    return {
      parts,
      facts: { pages: pageCount, ...(title ? { title } : {}) },
      gaps,
    }
  },
}
