// ============================================================
// Images on shared pages
// ============================================================
//
// A shared Doc shows the images it embeds from its own Space, and nothing
// else in the Space becomes reachable: each image is read here and placed in
// the page as a data URL, which the share renderer and its policy already
// allow. A page carries at most a few MiB of images, since it travels to a
// linked Worktable's visitor through a tunnel with a response limit; images
// past that, larger ones, and types the file type table's share policy
// leaves out (SVG and AVIF) keep the placeholder shared pages show today.

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import {
  FILE_TYPES,
  fileTypeFor,
  fileTypePolicy,
  resolveDocLink,
} from "@worktable/types"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { readDocumentSource } from "./document-source-reader.ts"
import type { DocumentCatalogEntry } from "./document-catalog.ts"
import { readDocumentIdentities } from "./document-query.ts"
import {
  contentHashOf,
  currentFileRevision,
  rememberContentHash,
} from "./file-revision.ts"
import { filesEnabled } from "./files-enabled.ts"
import { rewriteBlockLinks, rewriteMarkdownLinks } from "./link-rewrite.ts"
import { getWorkspaceRoot } from "./workspace.ts"

/** One image larger than this keeps the placeholder. */
const IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** A page's images together, before base64; it grows by a third. */
const PAGE_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024
const READ_TIMEOUT_MS = 10_000

/**
 * What a cached page saw of a file it embeds, to tell when it changed: the
 * content hash of the bytes it shows, or, for an image it leaves out,
 * whether the Space could show it and the file's revision, or null while it
 * isn't there to read, since only those and its size decide that.
 */
export type EmbeddedFile =
  | { absolutePath: string; path: string; contentHash: string }
  | {
      absolutePath: string
      path: string
      showable: boolean
      revision: string | null
    }

type CatalogFile = Extract<DocumentCatalogEntry, { kind: "document" }>

async function revisionOf(
  absolutePath: string
): Promise<{ revision: string; size: number; changedAtNs: bigint } | null> {
  return currentFileRevision(absolutePath).catch(() => null)
}

/**
 * The Space's files a shared page may show, by path: not archived, whether
 * the catalog or the Space's archive records say so.
 */
async function showableFiles(
  spaceId: string
): Promise<Map<string, CatalogFile>> {
  const { catalog, identities } = await readDocumentIdentities(spaceId)
  return new Map(
    catalog.entries.flatMap((entry) =>
      entry.kind === "document" &&
      entry.descriptor.format.id === BUILTIN_DOCUMENT_FORMATS.file &&
      !entry.handle.archived &&
      !identities.archived.has(entry.descriptor.documentId)
        ? [[entry.descriptor.path, entry] as const]
        : []
    )
  )
}

/**
 * Whether every file a cached page embeds is as it was: shown, left out or
 * missing then, and still so, so a file that appears, changes or is archived
 * renders the page anew. A shown file's hash is the one kept for its
 * revision, so this reads a file whole only once it has a new revision.
 */
export async function embeddedFilesUnchanged(
  spaceId: string,
  files: readonly EmbeddedFile[]
): Promise<boolean> {
  if (files.length === 0) return true
  const showable = await showableFiles(spaceId)
  for (const file of files) {
    const now = await revisionOf(file.absolutePath)
    if (!("contentHash" in file)) {
      if (showable.has(file.path) !== file.showable) return false
      if ((now?.revision ?? null) !== file.revision) return false
      continue
    }
    // One grown past what a page shows, or archived, is left out now.
    if (!now || now.size > IMAGE_MAX_BYTES || !showable.has(file.path)) {
      return false
    }
    const hash = await contentHashOf({
      path: file.absolutePath,
      revision: now.revision,
      size: now.size,
    }).catch(() => null)
    if (hash !== file.contentHash) return false
  }
  return true
}

/** The media type a shared page carries an image of this name as. */
function imageType(path: string): string | undefined {
  const type = fileTypeFor(path)
  return type !== null && fileTypePolicy(type, "share") === "inline"
    ? FILE_TYPES[type].mediaType
    : undefined
}

/**
 * A shared Doc's content with the images it embeds from its Space placed in
 * it as data URLs, and what it saw of each file it embeds. With files off,
 * the content as it is.
 */
export async function inlineSharedImages<T extends string | unknown[]>(
  spaceId: string,
  docPath: string,
  content: T
): Promise<{ content: T; embeds: EmbeddedFile[] }> {
  if (!filesEnabled()) return { content, embeds: [] }
  // Each image's occurrences, as every one carries its own data URL.
  const targets = new Map<string, number>()
  const collect = (target: string, imageUses = 1) => {
    // A definition many images refer to shows its bytes in each of them.
    targets.set(target, (targets.get(target) ?? 0) + Math.max(1, imageUses))
    return null
  }
  if (typeof content === "string") {
    rewriteMarkdownLinks(content, collect, { imagesOnly: true })
  } else {
    rewriteBlockLinks(content, collect, { imagesOnly: true })
  }
  if (targets.size === 0) return { content, embeds: [] }

  const files = await showableFiles(spaceId)
  const spaceRoot = resolve(getWorkspaceRoot(), "spaces", spaceId)
  const dataUrls = new Map<string, string>()
  const embeds: EmbeddedFile[] = []
  let budget = PAGE_IMAGE_BUDGET_BYTES
  for (const [target, occurrences] of targets) {
    const path = resolveDocLink(docPath, target)
    const mediaType = path === null ? undefined : imageType(path)
    if (path === null || !mediaType) continue
    const entry = files.get(path)
    // Every image the page refers to is noted, shown or not, so one that
    // appears, recovers or shrinks later renders the page anew.
    const absolutePath =
      entry && entry.handle.source.kind === "file"
        ? resolve(spaceRoot, entry.handle.source.relativePath)
        : resolve(spaceRoot, "docs", ...path.split("/"))
    const startedAt = Date.now()
    const current = await revisionOf(absolutePath)
    const shown =
      entry &&
      entry.handle.source.kind === "file" &&
      current &&
      current.size <= IMAGE_MAX_BYTES &&
      current.size * occurrences <= budget
        ? await readDocumentSource({
            spaceRoot,
            documentId: entry.descriptor.documentId,
            format: entry.descriptor.format,
            source: entry.handle.source,
            maxBytes: IMAGE_MAX_BYTES,
            signal: AbortSignal.timeout(READ_TIMEOUT_MS),
          }).catch(() => null)
        : null
    if (!shown || shown.byteLength * occurrences > budget) {
      embeds.push({
        absolutePath,
        path,
        showable: entry !== undefined,
        revision: current?.revision ?? null,
      })
      continue
    }
    // The bytes shown are named by their own hash, as the file's content
    // hash names them, whatever revision they were read at. Kept for the
    // file's revision too, so the next view needn't read them again.
    const contentHash = createHash("sha256").update(shown).digest("base64url")
    embeds.push({ absolutePath, path, contentHash })
    if (current) {
      await rememberContentHash(absolutePath, current, startedAt, contentHash)
    }
    budget -= shown.byteLength * occurrences
    dataUrls.set(
      target,
      `data:${mediaType};base64,${Buffer.from(shown).toString("base64")}`
    )
  }
  const inline = (target: string) => dataUrls.get(target) ?? null
  const inlined =
    typeof content === "string"
      ? rewriteMarkdownLinks(content, inline, { imagesOnly: true })
      : rewriteBlockLinks(content, inline, { imagesOnly: true }).blocks
  return { content: inlined as T, embeds }
}
