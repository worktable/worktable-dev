// ============================================================
// Space images in HTML Docs
// ============================================================
//
// An HTML Doc shows an image kept in its Space by naming it, as in
// <img src="img/hero.jpg">: relative to the Doc's folder, or from the Space
// root with a leading "/", as Markdown Docs embed images. Its frame can load
// nothing from the Space (img-src data: blob:), so the server places each
// named image in the page as a data URL wherever the page is served: the
// member frame, previews, old versions and share links.
//
// - Only literal src attributes of img elements count, never script text,
//   so a page shows only files it names. Images built by code aren't found.
// - The rules and caps are those of images on shared pages (space-images.ts),
//   so members and visitors see the same page. An image that is missing,
//   archived, too large, past the page's budget or not an image keeps its
//   src and shows broken.
// - A placed image keeps its path in data-worktable-src, for page code.
// - A frame's revision names the images it shows by their catalog stamps
//   (htmlImagesStamp), so a replaced, added or archived image loads anew.
//   The images a source names are kept by its hash, so lists and page checks
//   read no source to stamp them.
//
// Held behind the MCP preview surface (htmlSpaceImagesEnabled).

import { createHash } from "node:crypto"
import { resolveDocLink } from "@worktable/types"
import { sourceStampSize } from "./document-catalog.ts"
import {
  applySpanEdits,
  htmlAttributeText,
  htmlMediaSources,
  type HtmlMediaSource,
} from "./html-media-sources.ts"
import { htmlSpaceImagesEnabled } from "./mcp/surface.ts"
import {
  IMAGE_MAX_BYTES,
  PAGE_IMAGE_BUDGET_BYTES,
  PAGE_IMAGE_TARGETS_MAX,
  readSpaceImages,
  showableSpaceFiles,
  spaceImageType,
  type SpaceFile,
} from "./space-images.ts"
import type { WidgetValidationIssue } from "./widget-authoring.ts"

export { htmlSpaceImagesEnabled }

/** The attribute a placed image keeps its path in. */
const HTML_IMAGE_PATH_ATTRIBUTE = "data-worktable-src"

/** Whether a src names a path in the Space rather than a URL or a fragment. */
function namesSpacePath(value: string): boolean {
  return resolveDocLink("", value) !== null
}

/** A page's img elements naming a Space path past this many stay as written. */
const HTML_IMAGE_SOURCES_MAX = 4_096

/**
 * The src attributes of a page's img elements that name a Space path, up to
 * `max` of them, kept as they are parsed.
 */
function htmlImageSources(html: string, max = HTML_IMAGE_SOURCES_MAX): HtmlMediaSource[] {
  return htmlMediaSources(html, {
    accept: (tag, value) => tag === "img" && namesSpacePath(value),
    max,
  })
}

// ── The images a source names ────────────────────────────────

const TARGETS_MAX = 4_096
/** By source sha256: each distinct target it names, as written, up to the cap. */
const targetsBySource = new Map<string, readonly string[]>()

function rememberTargets(sourceSha256: string, targets: readonly string[]) {
  targetsBySource.delete(sourceSha256)
  targetsBySource.set(sourceSha256, targets)
  for (const oldest of targetsBySource.keys()) {
    if (targetsBySource.size <= TARGETS_MAX) break
    targetsBySource.delete(oldest)
  }
}

/**
 * The image targets a source names, read once per source hash. `html` is
 * the source, or reads it when the hash is not known yet; a source that
 * can't be read names none.
 */
async function imageTargets(
  sourceSha256: string,
  html: string | (() => Promise<string | null>)
): Promise<readonly string[]> {
  const known = targetsBySource.get(sourceSha256)
  if (known) {
    rememberTargets(sourceSha256, known)
    return known
  }
  const text = typeof html === "string" ? html : await html()
  if (text === null) return []
  const targets = [
    ...new Set(htmlImageSources(text).map((source) => source.value)),
  ].slice(0, PAGE_IMAGE_TARGETS_MAX)
  // A source read now may have changed since it was hashed.
  if (
    typeof html === "string" ||
    createHash("sha256").update(text).digest("hex") === sourceSha256
  ) {
    rememberTargets(sourceSha256, targets)
  }
  return targets
}

