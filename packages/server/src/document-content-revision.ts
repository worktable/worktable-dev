// ============================================================
// Content revisions: what the app renders, by revision
// ============================================================
//
// The app reads a document's content by revision and keeps it: Markdown and
// rich text from GET …/documents/content?path=&rev=, an HTML Doc's frame from
// its content address with rev=. Both are cached as immutable, so a revision
// must name exactly the response the server sends for it. It hashes:
// - the source bytes;
// - what else shapes the response: the storage kind of a Doc (Markdown or
//   rich text) and whether an HTML Doc may use the network (its frame's CSP);
// - the web build this server serves. Server code turns bytes into a
//   response (parsing, the HTML runtime it injects), and the build changes
//   with every release and deployment. Without a build id, as in
//   development, a token for this process stands in.
//
// Documents with identical sources share a revision. That is safe because
// they get identical responses; the path in a content address only says
// where to look.
//
// Lists and page checks report revisions without reading every source. A
// source's hash is kept with its file fingerprint and reused while the
// fingerprint is unchanged, the rule the read model uses: a fingerprint that
// changed within the racy window proves nothing, so that file is read again.

import { createHash, randomUUID } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { extname, resolve } from "node:path"
import type { DocumentSource } from "@worktable/types"
import { mapWithConcurrency } from "./bounded-concurrency.ts"
import type { DocumentCatalog } from "./document-catalog.ts"
import {
  legacySpecializedDocumentView,
  readDocumentCatalogSnapshot,
} from "./document-query.ts"
import { FingerprintCache, fingerprintOf } from "./file-fingerprint.ts"
import {
  htmlDocumentFrameInputsStorageV2,
  usesHtmlDocumentStorageV2,
} from "./html-document-storage-v2.ts"
import { previewFontVersion } from "./preview-fonts.ts"
import { servedBuildId } from "./static-assets.ts"
import { getDocPath } from "./store.ts"
import {
  getWidgetContentPath,
  getWidgetPath,
  readWidgetDocument,
} from "./widget-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"

const REVISION_SCHEME = "worktable.content-revision.1"
const PROCESS_BUILD = `process:${randomUUID()}`

