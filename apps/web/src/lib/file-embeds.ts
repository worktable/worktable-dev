// A Doc's embedded files: where they load from, and where pasted ones go.
//
// Embeds are plain relative paths in the Doc, like `signup-flow/error.png`,
// resolved from the Doc's folder as links are. Files pasted or dropped into
// a Doc go in the Doc's own folder (`onboarding/signup-flow.md` owns
// `onboarding/signup-flow/`), and the Doc stores the path relative to it.

import {
  FILE_TYPES,
  pastedFileType,
  resolveDocLink,
  versionIdTimestamp,
} from "@worktable/types"
import { authenticatedFetch, BASE_URL, HttpError } from "./http"

/**
 * A file's bytes in a Space. Naming its version, its content hash or the
 * stamp a Doc's page gives, lets the browser keep that content for good;
 * `download` asks for a download, even of an image.
 */
export function fileSourceUrl(
  spaceId: string,
  path: string,
  version: string | null = null,
  options: { download?: boolean; at?: string } = {}
): string {
  return `${BASE_URL}/api/spaces/${encodeURIComponent(spaceId)}/documents/file?path=${encodeURIComponent(path)}${version ? `&v=${encodeURIComponent(version)}` : ""}${options.download ? "&download=1" : ""}${options.at ? `&at=${encodeURIComponent(options.at)}` : ""}`
}

/** A Space's file, as a URL from fileSourceUrl names it. */
export interface SourceFile {
  spaceId: string
  path: string
  version: string | null
  at?: string
}

/**
 * The Space file a fileSourceUrl URL loads, or null for any other URL, such
 * as an image a Doc embeds from the web.
 */
export function sourceFileOf(url: string): SourceFile | null {
  const page = globalThis.location?.href ?? "http://localhost/"
  let source: URL
  let spaces: URL
  try {
    source = new URL(url, page)
    spaces = new URL(`${BASE_URL}/api/spaces/`, page)
  } catch {
    return null
  }
  if (
    source.origin !== spaces.origin ||
    !source.pathname.startsWith(spaces.pathname)
  )
    return null
  const spaceId = /^([^/]+)\/documents\/file$/.exec(
    source.pathname.slice(spaces.pathname.length)
  )?.[1]
  const path = source.searchParams.get("path")
  if (!spaceId || !path) return null
  const at = source.searchParams.get("at")
  return {
    spaceId: decodeURIComponent(spaceId),
    path,
    version: source.searchParams.get("v"),
    ...(at ? { at } : {}),
  }
}

/**
 * Upload New Version: the file's new bytes, keeping the old in its history.
 * `basedOn` is the version the page loaded, or a revision a replace gave;
 * once the file changed since, this throws a FileChangedError and nothing
 * is replaced. "current" is Replace Anyway: it replaces whatever is current.
 */
export async function replaceFile(
  spaceId: string,
  path: string,
  file: File,
  basedOn: string
): Promise<{ contentHash: string; sourceRevision: string }> {
  const response = await authenticatedFetch(
    `${BASE_URL}/api/spaces/${encodeURIComponent(spaceId)}/documents/file?path=${encodeURIComponent(path)}${basedOn === "current" ? "&replace=current" : ""}`,
    {
      method: "PUT",
      body: file,
      ...(basedOn === "current" ? {} : { headers: { "If-Match": `"${basedOn}"` } }),
    }
  )
  const body = (await response.json().catch(() => null)) as {
    contentHash?: string
    sourceRevision?: string
    code?: string
    error?: string
  } | null
  if (response.status === 409 && body?.code === "REVISION_CHANGED") {
    throw new FileChangedError()
  }
  if (
    !response.ok ||
    typeof body?.contentHash !== "string" ||
    typeof body.sourceRevision !== "string"
  ) {
    throw new HttpError(
      response.status,
      body,
      body?.error ?? "The file could not be replaced"
    )
  }
  return { contentHash: body.contentHash, sourceRevision: body.sourceRevision }
}

/** The file changed after the version a replace was based on. */
export class FileChangedError extends Error {
  constructor() {
    super("The file changed since it was opened")
    this.name = "FileChangedError"
  }
}

/**
 * The URL an embed loads from: a file in the Doc's Space, or the target
 * itself. With the file's version from the Doc's page, the browser keeps
 * the file and shows it again without asking. `at` asks for the file as it
 * was then, for an old version.
 */