/**
 * What an HTML Doc's frame shows of its Space's images, for its revision:
 * each image path it names with its catalog stamp, or "-" when the Space
 * can't show it. Undefined while the feature is off or the page names no
 * image, so its revision is the one it always had.
 */
export async function htmlImagesStamp(input: {
  spaceId: string
  /** The HTML Doc's path, which relative targets resolve from. */
  path: string
  sourceSha256: string
  html: string | (() => Promise<string | null>)
  /** The caller holds the Space's document path lock. */
  lockHeld?: boolean
  /** The Space's showable files, when a caller stamps many pages at once. */
  files?: () => Promise<ReadonlyMap<string, SpaceFile>>
}): Promise<string | undefined> {
  if (!htmlSpaceImagesEnabled()) return undefined
  const targets = await imageTargets(input.sourceSha256, input.html)
  if (targets.length === 0) return undefined
  const files = input.files
    ? await input.files()
    : await showableSpaceFiles(input.spaceId, {
        lockHeld: input.lockHeld ?? false,
      })
  const parts = new Set<string>()
  for (const target of targets) {
    const path = resolveDocLink(input.path, target)
    if (path === null || !spaceImageType(path)) continue
    const entry = files.get(path)
    const stamp =
      entry?.handle.source.kind === "file"
        ? (entry.handle.sourceStamp ?? "?")
        : "-"
    parts.add(`${path}\0${stamp}`)
  }
  return parts.size > 0 ? [...parts].sort().join("\n") : undefined
}

// ── Serving ──────────────────────────────────────────────────

/**
 * An HTML Doc's page with the Space images it names placed in it as data
 * URLs, and how many it placed. `path` is the HTML Doc's own path, which
 * relative targets resolve from; `html` may already carry the runtime and
 * theme. With the feature off, the page as it is. It reads the images, so
 * it runs outside the Space's document path lock.
 */
export async function inlineHtmlSpaceImages(
  spaceId: string,
  path: string,
  html: string
): Promise<{ html: string; inlined: number; named: boolean }> {
  if (!htmlSpaceImagesEnabled()) return { html, inlined: 0, named: false }
  const sources = htmlImageSources(html)
  if (sources.length === 0) return { html, inlined: 0, named: false }
  const targets = new Map<string, number>()
  for (const source of sources) {
    targets.set(source.value, (targets.get(source.value) ?? 0) + 1)
  }
  const { dataUrls } = await readSpaceImages(spaceId, path, targets)
  if (dataUrls.size === 0) return { html, inlined: 0, named: true }
  const edits: Array<{ at: number; length: number; text: string }> = []
  for (const source of sources) {
    const dataUrl = dataUrls.get(source.value)
    if (!dataUrl) continue
    // A data URL needs no escaping in any quote; the path after it does.
    const end = source.at + source.length + (source.quote ? 1 : 0)
    edits.push(
      { at: source.at, length: source.length, text: dataUrl },
      {
        at: end,
        length: 0,
        text: ` ${HTML_IMAGE_PATH_ATTRIBUTE}="${htmlAttributeText(source.value, '"')}"`,
      }
    )
  }
  return { html: applySpanEdits(html, edits), inlined: edits.length / 2, named: true }
}

// ── Writing ──────────────────────────────────────────────────

const MIB = 1024 * 1024

function mib(bytes: number): string {
  return `${Math.round((bytes / MIB) * 10) / 10} MiB`
}

/**
 * What an agent's write should know about the Space images its page names:
 * images the Space can't show, as written, and ones over a cap, which show
 * broken. Sizes come from the Space's catalog, so no image is read. Empty
 * while the feature is off.
 */