function revisionOf(parts: readonly string[]): string {
  const hash = createHash("sha256")
  hash.update(REVISION_SCHEME)
  hash.update("\0")
  hash.update(servedBuildId() ?? PROCESS_BUILD)
  for (const part of parts) {
    hash.update("\0")
    hash.update(part)
  }
  // 132 bits: equal revisions are equal content.
  return hash.digest("base64url").slice(0, 22)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** A Markdown (`md`) or rich-text (`json`) Doc's revision. */
export function docContentRevision(input: {
  storedAs: "md" | "json"
  sha256: string
}): string {
  return revisionOf(["doc", input.storedAs, input.sha256])
}

/**
 * An HTML Doc frame's revision. The frame also carries the preview fonts'
 * CSS, which changes when the product font is provisioned or replaced.
 */
export function htmlContentRevision(input: {
  sourceSha256: string
  network: boolean
}): string {
  return revisionOf([
    "html",
    input.network ? "network" : "local",
    previewFontVersion(),
    input.sourceSha256,
  ])
}

/** The revision of an HTML Doc as read by readWidgetDocument. */
export function htmlContentRevisionOf(document: {
  widget: { permissions?: { network?: boolean } }
  sourceBytes: Uint8Array
}): string {
  return htmlContentRevision({
    sourceSha256: sha256Hex(document.sourceBytes),
    // As the frame's CSP reads it.
    network: document.widget.permissions?.network ?? false,
  })
}

/** The revision of the bytes a Doc read (readDocSourceSnapshot) parsed. */
export function docSnapshotRevision(snapshot: {
  result: { storedAs: "md" | "json" | null }
  revision?: { sha256: string }
}): string | undefined {
  const storedAs = snapshot.result.storedAs
  return snapshot.revision && storedAs
    ? docContentRevision({ storedAs, sha256: snapshot.revision.sha256 })
    : undefined
}

/** The storage kind of a Doc source file, from its extension. */
export function docStoredAs(path: string): "md" | "json" | null {
  const extension = extname(path)
  return extension === ".md" ? "md" : extension === ".json" ? "json" : null
}

// ── Hashes kept by fingerprint ───────────────────────────────

/** The largest Doc source served as content, so the largest one hashed. */
export const DOC_CONTENT_MAX_BYTES = 64 * 1024 * 1024

const SOURCE_DIGEST_LIMIT = 16_384
const sourceDigests = new FingerprintCache<string>(SOURCE_DIGEST_LIMIT)

/**
 * The sha256 of a file's bytes, or null when it is missing, unreadable or
 * larger than the content it could be served as. A revision is then left
 * out, and the document opens without one.
 */
async function sourceSha256(path: string): Promise<string | null> {
  try {
    // Fingerprint first: a change during the read leaves the key stale.
    const info = await stat(path, { bigint: true })
    if (!info.isFile() || info.size > BigInt(DOC_CONTENT_MAX_BYTES)) {
      return null
    }
    const fingerprint = fingerprintOf(info)
    if (!fingerprint.racy) {
      const known = sourceDigests.get(path, fingerprint.key)
      if (known !== undefined) return known
    }
    const sha256 = sha256Hex(await readFile(path))
    if (!fingerprint.racy) sourceDigests.set(path, fingerprint.key, sha256)
    return sha256
  } catch {
    return null
  }
}

/** The revision of the Doc source file at `path`, or null without one. */
async function docSourceRevision(path: string): Promise<string | null> {
  const storedAs = docStoredAs(path)
  if (!storedAs) return null
  const sha256 = await sourceSha256(path)
  return sha256 === null ? null : docContentRevision({ storedAs, sha256 })
}

/** The current revision of a Doc by path, as GET …/docs/<path> reads it. */
export async function currentDocContentRevision(
  spaceId: string,
  docPath: string
): Promise<string | undefined> {
  return (await docSourceRevision(getDocPath(spaceId, docPath))) ?? undefined
}

/** The current revision of the Doc whose source a catalog handle names. */
export async function docSourceContentRevision(
  spaceId: string,
  source: DocumentSource
): Promise<string | undefined> {
  if (source.kind !== "file") return undefined
  return (
    (await docSourceRevision(
      resolve(getWorkspaceRoot(), "spaces", spaceId, source.relativePath)
    )) ?? undefined
  )
}

// A legacy HTML bundle's frame depends on widget.yaml (its permissions) and
// index.html. Keep each bundle's revision with both fingerprints.
const LEGACY_HTML_LIMIT = 4_096
const legacyHtmlRevisions = new FingerprintCache<string>(LEGACY_HTML_LIMIT)

async function legacyHtmlRevision(
  spaceId: string,
  widgetId: string
): Promise<string | null> {
  const yamlPath = getWidgetPath(spaceId, widgetId)
  const [settings, source] = await Promise.all([
    stat(yamlPath, { bigint: true }),
    stat(getWidgetContentPath(spaceId, widgetId), { bigint: true }),
  ])
  if (source.size > BigInt(DOC_CONTENT_MAX_BYTES)) return null
  const settingsKey = fingerprintOf(settings)
  const sourceKey = fingerprintOf(source)
  const key = `${settingsKey.key}|${sourceKey.key}|${previewFontVersion()}`
  const racy = settingsKey.racy || sourceKey.racy
  if (!racy) {
    const known = legacyHtmlRevisions.get(yamlPath, key)
    if (known !== undefined) return known
  }
  const { data } = await readWidgetDocument(spaceId, widgetId)
  if (!data) return null
  const revision = htmlContentRevisionOf(data)
  if (!racy) legacyHtmlRevisions.set(yamlPath, key, revision)
  return revision
}

// ── Revisions for rows ───────────────────────────────────────

const ROW_CONCURRENCY = 16

// The read model publishes the same catalog again while nothing it was built
// from changed, every source's fingerprint included, and builds a new one
// when anything did. A Space's revisions are therefore listed once per
// catalog, and again only when the fonts HTML frames carry change.
const listedRevisions = new WeakMap<
  DocumentCatalog,
  { fonts: string; htmlFiles: boolean; revisions: Promise<Map<string, string>> }
>()

/**
 * Content revisions of documents the app opens by revision (Markdown, rich
 * text and HTML Docs), by path, from the Space's catalog snapshot. Limited to
 * `paths` when given. A document missing from the result is opened without
 * one. Revisions in rows are hints: opening a document still checks it.
 */
export async function documentContentRevisions(
  spaceId: string,
  paths?: Iterable<string>
): Promise<Map<string, string>> {
  const wanted = paths ? new Set(paths) : undefined
  if (wanted?.size === 0) return new Map()
  let catalog: DocumentCatalog
  try {
    catalog = await readDocumentCatalogSnapshot(spaceId)
  } catch {
    return new Map()
  }
  const htmlFiles = await usesHtmlDocumentStorageV2()
  const fonts = previewFontVersion()
  const listed = listedRevisions.get(catalog)
  if (listed?.fonts === fonts && listed.htmlFiles === htmlFiles) {
    const all = await listed.revisions
    return wanted
      ? new Map(
          [...wanted].flatMap((path) => {
            const revision = all.get(path)
            return revision ? [[path, revision] as const] : []
          })
        )
      : all
  }
  // A few rows (Recent, search, pins) read only theirs; a whole list keeps
  // what it read for the next one.
  if (wanted) return catalogRevisions(spaceId, catalog, htmlFiles, wanted)
  const revisions = catalogRevisions(spaceId, catalog, htmlFiles)
  listedRevisions.set(catalog, { fonts, htmlFiles, revisions })
  return revisions
}

async function catalogRevisions(
  spaceId: string,
  catalog: DocumentCatalog,
  htmlFiles: boolean,
  wanted?: ReadonlySet<string>
): Promise<Map<string, string>> {
  const revisions = new Map<string, string>()
  const spaceRoot = resolve(getWorkspaceRoot(), "spaces", spaceId)
  const candidates: Array<{
    path: string
    view: "doc" | "html"
    source: DocumentSource
  }> = []
  let htmlInFiles = false
  for (const entry of catalog.entries) {
    if (entry.kind !== "document") continue
    const path = entry.descriptor.path
    if (wanted && !wanted.has(path)) continue
    const view = legacySpecializedDocumentView({
      path,
      format: entry.descriptor.format,
      source: entry.handle.source,
      health: entry.descriptor.health,
      allowHtmlFile: htmlFiles,
    })
    if (view === "html" && entry.handle.source.kind === "file") {
      htmlInFiles = true
      continue
    }
    if (view) candidates.push({ path, view, source: entry.handle.source })
  }
  await mapWithConcurrency(candidates, ROW_CONCURRENCY, async (candidate) => {
    try {
      const revision =
        candidate.view === "doc"
          ? await docSourceRevision(
              resolve(spaceRoot, candidate.source.relativePath)
            )
          : await legacyHtmlRevision(spaceId, candidate.path)
      if (revision) revisions.set(candidate.path, revision)
    } catch {
      // A source that cannot be read opens without a revision.
    }
  })
  if (htmlInFiles) {
    try {
      const inputs = await htmlDocumentFrameInputsStorageV2({
        spaceId,
        catalog: async () => catalog,
        ...(wanted ? { paths: wanted } : {}),
      })
      for (const [path, input] of inputs) {
        revisions.set(path, htmlContentRevision(input))
      }
    } catch {
      // Listed without revisions, as above.
    }
  }
  return revisions
}

/**
 * Add each row's content revision, grouped by Space. Rows are copied; the
 * objects other callers (agent tools among them) receive stay as they were.
 */
export async function withContentRevisions<T>(
  rows: readonly T[],
  locate: (row: T) => { spaceId: string; path: string } | null,
  attach: (row: T, revision: string) => T
): Promise<T[]> {
  const bySpace = new Map<string, Set<string>>()
  for (const row of rows) {
    const location = locate(row)
    if (!location) continue
    const paths = bySpace.get(location.spaceId) ?? new Set<string>()
    paths.add(location.path)
    bySpace.set(location.spaceId, paths)
  }
  const revisions = new Map<string, Map<string, string>>()
  await Promise.all(
    [...bySpace].map(async ([spaceId, paths]) => {
      revisions.set(spaceId, await documentContentRevisions(spaceId, paths))
    })
  )
  return rows.map((row) => {
    const location = locate(row)
    const revision = location
      ? revisions.get(location.spaceId)?.get(location.path)
      : undefined
    return revision ? attach(row, revision) : row
  })
}
