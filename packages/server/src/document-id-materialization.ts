import { createHash } from "node:crypto"
import { lstat, opendir, realpath, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { DocumentId } from "@worktable/types"
import { readBoundedRegularFile } from "./bounded-file.ts"
import {
  mintDocumentId,
  readDocumentInventoryAt,
  updateDocumentInventoryAt,
  validateDocumentInventoryMutationAt,
} from "./document-inventory.ts"
import {
  preflightDocumentWorkspace,
  type DocumentPreflightReport,
  type PreflightDocumentSource,
} from "./document-preflight.ts"
import { calculateLocalWorkspaceContentCheckpoints } from "./workspace-transfer-v2.ts"
import { isWorkspaceManifest } from "./workspace.ts"

const MATERIALIZATION_CENSUS_MAX_ENTRIES = 250_000
const MATERIALIZATION_WORKSPACE_MANIFEST_MAX_BYTES = 1024 * 1024

interface DirectoryIdentity {
  dev: number
  ino: number
}

let beforeMaterializationApplyHookForTests:
  | (() => void | Promise<void>)
  | null = null

export function setBeforeDocumentIdMaterializationApplyHookForTests(
  hook: (() => void | Promise<void>) | null
): void {
  beforeMaterializationApplyHookForTests = hook
}

export type DocumentIdentityDependencyKind =
  | "annotations"
  | "doc-metadata"
  | "history"
  | "runtime-state"
  | "record-document-reference"
  | "html-state"
  | "html-metadata"
  | "html-companion"
  | "shares"
  | "aliases"
  | "ordering"
  | "empty-folder"
  | "raw-html"

export interface DocumentIdentityDependency {
  kind: DocumentIdentityDependencyKind
  location: "workspace" | "app"
  path: string
  entry: "file" | "directory"
  bytes?: number
}

export interface DocumentIdentityCensusDiagnostic {
  severity: "error"
  path: string
  message: string
}

export interface DocumentIdentityCensus {
  type: "worktable.document-identity-census"
  version: 1
  clean: boolean
  appDataInspection: "not-requested" | "complete"
  checkpoint: string
  dependencies: DocumentIdentityDependency[]
  diagnostics: DocumentIdentityCensusDiagnostic[]
}

export interface DocumentIdMaterializationPlan {
  type: "worktable.document-id-materialization-plan"
  version: 1
  workspaceRoot: string
  workspaceId: string
  workspaceContentCheckpoint: string
  materializationBaseCheckpoint: string
  sourceCheckpoint: string
  documentCount: number
  durableCount: number
  materializeCount: number
  preflight: DocumentPreflightReport
  census: DocumentIdentityCensus
  diagnostics: DocumentIdentityCensusDiagnostic[]
  clean: boolean
}

export interface DocumentIdMaterializationResult {
  workspaceId: string
  beforeWorkspaceContentCheckpoint: string
  afterWorkspaceContentCheckpoint: string
  sourceCheckpoint: string
  documentCount: number
  durableCount: number
  materializedCount: number
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/")
}

function classifyWorkspaceDependency(
  path: string,
  entry: "file" | "directory",
  empty: boolean,
  coreWidgetFile: boolean
): DocumentIdentityDependencyKind[] {
  const kinds: DocumentIdentityDependencyKind[] = []
  if (/^spaces\/[^/]+\/annotations\//u.test(path)) kinds.push("annotations")
  if (/^spaces\/[^/]+\/docs\.meta\.json$/u.test(path)) {
    kinds.push("doc-metadata")
  }
  if (/^spaces\/[^/]+\/widgets\.meta\.json$/u.test(path)) {
    kinds.push("html-metadata")
  }
  if (
    entry === "file" &&
    /^spaces\/[^/]+\/records\/[^/]+\/[^/]+\.yaml$/u.test(path)
  ) {
    // A collection schema determines whether row values are portable document
    // paths. Keep both schema and rows without parsing hand-editable or
    // future-version record files inside this census.
    kinds.push("record-document-reference")
  }
  if (path.startsWith("versions/")) kinds.push("history")
  if (/^spaces\/[^/]+\/doc-aliases\.json$/u.test(path)) kinds.push("aliases")
  if (/^spaces\/[^/]+\/space\.json$/u.test(path)) kinds.push("ordering")
  if (/^spaces\/[^/]+\/docs\/.+\.html$/iu.test(path)) kinds.push("raw-html")
  if (/^spaces\/[^/]+\/widgets\/.+\/state\.yaml$/u.test(path)) {
    kinds.push("html-state")
  } else if (
    entry === "file" &&
    /^spaces\/[^/]+\/widgets\//u.test(path) &&
    !coreWidgetFile
  ) {
    kinds.push("html-companion")
  }
  if (
    entry === "directory" &&
    empty &&
    (/^spaces\/[^/]+\/(?:docs|widgets|annotations)(?:\/|$)/u.test(path) ||
      path === "versions" ||
      path.startsWith("versions/"))
  ) {
    kinds.push("empty-folder")
  }
  return kinds
}

async function scanDependencyTree(input: {
  root: string
  location: "workspace" | "app"
  classify: (
    path: string,
    entry: "file" | "directory",
    empty: boolean,
    coreWidgetFile: boolean
  ) => DocumentIdentityDependencyKind[]
  dependencies: DocumentIdentityDependency[]
  diagnostics: DocumentIdentityCensusDiagnostic[]
  budget: { entries: number }
}): Promise<void> {
  const walk = async (
    directory: string,
    insideWidgetRoot = false
  ): Promise<void> => {
    const handle = await opendir(directory)
    const entries = []
    for await (const entry of handle) {
      input.budget.entries += 1
      if (input.budget.entries > MATERIALIZATION_CENSUS_MAX_ENTRIES) {
        throw new Error("document identity census exceeds its entry limit")
      }
      entries.push(entry)
    }
    entries.sort((left, right) => compareStrings(left.name, right.name))
    const path = portableRelative(input.root, directory)
    const currentIsWidgetRoot =
      !insideWidgetRoot &&
      /^spaces\/[^/]+\/widgets\/.+/u.test(path) &&
      entries.some((entry) => entry.name === "widget.yaml" && entry.isFile())
    for (const kind of input.classify(
      path,
      "directory",
      entries.length === 0,
      false
    )) {
      input.dependencies.push({
        kind,
        location: input.location,
        path: path || ".",
        entry: "directory",
      })
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const relativePath = portableRelative(input.root, absolutePath)
      if (entry.isSymbolicLink()) {
        input.diagnostics.push({
          severity: "error",
          path: relativePath,
          message: "document identity dependency cannot be a symbolic link",
        })
        continue
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, insideWidgetRoot || currentIsWidgetRoot)
        continue
      }
      if (!entry.isFile()) {
        input.diagnostics.push({
          severity: "error",
          path: relativePath,
          message: "document identity dependency must be a regular file",
        })
        continue
      }
      const info = await lstat(absolutePath)
      const coreWidgetFile =
        currentIsWidgetRoot &&
        (entry.name === "index.html" || entry.name === "widget.yaml")
      for (const kind of input.classify(
        relativePath,
        "file",
        false,
        coreWidgetFile
      )) {
        input.dependencies.push({
          kind,
          location: input.location,
          path: relativePath,
          entry: "file",
          bytes: info.size,
        })
      }
    }
  }

  try {
    const info = await lstat(input.root)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      input.diagnostics.push({
        severity: "error",
        path: ".",
        message: "document identity census root must be a real directory",
      })
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    input.diagnostics.push({
      severity: "error",
      path: ".",
      message: error instanceof Error ? error.message : String(error),
    })
    return
  }
  try {
    await walk(input.root)
  } catch (error) {
    input.diagnostics.push({
      severity: "error",
      path: ".",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Inventory every current path-keyed dependency that must survive stable-ID
 * materialization. This is intentionally a census, not a migration: the first
 * identity pass changes only documents.meta.json in a verified sibling copy.
 */
export async function censusDocumentIdentityDependencies(
  workspaceRootInput: string,
  options: { appDir?: string; runtimeCacheKey?: string } = {}
): Promise<DocumentIdentityCensus> {
  const workspaceRoot = resolve(workspaceRootInput)
  const dependencies: DocumentIdentityDependency[] = []
  const diagnostics: DocumentIdentityCensusDiagnostic[] = []
  const budget = { entries: 0 }
  await scanDependencyTree({
    root: workspaceRoot,
    location: "workspace",
    classify: classifyWorkspaceDependency,
    dependencies,
    diagnostics,
    budget,
  })

  if (options.appDir) {
    const appDir = resolve(options.appDir)
    if (!options.runtimeCacheKey) {
      throw new Error(
        "document identity census requires a runtime cache key with app data"
      )
    }
    if (!/^[a-f0-9]{16}$/u.test(options.runtimeCacheKey)) {
      throw new Error("document identity census runtime cache key is invalid")
    }
    const appInfo = await stat(appDir).catch((error) => {
      throw new Error(
        "document identity census app data root must be an existing directory",
        { cause: error }
      )
    })
    if (!appInfo.isDirectory()) {
      throw new Error(
        "document identity census app data root must be an existing directory"
      )
    }
    const runtimeCacheKey = options.runtimeCacheKey
    await scanDependencyTree({
      root: resolve(appDir, "yjs", runtimeCacheKey),
      location: "app",
      classify: (_path, entry) => (entry === "file" ? ["runtime-state"] : []),
      dependencies,
      diagnostics,
      budget,
    })
    const sharesPath = resolve(appDir, "document-shares.json")
    try {
      const info = await lstat(sharesPath)
      if (!info.isFile() || info.isSymbolicLink()) {
        diagnostics.push({
          severity: "error",
          path: "document-shares.json",
          message: "document share state must be a regular file",
        })
      } else {
        dependencies.push({
          kind: "shares",
          location: "app",
          path: "document-shares.json",
          entry: "file",
          bytes: info.size,
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({
          severity: "error",
          path: "document-shares.json",
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  dependencies.sort((left, right) =>
    compareStrings(
      `${left.location}/${left.path}/${left.kind}`,
      `${right.location}/${right.path}/${right.kind}`
    )
  )
  diagnostics.sort((left, right) =>
    compareStrings(
      `${left.path}/${left.message}`,
      `${right.path}/${right.message}`
    )
  )
  const checkpoint = createHash("sha256")
    .update(JSON.stringify({ dependencies, diagnostics }))
    .digest("hex")
  return {
    type: "worktable.document-identity-census",
    version: 1,
    clean: diagnostics.length === 0,
    appDataInspection: options.appDir ? "complete" : "not-requested",
    checkpoint,
    dependencies,
    diagnostics,
  }
}

function sourceFacts(document: PreflightDocumentSource): string {
  return JSON.stringify({
    spaceId: document.spaceId,
    path: document.path,
    format: document.format,
    health: document.health,
    source: document.source,
    bytes: document.bytes,
    sha256: document.sha256,
  })
}

export function calculateDocumentSourceCheckpoint(
  documents: readonly PreflightDocumentSource[]
): string {
  return createHash("sha256")
    .update(documents.map(sourceFacts).sort(compareStrings).join("\n"))
    .digest("hex")
}

function projectedDocumentId(
  document: PreflightDocumentSource,
  reserved: Set<DocumentId>
): DocumentId {
  let salt = 0
  while (true) {
    const encoded = createHash("sha256")
      .update(`${sourceFacts(document)}\0${salt}`)
      .digest()
      .subarray(0, 16)
      .toString("base64url")
    const documentId = `doc_${encoded}` as DocumentId
    if (!reserved.has(documentId)) {
      reserved.add(documentId)
      return documentId
    }
    salt += 1
  }
}

function provisionalDocumentsBySpace(
  documents: readonly PreflightDocumentSource[]
): Map<string, PreflightDocumentSource[]> {
  const bySpace = new Map<string, PreflightDocumentSource[]>()
  for (const document of documents) {
    if (document.identity === "durable") continue
    const spaceDocuments = bySpace.get(document.spaceId) ?? []
    spaceDocuments.push(document)
    bySpace.set(document.spaceId, spaceDocuments)
  }
  return bySpace
}

function inventoryUpsert(
  document: PreflightDocumentSource,
  documentId: DocumentId
) {
  return {
    documentId,
    path: document.path,
    format: document.format,
    source: document.source,
  }
}

function materializationError(report: DocumentPreflightReport): Error {
  const errors = report.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  )
  return new Error(
    `document identity materialization preflight failed: ${
      errors
        .slice(0, 3)
        .map((diagnostic) => diagnostic.message)
        .join("; ") || "workspace is not clean"
    }`
  )
}

export async function planDocumentIdMaterialization(
  workspaceRootInput: string,
  options: { appDir?: string; runtimeCacheKey?: string } = {}
): Promise<DocumentIdMaterializationPlan> {
  const workspaceRoot = resolve(workspaceRootInput)
  const beforeInspectionCheckpoints =
    await calculateLocalWorkspaceContentCheckpoints(workspaceRoot)
  const [preflight, census, manifestBytes] = await Promise.all([
    preflightDocumentWorkspace(workspaceRoot),
    censusDocumentIdentityDependencies(workspaceRoot, options),
    readBoundedRegularFile(
      resolve(workspaceRoot, "worktable.workspace.json"),
      MATERIALIZATION_WORKSPACE_MANIFEST_MAX_BYTES
    ),
  ])
  const workspaceCheckpoints =
    await calculateLocalWorkspaceContentCheckpoints(workspaceRoot)
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestBytes)
  } catch {
    manifest = null
  }
  if (!isWorkspaceManifest(manifest) || manifest.version !== 1) {
    throw new Error(
      "document identity materialization requires a V1 workspace manifest"
    )
  }
  const diagnostics: DocumentIdentityCensusDiagnostic[] = []
  if (
    beforeInspectionCheckpoints.workspaceContentCheckpoint !==
    workspaceCheckpoints.workspaceContentCheckpoint
  ) {
    diagnostics.push({
      severity: "error",
      path: ".",
      message:
        "workspace content changed while document identity dependencies were inspected",
    })
  }
  const durableIds = new Map<DocumentId, PreflightDocumentSource>()
  for (const document of preflight.documents) {
    if (document.identity !== "durable") continue
    const prior = durableIds.get(document.documentId)
    if (prior) {
      diagnostics.push({
        severity: "error",
        path: `${document.spaceId}/${document.path}`,
        message: `durable document ID is also used by ${prior.spaceId}/${prior.path}`,
      })
    } else {
      durableIds.set(document.documentId, document)
    }
  }
  const durableCount = preflight.documents.filter(
    (document) => document.identity === "durable"
  ).length
  if (preflight.clean) {
    const projectedIds = new Set(durableIds.keys())
    for (const [spaceId, documents] of provisionalDocumentsBySpace(
      preflight.documents
    )) {
      try {
        await validateDocumentInventoryMutationAt(
          resolve(workspaceRoot, "spaces", spaceId),
          {
            upsert: documents.map((document) =>
              inventoryUpsert(
                document,
                projectedDocumentId(document, projectedIds)
              )
            ),
          }
        )
      } catch (error) {
        diagnostics.push({
          severity: "error",
          path: `spaces/${spaceId}/documents.meta.json`,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return {
    type: "worktable.document-id-materialization-plan",
    version: 1,
    workspaceRoot,
    workspaceId: manifest.id,
    ...workspaceCheckpoints,
    sourceCheckpoint: calculateDocumentSourceCheckpoint(preflight.documents),
    documentCount: preflight.documentCount,
    durableCount,
    materializeCount: preflight.documentCount - durableCount,
    preflight,
    census,
    diagnostics,
    clean: preflight.clean && census.clean && diagnostics.length === 0,
  }
}

/** Materialize provisional identities inside a verified sibling copy. */
export async function materializeDocumentIdsAt(
  workspaceRootInput: string,
  expected: {
    workspaceId: string
    workspaceContentCheckpoint: string
    appDir?: string
    runtimeCacheKey?: string
  }
): Promise<DocumentIdMaterializationResult> {
  const workspaceRootPath = resolve(workspaceRootInput)
  const workspaceRootIdentity = await requireDirectoryIdentity(
    workspaceRootPath,
    "document identity materialization workspace root"
  )
  return materializeDocumentIdsAtBound(
    workspaceRootPath,
    expected,
    workspaceRootIdentity
  )
}

async function materializeDocumentIdsAtBound(
  workspaceRootPath: string,
  expected: {
    workspaceId: string
    workspaceContentCheckpoint: string
    appDir?: string
    runtimeCacheKey?: string
  },
  workspaceRootIdentity: DirectoryIdentity,
  sourceSpaceRootIdentities?: ReadonlyMap<string, DirectoryIdentity>
): Promise<DocumentIdMaterializationResult> {
  await requireDirectoryIdentity(
    workspaceRootPath,
    "document identity materialization workspace root",
    workspaceRootIdentity
  )
  const workspaceRoot = await realpath(workspaceRootPath)
  const plan = await planDocumentIdMaterialization(workspaceRoot, expected)
  await requireDirectoryIdentity(
    workspaceRootPath,
    "document identity materialization workspace root",
    workspaceRootIdentity
  )
  const before = plan.preflight
  if (!plan.clean) {
    if (!before.clean) throw materializationError(before)
    throw new Error(
      `document identity materialization census failed: ${[
        ...plan.census.diagnostics,
        ...plan.diagnostics,
      ]
        .slice(0, 3)
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`
    )
  }
  if (plan.workspaceId !== expected.workspaceId) {
    throw new Error("workspace identity changed after migration census")
  }
  if (plan.workspaceContentCheckpoint !== expected.workspaceContentCheckpoint) {
    throw new Error("workspace content changed after migration census")
  }
  const beforeSourceCheckpoint = calculateDocumentSourceCheckpoint(
    before.documents
  )
  const existingIds = new Set(
    before.documents.map((document) => document.documentId)
  )
  const mutations = await Promise.all(
    [...provisionalDocumentsBySpace(before.documents)]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(async ([spaceId, documents]) => {
        const spaceRoot = resolve(workspaceRoot, "spaces", spaceId)
        const [rootInfo, physicalRoot] = await Promise.all([
          lstat(spaceRoot),
          realpath(spaceRoot),
        ])
        if (
          !rootInfo.isDirectory() ||
          rootInfo.isSymbolicLink() ||
          !isInside(workspaceRoot, physicalRoot)
        ) {
          throw new Error(
            `document identity materialization Space root changed: ${spaceId}`
          )
        }
        const sourceIdentity = sourceSpaceRootIdentities?.get(spaceId)
        if (
          sourceIdentity &&
          rootInfo.dev === sourceIdentity.dev &&
          rootInfo.ino === sourceIdentity.ino
        ) {
          throw new Error(
            `refusing to materialize a Space shared with the source workspace: ${spaceId}`
          )
        }
        return {
          spaceRoot,
          expectedSpaceRootIdentity: {
            dev: rootInfo.dev,
            ino: rootInfo.ino,
          },
          upsert: documents.map((document) => {
            let documentId: DocumentId
            do documentId = mintDocumentId()
            while (existingIds.has(documentId))
            existingIds.add(documentId)
            return inventoryUpsert(document, documentId)
          }),
        }
      })
  )
  await requireDirectoryIdentity(
    workspaceRootPath,
    "document identity materialization workspace root",
    workspaceRootIdentity
  )
  // Validate every final serialized inventory before committing the first
  // Space, so capacity or schema failures cannot leave a partially migrated
  // copy merely because another Space sorted earlier.
  for (const { spaceRoot, upsert } of mutations) {
    await validateDocumentInventoryMutationAt(spaceRoot, { upsert })
  }
  for (const { spaceRoot, expectedSpaceRootIdentity, upsert } of mutations) {
    await requireDirectoryIdentity(
      workspaceRootPath,
      "document identity materialization workspace root",
      workspaceRootIdentity
    )
    await updateDocumentInventoryAt(
      spaceRoot,
      { upsert },
      {
        expectedSpaceRootIdentity,
      }
    )
  }

  const beforePostflightCheckpoints =
    await calculateLocalWorkspaceContentCheckpoints(workspaceRoot)
  const after = await preflightDocumentWorkspace(workspaceRoot)
  if (!after.clean) throw materializationError(after)
  if (after.documents.some((document) => document.identity !== "durable")) {
    throw new Error("document identity materialization left provisional claims")
  }
  if (
    after.documentCount !== before.documentCount ||
    calculateDocumentSourceCheckpoint(after.documents) !==
      beforeSourceCheckpoint
  ) {
    throw new Error(
      "document sources changed while stable identities were materialized"
    )
  }
  const afterCheckpoints =
    await calculateLocalWorkspaceContentCheckpoints(workspaceRoot)
  if (
    beforePostflightCheckpoints.workspaceContentCheckpoint !==
    afterCheckpoints.workspaceContentCheckpoint
  ) {
    throw new Error(
      "workspace content changed while materialized document identities were verified"
    )
  }
  if (
    afterCheckpoints.materializationBaseCheckpoint !==
    plan.materializationBaseCheckpoint
  ) {
    throw new Error(
      "non-inventory workspace content changed while stable identities were materialized"
    )
  }

  const priorDurable = new Map(
    before.documents
      .filter((document) => document.identity === "durable")
      .map((document) => [sourceFacts(document), document.documentId])
  )
  for (const document of after.documents) {
    const priorId = priorDurable.get(sourceFacts(document))
    if (priorId && priorId !== document.documentId) {
      throw new Error("document identity materialization changed a durable ID")
    }
  }
  return {
    workspaceId: plan.workspaceId,
    beforeWorkspaceContentCheckpoint: plan.workspaceContentCheckpoint,
    afterWorkspaceContentCheckpoint:
      afterCheckpoints.workspaceContentCheckpoint,
    sourceCheckpoint: beforeSourceCheckpoint,
    documentCount: after.documentCount,
    durableCount: after.documentCount,
    materializedCount: before.documents.length - priorDurable.size,
  }
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !fromRoot.startsWith("../") &&
      !fromRoot.startsWith("..\\"))
  )
}

async function requireDirectoryIdentity(
  path: string,
  label: string,
  expected?: DirectoryIdentity
): Promise<DirectoryIdentity> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`)
  }
  const identity = { dev: info.dev, ino: info.ino }
  if (
    expected &&
    (identity.dev !== expected.dev || identity.ino !== expected.ino)
  ) {
    throw new Error(`${label} changed before write`)
  }
  return identity
}

async function requireSeparateWorkspaceRoots(
  sourceWorkspaceInput: string,
  copyWorkspaceInput: string
): Promise<{
  sourceWorkspace: string
  copyWorkspace: string
  copyWorkspaceIdentity: DirectoryIdentity
}> {
  const [sourceWorkspace, copyWorkspace] = await Promise.all([
    realpath(resolve(sourceWorkspaceInput)),
    realpath(resolve(copyWorkspaceInput)),
  ])
  const [sourceInfo, copyInfo] = await Promise.all([
    lstat(sourceWorkspace),
    lstat(copyWorkspace),
  ])
  if (
    sourceWorkspace === copyWorkspace ||
    (sourceInfo.dev === copyInfo.dev && sourceInfo.ino === copyInfo.ino) ||
    isInside(sourceWorkspace, copyWorkspace) ||
    isInside(copyWorkspace, sourceWorkspace)
  ) {
    throw new Error(
      "refusing to materialize the source workspace; the target must be a separate copy"
    )
  }
  return {
    sourceWorkspace,
    copyWorkspace,
    copyWorkspaceIdentity: { dev: copyInfo.dev, ino: copyInfo.ino },
  }
}

function asJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export async function assertSourceDocumentInventoryLineage(
  sourceWorkspace: string,
  copyWorkspace: string,
  spaceIds: readonly string[]
): Promise<void> {
  for (const spaceId of spaceIds) {
    const sourceSpaceRoot = resolve(sourceWorkspace, "spaces", spaceId)
    const copySpaceRoot = resolve(copyWorkspace, "spaces", spaceId)
    const [sourceInventory, copyInventory] = await Promise.all([
      readDocumentInventoryAt(
        resolve(sourceSpaceRoot, "documents.meta.json"),
        sourceSpaceRoot
      ),
      readDocumentInventoryAt(
        resolve(copySpaceRoot, "documents.meta.json"),
        copySpaceRoot
      ),
    ])
    for (const [key, value] of Object.entries(sourceInventory.raw)) {
      if (key === "documents") continue
      if (
        !Object.hasOwn(copyInventory.raw, key) ||
        !isDeepStrictEqual(copyInventory.raw[key], value)
      ) {
        throw new Error(
          "the copied workspace changed source-owned document identity metadata"
        )
      }
    }
    const sourceDocuments = asJsonObject(sourceInventory.raw["documents"])
    const copyDocuments = asJsonObject(copyInventory.raw["documents"])
    for (const [documentId, entry] of Object.entries(sourceDocuments)) {
      if (
        !Object.hasOwn(copyDocuments, documentId) ||
        !isDeepStrictEqual(copyDocuments[documentId], entry)
      ) {
        throw new Error(
          "the copied workspace changed source-owned document identity metadata"
        )
      }
    }
  }
}

async function sourceSpaceDirectoryIdentities(
  sourceWorkspace: string,
  spaceIds: readonly string[]
): Promise<Map<string, DirectoryIdentity>> {
  const identities = new Map<string, DirectoryIdentity>()
  await Promise.all(
    spaceIds.map(async (spaceId) => {
      const spaceRoot = resolve(sourceWorkspace, "spaces", spaceId)
      const [info, physicalRoot] = await Promise.all([
        lstat(spaceRoot),
        realpath(spaceRoot),
      ])
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !isInside(sourceWorkspace, physicalRoot)
      ) {
        throw new Error(`source workspace Space root changed: ${spaceId}`)
      }
      identities.set(spaceId, { dev: info.dev, ino: info.ino })
    })
  )
  return identities
}

async function assertSeparateSpaceDirectories(
  copyWorkspace: string,
  sourceIdentities: ReadonlyMap<string, DirectoryIdentity>,
  spaceIds: readonly string[]
): Promise<void> {
  await Promise.all(
    spaceIds.map(async (spaceId) => {
      const sourceIdentity = sourceIdentities.get(spaceId)
      if (!sourceIdentity) return
      const copyInfo = await lstat(resolve(copyWorkspace, "spaces", spaceId))
      if (
        copyInfo.dev === sourceIdentity.dev &&
        copyInfo.ino === sourceIdentity.ino
      ) {
        throw new Error(
          `the copied workspace shares a Space directory with the source: ${spaceId}`
        )
      }
    })
  )
}

export async function rehearseDocumentIdMaterialization(input: {
  sourceWorkspace: string
  copyWorkspace: string
  expectedWorkspaceId: string
  expectedSourceWorkspaceContentCheckpoint: string
  expectedCopyWorkspaceContentCheckpoint: string
  appDir?: string
  runtimeCacheKey?: string
}): Promise<
  DocumentIdMaterializationResult & {
    sourceWorkspace: string
    copyWorkspace: string
  }
> {
  const { sourceWorkspace, copyWorkspace, copyWorkspaceIdentity } =
    await requireSeparateWorkspaceRoots(
      input.sourceWorkspace,
      input.copyWorkspace
    )
  const inspectionOptions = {
    ...(input.appDir ? { appDir: input.appDir } : {}),
    ...(input.runtimeCacheKey
      ? { runtimeCacheKey: input.runtimeCacheKey }
      : {}),
  }
  const [sourceBefore, copyBefore] = await Promise.all([
    planDocumentIdMaterialization(sourceWorkspace, inspectionOptions),
    planDocumentIdMaterialization(copyWorkspace, inspectionOptions),
  ])
  if (!sourceBefore.clean || !copyBefore.clean) {
    throw new Error(
      "source or copied workspace is not ready for materialization"
    )
  }
  if (
    sourceBefore.workspaceId !== input.expectedWorkspaceId ||
    copyBefore.workspaceId !== input.expectedWorkspaceId
  ) {
    throw new Error(
      "source or copied workspace identity does not match the census"
    )
  }
  if (
    sourceBefore.workspaceContentCheckpoint !==
      input.expectedSourceWorkspaceContentCheckpoint ||
    copyBefore.workspaceContentCheckpoint !==
      input.expectedCopyWorkspaceContentCheckpoint
  ) {
    throw new Error(
      "source or copied workspace content does not match the census checkpoint"
    )
  }
  if (
    sourceBefore.materializationBaseCheckpoint !==
      copyBefore.materializationBaseCheckpoint ||
    sourceBefore.sourceCheckpoint !== copyBefore.sourceCheckpoint ||
    sourceBefore.documentCount !== copyBefore.documentCount
  ) {
    throw new Error(
      "the copied workspace does not match the source outside document identity metadata"
    )
  }
  await assertSourceDocumentInventoryLineage(
    sourceWorkspace,
    copyWorkspace,
    sourceBefore.preflight.spaceIds
  )
  const sourceSpaceRootIdentities = await sourceSpaceDirectoryIdentities(
    sourceWorkspace,
    sourceBefore.preflight.spaceIds
  )
  await assertSeparateSpaceDirectories(
    copyWorkspace,
    sourceSpaceRootIdentities,
    sourceBefore.preflight.spaceIds
  )
  const copyDocumentsBySource = new Map(
    copyBefore.preflight.documents.map((document) => [
      sourceFacts(document),
      document,
    ])
  )
  for (const sourceDocument of sourceBefore.preflight.documents) {
    if (sourceDocument.identity !== "durable") continue
    const copyDocument = copyDocumentsBySource.get(sourceFacts(sourceDocument))
    if (
      copyDocument?.identity !== "durable" ||
      copyDocument.documentId !== sourceDocument.documentId
    ) {
      throw new Error(
        "the copied workspace changed an existing durable document ID"
      )
    }
  }
  await beforeMaterializationApplyHookForTests?.()
  const result = await materializeDocumentIdsAtBound(
    copyWorkspace,
    {
      workspaceId: input.expectedWorkspaceId,
      workspaceContentCheckpoint: input.expectedCopyWorkspaceContentCheckpoint,
      ...inspectionOptions,
    },
    copyWorkspaceIdentity,
    sourceSpaceRootIdentities
  )
  await assertSourceDocumentInventoryLineage(
    sourceWorkspace,
    copyWorkspace,
    sourceBefore.preflight.spaceIds
  )
  const sourceAfter = await planDocumentIdMaterialization(
    sourceWorkspace,
    inspectionOptions
  )
  if (
    sourceAfter.workspaceId !== sourceBefore.workspaceId ||
    sourceAfter.workspaceContentCheckpoint !==
      sourceBefore.workspaceContentCheckpoint
  ) {
    throw new Error(
      "the source workspace changed during rehearsal; keep the migrated copy isolated and repeat from a fresh verified copy"
    )
  }
  return { ...result, sourceWorkspace, copyWorkspace }
}
