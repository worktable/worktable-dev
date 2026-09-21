import { createHash } from "node:crypto"
import { constants, type Dirent } from "node:fs"
import { lstat, open, opendir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type {
  DocumentFormatClaim,
  DocumentHealth,
  DocumentId,
  DocumentSource,
} from "@worktable/types"
import { SpaceFileSchema } from "@worktable/types"
import { BoundedFileReadError, readBoundedRegularFile } from "./bounded-file.ts"
import { DOC_ALIASES_MAX_BYTES } from "./doc-aliases.ts"
import {
  buildDocumentCatalog,
  type CatalogDocumentEntry,
} from "./document-catalog.ts"
import {
  DOCUMENT_INVENTORY_MAX_BYTES,
  inspectDocumentSource,
  type DocumentInventoryDiagnostic,
} from "./document-inventory.ts"
import { analyzeDocumentPath } from "./document-path.ts"

const PREFLIGHT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const PREFLIGHT_MAX_METADATA_BYTES = 8 * 1024 * 1024
const PREFLIGHT_MAX_SPACE_MANIFEST_BYTES = 1024 * 1024
const PREFLIGHT_MAX_ENTRIES = 100_000
const PREFLIGHT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
const PREFLIGHT_SECURE_READ_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

export interface DocumentPreflightDiagnostic {
  severity: "warning" | "error"
  code:
    | "workspace-missing-spaces"
    | "logical-path-conflict"
    | "document-discovery-failed"
    | "document-invalid"
    | "document-warning"
    | "inventory-error"
    | "inventory-warning"
    | "filesystem-symlink"
    | "filesystem-special-file"
    | "filesystem-unreadable"
    | "orphan-widget-content"
    | "orphan-widget-metadata"
    | "metadata-invalid-json"
    | "metadata-too-large"
    | "source-too-large"
    | "source-capture-failed"
    | "workspace-too-many-entries"
    | "workspace-too-large"
  spaceId?: string
  path?: string
  message: string
}

export interface PreflightDocumentSource {
  spaceId: string
  documentId: DocumentId
  identity: "durable" | "provisional"
  path: string
  format: DocumentFormatClaim
  health: DocumentHealth
  source: DocumentSource
  bytes: number | null
  sha256: string | null
}

export interface DocumentPreflightReport {
  type: "worktable.document-preflight"
  version: 1
  workspaceRoot: string
  clean: boolean
  spaceIds: string[]
  spaceCount: number
  documentCount: number
  conflictCount: number
  sourceBytes: number
  checkpoint: string
  documents: PreflightDocumentSource[]
  diagnostics: DocumentPreflightDiagnostic[]
}

interface CaptureResult {
  bytes: number
  sha256: string
}

interface PreflightBudget {
  entries: number
  sourceBytes: number
  maxEntries: number
  maxSourceBytes: number
  entryLimitExceeded: boolean
  byteLimitExceeded: boolean
}

interface CheckpointSidecar {
  spaceId: string
  path: "doc-aliases.json" | "documents.meta.json"
  bytes?: number
  sha256?: string
  unavailable?: string
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function filesystemIdentity(info: Awaited<ReturnType<typeof lstat>>): string {
  return `${info.dev}:${info.ino}`
}

function captureErrorCode(error: unknown): DocumentPreflightDiagnostic["code"] {
  const message = error instanceof Error ? error.message : String(error)
  if (message === "source-too-large") return "source-too-large"
  if (message === "workspace-too-many-entries") {
    return "workspace-too-many-entries"
  }
  if (message === "workspace-too-large") return "workspace-too-large"
  return "source-capture-failed"
}

function inventoryDiagnostic(
  spaceId: string,
  diagnostic: DocumentInventoryDiagnostic
): DocumentPreflightDiagnostic {
  return {
    severity: diagnostic.severity,
    code:
      diagnostic.severity === "error" ? "inventory-error" : "inventory-warning",
    spaceId,
    path: diagnostic.documentId,
    message: `${diagnostic.code}: ${diagnostic.message}`,
  }
}

async function captureCheckpointSidecars(
  workspaceRoot: string,
  spaceIds: readonly string[]
): Promise<CheckpointSidecar[]> {
  const sidecars: CheckpointSidecar[] = []
  for (const spaceId of spaceIds) {
    for (const file of [
      { path: "doc-aliases.json" as const, maxBytes: DOC_ALIASES_MAX_BYTES },
      {
        path: "documents.meta.json" as const,
        maxBytes: DOCUMENT_INVENTORY_MAX_BYTES,
      },
    ]) {
      const absolutePath = resolve(workspaceRoot, "spaces", spaceId, file.path)
      try {
        const text = await readBoundedRegularFile(absolutePath, file.maxBytes)
        const content = Buffer.from(text, "utf8")
        sidecars.push({
          spaceId,
          path: file.path,
          bytes: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        })
      } catch (error) {
        if (
          error instanceof BoundedFileReadError &&
          error.reason === "missing"
        ) {
          continue
        }
        sidecars.push({
          spaceId,
          path: file.path,
          unavailable:
            error instanceof BoundedFileReadError ? error.reason : "unreadable",
        })
      }
    }
  }
  return sidecars
}

async function hashFile(
  spaceRoot: string,
  relativePath: string,
  budget: PreflightBudget
): Promise<CaptureResult> {
  if (budget.byteLimitExceeded) throw new Error("workspace-too-large")
  const inspected = await inspectDocumentSource(spaceRoot, {
    kind: "file",
    relativePath,
  })
  if (!inspected.safe) throw new Error(inspected.message)
  const handle = await open(inspected.absolutePath, PREFLIGHT_SECURE_READ_FLAGS)
  try {
    const [info, pathInfo] = await Promise.all([
      handle.stat(),
      lstat(inspected.absolutePath),
    ])
    if (
      !info.isFile() ||
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      info.dev !== pathInfo.dev ||
      info.ino !== pathInfo.ino
    ) {
      throw new Error("source is not the validated regular file")
    }
    if (info.size > PREFLIGHT_MAX_FILE_BYTES) {
      throw new Error("source-too-large")
    }
    if (budget.sourceBytes + info.size > budget.maxSourceBytes) {
      budget.byteLimitExceeded = true
      throw new Error("workspace-too-large")
    }
    const hash = createHash("sha256")
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > PREFLIGHT_MAX_FILE_BYTES) throw new Error("source-too-large")
      if (budget.sourceBytes + bytes > budget.maxSourceBytes) {
        budget.byteLimitExceeded = true
        throw new Error("workspace-too-large")
      }
      hash.update(buffer)
    }
    const inspectedAfter = await inspectDocumentSource(spaceRoot, {
      kind: "file",
      relativePath,
    })
    if (!inspectedAfter.safe) throw new Error(inspectedAfter.message)
    const [after, pathAfter] = await Promise.all([
      handle.stat(),
      lstat(inspectedAfter.absolutePath),
    ])
    if (
      !after.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      pathAfter.dev !== info.dev ||
      pathAfter.ino !== info.ino ||
      bytes !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    ) {
      throw new Error("source changed during capture")
    }
    budget.sourceBytes += bytes
    return {
      bytes,
      sha256: hash.digest("hex"),
    }
  } finally {
    await handle.close()
  }
}

