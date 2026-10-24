// A Doc's embedded files: where they load from, and where pasted ones go.
//
// Embeds are plain relative paths in the Doc, like `signup-flow/error.png`,
// resolved from the Doc's folder as links are. Files pasted or dropped into
// a Doc go in the Doc's own folder (`onboarding/signup-flow.md` owns
// `onboarding/signup-flow/`), and the Doc stores the path relative to it.

import { resolveDocLink } from "@worktable/types"
import { authenticatedFetch, BASE_URL, HttpError } from "./http"

/**
 * The URL an embed loads from: a file in the Doc's Space, or the target
 * itself. With the file's version from the Doc's page, the browser keeps
 * the file and shows it again without asking.
 */
export function embedSourceUrl(
  spaceId: string,
  docPath: string,
  target: string,
  versions?: Readonly<Record<string, string>>
): string {
  const path = resolveDocLink(docPath, target)
  if (path === null) return target
  const version = versions?.[path]
  return `${BASE_URL}/api/spaces/${encodeURIComponent(spaceId)}/documents/file?path=${encodeURIComponent(path)}${version ? `&v=${encodeURIComponent(version)}` : ""}`
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
  const fromType = file.type.startsWith("image/")
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
 * Save a file pasted or dropped into a Doc in the Doc's own folder, keeping
 * any file already there, and return the path the Doc should embed.
 */
export async function uploadEmbeddedFile(
  spaceId: string,
  docPath: string,
  file: File
): Promise<string> {
  const target = `${docPath}/${embeddedFileName(file)}`
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
  // Embeds are relative to the folder the Doc sits in.
  const folder = docPath.includes("/")
    ? docPath.slice(0, docPath.lastIndexOf("/") + 1)
    : ""
  return linkPath(
    body.path.startsWith(folder) ? body.path.slice(folder.length) : `/${body.path}`
  )
}