export async function htmlImageWarnings(input: {
  spaceId: string
  htmlPath: string
  html: string
}): Promise<WidgetValidationIssue[]> {
  if (!htmlSpaceImagesEnabled()) return []
  // One past the cap, to say when the page names more.
  const sources = htmlImageSources(input.html, HTML_IMAGE_SOURCES_MAX + 1)
  if (sources.length === 0) return []
  const targets = new Map<string, number>()
  for (const source of sources) {
    targets.set(source.value, (targets.get(source.value) ?? 0) + 1)
  }
  const files = await showableSpaceFiles(input.spaceId)
  const issues: WidgetValidationIssue[] = []
  if (targets.size > PAGE_IMAGE_TARGETS_MAX || sources.length > HTML_IMAGE_SOURCES_MAX) {
    issues.push({
      severity: "warning",
      code: "space_images_too_many",
      message: `The page names more Space images than a page shows, ${PAGE_IMAGE_TARGETS_MAX} images in up to ${HTML_IMAGE_SOURCES_MAX} img elements, so those past that show as broken images.`,
      hint: "Put a large gallery in a Markdown Doc.",
    })
  }
  const missing: string[] = []
  const unsupported: string[] = []
  const tooLarge: string[] = []
  const overBudget: string[] = []
  let budget = PAGE_IMAGE_BUDGET_BYTES
  for (const [target, occurrences] of [...targets].slice(0, PAGE_IMAGE_TARGETS_MAX)) {
    const path = resolveDocLink(input.htmlPath, target)
    if (path === null) continue
    if (!spaceImageType(path)) {
      unsupported.push(target)
      continue
    }
    const entry = files.get(path)
    if (entry?.handle.source.kind !== "file") {
      missing.push(target)
      continue
    }
    // A stamp without a size says nothing either way.
    const size = sourceStampSize(entry.handle.sourceStamp)
    if (size === undefined) continue
    if (size > IMAGE_MAX_BYTES) {
      tooLarge.push(`${target} (${mib(size)})`)
    } else if (size * occurrences > budget) {
      overBudget.push(target)
    } else {
      budget -= size * occurrences
    }
  }
  const list = (items: string[]) => items.join(", ")
  if (missing.length > 0) {
    issues.push({
      severity: "warning",
      code: "space_image_missing",
      message: `Not a file in this Space, so it shows as a broken image: ${list(missing)}.`,
      hint: "Paths resolve from this HTML Doc's folder, or from the Space root with a leading /. Upload images with worktable_files_write.",
    })
  }
  if (unsupported.length > 0) {
    issues.push({
      severity: "warning",
      code: "space_image_unsupported",
      message: `Not an image type HTML Docs show from the Space: ${list(unsupported)}.`,
      hint: "Use PNG, JPEG, GIF or WebP files, or inline SVG markup.",
    })
  }
  if (tooLarge.length > 0) {
    issues.push({
      severity: "warning",
      code: "space_image_too_large",
      message: `Larger than ${mib(IMAGE_MAX_BYTES)}, so it shows as a broken image: ${list(tooLarge)}.`,
      hint: "Upload a smaller version of the image.",
    })
  }
  if (overBudget.length > 0) {
    issues.push({
      severity: "warning",
      code: "space_images_over_budget",
      message: `The page's images pass ${mib(PAGE_IMAGE_BUDGET_BYTES)} together, so these show as broken images: ${list(overBudget)}.`,
      hint: "Use smaller images, or put a large gallery in a Markdown Doc.",
    })
  }
  return issues
}

// ── After a move ─────────────────────────────────────────────

/**
 * An HTML Doc's source with its img targets rewritten: `rewrite` returns a
 * target's new text, or null to leave it.
 */
export function rewriteHtmlImageTargets(
  html: string,
  rewrite: (target: string) => string | null
): string {
  const edits: Array<{ at: number; length: number; text: string }> = []
  for (const source of htmlImageSources(html)) {
    const text = rewrite(source.value)
    if (text !== null) {
      edits.push({
        at: source.at,
        length: source.length,
        text: htmlAttributeText(text, source.quote),
      })
    }
  }
  return edits.length === 0 ? html : applySpanEdits(html, edits)
}

/** Whether a page names a Space image, while the feature is on. */
export function htmlNamesSpaceImages(html: string): boolean {
  return htmlSpaceImagesEnabled() && htmlImageSources(html, 1).length > 0
}

/** The img targets an HTML Doc's source names, once per occurrence. */
export function htmlImageTargets(html: string): string[] {
  return htmlImageSources(html).map((source) => source.value)
}