async function bundleFiles(
  root: string,
  options: { legacyHtml: boolean }
): Promise<Array<{ relativePath: string }>> {
  if (options.legacyHtml) {
    return ["index.html", "widget.yaml"].map((name) => ({
      relativePath: name,
    }))
  }
  const files: Array<{ relativePath: string }> = []
  const portablePaths = new Set<string>()
  let entries = 0
  const walk = async (directory: string): Promise<void> => {
    const handle = await opendir(directory)
    for await (const entry of handle) {
      entries += 1
      if (entries > PREFLIGHT_MAX_ENTRIES) {
        throw new Error("workspace-too-many-entries")
      }
      const absolutePath = join(directory, entry.name)
      const relativePath = relative(root, absolutePath).split("\\").join("/")
      const analysis = analyzeDocumentPath(relativePath)
      if (
        !analysis.safe ||
        !analysis.portable ||
        analysis.canonicalPath !== relativePath ||
        !analysis.comparisonKey
      ) {
        throw new Error("bundle contains a nonportable path")
      }
      if (portablePaths.has(analysis.comparisonKey)) {
        throw new Error("bundle contains colliding portable paths")
      }
      portablePaths.add(analysis.comparisonKey)
      if (entry.isSymbolicLink()) throw new Error("bundle contains a symlink")
      if (entry.isDirectory()) {
        await walk(absolutePath)
      } else if (entry.isFile()) {
        files.push({ relativePath })
      } else {
        throw new Error("bundle contains a special file")
      }
    }
  }
  await walk(root)
  files.sort((a, b) => compareStrings(a.relativePath, b.relativePath))
  return files
}

