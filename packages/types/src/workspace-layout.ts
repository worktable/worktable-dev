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
