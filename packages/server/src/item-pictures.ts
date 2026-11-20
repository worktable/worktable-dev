// ============================================================
// Pictures of items, for people
// ============================================================
//
// A small picture of an item in a Space, for a list or card that would
// otherwise show its icon: the first page of a PDF, an image scaled down,
// a drawing. Each picture is of one version of its item, so its address
// names that version and the browser keeps it for good; a new version is a
// new address. A version the item is no longer at has no picture.
//
// Pictures are drawn in the sandboxed preview browser (file-pictures.ts,
// drawing-native.ts) in its background lane: anyone waiting on a preview
// goes first, and pictures never take a place in its queue. One picture is
// drawn once however many ask for it at the same time. Nothing is kept on
// the server yet; the derived store will keep them once it exists.
//
// Docs and HTML Docs have no stored picture: a pinned HTML Doc shows itself
// live, and Docs keep their icon.

import { resolve } from "node:path"
import type { DocumentCatalogEntry } from "./document-catalog.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { inspectDocumentSource } from "./document-inventory.ts"
import { readDocumentIdentities } from "./document-query.ts"
import { resolveCurrentFile } from "./document-page-service.ts"
import { previewBrowserFailed } from "./document-preview-browser.ts"
import { renderDrawing } from "./drawing-render.ts"
import {
  FilePictureError,
  filePictureKind,
  renderFilePicture,
} from "./file-pictures.ts"
import {
  FILE_READ_CHUNK_BYTES,
  FileRevisionError,
  OpenFileRevision,
} from "./file-revision.ts"
import {
  QUICKDRAW_FORMAT,
  QUICKDRAW_MAX_BYTES,
  QuickdrawDocumentSchema,
} from "@worktable/types"
import { getWorkspaceRoot } from "./workspace.ts"

/** A picture's width: a pinned tile at twice its widest. */
export const ITEM_PICTURE_WIDTH = 480
/** How long a picture may take, waiting for its turn included. */
const PICTURE_DEADLINE_MS = 20_000

export interface ItemPicture {
  mimeType: string
  bytes: Uint8Array
}

/** Why there is no picture, and whether asking again could change that. */
export class ItemPictureError extends Error {
  /** "none": never at this version. "busy": not now; ask again later. */
  readonly kind: "none" | "busy"
  constructor(kind: "none" | "busy", message: string) {
    super(message)
    this.name = "ItemPictureError"
    this.kind = kind
  }
}

/** Whether a catalog entry is an item with a picture. */
function hasPicture(entry: DocumentCatalogEntry): boolean {
  if (entry.kind !== "document" || entry.handle.source.kind !== "file")
    return false
  const format = entry.descriptor.format.id
  if (format === QUICKDRAW_FORMAT) return true
  return (
    format === BUILTIN_DOCUMENT_FORMATS.file &&
    filePictureKind(entry.descriptor.path) !== "none"
  )
}

/**
 * The version each of these items' pictures is of, by path, for the items
 * that have one. Read from the Space's catalog snapshot: no file is read.
 * Empty where this host's preview browser can't start.
 */
export async function pictureVersions(
  spaceId: string,
  paths: Iterable<string>
): Promise<Map<string, string>> {
  const versions = new Map<string, string>()
  if (previewBrowserFailed()) return versions
  const wanted = new Set(paths)
  if (wanted.size === 0) return versions
  const { catalog } = await readDocumentIdentities(spaceId)
  for (const entry of catalog.entries) {
    if (entry.kind !== "document" || !wanted.has(entry.descriptor.path))
      continue
    if (hasPicture(entry) && entry.handle.sourceStamp)
      versions.set(entry.descriptor.path, entry.handle.sourceStamp)
  }
  return versions
}

// One drawing for everyone who asks for the same picture at once.
const inFlight = new Map<string, Promise<ItemPicture>>()

/**
 * The picture of an item at `version`. Throws ItemPictureError "none" when
 * it has no picture at that version, and "busy" when it can't be drawn now.
 */
export function itemPicture(input: {
  spaceId: string
  path: string
  version: string
  theme: "light" | "dark"
}): Promise<ItemPicture> {
  const key = [input.spaceId, input.path, input.version, input.theme].join("\0")
  const pending = inFlight.get(key)
  if (pending) return pending
  const drawing = drawItemPicture(input).finally(() => inFlight.delete(key))
  inFlight.set(key, drawing)
  return drawing
}