async function captureSource(
  spaceRoot: string,
  source: DocumentSource,
  budget: PreflightBudget
): Promise<CaptureResult> {
  const inspected = await inspectDocumentSource(spaceRoot, source)
  if (!inspected.safe) throw new Error(inspected.message)
  if (source.kind === "file") {
    return hashFile(spaceRoot, source.relativePath, budget)
  }
  const legacyHtml =
    source.relativePath.startsWith("widgets/") &&
    !source.relativePath.endsWith(".wtdoc")
  const files = await bundleFiles(inspected.absolutePath, { legacyHtml })
  const bundleHash = createHash("sha256")
  let bytes = 0
  const sourceBytesBeforeBundle = budget.sourceBytes
  try {
    for (const file of files) {
      const captured = await hashFile(
        spaceRoot,
        `${source.relativePath}/${file.relativePath}`,
        budget
      )
      bytes += captured.bytes
      bundleHash.update(file.relativePath)
      bundleHash.update("\0")
      bundleHash.update(String(captured.bytes))
      bundleHash.update("\0")
      bundleHash.update(captured.sha256)
      bundleHash.update("\0")
    }
  } catch (error) {
    budget.sourceBytes = sourceBytesBeforeBundle
    throw error
  }
  return { bytes, sha256: bundleHash.digest("hex") }
}

