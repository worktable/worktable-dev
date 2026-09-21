import type {
  DocumentFormatClaim,
  DocumentGenerationManifestV2,
  DocumentId,
  DocumentProvenance,
} from "@worktable/types"
import {
  sourceCategory,
  WidgetFileSchema,
  type WidgetFile,
} from "@worktable/types"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  BUILTIN_DOCUMENT_COMPANIONS,
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import { updateDocumentInventory } from "./document-inventory.ts"
import {
  listCompatibleDocumentVersionsV2,
  listDocumentGenerationsV2,
  markDocumentGenerationCheckpointV2,
  readDocumentGenerationV2,
  writeDocumentGenerationV2,
  type DocumentGenerationPayloadSource,
  type DocumentGenerationPayloadCompanion,
} from "./document-version-store-v2.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import {
  automaticCheckpointLabel,
  listVersionEntries,
  markVersionCheckpoint,
  mintVersionId,
  readVersionSnapshot,
  stableVersionHash,
  type VersionCheckpoint,
  type VersionEntry,
  type VersionSnapshotBase,
} from "./version-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { readWorkspaceStorageLayoutAt } from "./workspace-storage-v2.ts"
import { parseCanonicalYaml } from "./yaml.ts"
import { pruneDocumentGenerationsForCountV2 } from "./version-retention.ts"

type LegacyKind = "docs" | "widgets"

interface CompatibleOwner {
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
}

interface LegacyDocContent {
  data: unknown
  format: string | null
  storedAs: "md" | "json" | null
  error: string | null
}

interface LegacyWidgetContent {
  html: string
  widget: {
    name: string
    description?: string
    permissions: unknown
    metadata: Record<string, unknown>
    runtime: unknown
  }
  authoredSource?: {
    htmlBytes: Uint8Array
    widgetYamlBytes?: Uint8Array
  }
}

interface LegacyDocSnapshotCompatibility extends VersionSnapshotBase {
  docPath: string
}

interface LegacyWidgetSnapshotCompatibility extends VersionSnapshotBase {
  widgetId: string
}

interface RecordOptions {
  documentId?: DocumentId
  force?: boolean
  operation?: "create" | "update" | "checkpoint"
  checkpoint?: VersionCheckpoint
}

function sameSemanticContent(left: unknown, right: unknown): boolean {
  return stableVersionHash(left) === stableVersionHash(right)
}

function missingManifest(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  const reason = (error as { reason?: string }).reason
  return code === "ENOENT" || code === "ENOTDIR" || reason === "missing"
}

/** Runtime workspaces always have a manifest; missing manifests are V1 fixtures. */
export async function usesDocumentVersionStoreV2(): Promise<boolean> {
  try {
    return (
      (await readWorkspaceStorageLayoutAt(getWorkspaceRoot())).kind === "v2"
    )
  } catch (error) {
    if (missingManifest(error)) return false
    throw error
  }
}

function comparisonKey(path: string): string | null {
  return analyzeDocumentPath(path).comparisonKey
}

async function resolveOwner(
  spaceId: string,
  path: string,
  expectedFormats: readonly string[]
): Promise<CompatibleOwner | null> {
  const requestedKey = comparisonKey(path)
  if (!requestedKey) return null
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
  })
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.kind === "document" &&
      comparisonKey(candidate.descriptor.path) === requestedKey
  )
  if (
    !entry ||
    entry.kind !== "document" ||
    entry.handle.identity !== "durable" ||
    !expectedFormats.includes(entry.descriptor.format.id)
  ) {
    return null
  }
  return {
    documentId: entry.handle.documentId,
    path: entry.descriptor.path,
    format: entry.descriptor.format,
  }
}

function checkpointForCompatibility(
  manifest: DocumentGenerationManifestV2
): VersionCheckpoint | undefined {
  const checkpoint = manifest.checkpoint
  if (!checkpoint) return undefined
  return {
    meaningful: checkpoint.meaningful,
    kind: checkpoint.kind,
    ...(checkpoint.label ? { label: checkpoint.label } : {}),
    sourceCategory:
      checkpoint.sourceCategory ??
      sourceCategory(manifest.source, manifest.createdBy),
    ...(checkpoint.transition ? { transition: checkpoint.transition } : {}),
  }
}