export function embedSourceUrl(
  spaceId: string,
  docPath: string,
  target: string,
  files: {
    versions?: Readonly<Record<string, string>> | undefined
    at?: string | undefined
  } = {}
): string {
  const path = resolveDocLink(docPath, target)
  return path === null
    ? target
    : files.at
      ? fileSourceUrl(spaceId, path, null, { at: files.at })
      : fileSourceUrl(spaceId, path, files.versions?.[path] ?? null)
}

/**
 * When an old version's content was saved, to show its files as they were
 * then. A version that merged rapid saves keeps the first one's createdAt;
 * its id names the last.
 */
export function versionFilesAt(version: { id: string; createdAt: string }): string {
  const savedAt = versionIdTimestamp(version.id)
  return savedAt === null ? version.createdAt : new Date(savedAt).toISOString()
}

// The sizes of images shown this session, by URL. A page shown again gives
// each image its space before it loads, so nothing below it jumps.
const imageSizes = new Map<string, { width: number; height: number }>()
const IMAGE_SIZES_MAX = 500

/** An image's size when it was shown before, for its width and height. */
export function knownImageSize(
  url: string
): { width: number; height: number } | undefined {
  return imageSizes.get(url)
}

/** Remember a loaded image's size, under the URL it loaded from. */
export function rememberImageSize(url: string, image: HTMLImageElement): void {
  if (image.naturalWidth === 0 || imageSizes.has(url)) return
  if (imageSizes.size >= IMAGE_SIZES_MAX) {
    const oldest = imageSizes.keys().next().value
    if (oldest !== undefined) imageSizes.delete(oldest)
  }
  imageSizes.set(url, { width: image.naturalWidth, height: image.naturalHeight })
}

/** A path as a link holds it: characters a URL reads as syntax are encoded. */
function linkPath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      segment.replace(/[ #?%()<>"']/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join("/")
}

function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * The name a pasted or dropped file is saved under: its own name as a slug,
 * or, for a clipboard image with a generic name, one that says when.
 */
export function embeddedFileName(file: File, now = new Date()): string {
  // Some runtimes leave an empty name undefined.
  const fileName = file.name ?? ""
  const dot = fileName.lastIndexOf(".")
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  // A pasted image is named for its type in the file type table; one the
  // table doesn't list keeps its media subtype.
  const pasted = pastedFileType(file.type)
  const fromType = pasted
    ? (FILE_TYPES[pasted].extensions[0] ?? "")
    : file.type.startsWith("image/")
      ? file.type.slice("image/".length).replace("jpeg", "jpg").replace("svg+xml", "svg")
      : ""
  const extension = (dot > 0 ? fileName.slice(dot + 1) : fromType)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  const named = slug(base)
  const generic = !named || /^(image|blob|untitled|clipboard)$/.test(named)
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`
  const name = generic ? `pasted-image-${stamp}` : named
  return extension ? `${name}.${extension}` : name
}

/**
 * Save a file into a folder of a Space (its top level when folder is empty),
 * keeping any file already there under a numbered name. Returns its path.
 */
export async function uploadFileToFolder(
  spaceId: string,
  folder: string,
  file: File
): Promise<string> {
  const target = folder
    ? `${folder}/${embeddedFileName(file)}`
    : embeddedFileName(file)
  const response = await authenticatedFetch(
    `${BASE_URL}/api/spaces/${encodeURIComponent(spaceId)}/documents/file?path=${encodeURIComponent(target)}&keepBoth=1`,
    { method: "PUT", body: file }
  )
  const body = (await response.json().catch(() => null)) as {
    path?: string
    error?: string
  } | null
  if (!response.ok || typeof body?.path !== "string") {
    throw new HttpError(
      response.status,
      body,
      body?.error ?? "The file could not be saved"
    )
  }
  return body.path
}

/**
 * Save a file pasted or dropped into a Doc in the Doc's own folder, keeping
 * any file already there, and return the path the Doc should embed.
 */
export async function uploadEmbeddedFile(
  spaceId: string,
  docPath: string,
  file: File
): Promise<string> {
  const path = await uploadFileToFolder(spaceId, docPath, file)
  // Embeds are relative to the folder the Doc sits in.
  const folder = docPath.includes("/")
    ? docPath.slice(0, docPath.lastIndexOf("/") + 1)
    : ""
  return linkPath(
    path.startsWith(folder) ? path.slice(folder.length) : `/${path}`
  )
}
