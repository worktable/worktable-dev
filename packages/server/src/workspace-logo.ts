import { createHash } from "node:crypto"
import { copyFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { IDENTITY_IMAGE_TYPES, type IdentityImageType } from "@worktable/types"
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

/** Write a logo image, replacing the previous one atomically. */
export async function writeWorkspaceLogoFile(
  root: string,
  image: IdentityImage
): Promise<void> {
  await atomicWriteBytes(join(root, workspaceLogoFileName(image.type)), image.bytes)
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