function publicV2Entry(input: {
  manifest: DocumentGenerationManifestV2
  format: string
  storedAs: string
}): VersionEntry {
  const checkpoint = checkpointForCompatibility(input.manifest)
  return {
    id: input.manifest.id,
    createdAt: input.manifest.createdAt,
    createdBy: input.manifest.createdBy,
    source: input.manifest.source,
    ...(input.manifest.reason ? { reason: input.manifest.reason } : {}),
    operation: input.manifest.operation,
    before: null,
    after: {
      format: input.format,
      storedAs: input.storedAs,
      contentHash:
        input.manifest.provenance?.contentHash ?? input.manifest.contentHash,
    },
    ...(checkpoint ? { checkpoint } : {}),
  }
}

function compareNewest(
  left: { id: string; createdAt: string },
  right: { id: string; createdAt: string }
): number {
  const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt)
  return byTime || right.id.localeCompare(left.id)
}

function docFormat(
  content: LegacyDocContent,
  exactBytes?: Uint8Array
): {
  claim: DocumentFormatClaim
  format: "markdown" | "blocknote"
  storedAs: "md" | "json"
  payload: DocumentGenerationPayloadSource
} {
  if (content.storedAs === "md" && typeof content.data === "string") {
    const bytes = exactBytes ?? new TextEncoder().encode(content.data)
    if (
      new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== content.data
    ) {
      throw new Error("captured Markdown bytes disagree with parsed content")
    }
    return {
      claim: { id: BUILTIN_DOCUMENT_FORMATS.markdown, sourceVersion: 1 },
      format: "markdown",
      storedAs: "md",
      payload: {
        kind: "file",
        entries: [
          {
            path: "document.md",
            bytes,
          },
        ],
      },
    }
  }
  if (content.storedAs === "json" && Array.isArray(content.data)) {
    const bytes =
      exactBytes ??
      new TextEncoder().encode(JSON.stringify(content.data, null, 2))
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ) as unknown
    if (!Array.isArray(parsed) || !sameSemanticContent(parsed, content.data)) {
      throw new Error("captured rich-text bytes disagree with parsed content")
    }
    return {
      claim: { id: BUILTIN_DOCUMENT_FORMATS.richText, sourceVersion: 1 },
      format: "blocknote",
      storedAs: "json",
      payload: {
        kind: "file",
        entries: [
          {
            path: "document.json",
            bytes,
          },
        ],
      },
    }
  }
  throw new Error(
    "legacy Doc content cannot be captured as an exact generation"
  )
}

function widgetPayload(
  content: LegacyWidgetContent
): {
  payload: DocumentGenerationPayloadSource
  companions: DocumentGenerationPayloadCompanion[]
} {
  const exact = content.authoredSource
  if (exact) {
    const html = new TextDecoder("utf-8", { fatal: true }).decode(
      exact.htmlBytes
    )
    const parsed = exact.widgetYamlBytes
      ? WidgetFileSchema.parse(
          parseCanonicalYaml(
            new TextDecoder("utf-8", { fatal: true }).decode(exact.widgetYamlBytes)
          )
        )
      : null
    if (
      html !== content.html ||
      (parsed && !sameSemanticContent(versionableWidget(parsed), content.widget))
    ) {
      throw new Error("captured HTML source disagrees with parsed content")
    }
  }
  return {
    payload: {
      kind: "file",
      entries: [
        {
          path: "document.html",
          bytes: exact?.htmlBytes ?? new TextEncoder().encode(content.html),
        },
      ],
    },
    companions: [
      {
        key: BUILTIN_DOCUMENT_COMPANIONS.htmlPermissions,
        entries: [
          {
            path: "properties.json",
            bytes: new TextEncoder().encode(
              JSON.stringify(content.widget, null, 2)
            ),
          },
        ],
      },
    ],
  }
}

function versionableWidget(widget: WidgetFile): LegacyWidgetContent["widget"] {
  return {
    name: widget.name,
    ...(widget.description !== undefined
      ? { description: widget.description }
      : {}),
    permissions: widget.permissions,
    metadata: widget.metadata,
    runtime: widget.runtime,
  }
}

