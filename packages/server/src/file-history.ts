// ============================================================
// A file as it was
// ============================================================
//
// An old version of a Doc shows the files it embeds as they were when that
// version was saved: each file's newest version from then or before, from
// the file's own history. A file moved since is found through its alias.
// A version retention has since removed, or a file kept only later, reads
// as nothing, never as today's file.

import { resolveDocLink } from "@worktable/types"
import { resolveDocAliasIn } from "./doc-aliases.ts"
import {
  createRegisteredDocument,
  DocumentWriteError,
  readRegisteredDocumentSource,
} from "./document-write-service.ts"
import { filesPreviewEnabled } from "./files-preview.ts"
import {
  encodeTargetPath,
  rewriteBlockLinks,
  rewriteDocTargets,
  rewriteMarkdownLinks,
} from "./link-rewrite.ts"
import { agentChangeBase } from "./mcp/dispatcher.ts"
import { versionIdTimestamp } from "./version-store.ts"
import { logError } from "./debug-log.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import { readDocumentCatalogSnapshot } from "./document-query.ts"
import {
  listDocumentGenerationsV2,
  readDocumentGenerationV2,
} from "./document-version-store-v2.ts"
import { getWorkspaceRoot } from "./workspace.ts"

/** Copies one restore makes at most, and their bytes together. */
const RESTORE_COPIES_MAX = 50
const RESTORE_COPY_BYTES_MAX = 256 * 1024 * 1024

/** The bytes a file had at `at` (epoch ms), or null when none were kept. */
export async function readFileAsOf(
  spaceId: string,
  path: string,
  at: number
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const catalog = await readDocumentCatalogSnapshot(spaceId)
  // Paths compare as the current file read compares them, so a link that
  // differs from the file's name only in case finds it here too.
  const key = (candidate: string) =>
    analyzeDocumentPath(candidate).comparisonKey ?? candidate
  const fileAt = (candidate: string | null) =>
    candidate === null
      ? undefined
      : catalog.entries.find(
          (entry) =>
            entry.kind === "document" &&
            key(entry.descriptor.path) === key(candidate) &&
            entry.descriptor.format.id === BUILTIN_DOCUMENT_FORMATS.file &&
            entry.handle.identity === "durable"
        )
  const entry =
    fileAt(path) ?? fileAt(resolveDocAliasIn(catalog.aliases, path))
  if (!entry || entry.kind !== "document") return null
  const workspaceRoot = getWorkspaceRoot()
  const generations = await listDocumentGenerationsV2({
    workspaceRoot,
    spaceId,
    documentId: entry.descriptor.documentId,
  })
  // A version that merged later saves holds what the last of them saved.
  const savedAt = (generation: (typeof generations)[number]) =>
    Date.parse(generation.updatedAt ?? generation.createdAt)
  // Between its first and last save, what the file held was not kept: an
  // earlier version would be the wrong image, so there is none.
  if (
    generations.some(
      (generation) =>
        generation.updatedAt !== undefined &&
        Date.parse(generation.createdAt) <= at &&
        at < savedAt(generation)
    )
  ) {
    return null
  }
  const then = generations
    .filter((generation) => savedAt(generation) <= at)
    .sort((a, b) => savedAt(b) - savedAt(a))[0]
  if (!then) return null
  const read = await readDocumentGenerationV2({
    workspaceRoot,
    spaceId,
    documentId: entry.descriptor.documentId,
    generationId: then.id,
  })
  const bytes = read?.authoredSource.entries[0]?.bytes
  if (!bytes) return null
  return {
    bytes,
    fileName: entry.descriptor.path.split("/").at(-1) ?? entry.descriptor.path,
  }
}

/**
 * After a Doc is restored to its version from `at`: an image it embeds that
 * has changed since gets a copy of how it was then, saved in the Doc's own
 * folder, and the restored Doc shows the copy. The image itself, which other
 * Docs may use, stays as it is now. Returns the copies made.
 */