async function scanFilesystemDiagnostics(
  workspaceRoot: string,
  spaceId: string,
  budget: PreflightBudget
): Promise<DocumentPreflightDiagnostic[]> {
  const diagnostics: DocumentPreflightDiagnostic[] = []
  const spaceRoot = resolve(workspaceRoot, "spaces", spaceId)
  const walk = async (
    rootName: "docs" | "widgets",
    directory: string,
    belowLegacyWidget = false
  ): Promise<void> => {
    if (budget.entryLimitExceeded) return
    const entries: Dirent[] = []
    try {
      const handle = await opendir(directory)
      for await (const entry of handle) {
        budget.entries += 1
        if (budget.entries > budget.maxEntries) {
          budget.entryLimitExceeded = true
          diagnostics.push({
            severity: "error",
            code: "workspace-too-many-entries",
            spaceId,
            message:
              "workspace docs and widgets exceed the preflight entry limit",
          })
          return
        }
        entries.push(entry)
      }
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "filesystem-unreadable",
        spaceId,
        path: relative(spaceRoot, directory).split("\\").join("/"),
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    entries.sort((a, b) => compareStrings(a.name, b.name))
    const names = new Set(entries.map((entry) => entry.name))
    if (rootName === "widgets") {
      const relativeDirectory = relative(
        resolve(spaceRoot, "widgets"),
        directory
      )
        .split("\\")
        .join("/")
      if (relativeDirectory && !belowLegacyWidget) {
        if (names.has("index.html") && !names.has("widget.yaml")) {
          diagnostics.push({
            severity: "error",
            code: "orphan-widget-content",
            spaceId,
            path: `widgets/${relativeDirectory}`,
            message: "widget directory has index.html without widget.yaml",
          })
        }
        if (names.has("widget.yaml") && !names.has("index.html")) {
          diagnostics.push({
            severity: "error",
            code: "orphan-widget-metadata",
            spaceId,
            path: `widgets/${relativeDirectory}`,
            message: "widget directory has widget.yaml without index.html",
          })
        }
      }
      const isLegacyWidgetRoot =
        Boolean(relativeDirectory) && names.has("widget.yaml")
      belowLegacyWidget ||= isLegacyWidgetRoot
    }
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const relativePath = relative(spaceRoot, absolutePath)
        .split("\\")
        .join("/")
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          severity: "error",
          code: "filesystem-symlink",
          spaceId,
          path: relativePath,
          message: "document storage contains a symbolic link",
        })
        continue
      }
      if (entry.isDirectory()) {
        await walk(rootName, absolutePath, belowLegacyWidget)
        if (budget.entryLimitExceeded) return
        continue
      }
      if (!entry.isFile()) {
        diagnostics.push({
          severity: "error",
          code: "filesystem-special-file",
          spaceId,
          path: relativePath,
          message: "document storage contains a special file",
        })
        continue
      }
    }
  }

  for (const rootName of ["docs", "widgets"] as const) {
    if (budget.entryLimitExceeded) break
    const root = resolve(spaceRoot, rootName)
    let info
    try {
      info = await lstat(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      diagnostics.push({
        severity: "error",
        code: "filesystem-unreadable",
        spaceId,
        path: rootName,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (info.isSymbolicLink()) {
      diagnostics.push({
        severity: "error",
        code: "filesystem-symlink",
        spaceId,
        path: rootName,
        message: "document storage root cannot be a symbolic link",
      })
    } else if (!info.isDirectory()) {
      diagnostics.push({
        severity: "error",
        code: "filesystem-special-file",
        spaceId,
        path: rootName,
        message: "document storage root must be a directory",
      })
    } else {
      await walk(rootName, root)
    }
  }
  if (budget.entryLimitExceeded) return diagnostics
  for (const metadataName of ["docs.meta.json", "widgets.meta.json"] as const) {
    const path = resolve(spaceRoot, metadataName)
    let text: string
    try {
      text = await readBoundedRegularFile(path, PREFLIGHT_MAX_METADATA_BYTES)
    } catch (error) {
      const reason =
        error instanceof BoundedFileReadError ? error.reason : "unreadable"
      if (reason === "missing") continue
      if (reason === "symlink" || reason === "not-file") {
        diagnostics.push({
          severity: "error",
          code:
            reason === "symlink"
              ? "filesystem-symlink"
              : "filesystem-special-file",
          spaceId,
          path: metadataName,
          message: `${metadataName} must be a regular file`,
        })
        continue
      }
      if (reason === "too-large") {
        diagnostics.push({
          severity: "error",
          code: "metadata-too-large",
          spaceId,
          path: metadataName,
          message: `${metadataName} exceeds its preflight size limit`,
        })
        continue
      }
      diagnostics.push({
        severity: "error",
        code: "filesystem-unreadable",
        spaceId,
        path: metadataName,
        message: `${metadataName} could not be read consistently`,
      })
      continue
    }
    try {
      JSON.parse(text)
    } catch {
      diagnostics.push({
        severity: "error",
        code: "metadata-invalid-json",
        spaceId,
        path: metadataName,
        message: `${metadataName} is not valid JSON`,
      })
    }
  }
  return diagnostics
}

async function pathOrAncestorHasFilesystemIdentity(
  spaceRoot: string,
  relativePath: string,
  identities: ReadonlySet<string>
): Promise<boolean> {
  let current: string | null = relativePath
  while (current) {
    try {
      const info = await lstat(resolve(spaceRoot, current))
      if (!info.isSymbolicLink() && identities.has(filesystemIdentity(info))) {
        return true
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    }
    const separator = current.lastIndexOf("/")
    current = separator === -1 ? null : current.slice(0, separator)
  }
  return false
}

function invalidDocumentDiagnostic(
  spaceId: string,
  entry: CatalogDocumentEntry
): DocumentPreflightDiagnostic | null {
  if (entry.descriptor.health !== "invalid") return null
  return {
    severity: "error",
    code: "document-invalid",
    spaceId,
    path: entry.descriptor.path,
    message:
      entry.handle.diagnostics.map((item) => item.message).join("; ") ||
      "document source is invalid",
  }
}

function warningDocumentDiagnostics(
  spaceId: string,
  path: string,
  diagnostics: CatalogDocumentEntry["handle"]["diagnostics"]
): DocumentPreflightDiagnostic[] {
  return diagnostics
    .filter((item) => item.severity === "warning")
    .map((item) => ({
      severity: "warning",
      code: "document-warning",
      spaceId,
      path,
      message: `${item.code}: ${item.message}`,
    }))
}

interface PublishedSpaceResult {
  spaceId: string | null
  diagnostic: DocumentPreflightDiagnostic | null
}

async function publishedSpace(
  spacesRoot: string,
  entry: Dirent
): Promise<PublishedSpaceResult> {
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return { spaceId: null, diagnostic: null }
  }
  const spaceRoot = resolve(spacesRoot, entry.name)
  const manifestPath = resolve(spaceRoot, "space.json")
  try {
    const spaceInfo = await lstat(spaceRoot)
    if (spaceInfo.isSymbolicLink()) {
      return {
        spaceId: null,
        diagnostic: {
          severity: "error",
          code: "filesystem-symlink",
          spaceId: entry.name,
          path: `spaces/${entry.name}`,
          message: "enumerated Space root became a symbolic link",
        },
      }
    }
    if (!spaceInfo.isDirectory()) {
      return {
        spaceId: null,
        diagnostic: {
          severity: "error",
          code: "filesystem-special-file",
          spaceId: entry.name,
          path: `spaces/${entry.name}`,
          message: "enumerated Space root is no longer a directory",
        },
      }
    }
  } catch (error) {
    return {
      spaceId: null,
      diagnostic: {
        severity: "error",
        code: "filesystem-unreadable",
        spaceId: entry.name,
        path: `spaces/${entry.name}`,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  let manifestText: string
  try {
    manifestText = await readBoundedRegularFile(
      manifestPath,
      PREFLIGHT_MAX_SPACE_MANIFEST_BYTES
    )
  } catch (error) {
    const reason =
      error instanceof BoundedFileReadError ? error.reason : "unreadable"
    if (reason === "missing") {
      return { spaceId: null, diagnostic: null }
    }
    const code =
      reason === "symlink"
        ? "filesystem-symlink"
        : reason === "not-file"
          ? "filesystem-special-file"
          : "filesystem-unreadable"
    return {
      spaceId: null,
      diagnostic: {
        severity: "error",
        code,
        path: `spaces/${entry.name}/space.json`,
        message:
          reason === "too-large"
            ? "Space manifest exceeds the preflight read limit"
            : "Space manifest could not be read consistently",
      },
    }
  }

  try {
    const parsed = SpaceFileSchema.safeParse(JSON.parse(manifestText))
    const published = parsed.success && parsed.data.id === entry.name
    return {
      spaceId: published ? entry.name : null,
      diagnostic: null,
    }
  } catch {
    return { spaceId: null, diagnostic: null }
  }
}

/**
 * Produces deterministic evidence for a quiescent workspace without mutating it.
 * This is an inspection pass, not a filesystem transaction: a later migration
 * must stop writers, operate on a staged copy, and recheck its checkpoint.
 */
export async function preflightDocumentWorkspace(
  workspaceRootInput: string,
  limits?: { maxEntries?: number; maxSourceBytes?: number }
): Promise<DocumentPreflightReport> {
  const workspaceRoot = resolve(workspaceRootInput)
  const spacesRoot = resolve(workspaceRoot, "spaces")
  const diagnostics: DocumentPreflightDiagnostic[] = []
  const budget: PreflightBudget = {
    entries: 0,
    sourceBytes: 0,
    maxEntries: limits?.maxEntries ?? PREFLIGHT_MAX_ENTRIES,
    maxSourceBytes: limits?.maxSourceBytes ?? PREFLIGHT_MAX_TOTAL_BYTES,
    entryLimitExceeded: false,
    byteLimitExceeded: false,
  }
  const spaceEntries: Dirent[] = []
  let workspaceInfo
  let workspaceMissing = false
  try {
    workspaceInfo = await lstat(workspaceRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      workspaceMissing = true
    } else {
      diagnostics.push({
        severity: "error",
        code: "filesystem-unreadable",
        path: ".",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const workspaceRootIsRealDirectory =
    workspaceInfo?.isDirectory() && !workspaceInfo.isSymbolicLink()
  if (workspaceInfo?.isSymbolicLink()) {
    diagnostics.push({
      severity: "error",
      code: "filesystem-symlink",
      path: ".",
      message: "workspace root cannot be a symbolic link",
    })
  } else if (workspaceInfo && !workspaceInfo.isDirectory()) {
    diagnostics.push({
      severity: "error",
      code: "filesystem-special-file",
      path: ".",
      message: "workspace root must be a directory",
    })
  }
  let spacesInfo
  if (workspaceRootIsRealDirectory) {
    try {
      spacesInfo = await lstat(spacesRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        diagnostics.push({
          severity: "error",
          code: "workspace-missing-spaces",
          message: "workspace is missing its spaces directory",
        })
      } else {
        diagnostics.push({
          severity: "error",
          code: "filesystem-unreadable",
          path: "spaces",
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } else if (workspaceMissing) {
    diagnostics.push({
      severity: "error",
      code: "workspace-missing-spaces",
      message: "workspace is missing its spaces directory",
    })
  }
  if (spacesInfo?.isSymbolicLink()) {
    diagnostics.push({
      severity: "error",
      code: "filesystem-symlink",
      path: "spaces",
      message: "workspace spaces root cannot be a symbolic link",
    })
  } else if (spacesInfo && !spacesInfo.isDirectory()) {
    diagnostics.push({
      severity: "error",
      code: "filesystem-special-file",
      path: "spaces",
      message: "workspace spaces root must be a directory",
    })
  } else if (spacesInfo) {
    try {
      const spaces = await opendir(spacesRoot)
      for await (const entry of spaces) {
        budget.entries += 1
        if (budget.entries > budget.maxEntries) {
          budget.entryLimitExceeded = true
          diagnostics.push({
            severity: "error",
            code: "workspace-too-many-entries",
            path: "spaces",
            message: "workspace exceeds the preflight entry limit",
          })
          break
        }
        spaceEntries.push(entry)
      }
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "filesystem-unreadable",
        path: "spaces",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  spaceEntries.sort((a, b) => compareStrings(a.name, b.name))
  const spaceIds: string[] = []
  if (!budget.entryLimitExceeded) {
    for (const entry of spaceEntries) {
      const published = await publishedSpace(spacesRoot, entry)
      if (published.diagnostic) diagnostics.push(published.diagnostic)
      if (published.spaceId) spaceIds.push(published.spaceId)
    }
  }

  const documents: PreflightDocumentSource[] = []
  const provenBundleIdentitiesBySpace = new Map<string, ReadonlySet<string>>()
  let conflictCount = 0
  for (const spaceId of spaceIds) {
    const filesystemDiagnostics = await scanFilesystemDiagnostics(
      workspaceRoot,
      spaceId,
      budget
    )
    diagnostics.push(...filesystemDiagnostics)
    if (budget.entryLimitExceeded) break
  }

  if (!budget.entryLimitExceeded) {
    for (const spaceId of spaceIds) {
      let catalog
      try {
        catalog = await buildDocumentCatalog({ workspaceRoot, spaceId })
      } catch (error) {
        diagnostics.push({
          severity: "error",
          code: "document-discovery-failed",
          spaceId,
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      provenBundleIdentitiesBySpace.set(
        spaceId,
        catalog.provenCoreBundleIdentities
      )
      diagnostics.push(
        ...catalog.inventoryDiagnostics.map((item) =>
          inventoryDiagnostic(spaceId, item)
        )
      )
      const spaceRoot = resolve(workspaceRoot, "spaces", spaceId)
      for (const entry of catalog.entries) {
        if (entry.kind === "conflict") {
          conflictCount += 1
          diagnostics.push({
            severity: "error",
            code: "logical-path-conflict",
            spaceId,
            path: entry.pathKey,
            message: `logical path has ${entry.claims.length} claims`,
          })
          for (const claim of entry.claims) {
            if (claim.kind === "alias") continue
            diagnostics.push(
              ...warningDocumentDiagnostics(
                spaceId,
                claim.path,
                claim.diagnostics
              )
            )
            const claimErrors = claim.diagnostics.filter(
              (item) => item.severity === "error"
            )
            if (claimErrors.length > 0) {
              diagnostics.push({
                severity: "error",
                code: "document-invalid",
                spaceId,
                path: claim.path,
                message: claimErrors.map((item) => item.message).join("; "),
              })
            }
            let capture: CaptureResult | null = null
            if (
              !budget.byteLimitExceeded &&
              !claim.diagnostics.some((item) => item.severity === "error")
            ) {
              try {
                capture = await captureSource(spaceRoot, claim.source, budget)
              } catch (error) {
                if (captureErrorCode(error) !== "workspace-too-large") {
                  diagnostics.push({
                    severity: "error",
                    code: captureErrorCode(error),
                    spaceId,
                    path: claim.path,
                    message:
                      error instanceof Error ? error.message : String(error),
                  })
                }
              }
            }
            documents.push({
              spaceId,
              documentId: claim.documentId,
              identity: claim.identity,
              path: claim.path,
              format: claim.format,
              health: "ambiguous",
              source: claim.source,
              bytes: capture?.bytes ?? null,
              sha256: capture?.sha256 ?? null,
            })
          }
          continue
        }
        diagnostics.push(
          ...warningDocumentDiagnostics(
            spaceId,
            entry.descriptor.path,
            entry.handle.diagnostics
          )
        )
        const invalid = invalidDocumentDiagnostic(spaceId, entry)
        if (invalid) diagnostics.push(invalid)
        let capture: CaptureResult | null = null
        if (
          !budget.byteLimitExceeded &&
          entry.descriptor.health !== "invalid"
        ) {
          try {
            capture = await captureSource(
              spaceRoot,
              entry.handle.source,
              budget
            )
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            if (captureErrorCode(error) !== "workspace-too-large") {
              diagnostics.push({
                severity: "error",
                code: captureErrorCode(error),
                spaceId,
                path: entry.descriptor.path,
                message,
              })
            }
          }
        }
        documents.push({
          spaceId,
          documentId: entry.descriptor.documentId,
          identity: entry.handle.identity,
          path: entry.descriptor.path,
          format: entry.descriptor.format,
          health: entry.descriptor.health,
          source: entry.handle.source,
          bytes: capture?.bytes ?? null,
          sha256: capture?.sha256 ?? null,
        })
      }
    }
  }

  const unsuppressedDiagnostics: DocumentPreflightDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const suppressible =
      diagnostic.code === "orphan-widget-content" ||
      diagnostic.code === "orphan-widget-metadata"
    const identities = diagnostic.spaceId
      ? provenBundleIdentitiesBySpace.get(diagnostic.spaceId)
      : undefined
    if (
      suppressible &&
      diagnostic.spaceId &&
      diagnostic.path &&
      identities?.size
    ) {
      try {
        if (
          await pathOrAncestorHasFilesystemIdentity(
            resolve(workspaceRoot, "spaces", diagnostic.spaceId),
            diagnostic.path,
            identities
          )
        ) {
          continue
        }
      } catch {
        // Retain the diagnostic when the physical containment cannot be proven.
      }
    }
    unsuppressedDiagnostics.push(diagnostic)
  }
  diagnostics.splice(0, diagnostics.length, ...unsuppressedDiagnostics)

  if (budget.byteLimitExceeded) {
    diagnostics.push({
      severity: "error",
      code: "workspace-too-large",
      message: "captured document sources exceed the preflight workspace limit",
    })
  }
  documents.sort((a, b) =>
    compareStrings(
      `${a.spaceId}/${a.path}/${a.source.kind}/${a.source.relativePath}/${a.documentId}`,
      `${b.spaceId}/${b.path}/${b.source.kind}/${b.source.relativePath}/${b.documentId}`
    )
  )
  diagnostics.sort((a, b) =>
    compareStrings(
      `${a.spaceId ?? ""}/${a.path ?? ""}/${a.code}/${a.severity}/${a.message}`,
      `${b.spaceId ?? ""}/${b.path ?? ""}/${b.code}/${b.severity}/${b.message}`
    )
  )
  const checkpointSidecars = await captureCheckpointSidecars(
    workspaceRoot,
    spaceIds
  )
  const checkpointHash = createHash("sha256")
  checkpointHash.update(
    JSON.stringify({
      spaceIds,
      conflictCount,
      sourceBytes: budget.sourceBytes,
    })
  )
  checkpointHash.update("\n")
  for (const sidecar of checkpointSidecars) {
    checkpointHash.update(JSON.stringify(sidecar))
    checkpointHash.update("\n")
  }
  for (const document of documents) {
    checkpointHash.update(JSON.stringify(document))
    checkpointHash.update("\n")
  }
  for (const diagnostic of diagnostics) {
    checkpointHash.update(JSON.stringify(diagnostic))
    checkpointHash.update("\n")
  }
  return {
    type: "worktable.document-preflight",
    version: 1,
    workspaceRoot,
    clean: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    spaceIds,
    spaceCount: spaceIds.length,
    documentCount: documents.length,
    conflictCount,
    sourceBytes: budget.sourceBytes,
    checkpoint: checkpointHash.digest("hex"),
    documents,
    diagnostics,
  }
}

export function formatDocumentPreflightReport(
  report: DocumentPreflightReport
): string {
  const lines = [
    `Document preflight: ${report.clean ? "clean" : "blocked"}`,
    `Spaces: ${report.spaceCount}`,
    `Documents: ${report.documentCount}`,
    `Conflicts: ${report.conflictCount}`,
    `Source bytes: ${report.sourceBytes}`,
    `Checkpoint: ${report.checkpoint}`,
  ]
  for (const diagnostic of report.diagnostics) {
    lines.push(
      `${diagnostic.severity.toUpperCase()} ${diagnostic.code}` +
        `${diagnostic.spaceId ? ` [${diagnostic.spaceId}]` : ""}` +
        `${diagnostic.path ? ` ${diagnostic.path}` : ""}: ${diagnostic.message}`
    )
  }
  return `${lines.join("\n")}\n`
}