async function drawItemPicture(input: {
  spaceId: string
  path: string
  version: string
  theme: "light" | "dark"
}): Promise<ItemPicture> {
  // A browser that failed to start may start later: not now, not never.
  if (previewBrowserFailed())
    throw new ItemPictureError("busy", "The preview browser isn't running.")
  const deadline = new AbortController()
  // Held by a timer this call owns: Bun 1.3 can collect an unreferenced
  // AbortSignal.timeout before it fires.
  const timer = setTimeout(
    () =>
      deadline.abort(new DOMException("Picture timed out", "TimeoutError")),
    PICTURE_DEADLINE_MS
  )
  try {
    const { catalog } = await readDocumentIdentities(input.spaceId)
    const entry = catalog.entries.find(
      (candidate) =>
        candidate.kind === "document" &&
        candidate.descriptor.path === input.path
    )
    if (!entry || !hasPicture(entry))
      throw new ItemPictureError("none", "This item has no picture.")
    if (entry.kind !== "document") throw new Error("unreachable")
    return entry.descriptor.format.id === QUICKDRAW_FORMAT
      ? await drawingPicture(input, entry, deadline.signal)
      : await filePicture(input, deadline.signal)
  } catch (error) {
    if (error instanceof ItemPictureError) throw error
    // What a file is at this version decides these, so they hold for good;
    // a maker switched off may be switched back on.
    if (error instanceof FilePictureError && error.code !== "off")
      throw new ItemPictureError("none", error.message)
    // Busy, timed out, cancelled, a browser that couldn't start, a maker
    // switched off, or changed while it was read: not now.
    throw new ItemPictureError(
      "busy",
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    clearTimeout(timer)
  }
}

/** A plain file's picture, read at `version` a piece at a time. */
async function filePicture(
  input: { spaceId: string; path: string; version: string },
  signal: AbortSignal
): Promise<ItemPicture> {
  const result = await resolveCurrentFile({
    spaceId: input.spaceId,
    path: input.path,
    revision: input.version,
  })
  if (result.kind === "changed" || result.kind === "not-found")
    throw new ItemPictureError("none", "The file is not at this version.")
  if (result.kind !== "file")
    throw new ItemPictureError("busy", "The file can't be read now.")
  const { current } = result
  const opened = await OpenFileRevision.open(
    current.pinned.path,
    current.pinned.revision
  )
  try {
    const picture = await renderFilePicture(
      {
        name: current.path,
        size: opened.size,
        read: (position, length) => opened.read(position, length),
      },
      {
        width: ITEM_PICTURE_WIDTH,
        format: "webp",
        background: true,
        signal,
      }
    )
    return { mimeType: picture.mimeType, bytes: picture.bytes }
  } finally {
    await opened.close()
  }
}

/**
 * A drawing's picture in `theme`, from the source the Space's snapshot
 * names, read at `version` a piece at a time: no catalog is built for it.
 */
async function drawingPicture(
  input: {
    spaceId: string
    path: string
    version: string
    theme: "light" | "dark"
  },
  entry: Extract<DocumentCatalogEntry, { kind: "document" }>,
  signal: AbortSignal
): Promise<ItemPicture> {
  // Checked as the file route checks a file: no link on the way to it.
  const inspected = await inspectDocumentSource(
    resolve(getWorkspaceRoot(), "spaces", input.spaceId),
    entry.handle.source
  )
  if (!inspected.safe)
    throw new ItemPictureError("none", "The drawing can't be read safely.")
  let opened: OpenFileRevision
  try {
    opened = await OpenFileRevision.open(inspected.absolutePath, input.version)
  } catch (error) {
    if (error instanceof FileRevisionError && error.reason === "changed")
      throw new ItemPictureError("none", "The drawing is not at this version.")
    throw error
  }
  let bytes: Uint8Array
  try {
    if (opened.size > QUICKDRAW_MAX_BYTES)
      throw new ItemPictureError("none", "The drawing is too large to draw.")
    bytes = new Uint8Array(opened.size)
    for (let position = 0; position < opened.size; ) {
      const chunk = await opened.read(
        position,
        Math.min(FILE_READ_CHUNK_BYTES, opened.size - position)
      )
      bytes.set(chunk, position)
      position += chunk.byteLength
    }
  } finally {
    await opened.close()
  }
  let drawing
  try {
    drawing = QuickdrawDocumentSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes))
    )
  } catch {
    throw new ItemPictureError("none", "The drawing can't be read.")
  }
  const rendered = await renderDrawing(drawing, {
    format: "png",
    theme: input.theme,
    width: ITEM_PICTURE_WIDTH,
    signal,
    lowPriority: true,
  })
  return {
    mimeType: rendered.mimeType,
    bytes: new Uint8Array(Buffer.from(rendered.data, "base64")),
  }
}
