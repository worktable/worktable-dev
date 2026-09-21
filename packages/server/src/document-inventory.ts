import { randomBytes } from "node:crypto"
import { lstat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  CanonicalIdSchema,
  DocumentFormatClaimSchema,
  DocumentIdSchema,
  DocumentSourceSchema,
  type DocumentFormatClaim,
  type DocumentId,
  type DocumentSource,
} from "@worktable/types"
import { BoundedFileReadError, readBoundedRegularFile } from "./bounded-file.ts"
import { atomicWriteText } from "./atomic-file.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"
import { withStoreWriteLock } from "./store.ts"
import { getDocumentInventoryPath, getSpacesDir } from "./workspace.ts"

export const DOCUMENT_INVENTORY_MAX_BYTES = 8 * 1024 * 1024
export const DOCUMENT_INVENTORY_MAX_ENTRIES = 100_000
export const DOCUMENT_BUNDLE_MANIFEST_MAX_BYTES = 1024 * 1024

export class DocumentInventorySpaceNotFoundError extends Error {
  constructor(spaceId: string) {
    super(`Space does not exist: ${spaceId}`)
    this.name = "DocumentInventorySpaceNotFoundError"
  }
}

export interface DocumentInventoryDiagnostic {
  severity: "warning" | "error"
  code:
    | "inventory-not-file"
    | "inventory-too-large"
    | "inventory-invalid-json"
    | "inventory-invalid-header"
    | "inventory-invalid-documents"
    | "inventory-lossy-number"
    | "inventory-too-many-entries"
    | "entry-invalid"
    | "entry-case-colliding-id"
    | "entry-duplicate-source"
    | "entry-unsafe-path"
    | "entry-unsafe-source"
    | "bundle-not-directory"
    | "bundle-symlink"
    | "bundle-manifest-missing"
    | "bundle-manifest-not-file"
    | "bundle-manifest-too-large"
    | "bundle-manifest-invalid"
    | "bundle-content-unsafe"
    | "bundle-content-missing"
    | "bundle-content-not-file"
  documentId?: string
  message: string
}

export interface DocumentInventoryEntry {
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
  source: DocumentSource
  raw: Record<string, unknown>
}

export interface DocumentInventory {
  type: "worktable.document-inventory"
  version: 1
  entries: Map<DocumentId, DocumentInventoryEntry>
  raw: Record<string, unknown>
  exists: boolean
  diagnostics: DocumentInventoryDiagnostic[]
}

export interface DocumentBundleManifest {
  type: "worktable.document-bundle"
  version: 1
  documentId: DocumentId
  format: DocumentFormatClaim
  content: string
  raw: Record<string, unknown>
}

function emptyInventory(): DocumentInventory {
  return {
    type: "worktable.document-inventory",
    version: 1,
    entries: new Map(),
    raw: {
      type: "worktable.document-inventory",
      version: 1,
      documents: {},
    },
    exists: false,
    diagnostics: [],
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareStrings)
      .map((key) => [key, sortedJson(value[key])])
  )
}

function serializeInventory(raw: Record<string, unknown>): string {
  return `${JSON.stringify(sortedJson(raw), null, 2)}\n`
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

function isMissingFilesystemError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

function normalizeJsonNumber(token: string): string | null {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)
  if (!match) return null

  const negative = match[1] === "-"
  const fraction = match[3] ?? ""
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "")
  if (!digits) return "0e0"

  let trailingZeros = 0
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1)
    trailingZeros += 1
  }

  const exponentToken = match[4] ?? "0"
  const exponentDigits = exponentToken.replace(/^[+-]?0+/, "") || "0"
  // Any non-zero exponent this long necessarily overflows or underflows a
  // finite JSON number. Avoid constructing an attacker-sized BigInt from it.
  if (exponentDigits.length > 4) return null
  const exponent =
    BigInt(exponentToken) - BigInt(fraction.length) + BigInt(trailingZeros)
  return `${negative ? "-" : ""}${digits}e${exponent}`
}