async function markAutomaticSourceTransition(input: {
  spaceId: string
  path: string
  documentId: DocumentId
  legacyKind: LegacyKind
  previousProvenance?: DocumentProvenance
  currentProvenance: DocumentProvenance
}): Promise<void> {
  const previous = input.previousProvenance
  if (!previous) return
  const checkpoint = automaticSourceTransition(
    previous,
    input.currentProvenance
  )
  if (!checkpoint) return
  const marked = await markDocumentGenerationCheckpointV2({
    workspaceRoot: getWorkspaceRoot(),
    spaceId: input.spaceId,
    documentId: input.documentId,
    generationId: previous.versionId,
    checkpoint,
  })
  if (!marked) {
    await markVersionCheckpoint(
      input.spaceId,
      input.legacyKind,
      input.path,
      previous.versionId,
      checkpoint
    )
  }
}

function automaticSourceTransition(
  previous: DocumentProvenance,
  current: DocumentProvenance
): VersionCheckpoint | null {
  if (previous.contentHash === current.contentHash) return null
  const from = sourceCategory(previous.source, previous.updatedBy)
  const to = sourceCategory(current.source, current.updatedBy)
  if (from === to) return null
  return {
    meaningful: true,
    kind:
      from === "restore" || to === "restore" ? "restore" : "source-transition",
    label: automaticCheckpointLabel(from, to),
    sourceCategory: from,
    transition: { from, to },
  }
}

async function hasCompatibleHistory(input: {
  spaceId: string
  documentId: DocumentId
  path: string
  legacyKind: LegacyKind
}): Promise<boolean> {
  const versions = await listCompatibleDocumentVersionsV2({
    workspaceRoot: getWorkspaceRoot(),
    spaceId: input.spaceId,
    documentId: input.documentId,
    legacy: { kind: input.legacyKind, key: input.path },
  })
  return versions.length > 0
}

async function writeGeneration(input: {
  spaceId: string
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
  payload: DocumentGenerationPayloadSource
  companions?: DocumentGenerationPayloadCompanion[]
  operation: "create" | "update" | "checkpoint"
  createdAt: string
  createdBy: string
  source: string
  reason?: string
  checkpoint?: VersionCheckpoint
  contentHash: string
  previousProvenance?: DocumentProvenance
}): Promise<DocumentProvenance> {
  const versionId = mintVersionId(input.createdAt)
  const provenance: DocumentProvenance = {
    updatedAt: input.createdAt,
    updatedBy: input.createdBy,
    source: input.source,
    versionId,
    contentHash: input.contentHash,
  }
  const previousCheckpoint = input.previousProvenance
    ? automaticSourceTransition(input.previousProvenance, provenance)
    : null
  await writeDocumentGenerationV2({
    workspaceRoot: getWorkspaceRoot(),
    spaceId: input.spaceId,
    documentId: input.documentId,
    generationId: versionId,
    logicalPath: input.path,
    format: input.format,
    operation: input.operation,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    source: input.source,
    ...(input.reason ? { reason: input.reason } : {}),
    provenance,
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    ...(input.previousProvenance && previousCheckpoint
      ? {
          previousGenerationCheckpoint: {
            generationId: input.previousProvenance.versionId,
            checkpoint: previousCheckpoint,
          },
        }
      : {}),
    authoredSource: input.payload,
    ...(input.companions ? { companions: input.companions } : {}),
    registry: createBuiltinDocumentFormatRegistry(),
  })
  return provenance
}

async function writeBaseline(input: {
  spaceId: string
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
  payload: DocumentGenerationPayloadSource
  companions?: DocumentGenerationPayloadCompanion[]
  createdAt: string
  contentHash: string
}): Promise<void> {
  await writeGeneration({
    ...input,
    operation: "create",
    createdBy: "system",
    source: "filesystem",
    reason: "Pre-tracking baseline",
    checkpoint: {
      meaningful: true,
      kind: "system",
      label: "Pre-tracking baseline",
      sourceCategory: "external",
    },
  })
}