export async function keepEarlierImagesForRestoredDoc(
  spaceId: string,
  docPath: string,
  at: number,
  createdBy: string
): Promise<string[]> {
  if (!filesPreviewEnabled()) return []
  const current = await agentChangeBase(spaceId, docPath, undefined, false)
  const targets = new Set<string>()
  const collect = (target: string) => {
    targets.add(target)
    return null
  }
  if (typeof current.base === "string") {
    rewriteMarkdownLinks(current.base, collect, { imagesOnly: true })
  } else if (Array.isArray(current.base)) {
    rewriteBlockLinks(current.base, collect, { imagesOnly: true })
  }
  // Spellings of one file (`x.png`, `./x.png`, `x.png#a`) share one copy.
  const byFile = new Map<string, { path: string; spellings: string[] }>()
  for (const target of targets) {
    const path = resolveDocLink(docPath, target)
    if (path === null) continue
    const key = analyzeDocumentPath(path).comparisonKey ?? path
    const file = byFile.get(key)
    if (file) file.spellings.push(target)
    else byFile.set(key, { path, spellings: [target] })
  }
  const copies = new Map<string, string>()
  const kept: string[] = []
  let keptBytes = 0
  const docLeaf = docPath.split("/").at(-1) ?? docPath
  const day = new Date(at).toISOString().slice(0, 10)
  for (const { path, spellings } of byFile.values()) {
    // One restore copies a bounded amount; images past it show as they are now.
    if (kept.length >= RESTORE_COPIES_MAX) break
    const then = await readFileAsOf(spaceId, path, at)
    if (!then || keptBytes + then.bytes.byteLength > RESTORE_COPY_BYTES_MAX) continue
    const now = await readRegisteredDocumentSource({ spaceId, path }).catch(
      () => null
    )
    if (
      !now ||
      now.format.id !== BUILTIN_DOCUMENT_FORMATS.file ||
      Buffer.from(now.bytes).equals(Buffer.from(then.bytes))
    ) {
      continue
    }
    const dot = then.fileName.lastIndexOf(".")
    const base = dot > 0 ? then.fileName.slice(0, dot) : then.fileName
    const extension = dot > 0 ? then.fileName.slice(dot) : ""
    for (let n = 1; n <= 100; n++) {
      const name = `${base}-${day}${n === 1 ? "" : `-${n}`}${extension}`
      try {
        await createRegisteredDocument({
          spaceId,
          path: `${docPath}/${name}`,
          format: { id: BUILTIN_DOCUMENT_FORMATS.file, sourceVersion: 1 },
          bytes: then.bytes,
          createdBy,
          source: "system",
          reason: "Kept with a restored version",
        })
        const copy = `${docLeaf}/${name}`
        kept.push(copy)
        keptBytes += then.bytes.byteLength
        for (const spelling of spellings) copies.set(spelling, copy)
        break
      } catch (error) {
        if (!(error instanceof DocumentWriteError) || error.reason !== "conflict") {
          throw error
        }
      }
    }
  }
  if (copies.size > 0) {
    await rewriteDocTargets(
      spaceId,
      docPath,
      (target) => {
        const copy = copies.get(target)
        return copy === undefined ? null : encodeTargetPath(copy)
      },
      { reason: "Kept the images of a restored version", imagesOnly: true }
    )
  }
  return kept
}

/**
 * Run after a Doc version is restored: keep the earlier images it showed.
 * A failure here leaves the restore as it is, and is logged.
 */
export async function keepEarlierImagesAfterRestore(
  spaceId: string,
  docPath: string,
  versionId: string,
  createdBy: string
): Promise<string[]> {
  const at = versionIdTimestamp(versionId)
  if (at === null) return []
  try {
    return await keepEarlierImagesForRestoredDoc(spaceId, docPath, at, createdBy)
  } catch (error) {
    console.warn("[files] earlier images were not kept with a restore:", logError(error))
    return []
  }
}