function containsJsonNumberThatChangesOnRewrite(text: string): boolean {
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (inString) {
      if (character === "\\") index += 1
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character !== "-" && (character < "0" || character > "9")) continue
    let end = index + 1
    while (end < text.length && /[0-9eE+.-]/.test(text[end]!)) end += 1
    const token = text.slice(index, end)
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      const normalized = normalizeJsonNumber(token)
      if (!normalized) return true
      const value = Number(token)
      const rewritten = Number.isFinite(value) ? JSON.stringify(value) : null
      if (!rewritten || normalizeJsonNumber(rewritten) !== normalized) {
        return true
      }
    }
    index = end - 1
  }
  return false
}

async function requireRealInventorySpaceRoot(spaceId: string): Promise<string> {
  CanonicalIdSchema.parse(spaceId)
  const spaceRoot = resolve(getSpacesDir(), spaceId)
  let info
  try {
    info = await lstat(spaceRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DocumentInventorySpaceNotFoundError(spaceId)
    }
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Space root must be a real directory: ${spaceId}`)
  }
  return spaceRoot
}

async function inspectContainedPath(
  root: string,
  relativePath: string
): Promise<
  | {
      safe: true
      absolutePath: string
      info: Awaited<ReturnType<typeof lstat>>
    }
  | { safe: false; message: string }
> {
  const resolvedRoot = resolve(root)
  let rootInfo
  try {
    rootInfo = await lstat(resolvedRoot)
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      return { safe: false, message: "source root does not exist" }
    }
    throw error
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return {
      safe: false,
      message: "source root must be a real directory",
    }
  }

  let current = resolvedRoot
  let info = rootInfo
  const segments = relativePath.split("/")
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]!)
    try {
      info = await lstat(current)
    } catch (error) {
      if (isMissingFilesystemError(error)) {
        return { safe: false, message: "source locator does not exist" }
      }
      throw error
    }
    if (info.isSymbolicLink()) {
      return {
        safe: false,
        message: "source locator traverses a symbolic link",
      }
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      return {
        safe: false,
        message: "source locator traverses a non-directory",
      }
    }
  }
  return { safe: true, absolutePath: current, info }
}

export function validateDocumentSource(
  spaceRoot: string,
  source: DocumentSource
): { safe: true; absolutePath: string } | { safe: false; message: string } {
  const analysis = analyzeDocumentPath(source.relativePath)
  if (!analysis.safe || !analysis.canonicalPath) {
    return {
      safe: false,
      message: "source locator is not a safe relative path",
    }
  }
  if (
    !(
      source.relativePath.startsWith("docs/") ||
      source.relativePath.startsWith("widgets/")
    )
  ) {
    return {
      safe: false,
      message: "source locator must remain under docs or widgets",
    }
  }
  const absolutePath = resolve(spaceRoot, source.relativePath)
  if (!isInside(resolve(spaceRoot), absolutePath)) {
    return { safe: false, message: "source locator escaped its Space" }
  }
  if (
    source.kind === "bundle" &&
    source.manifestPath !== undefined &&
    source.manifestPath !== `${source.relativePath}/manifest.json`
  ) {
    return {
      safe: false,
      message: "bundle manifest locator must name the bundle's manifest.json",
    }
  }
  return { safe: true, absolutePath }
}

export async function inspectDocumentSource(
  spaceRoot: string,
  source: DocumentSource
): Promise<
  { safe: true; absolutePath: string } | { safe: false; message: string }
> {
  const lexical = validateDocumentSource(spaceRoot, source)
  if (!lexical.safe) return lexical
  const inspected = await inspectContainedPath(spaceRoot, source.relativePath)
  if (!inspected.safe) return inspected
  const correctShape =
    source.kind === "file"
      ? inspected.info.isFile()
      : inspected.info.isDirectory()
  if (!correctShape) {
    return {
      safe: false,
      message: `source locator is not a ${source.kind === "file" ? "regular file" : "directory"}`,
    }
  }
  return { safe: true, absolutePath: inspected.absolutePath }
}

function sourceComparisonKey(source: DocumentSource): string {
  const comparisonKey =
    analyzeDocumentPath(source.relativePath).comparisonKey ??
    source.relativePath
  return `${source.kind}:${comparisonKey}`
}

function parseEntry(
  documentId: string,
  value: unknown,
  spaceRoot: string,
  diagnostics: DocumentInventoryDiagnostic[]
): DocumentInventoryEntry | null {
  if (!DocumentIdSchema.safeParse(documentId).success || !isObject(value)) {
    diagnostics.push({
      severity: "error",
      code: "entry-invalid",
      documentId,
      message: "inventory entry has an invalid document id or object shape",
    })
    return null
  }
  const path = typeof value["path"] === "string" ? value["path"] : null
  const format = DocumentFormatClaimSchema.safeParse(value["format"])
  const source = DocumentSourceSchema.safeParse(value["source"])
  if (!path || !format.success || !source.success) {
    diagnostics.push({
      severity: "error",
      code: "entry-invalid",
      documentId,
      message: "inventory entry is missing a valid path, format, or source",
    })
    return null
  }
  const pathAnalysis = analyzeDocumentPath(path)
  if (!pathAnalysis.safe || !pathAnalysis.canonicalPath) {
    diagnostics.push({
      severity: "error",
      code: "entry-unsafe-path",
      documentId,
      message: "inventory entry has an unsafe logical path",
    })
    return null
  }
  const sourceValidation = validateDocumentSource(spaceRoot, source.data)
  if (!sourceValidation.safe) {
    diagnostics.push({
      severity: "error",
      code: "entry-unsafe-source",
      documentId,
      message: sourceValidation.message,
    })
    return null
  }
  return {
    documentId: documentId as DocumentId,
    path,
    format: format.data,
    source: source.data,
    raw: value,
  }
}

function parseInventoryEntries(
  documents: Record<string, unknown>,
  spaceRoot: string,
  diagnostics: DocumentInventoryDiagnostic[]
): Map<DocumentId, DocumentInventoryEntry> {
  const pairs = Object.entries(documents)
  if (pairs.length > DOCUMENT_INVENTORY_MAX_ENTRIES) {
    diagnostics.push({
      severity: "error",
      code: "inventory-too-many-entries",
      message: "document inventory exceeds its entry limit",
    })
  }
  const entries = new Map<DocumentId, DocumentInventoryEntry>()
  const portableIdOwners = new Map<string, string>()
  const sourceOwners = new Map<string, string>()
  for (const [documentId, value] of pairs.slice(
    0,
    DOCUMENT_INVENTORY_MAX_ENTRIES
  )) {
    const entry = parseEntry(documentId, value, spaceRoot, diagnostics)
    if (!entry) continue
    const portableId = entry.documentId.toLocaleLowerCase("en-US")
    const priorIdOwner = portableIdOwners.get(portableId)
    if (priorIdOwner && priorIdOwner !== entry.documentId) {
      diagnostics.push({
        severity: "error",
        code: "entry-case-colliding-id",
        documentId,
        message: `document ID collides on portable filesystems with ${priorIdOwner}`,
      })
    } else {
      portableIdOwners.set(portableId, entry.documentId)
    }
    const sourceKey = sourceComparisonKey(entry.source)
    const priorOwner = sourceOwners.get(sourceKey)
    if (priorOwner) {
      diagnostics.push({
        severity: "error",
        code: "entry-duplicate-source",
        documentId,
        message: `source locator is already claimed by ${priorOwner}`,
      })
    } else {
      sourceOwners.set(sourceKey, documentId)
    }
    entries.set(entry.documentId, entry)
  }
  return entries
}

export async function readDocumentInventoryAt(
  inventoryPath: string,
  spaceRoot = dirname(inventoryPath)
): Promise<DocumentInventory> {
  const diagnostics: DocumentInventoryDiagnostic[] = []
  let text: string
  try {
    text = await readBoundedRegularFile(
      inventoryPath,
      DOCUMENT_INVENTORY_MAX_BYTES
    )
  } catch (error) {
    if (error instanceof BoundedFileReadError && error.reason === "missing") {
      return emptyInventory()
    }
    const code =
      error instanceof BoundedFileReadError && error.reason === "too-large"
        ? "inventory-too-large"
        : error instanceof BoundedFileReadError &&
            (error.reason === "symlink" || error.reason === "not-file")
          ? "inventory-not-file"
          : "inventory-invalid-json"
    return {
      ...emptyInventory(),
      exists: true,
      diagnostics: [
        {
          severity: "error",
          code,
          message:
            code === "inventory-too-large"
              ? "document inventory exceeds its size limit"
              : code === "inventory-not-file"
                ? "document inventory must be a regular file"
                : "document inventory could not be read consistently",
        },
      ],
    }
  }

  let raw: unknown
  const hasLossyNumber = containsJsonNumberThatChangesOnRewrite(text)
  try {
    raw = JSON.parse(text)
  } catch {
    return {
      ...emptyInventory(),
      exists: true,
      diagnostics: [
        {
          severity: "error",
          code: "inventory-invalid-json",
          message: "document inventory is not valid JSON",
        },
      ],
    }
  }
  if (
    !isObject(raw) ||
    raw["type"] !== "worktable.document-inventory" ||
    raw["version"] !== 1
  ) {
    return {
      ...emptyInventory(),
      exists: true,
      raw: isObject(raw) ? raw : emptyInventory().raw,
      diagnostics: [
        {
          severity: "error",
          code: "inventory-invalid-header",
          message: "document inventory has an unsupported type or version",
        },
      ],
    }
  }
  if (hasLossyNumber) {
    diagnostics.push({
      severity: "error",
      code: "inventory-lossy-number",
      message:
        "document inventory contains a number that cannot be preserved exactly",
    })
  }
  const documents = raw["documents"]
  if (!isObject(documents)) {
    diagnostics.push({
      severity: "error",
      code: "inventory-invalid-documents",
      message: "document inventory documents must be an object",
    })
    return {
      type: "worktable.document-inventory",
      version: 1,
      entries: new Map(),
      raw,
      exists: true,
      diagnostics,
    }
  }
  const entries = parseInventoryEntries(documents, spaceRoot, diagnostics)
  return {
    type: "worktable.document-inventory",
    version: 1,
    entries,
    raw,
    exists: true,
    diagnostics,
  }
}

export async function readDocumentInventory(
  spaceId: string
): Promise<DocumentInventory> {
  const spaceRoot = await requireRealInventorySpaceRoot(spaceId)
  return readDocumentInventoryAt(getDocumentInventoryPath(spaceId), spaceRoot)
}

export function mintDocumentId(): DocumentId {
  return `doc_${randomBytes(16).toString("base64url")}` as DocumentId
}

export interface DocumentInventoryMutation {
  upsert?: Array<
    Omit<DocumentInventoryEntry, "raw"> & { raw?: Record<string, unknown> }
  >
  remove?: DocumentId[]
}

interface InventorySpaceRootIdentity {
  dev: number
  ino: number
}

async function requireInventorySpaceRootIdentity(
  spaceRoot: string,
  expected?: InventorySpaceRootIdentity
): Promise<InventorySpaceRootIdentity> {
  const info = await lstat(spaceRoot)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("document inventory Space root must be a real directory")
  }
  const identity = { dev: info.dev, ino: info.ino }
  if (
    expected &&
    (identity.dev !== expected.dev || identity.ino !== expected.ino)
  ) {
    throw new Error("document inventory Space root changed before write")
  }
  return identity
}

function prepareInventoryMutation(
  current: DocumentInventory,
  spaceRoot: string,
  mutation: DocumentInventoryMutation
): string {
  if (
    current.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new Error("cannot update an invalid document inventory")
  }
  const raw = cloneJson(current.raw)
  raw["type"] = "worktable.document-inventory"
  raw["version"] = 1
  const documents = isObject(raw["documents"]) ? raw["documents"] : {}
  raw["documents"] = documents

  for (const documentId of mutation.remove ?? []) delete documents[documentId]
  for (const entry of mutation.upsert ?? []) {
    const validatedId = DocumentIdSchema.parse(entry.documentId)
    const pathAnalysis = analyzeDocumentPath(entry.path)
    if (!pathAnalysis.safe || !pathAnalysis.canonicalPath) {
      throw new Error(`unsafe document path for ${validatedId}`)
    }
    const format = DocumentFormatClaimSchema.parse(entry.format)
    const source = DocumentSourceSchema.parse(entry.source)
    const sourceValidation = validateDocumentSource(spaceRoot, source)
    if (!sourceValidation.safe) throw new Error(sourceValidation.message)
    const prior = isObject(documents[validatedId])
      ? documents[validatedId]
      : (entry.raw ?? {})
    const priorFormat = isObject(prior["format"]) ? prior["format"] : {}
    const priorSource = isObject(prior["source"]) ? prior["source"] : {}
    const formatBase = priorFormat["id"] === format.id ? priorFormat : {}
    const sourceBase =
      priorSource["kind"] === source.kind &&
      priorSource["relativePath"] === source.relativePath
        ? priorSource
        : {}
    documents[validatedId] = {
      ...prior,
      path: entry.path,
      format: { ...formatBase, ...format },
      source: { ...sourceBase, ...source },
    }
  }
  if (Object.keys(documents).length > DOCUMENT_INVENTORY_MAX_ENTRIES) {
    throw new Error("document inventory exceeds its entry limit")
  }
  const proposedDiagnostics: DocumentInventoryDiagnostic[] = []
  parseInventoryEntries(documents, spaceRoot, proposedDiagnostics)
  if (
    proposedDiagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new Error("cannot write an invalid document inventory")
  }
  const serialized = serializeInventory(raw)
  if (Buffer.byteLength(serialized) > DOCUMENT_INVENTORY_MAX_BYTES) {
    throw new Error("document inventory exceeds its size limit")
  }
  return serialized
}

/** Validate the complete serialized mutation without changing the inventory. */
export async function validateDocumentInventoryMutationAt(
  spaceRoot: string,
  mutation: DocumentInventoryMutation
): Promise<void> {
  const inventoryPath = resolve(spaceRoot, "documents.meta.json")
  const current = await readDocumentInventoryAt(inventoryPath, spaceRoot)
  prepareInventoryMutation(current, spaceRoot, mutation)
}

export async function validateDocumentInventoryMutation(
  spaceId: string,
  mutation: DocumentInventoryMutation
): Promise<void> {
  const spaceRoot = await requireRealInventorySpaceRoot(spaceId)
  await validateDocumentInventoryMutationAt(spaceRoot, mutation)
}

/**
 * Prepare the exact lossless inventory bytes for a later transactional
 * publication. Lifecycle journals use this to checkpoint before/after bytes
 * without publishing a partial multi-file move.
 */
export async function prepareDocumentInventoryMutationAt(
  spaceRoot: string,
  mutation: DocumentInventoryMutation
): Promise<string> {
  const inventoryPath = resolve(spaceRoot, "documents.meta.json")
  const current = await readDocumentInventoryAt(inventoryPath, spaceRoot)
  return prepareInventoryMutation(current, spaceRoot, mutation)
}

/**
 * Apply a lossless inventory mutation at an explicitly validated Space root.
 * The caller must provide an existing real directory, never a symbolic link.
 * Staged workspace migrations use this without publishing live-workspace
 * events; the normal Space-scoped wrapper below remains the runtime API.
 */
export async function updateDocumentInventoryAt(
  spaceRoot: string,
  mutation: DocumentInventoryMutation,
  options: {
    expectedSpaceRootIdentity?: InventorySpaceRootIdentity
  } = {}
): Promise<DocumentInventory> {
  const inventoryPath = resolve(spaceRoot, "documents.meta.json")
  return withStoreWriteLock(inventoryPath, async () => {
    const initialIdentity = await requireInventorySpaceRootIdentity(
      spaceRoot,
      options.expectedSpaceRootIdentity
    )
    const current = await readDocumentInventoryAt(inventoryPath, spaceRoot)
    const serialized = prepareInventoryMutation(current, spaceRoot, mutation)
    // Bind publication to the Space directory observed before preparation.
    // This refuses ordinary concurrent parent or Space replacement immediately
    // before atomicWriteText creates its sibling temporary file.
    await requireInventorySpaceRootIdentity(spaceRoot, initialIdentity)
    await atomicWriteText(inventoryPath, serialized)
    return readDocumentInventoryAt(inventoryPath, spaceRoot)
  })
}

export async function updateDocumentInventory(
  spaceId: string,
  mutation: DocumentInventoryMutation
): Promise<DocumentInventory> {
  const spaceRoot = await requireRealInventorySpaceRoot(spaceId)
  const updated = await updateDocumentInventoryAt(spaceRoot, mutation)
  notifyWorkspaceChange({ type: "documentCorpus", spaceId })
  return updated
}

export async function readDocumentBundleManifest(
  bundleRoot: string,
  signal?: AbortSignal
): Promise<{
  manifest: DocumentBundleManifest | null
  diagnostics: DocumentInventoryDiagnostic[]
}> {
  const diagnostics: DocumentInventoryDiagnostic[] = []
  let bundleInfo
  try {
    bundleInfo = await lstat(bundleRoot)
  } catch {
    return {
      manifest: null,
      diagnostics: [
        {
          severity: "error",
          code: "bundle-not-directory",
          message: "document bundle does not exist",
        },
      ],
    }
  }
  if (bundleInfo.isSymbolicLink()) {
    return {
      manifest: null,
      diagnostics: [
        {
          severity: "error",
          code: "bundle-symlink",
          message: "document bundle cannot be a symbolic link",
        },
      ],
    }
  }
  if (!bundleInfo.isDirectory()) {
    return {
      manifest: null,
      diagnostics: [
        {
          severity: "error",
          code: "bundle-not-directory",
          message: "document bundle must be a directory",
        },
      ],
    }
  }

  const manifestPath = resolve(bundleRoot, "manifest.json")
  let manifestText: string
  try {
    manifestText = await readBoundedRegularFile(
      manifestPath,
      DOCUMENT_BUNDLE_MANIFEST_MAX_BYTES,
      signal
    )
  } catch (error) {
    const reason =
      error instanceof BoundedFileReadError ? error.reason : "unreadable"
    const code =
      reason === "missing"
        ? "bundle-manifest-missing"
        : reason === "too-large"
          ? "bundle-manifest-too-large"
          : reason === "symlink" || reason === "not-file"
            ? "bundle-manifest-not-file"
            : "bundle-manifest-invalid"
    return {
      manifest: null,
      diagnostics: [
        {
          severity: "error",
          code,
          message:
            code === "bundle-manifest-missing"
              ? "document bundle is missing manifest.json"
              : code === "bundle-manifest-too-large"
                ? "bundle manifest exceeds its size limit"
                : code === "bundle-manifest-not-file"
                  ? "bundle manifest must be a regular file"
                  : "bundle manifest could not be read consistently",
        },
      ],
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(manifestText)
  } catch {
    raw = null
  }
  if (
    !isObject(raw) ||
    raw["type"] !== "worktable.document-bundle" ||
    raw["version"] !== 1 ||
    !DocumentIdSchema.safeParse(raw["documentId"]).success ||
    !DocumentFormatClaimSchema.safeParse(raw["format"]).success ||
    typeof raw["content"] !== "string"
  ) {
    diagnostics.push({
      severity: "error",
      code: "bundle-manifest-invalid",
      message: "bundle manifest has an invalid core contract",
    })
    return { manifest: null, diagnostics }
  }
  const contentAnalysis = analyzeDocumentPath(raw["content"])
  const contentPath = resolve(bundleRoot, raw["content"])
  if (
    !contentAnalysis.safe ||
    !contentAnalysis.portable ||
    contentAnalysis.canonicalPath !== raw["content"] ||
    !isInside(resolve(bundleRoot), contentPath)
  ) {
    diagnostics.push({
      severity: "error",
      code: "bundle-content-unsafe",
      message:
        "bundle content locator escaped, is nonportable, or is not canonical",
    })
    return { manifest: null, diagnostics }
  }
  const inspectedContent = await inspectContainedPath(
    bundleRoot,
    raw["content"]
  )
  if (!inspectedContent.safe) {
    diagnostics.push({
      severity: "error",
      code: inspectedContent.message.includes("symbolic link")
        ? "bundle-content-unsafe"
        : "bundle-content-missing",
      message: inspectedContent.message,
    })
    return { manifest: null, diagnostics }
  }
  const contentInfo = inspectedContent.info
  if (!contentInfo.isFile() || contentInfo.isSymbolicLink()) {
    diagnostics.push({
      severity: "error",
      code: "bundle-content-not-file",
      message: "bundle content must be a regular file",
    })
    return { manifest: null, diagnostics }
  }

  return {
    manifest: {
      type: "worktable.document-bundle",
      version: 1,
      documentId: raw["documentId"] as DocumentId,
      format: DocumentFormatClaimSchema.parse(raw["format"]),
      content: raw["content"],
      raw,
    },
    diagnostics,
  }
}
