// ============================================================
// Space images placed in a page
// ============================================================
//
// A page shows images from its own Space, and nothing else in the Space
// becomes reachable: each image it names is read here and placed in the page
// as a data URL, which shared pages and HTML Docs' frames already allow. A
// page carries at most a few MiB of images, since it travels to a linked
// Worktable's visitor through a tunnel with a response limit; images past
// that, larger ones, archived ones, and types the file type table's share
// policy leaves out (SVG and AVIF) stay out. Shared Docs (share-images.ts)
// and HTML Docs (html-space-images.ts) follow the same rules, so members and
// visitors see the same page.

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import {
  FILE_TYPES,
  fileTypeFor,
  fileTypePolicy,
  resolveDocLink,
} from "@worktable/types"
import type { DocumentCatalog, DocumentCatalogEntry } from "./document-catalog.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { readDocumentIdentities } from "./document-query.ts"
import { readDocumentSource } from "./document-source-reader.ts"
import {
  contentHashOf,
  currentFileRevision,
  rememberContentHash,
} from "./file-revision.ts"
import { createDocAliasResolver } from "./doc-aliases.ts"
import { getWorkspaceRoot } from "./workspace.ts"

/** One image larger than this stays out. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** A page's distinct image paths past this many stay out, unread. */
export const PAGE_IMAGE_TARGETS_MAX = 256
/** A page's images together, before base64; it grows by a third. */
export const PAGE_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024
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

export type SpaceFile = Extract<DocumentCatalogEntry, { kind: "document" }>

/**
 * The Space's showable files by path, found also under a path one of them
 * had before a move, through the Space's aliases, as links to moved Docs
 * are: a page naming an image that moved still shows it.
 */
class ShowableFiles extends Map<string, SpaceFile> {
  private readonly moved: (path: string) => string | null
  constructor(
    entries: Iterable<readonly [string, SpaceFile]>,
    moved: (path: string) => string | null
  ) {
    super(entries)
    this.moved = moved
  }
  override get(path: string): SpaceFile | undefined {
    const found = super.get(path)
    if (found) return found
    const now = this.moved(path)
    return now && now !== path ? super.get(now) : undefined
  }
  override has(path: string): boolean {
    return this.get(path) !== undefined
  }
}

async function revisionOf(
  absolutePath: string
): Promise<{ revision: string; size: number; changedAtNs: bigint } | null> {
  return currentFileRevision(absolutePath).catch(() => null)
}

// Built once per catalog snapshot: its archive facts come from the same one.
const showableByCatalog = new WeakMap<
  DocumentCatalog,
  ReadonlyMap<string, SpaceFile>
>()

/**
 * The Space's files a page may show, by path: not archived, whether the
 * catalog or the Space's archive records say so. From the Space's read-model
 * snapshot, so no file is read while it is current. `lockHeld` says the
 * caller holds the Space's document path lock, which this must not take
 * again.
 */
export async function showableSpaceFiles(
  spaceId: string,
  options: { lockHeld?: boolean } = {}
): Promise<ReadonlyMap<string, SpaceFile>> {
  const { catalog, identities } = await readDocumentIdentities(spaceId, options)
  const known = showableByCatalog.get(catalog)
  if (known) return known
  const files = new ShowableFiles(
    catalog.entries.flatMap((entry) =>
      entry.kind === "document" &&
      entry.descriptor.format.id === BUILTIN_DOCUMENT_FORMATS.file &&
      !entry.handle.archived &&
      !identities.archived.has(entry.descriptor.documentId)
        ? [[entry.descriptor.path, entry] as const]
        : []
    ),
    createDocAliasResolver(catalog.aliases)
  )
  showableByCatalog.set(catalog, files)
  return files
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
  const showable = await showableSpaceFiles(spaceId)
  for (const file of files) {
    if (!("contentHash" in file)) {
      if (showable.has(file.path) !== file.showable) return false
      // One the Space doesn't list was never read: it shows once listed.
      if (!file.showable) continue
      const now = await revisionOf(file.absolutePath)
      if ((now?.revision ?? null) !== file.revision) return false
      continue
    }
    const now = await revisionOf(file.absolutePath)
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

/** The media type a page carries an image of this name as, if it shows it. */
export function spaceImageType(path: string): string | undefined {
  const type = fileTypeFor(path)
  return type !== null && fileTypePolicy(type, "share") === "inline"
    ? FILE_TYPES[type].mediaType
    : undefined
}

/**
 * The images a page at `docPath` names, as data URLs by target as written,
 * and what it saw of each file it names. `targets` counts each target's
 * occurrences, as every one carries its own data URL; they are read in
 * order until the page's budget runs out.
 */
export async function readSpaceImages(
  spaceId: string,
  docPath: string,
  targets: ReadonlyMap<string, number>
): Promise<{ dataUrls: Map<string, string>; embeds: EmbeddedFile[] }> {
  const dataUrls = new Map<string, string>()
  const embeds: EmbeddedFile[] = []
  if (targets.size === 0) return { dataUrls, embeds }
  const files = await showableSpaceFiles(spaceId)
  const spaceRoot = resolve(getWorkspaceRoot(), "spaces", spaceId)
  let budget = PAGE_IMAGE_BUDGET_BYTES
  for (const [target, occurrences] of [...targets].slice(0, PAGE_IMAGE_TARGETS_MAX)) {
    const path = resolveDocLink(docPath, target)
    const mediaType = path === null ? undefined : spaceImageType(path)
    if (path === null || !mediaType) continue
    const entry = files.get(path)
    // Every image the page refers to is noted, shown or not, so one that
    // appears, recovers or shrinks later renders the page anew. One the
    // Space doesn't list isn't looked for on disk.
    const absolutePath =
      entry && entry.handle.source.kind === "file"
        ? resolve(spaceRoot, entry.handle.source.relativePath)
        : resolve(spaceRoot, "docs", ...path.split("/"))
    if (!entry) {
      embeds.push({ absolutePath, path, showable: false, revision: null })
      continue
    }
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
  return { dataUrls, embeds }
}
