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

export interface WorkspaceManifestV2 {
  type: "worktable.workspace"
  version: 2
  id: string
  name: string
  createdAt: string
  cloud: { status: "unlinked" }
  [key: string]: unknown
}

export type WorkspaceStorageLayout =
  | { kind: "v1"; version: 1; manifest: Record<string, unknown> }
  | { kind: "v2"; version: 2; manifest: WorkspaceManifestV2 }
  | { kind: "unsupported"; version: unknown }
  | { kind: "invalid"; version?: unknown; reason: string }

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

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function validOnboarding(value: unknown): boolean {
  if (value === undefined) return true
  if (!object(value) || value["version"] !== 1) return false
  if (value["status"] !== "pending" && value["status"] !== "complete") {
    return false
  }
  return (
    value["completedAt"] === undefined ||
    typeof value["completedAt"] === "string"
  )
}

function validManifestHeader(value: unknown, version: 1 | 2): boolean {
  if (!object(value) || !object(value["cloud"])) return false
  return (
    value["type"] === "worktable.workspace" &&
    value["version"] === version &&
    typeof value["id"] === "string" &&
    typeof value["name"] === "string" &&
    typeof value["createdAt"] === "string" &&
    value["cloud"]["status"] === "unlinked" &&
    validOnboarding(value["onboarding"])
  )
}

function v1Manifest(value: unknown): value is Record<string, unknown> {
  // Match the released V1 opener exactly. Stricter V2 requirements must not
  // retroactively reject a workspace that an existing build already admits.
  return validManifestHeader(value, 1)
}

function v2Manifest(value: unknown): value is WorkspaceManifestV2 {
  return (
    validManifestHeader(value, 2) &&
    object(value) &&
    (value["id"] as string).length > 0 &&
    (value["name"] as string).length > 0 &&
    !Number.isNaN(Date.parse(value["createdAt"] as string))
  )
}

/**
 * The storage-version switch is deliberately independent from the active V1
 * workspace opener. PR 4 can admit V2 only after constructing and verifying a
 * complete sibling workspace; older builds continue to reject version 2.
 */
export function workspaceStorageLayoutFromManifest(
  value: unknown
): WorkspaceStorageLayout {
  if (!object(value) || value["type"] !== "worktable.workspace") {
    return { kind: "invalid", reason: "missing workspace manifest header" }
  }
  if (value["version"] === 1) {
    return v1Manifest(value)
      ? { kind: "v1", version: 1, manifest: value }
      : { kind: "invalid", version: 1, reason: "malformed V1 manifest" }
  }
  if (value["version"] === 2) {
    return v2Manifest(value)
      ? { kind: "v2", version: 2, manifest: value }
      : { kind: "invalid", version: 2, reason: "malformed V2 manifest" }
  }
  return { kind: "unsupported", version: value["version"] }
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
    join(
      workspaceRoot,
      "spaces",
      validatedSpaceId(spaceId),
      "document-data"
    )
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