/**
 * Managed legacy creates publish their source before version capture. Bind the
 * minted owner at that first post-source boundary so a process interruption
 * can never strand the generation under an ID that discovery cannot recover.
 * Existing writes are idempotent upserts, including format transitions whose
 * lifecycle journal already published the same claim.
 */
async function materializeManagedLegacyOwner(input: {
  spaceId: string
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
  kind: LegacyKind
}): Promise<void> {
  const source =
    input.kind === "widgets"
      ? ({ kind: "file", relativePath: `docs/${input.path}.html` } as const)
      : ({
          kind: "file",
          relativePath: `docs/${input.path}${
            input.format.id === BUILTIN_DOCUMENT_FORMATS.markdown
              ? ".md"
              : ".json"
          }`,
        } as const)
  await updateDocumentInventory(input.spaceId, {
    upsert: [
      {
        documentId: input.documentId,
        path: input.path,
        format: input.format,
        source,
      },
    ],
  })
}

export async function recordLegacyDocVersionV2(input: {
  spaceId: string
  path: string
  before: LegacyDocContent | null
  after: LegacyDocContent
  updatedBy: string
  source: string
  reason?: string
  options?: RecordOptions
  contentHash: string
  baselineRequired?: boolean
  beforeBytes?: Uint8Array
  afterBytes?: Uint8Array
  previousProvenance?: DocumentProvenance
}): Promise<DocumentProvenance | undefined> {
  const after = docFormat(input.after, input.afterBytes)
  const owner = input.options?.documentId
    ? {
        documentId: input.options.documentId,
        path: input.path,
        format: after.claim,
      }
    : await resolveOwner(input.spaceId, input.path, [
        BUILTIN_DOCUMENT_FORMATS.markdown,
        BUILTIN_DOCUMENT_FORMATS.richText,
      ])
  if (!owner) return undefined
  if (input.options?.documentId && input.before === null) {
    await materializeManagedLegacyOwner({
      spaceId: input.spaceId,
      documentId: owner.documentId,
      path: owner.path,
      format: owner.format,
      kind: "docs",
    })
  }
  if (
    input.before &&
    (input.baselineRequired ||
      !(await hasCompatibleHistory({
        spaceId: input.spaceId,
        documentId: owner.documentId,
        path: owner.path,
        legacyKind: "docs",
      })))
  ) {
    const baseline = docFormat(input.before, input.beforeBytes)
    await writeBaseline({
      spaceId: input.spaceId,
      documentId: owner.documentId,
      path: owner.path,
      format: baseline.claim,
      payload: baseline.payload,
      createdAt: new Date(Date.now() - 1).toISOString(),
      contentHash: stableVersionHash(input.before.data),
    })
  }
  const createdAt = new Date().toISOString()
  const provenance = await writeGeneration({
    spaceId: input.spaceId,
    documentId: owner.documentId,
    path: owner.path,
    format: after.claim,
    payload: after.payload,
    operation:
      input.options?.operation ?? (input.before === null ? "create" : "update"),
    createdAt,
    createdBy: input.updatedBy,
    source: input.source,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.options?.checkpoint
      ? { checkpoint: input.options.checkpoint }
      : {}),
    contentHash: input.contentHash,
    previousProvenance: input.previousProvenance,
  })
  await markAutomaticSourceTransition({
    spaceId: input.spaceId,
    path: owner.path,
    documentId: owner.documentId,
    legacyKind: "docs",
    previousProvenance: input.previousProvenance,
    currentProvenance: provenance,
  })
  await pruneDocumentGenerationsForCountV2(
    input.spaceId,
    owner.documentId
  ).catch((error) => {
    console.warn("[document-versions] V2 retention cleanup failed:", error)
  })
  return provenance
}

