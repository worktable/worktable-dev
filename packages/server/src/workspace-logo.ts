import { createHash } from "node:crypto"
import { copyFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  IDENTITY_IMAGE_TYPES,
  isIconName,
  LISTED_LOGO_MAX_CHARS,
  recognitionColor,
  type IdentityImageType,
  type ListedWorktableLogo,
  type RecognitionColor,
} from "@worktable/types"
import {
  IDENTITY_IMAGE_EXTENSIONS,
  type IdentityImage,
} from "./identity-images.ts"
import { atomicWriteBytes } from "./atomic-file.ts"
import type { WorkspaceManifest } from "./workspace.ts"

/** The logo image's file in a Worktable folder, beside its manifest. */
export function workspaceLogoFileName(type: IdentityImageType): string {
  return `worktable-logo.${IDENTITY_IMAGE_EXTENSIONS[type]}`
}

/**
 * Put a new logo image in place, then record it with `commit`. Until the
 * record is written the previous logo stays whole: if it fails, the file it
 * replaced comes back, and logos of other types are removed only after.
 */
export async function replaceWorkspaceLogo(
  root: string,
  image: IdentityImage,
  commit: () => void | Promise<void>
): Promise<void> {
  const path = join(root, workspaceLogoFileName(image.type))
  const previous = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  await atomicWriteBytes(path, image.bytes)
  try {
    await commit()
  } catch (error) {
    if (previous) await atomicWriteBytes(path, new Uint8Array(previous))
    else await rm(path, { force: true })
    throw error
  }
  await removeWorkspaceLogoFiles(root, image.type)
}

/** Remove logo images other than `keep`, such as after a type change. */
export async function removeWorkspaceLogoFiles(
  root: string,
  keep?: IdentityImageType
): Promise<void> {
  for (const type of IDENTITY_IMAGE_TYPES) {
    if (type !== keep) await rm(join(root, workspaceLogoFileName(type)), { force: true })
  }
}

/** The saved logo image when `hash` names the current one. */
export async function readWorkspaceLogoFile(
  root: string,
  manifest: WorkspaceManifest,
  hash: string
): Promise<{ bytes: Uint8Array; type: IdentityImageType } | null> {
  const logo = manifest.logo
  if (logo?.kind !== "image" || logo.hash !== hash) return null
  if (!IDENTITY_IMAGE_TYPES.includes(logo.type)) return null
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(join(root, workspaceLogoFileName(logo.type))))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  // Browsers keep a logo by its address, so only the bytes that address
  // names may answer it, never a file that changed under the manifest.
  const actual = createHash("sha256").update(bytes).digest("hex").slice(0, 32)
  return actual === hash ? { bytes, type: logo.type } : null
}

/**
 * Give a replacement tree the logo its manifest keeps: the live Worktable's,
 * when replacing content keeps the live identity, such as clearing it or
 * importing a package into it.
 */
export async function carryWorkspaceLogo(
  liveRoot: string,
  stagingRoot: string,
  manifest: WorkspaceManifest
): Promise<void> {
  await removeWorkspaceLogoFiles(stagingRoot)
  const logo = manifest.logo
  if (logo?.kind !== "image" || !IDENTITY_IMAGE_TYPES.includes(logo.type)) return
  const name = workspaceLogoFileName(logo.type)
  await copyFile(join(liveRoot, name), join(stagingRoot, name)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    }
  )
}

/** A Worktable's color and logo as a list of other Worktables shows them. */
export interface ListedWorkspaceMark {
  color: RecognitionColor
  logo?: ListedWorktableLogo
}

/** What `listedWorkspaceMark` reports, without reading the image. */
export function listedWorkspaceMarkKey(manifest: WorkspaceManifest): string {
  const logo = manifest.logo
  return JSON.stringify([
    recognitionColor(manifest.color, manifest.id),
    logo?.kind === "icon" ? `icon:${logo.icon}` : logo ? `image:${logo.hash}` : null,
  ])
}

/**
 * The color the Worktable shows, and its logo: an icon, or the image inlined
 * when it is small enough for a list. A larger image lists as the color alone.
 */
export async function listedWorkspaceMark(
  root: string,
  manifest: WorkspaceManifest
): Promise<ListedWorkspaceMark> {
  const color = recognitionColor(manifest.color, manifest.id)
  const logo = manifest.logo
  if (logo?.kind === "icon")
    return isIconName(logo.icon) ? { color, logo: { kind: "icon", icon: logo.icon } } : { color }
  if (logo?.kind !== "image") return { color }
  const file = await readWorkspaceLogoFile(root, manifest, logo.hash)
  if (!file) return { color }
  const data = `data:${file.type};base64,${Buffer.from(file.bytes).toString("base64")}`
  return data.length <= LISTED_LOGO_MAX_CHARS
    ? { color, logo: { kind: "image", data } }
    : { color }
}
