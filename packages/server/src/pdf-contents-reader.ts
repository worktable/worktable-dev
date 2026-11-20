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
//   sense is in. A page it reads with text uses its Markdown; any other
//   page keeps pdf.js's plain text.
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

/** Character maps for text in fonts a PDF doesn't carry, from the bundle. */
class BundledCMaps {
  async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
    const asset = PDF_PREVIEW_ASSETS[`/pdfjs/cmaps/${name}.bcmap`]
    if (!asset) throw new Error(`no character map ${name}`)
    return { cMapData: new Uint8Array(await Bun.file(asset.url).arrayBuffer()), isCompressed: true }
  }
}

const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject,
  OPS.paintInlineImageXObject,
  OPS.paintImageMaskXObject,
])

const PICTURE_PAGE =
  "This page is a picture with no text layer. Worktable doesn't read text from pictures."

/** pdf-inspector's Markdown, split at its page marks, by page number. */
function markdownPages(markdown: string | undefined): Map<number, string> {
  const pages = new Map<number, string>()
  if (!markdown) return pages
  const marks = [...markdown.matchAll(/<!-- Page (\d+) -->\n?/g)]
  marks.forEach((mark, index) => {
    const start = mark.index! + mark[0].length
    const end = marks[index + 1]?.index ?? markdown.length
    pages.set(Number(mark[1]), markdown.slice(start, end).trim())
  })
  return pages
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
        CMapReaderFactory: BundledCMaps,
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
      structured = markdownPages(
        (await inspector())(bytes, { includePageMarkers: true, includeImages: false }).markdown
      )
    } catch {
      // Plain text for every page.
    }

    const parts: ContentsPart[] = []
    const gaps: ContentsGap[] = []
    for (let number = 1; number <= pagesRead; number += 1) {
      const markdown = structured.get(number)
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