export async function recordLegacyWidgetVersionV2(input: {
  spaceId: string
  path: string
  before: LegacyWidgetContent | null
  after: LegacyWidgetContent
  updatedBy: string
  source: string
  reason?: string
  options?: RecordOptions
  contentHash: string
  baselineRequired?: boolean
  previousProvenance?: DocumentProvenance
}): Promise<DocumentProvenance | undefined> {
  const owner = input.options?.documentId
    ? {
        documentId: input.options.documentId,
        path: input.path,
        format: { id: BUILTIN_DOCUMENT_FORMATS.html, sourceVersion: 1 },
      }
    : await resolveOwner(input.spaceId, input.path, [
        BUILTIN_DOCUMENT_FORMATS.html,
      ])
  if (!owner) return undefined
  if (input.options?.documentId && input.before === null) {
    await materializeManagedLegacyOwner({
      spaceId: input.spaceId,
      documentId: owner.documentId,
      path: owner.path,
      format: owner.format,
      kind: "widgets",
    })
  }
  if (
    input.before &&
    (input.baselineRequired ||
      !(await hasCompatibleHistory({
        spaceId: input.spaceId,
        documentId: owner.documentId,
        path: owner.path,
        legacyKind: "widgets",
      })))
  ) {
    const before = widgetPayload(input.before)
    await writeBaseline({
      spaceId: input.spaceId,
      documentId: owner.documentId,
      path: owner.path,
      format: owner.format,
      payload: before.payload,
      companions: before.companions,
      createdAt: new Date(Date.now() - 1).toISOString(),
      contentHash: stableVersionHash(input.before),
    })
  }
  const after = widgetPayload(input.after)
  const provenance = await writeGeneration({
    spaceId: input.spaceId,
    documentId: owner.documentId,
    path: owner.path,
    format: owner.format,
    payload: after.payload,
    companions: after.companions,
    operation:
      input.options?.operation ?? (input.before === null ? "create" : "update"),
    createdAt: new Date().toISOString(),
    createdBy: input.updatedBy,
    source: input.source,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.options?.checkpoint
      ? { checkpoint: input.options.checkpoint }
      : {}),
    contentHash: input.contentHash,
    previousProvenance: input.previousProvenance,
  })
  await markAutomaticSourceTransition({
    spaceId: input.spaceId,
    path: owner.path,
    documentId: owner.documentId,
    legacyKind: "widgets",
    previousProvenance: input.previousProvenance,
    currentProvenance: provenance,
  })
  await pruneDocumentGenerationsForCountV2(
    input.spaceId,
    owner.documentId
  ).catch((error) => {
    console.warn("[document-versions] V2 retention cleanup failed:", error)
  })
  return provenance
}

function docRepresentation(format: DocumentFormatClaim): {
  format: "markdown" | "blocknote"
  storedAs: "md" | "json"
} {
  if (format.id === BUILTIN_DOCUMENT_FORMATS.markdown) {
    return { format: "markdown", storedAs: "md" }
  }
  if (format.id === BUILTIN_DOCUMENT_FORMATS.richText) {
    return { format: "blocknote", storedAs: "json" }
  }
  throw new Error("V2 generation is not compatible with the Doc API")
}

export async function listLegacyDocVersionsV2(
  spaceId: string,
  path: string,
  options?: { checkpointsOnly?: boolean }
): Promise<VersionEntry[]> {
  const owner = await resolveOwner(spaceId, path, [
    BUILTIN_DOCUMENT_FORMATS.markdown,
    BUILTIN_DOCUMENT_FORMATS.richText,
  ])
  if (!owner) return []
  const [current, legacy] = await Promise.all([
    listDocumentGenerationsV2({
      workspaceRoot: getWorkspaceRoot(),
      spaceId,
      documentId: owner.documentId,
      checkpointsOnly: options?.checkpointsOnly,
    }),
    listVersionEntries(spaceId, "docs", owner.path, options),
  ])
  return [
    ...current.map((manifest) =>
      publicV2Entry({ manifest, ...docRepresentation(manifest.format) })
    ),
    ...legacy,
  ].sort(compareNewest)
}

