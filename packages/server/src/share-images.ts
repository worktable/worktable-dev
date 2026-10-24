// ============================================================
// Images on shared pages
// ============================================================
//
// A shared Doc shows the images it embeds from its own Space, and nothing
// else in the Space becomes reachable: each image is read here and placed in
// the page as a data URL, which the share renderer and its policy already
// allow. A page carries at most a few MiB of images, since it travels to a
// linked Worktable's visitor through a tunnel with a response limit; images
// past that, larger ones, and SVGs keep the placeholder shared pages show
// today.

import { lstat } from "node:fs/promises"
import { resolve } from "node:path"
import { resolveDocLink } from "@worktable/types"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { readDocumentSource } from "./document-source-reader.ts"
import { readDocumentCatalogSnapshot } from "./document-query.ts"
import { filesPreviewEnabled } from "./files-preview.ts"
import { rewriteBlockLinks, rewriteMarkdownLinks } from "./link-rewrite.ts"
import { getWorkspaceRoot } from "./workspace.ts"

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
/** One image larger than this keeps the placeholder. */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** A page's images together, before base64; it grows by a third. */
const PAGE_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024
const READ_TIMEOUT_MS = 10_000

/**
 * What a cached page saw of a file it embeds, to tell when it changed: its
 * size, time and inode, or -1 for each while it isn't there to read.
 */
export interface FileStamp {
  absolutePath: string
  size: number
  mtimeMs: number
  ino: number
}

async function stampOf(absolutePath: string): Promise<FileStamp> {
  const info = await lstat(absolutePath).catch(() => null)
  return info?.isFile()
    ? { absolutePath, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino }
    : { absolutePath, size: -1, mtimeMs: -1, ino: -1 }
}

/**
 * Whether every file a cached page embeds is as it was: shown, too large, or
 * missing then, and still so, so a file that appears or changes renders anew.
 */
export async function stampsStillHold(
  stamps: readonly FileStamp[]
): Promise<boolean> {
  for (const stamp of stamps) {
    const now = await stampOf(stamp.absolutePath)
    if (
      now.size !== stamp.size ||
      now.mtimeMs !== stamp.mtimeMs ||
      now.ino !== stamp.ino
    ) {
      return false
    }
  }
  return true
}

function imageType(path: string): string | undefined {
  const dot = path.lastIndexOf(".")
  return dot > path.lastIndexOf("/")
    ? IMAGE_TYPES[path.slice(dot).toLowerCase()]
    : undefined
}

/**
 * A shared Doc's content with the images it embeds from its Space placed in
 * it as data URLs, and the stamps of those images. With files off, the
 * content as it is.
 */
export async function inlineSharedImages<T extends string | unknown[]>(
  spaceId: string,
  docPath: string,
  content: T
): Promise<{ content: T; stamps: FileStamp[] }> {
  if (!filesPreviewEnabled()) return { content, stamps: [] }
  // Each image's occurrences, as every one carries its own data URL.
  const targets = new Map<string, number>()
  const collect = (target: string) => {
    targets.set(target, (targets.get(target) ?? 0) + 1)
    return null
  }
  if (typeof content === "string") {
    rewriteMarkdownLinks(content, collect, { imagesOnly: true })
  } else {
    rewriteBlockLinks(content, collect, { imagesOnly: true })
  }
  if (targets.size === 0) return { content, stamps: [] }

  const catalog = await readDocumentCatalogSnapshot(spaceId)
  const files = new Map(
    catalog.entries.flatMap((entry) =>
      entry.kind === "document" &&
      entry.descriptor.format.id === BUILTIN_DOCUMENT_FORMATS.file &&
      !entry.handle.archived
        ? [[entry.descriptor.path, entry] as const]
        : []
    )
  )
  const spaceRoot = resolve(getWorkspaceRoot(), "spaces", spaceId)
  const dataUrls = new Map<string, string>()
  const stamps: FileStamp[] = []
  let budget = PAGE_IMAGE_BUDGET_BYTES
  for (const [target, occurrences] of targets) {
    const path = resolveDocLink(docPath, target)
    const mediaType = path === null ? undefined : imageType(path)
    if (path === null || !mediaType) continue
    const entry = files.get(path)
    // Every image the page refers to is stamped, shown or not, so one that
    // appears, recovers or shrinks later renders the page anew.
    const absolutePath =
      entry && entry.handle.source.kind === "file"
        ? resolve(spaceRoot, entry.handle.source.relativePath)
        : resolve(spaceRoot, "docs", ...path.split("/"))
    const stamp = await stampOf(absolutePath)
    stamps.push(stamp)
    if (!entry || entry.handle.source.kind !== "file") continue
    if (stamp.size < 0 || stamp.size > IMAGE_MAX_BYTES) continue
    if (stamp.size * occurrences > budget) continue
    let bytes: Uint8Array
    try {
      bytes = await readDocumentSource({
        spaceRoot,
        documentId: entry.descriptor.documentId,
        format: entry.descriptor.format,
        source: entry.handle.source,
        maxBytes: IMAGE_MAX_BYTES,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      })
    } catch {
      continue
    }
    if (bytes.byteLength * occurrences > budget) continue
    budget -= bytes.byteLength * occurrences
    dataUrls.set(
      target,
      `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`
    )
  }
  const inline = (target: string) => dataUrls.get(target) ?? null
  const inlined =
    typeof content === "string"
      ? rewriteMarkdownLinks(content, inline, { imagesOnly: true })
      : rewriteBlockLinks(content, inline, { imagesOnly: true }).blocks
  return { content: inlined as T, stamps }
}
