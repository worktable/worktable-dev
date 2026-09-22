import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { lstat, mkdir } from "node:fs/promises"
import {
  CanonicalIdSchema,
  DocumentGenerationIdSchema,
  DocumentIdSchema,
  DocumentStorageSha256Schema,
} from "@worktable/types"
import { readBoundedRegularFile } from "./bounded-file.ts"

export const WORKSPACE_STORAGE_VERSION_V1 = 1 as const
export const WORKSPACE_STORAGE_VERSION_V2 = 2 as const
export const WORKSPACE_MANIFEST_MAX_BYTES = 1024 * 1024

import {
  workspaceStorageLayoutFromManifest,
  type WorkspaceStorageLayout,
} from "@worktable/types"
export {
  workspaceStorageLayoutFromManifest,
  type WorkspaceStorageLayout,
  type WorkspaceManifestV2,
} from "@worktable/types"

export class WorkspaceStorageVersionError extends Error {
  readonly layout: WorkspaceStorageLayout

  constructor(layout: WorkspaceStorageLayout) {
    const detail =
      layout.kind === "unsupported"
        ? `unsupported workspace storage version: ${String(layout.version)}`
        : layout.kind === "invalid"
          ? `invalid workspace manifest: ${layout.reason}`
          : `workspace storage version ${layout.version} is not admitted`
    super(detail)
    this.name = "WorkspaceStorageVersionError"
    this.layout = layout
  }
}

export async function readWorkspaceStorageLayoutAt(
  workspaceRoot: string
): Promise<WorkspaceStorageLayout> {
  const raw = await readBoundedRegularFile(
    join(workspaceRoot, "worktable.workspace.json"),
    WORKSPACE_MANIFEST_MAX_BYTES
  )
  try {
    return workspaceStorageLayoutFromManifest(JSON.parse(raw))
  } catch {
    return { kind: "invalid", reason: "manifest is not valid JSON" }
  }
}

export async function requireWorkspaceStorageVersionAt(
  workspaceRoot: string,
  admitted: readonly (1 | 2)[]
): Promise<Extract<WorkspaceStorageLayout, { kind: "v1" | "v2" }>> {
  const layout = await readWorkspaceStorageLayoutAt(workspaceRoot)
  if (
    (layout.kind === "v1" || layout.kind === "v2") &&
    admitted.includes(layout.version)
  ) {
    return layout
  }
  throw new WorkspaceStorageVersionError(layout)
}

function validatedSpaceId(spaceId: string): string {
  return CanonicalIdSchema.parse(spaceId)
}

function validatedDocumentId(documentId: string): string {
  return DocumentIdSchema.parse(documentId)
}

function validatedGenerationId(generationId: string): string {
  return DocumentGenerationIdSchema.parse(generationId)
}

function validatedRetirementId(retirementId: string): string {
  if (!/^dsv2_[A-Za-z0-9_-]{22}$/.test(retirementId)) {
    throw new Error("invalid document history retirement id")
  }
  return retirementId
}

function contained(root: string, path: string): string {
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(path)
  const rel = relative(absoluteRoot, absolutePath)
  if (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  ) {
    return absolutePath
  }
  throw new Error("document storage path escapes its workspace root")
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

/** Require every directory component to be real and contained. */
export async function requireRealDocumentStorageDirectory(
  workspaceRoot: string,
  directory: string
): Promise<string> {
  const root = resolve(workspaceRoot)
  const target = contained(root, directory)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("workspace storage root must be a real directory")
  }
  const rel = relative(root, target)
  let current = root
  for (const segment of rel ? rel.split(sep) : []) {
    current = join(current, segment)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(
        `document storage path is not a real directory: ${current}`
      )
    }
  }
  return target
}

/** Create absent components one at a time without accepting symlink parents. */
export async function ensureRealDocumentStorageDirectory(
  workspaceRoot: string,
  directory: string
): Promise<string> {
  const root = resolve(workspaceRoot)
  const target = contained(root, directory)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("workspace storage root must be a real directory")
  }
  const rel = relative(root, target)
  let current = root
  for (const segment of rel ? rel.split(sep) : []) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(
          `document storage path is not a real directory: ${current}`
        )
      }
    } catch (error) {
      if (!missing(error)) throw error
      try {
        await mkdir(current)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError
        }
      }
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(
          `document storage path is not a real directory: ${current}`
        )
      }
    }
  }
  return target
}

export function documentDataV2RootDirectory(
  workspaceRoot: string,
  spaceId: string
): string {
  return contained(
    workspaceRoot,
    join(workspaceRoot, "spaces", validatedSpaceId(spaceId), "document-data")
  )
}

export function documentDataV2Directory(
  workspaceRoot: string,
  spaceId: string,
  documentId: string
): string {
  return join(
    documentDataV2RootDirectory(workspaceRoot, spaceId),
    validatedDocumentId(documentId)
  )
}

export function documentAnnotationsV2Path(
  workspaceRoot: string,
  spaceId: string,
  documentId: string
): string {
  return join(
    documentDataV2Directory(workspaceRoot, spaceId, documentId),
    "annotations.json"
  )
}

export function documentPortableStateV2Directory(
  workspaceRoot: string,
  spaceId: string,
  documentId: string
): string {
  return join(
    documentDataV2Directory(workspaceRoot, spaceId, documentId),
    "state"
  )
}

export function documentPortableStateV2CurrentPath(
  workspaceRoot: string,
  spaceId: string,
  documentId: string
): string {
  return join(
    documentPortableStateV2Directory(workspaceRoot, spaceId, documentId),
    "current.json"
  )
}

export function documentPortableStateV2RevisionDirectory(
  workspaceRoot: string,
  spaceId: string,
  documentId: string,
  revision: string
): string {
  return join(
    documentPortableStateV2Directory(workspaceRoot, spaceId, documentId),
    "revisions",
    DocumentStorageSha256Schema.parse(revision)
  )
}

export function documentVersionsV2Directory(
  workspaceRoot: string,
  spaceId: string,
  documentId: string
): string {
  return contained(
    workspaceRoot,
    join(
      workspaceRoot,
      "versions",
      validatedSpaceId(spaceId),
      "documents",
      validatedDocumentId(documentId)
    )
  )
}

export function documentGenerationV2Directory(
  workspaceRoot: string,
  spaceId: string,
  documentId: string,
  generationId: string
): string {
  return join(
    documentVersionsV2Directory(workspaceRoot, spaceId, documentId),
    validatedGenerationId(generationId)
  )
}

/** Hidden, non-active history retained after a durable document is deleted. */
export function documentRetiredVersionsV2Directory(
  workspaceRoot: string,
  spaceId: string,
  documentId: string,
  retirementId: string
): string {
  return contained(
    workspaceRoot,
    join(
      workspaceRoot,
      "versions",
      validatedSpaceId(spaceId),
      ".retired",
      "documents",
      validatedDocumentId(documentId),
      validatedRetirementId(retirementId)
    )
  )
}