export async function readLegacyDocVersionV2(
  spaceId: string,
  path: string,
  versionId: string
): Promise<LegacyDocSnapshotCompatibility | null> {
  const owner = await resolveOwner(spaceId, path, [
    BUILTIN_DOCUMENT_FORMATS.markdown,
    BUILTIN_DOCUMENT_FORMATS.richText,
  ])
  if (!owner) return null
  const generation = await readDocumentGenerationV2({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    documentId: owner.documentId,
    generationId: versionId,
  })
  if (!generation) {
    return readVersionSnapshot<LegacyDocSnapshotCompatibility>(
      spaceId,
      "docs",
      owner.path,
      versionId
    )
  }
  if (
    generation.authoredSource.kind !== "file" ||
    generation.authoredSource.entries.length !== 1
  ) {
    throw new Error("V2 generation is not compatible with the Doc API")
  }
  const representation = docRepresentation(generation.manifest.format)
  const bytes = generation.authoredSource.entries[0]!.bytes
  const content =
    representation.storedAs === "md"
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  return {
    type: "worktable.doc-version",
    version: 1,
    spaceId,
    docPath: owner.path,
    ...publicV2Entry({
      manifest: generation.manifest,
      ...representation,
    }),
    before: null,
    after: {
      format: representation.format,
      storedAs: representation.storedAs,
      contentHash:
        generation.manifest.provenance?.contentHash ??
        generation.manifest.contentHash,
      content,
    },
  }
}

export async function listLegacyWidgetVersionsV2(
  spaceId: string,
  path: string,
  options?: { checkpointsOnly?: boolean }
): Promise<VersionEntry[]> {
  const owner = await resolveOwner(spaceId, path, [
    BUILTIN_DOCUMENT_FORMATS.html,
  ])
  if (!owner) return []
  const [current, legacy] = await Promise.all([
    listDocumentGenerationsV2({
      workspaceRoot: getWorkspaceRoot(),
      spaceId,
      documentId: owner.documentId,
      checkpointsOnly: options?.checkpointsOnly,
    }),
    listVersionEntries(spaceId, "widgets", owner.path, options),
  ])
  const seen = new Set<string>()
  return [
    ...current.map((manifest) =>
      publicV2Entry({ manifest, format: "html", storedAs: "html" })
    ),
    ...legacy,
  ].filter((entry) => {
      if (seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })
    .sort(compareNewest)
}

export async function readLegacyWidgetVersionV2(
  spaceId: string,
  path: string,
  versionId: string
): Promise<LegacyWidgetSnapshotCompatibility | null> {
  const owner = await resolveOwner(spaceId, path, [
    BUILTIN_DOCUMENT_FORMATS.html,
  ])
  if (!owner) return null
  const generation = await readDocumentGenerationV2({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    documentId: owner.documentId,
    generationId: versionId,
  })
  if (!generation) {
    return readVersionSnapshot<LegacyWidgetSnapshotCompatibility>(
      spaceId,
      "widgets",
      owner.path,
      versionId
    )
  }
  const html = generation.authoredSource.entries.find(
    (entry) =>
      generation.authoredSource.kind === "file"
        ? entry.path === "document.html"
        : entry.path === "index.html"
  )
  const widget = generation.authoredSource.kind === "bundle"
    ? generation.authoredSource.entries.find(
        (entry) => entry.path === "widget.json"
      )
    : generation.companions
        .find(
          (companion) =>
            companion.key === BUILTIN_DOCUMENT_COMPANIONS.htmlPermissions
        )
        ?.entries.find((entry) => entry.path === "properties.json")
  if (!html || !widget) {
    throw new Error("V2 HTML generation is incomplete")
  }
  const widgetText = new TextDecoder("utf-8", { fatal: true }).decode(
    widget.bytes
  )
  const parsedWidget =
    widget.path === "widget.json"
      ? (JSON.parse(widgetText) as LegacyWidgetContent["widget"])
      : parseCanonicalYaml(widgetText)
  const fullWidget = WidgetFileSchema.safeParse(parsedWidget)
  const content: LegacyWidgetContent = {
    html: new TextDecoder("utf-8", { fatal: true }).decode(html.bytes),
    widget: fullWidget.success
      ? versionableWidget(fullWidget.data)
      : (parsedWidget as LegacyWidgetContent["widget"]),
  }
  return {
    type: "worktable.widget-version",
    version: 1,
    spaceId,
    widgetId: owner.path,
    ...publicV2Entry({
      manifest: generation.manifest,
      format: "html",
      storedAs: "html",
    }),
    before: null,
    after: {
      format: "html",
      storedAs: "html",
      contentHash:
        generation.manifest.provenance?.contentHash ??
        generation.manifest.contentHash,
      content,
    },
  }
}
