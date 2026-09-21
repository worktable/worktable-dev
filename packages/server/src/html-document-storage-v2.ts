import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  WidgetFileSchema,
  WidgetPermissionsSchema,
  type DocumentId,
  type WidgetFile,
} from "@worktable/types"
import { atomicWriteText } from "./atomic-file.ts"
import { BoundedFileReadError } from "./bounded-file.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  readDocumentPortableStateV2,
  writeDocumentPortableStateV2,
} from "./document-data-v2.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import { DOCUMENT_STORAGE_PROFILE_IDS } from "./document-storage-profile.ts"
import {
  DOCUMENT_GENERATION_MAX_ENTRY_BYTES,
  type DocumentGenerationPayloadEntry,
} from "./document-version-store-v2.ts"
import { readBoundedRegularFileBytes } from "./bounded-file.ts"
import { mapWithConcurrency } from "./bounded-concurrency.ts"
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts"
import { getDocArchiveInfo } from "./store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import {
  ensureRealDocumentStorageDirectory,
  readWorkspaceStorageLayoutAt,
} from "./workspace-storage-v2.ts"

export const HTML_DOCUMENT_PROPERTIES_ENTRY = "html/properties.json"
export const HTML_DOCUMENT_RUNTIME_STATE_ENTRY = "html/runtime-state.json"
export const HTML_DOCUMENT_LEGACY_COMPANION_PREFIX = "html/legacy-companions/"
export const HTML_DOCUMENT_PORTABLE_STATE_VERSION = 1

const HTML_FORMAT = {
  id: BUILTIN_DOCUMENT_FORMATS.html,
  sourceVersion: 1,
} as const

const DENIED_PERMISSIONS = WidgetPermissionsSchema.parse({
  network: false,
  records: {},
  state: { read: true, write: true },
})

/**
 * HTML source files use the common document path grammar in V2. The legacy
 * WidgetIdSchema remains intentionally narrower because its path-style REST
 * routes depend on reserved, URL-clean segments.
 */
export function isHtmlDocumentPath(path: string): boolean {
  const analyzed = analyzeDocumentPath(path)
  return analyzed.safe && analyzed.canonicalPath === path
}

export function parseHtmlDocumentWidgetFile(
  value: unknown,
  path: string
): WidgetFile {
  if (!isHtmlDocumentPath(path)) {
    throw new Error(`Invalid HTML document path: ${path}`)
  }
  const parsed = WidgetFileSchema.parse({
    ...(value as object),
    // Validate the compatibility payload independently from the legacy route
    // identifier. WidgetFile's TypeScript shape still represents `id` as a
    // string, so restoring the common logical path is type-safe.
    id: "html-document",
  })
  return { ...parsed, id: path }
}

interface HtmlPropertiesEnvelope {
  type: "worktable.html-properties"
  version: 1
  sourceSha256: string
  widget: WidgetFile
}

export interface HtmlDocumentStorageV2Owner {
  documentId: DocumentId
  identity: "durable" | "provisional"
  path: string
  sourceRelativePath: string
  title: string
  updatedAt?: string
  archived: boolean
}

function sourceHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
}

function decodeObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    )
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function entryAt(
  entries: readonly DocumentGenerationPayloadEntry[],
  path: string
): DocumentGenerationPayloadEntry | undefined {
  return entries.find((entry) => entry.path === path)
}

function withoutEntry(
  entries: readonly DocumentGenerationPayloadEntry[],
  path: string
): DocumentGenerationPayloadEntry[] {
  return entries
    .filter((entry) => entry.path !== path)
    .map((entry) => ({ path: entry.path, bytes: entry.bytes.slice() }))
}

function propertiesEnvelope(
  widget: WidgetFile,
  sha256: string
): HtmlPropertiesEnvelope {
  const stored = {
    ...parseHtmlDocumentWidgetFile(widget, widget.id),
    archive: undefined,
  }
  return {
    type: "worktable.html-properties",
    version: 1,
    sourceSha256: sha256,
    widget: stored,
  }
}

export function buildHtmlDocumentPortableStateEntries(input: {
  widget: WidgetFile
  sourceBytes: Uint8Array
  runtimeState?: Record<string, unknown>
  legacyCompanions?: DocumentGenerationPayloadEntry[]
}): DocumentGenerationPayloadEntry[] {
  return [
    {
      path: HTML_DOCUMENT_PROPERTIES_ENTRY,
      bytes: encodeJson(
        propertiesEnvelope(input.widget, sourceHash(input.sourceBytes))
      ),
    },
    ...(input.runtimeState
      ? [
          {
            path: HTML_DOCUMENT_RUNTIME_STATE_ENTRY,
            bytes: encodeJson(input.runtimeState),
          },
        ]
      : []),
    ...(input.legacyCompanions ?? []).map((entry) => ({
      path: `${HTML_DOCUMENT_LEGACY_COMPANION_PREFIX}${entry.path}`,
      bytes: entry.bytes.slice(),
    })),
  ]
}

function parsePropertiesEnvelope(
  entry: DocumentGenerationPayloadEntry | undefined,
  path: string,
  archive: WidgetFile["archive"]
): HtmlPropertiesEnvelope | null {
  if (!entry) return null
  const value = decodeObject(entry.bytes)
  if (
    !value ||
    value["type"] !== "worktable.html-properties" ||
    value["version"] !== 1 ||
    typeof value["sourceSha256"] !== "string"
  ) {
    return null
  }
  try {
    return {
      type: "worktable.html-properties",
      version: 1,
      sourceSha256: value["sourceSha256"],
      widget: parseHtmlDocumentWidgetFile(
        {
          ...(value["widget"] as object),
          archive: archive ?? null,
        },
        path
      ),
    }
  } catch {
    return null
  }
}

function defaultWidget(input: {
  path: string
  title: string
  updatedAt?: string
  archive: WidgetFile["archive"]
}): WidgetFile {
  const timestamp =
    input.updatedAt && !Number.isNaN(Date.parse(input.updatedAt))
      ? input.updatedAt
      : new Date(0).toISOString()
  return parseHtmlDocumentWidgetFile(
    {
      version: 1,
      kind: "worktable.widget",
      name: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: "filesystem",
      updatedBy: "external",
      archive: input.archive ?? null,
      metadata: {},
      runtime: { type: "html", entry: "index.html" },
      permissions: DENIED_PERMISSIONS,
    },
    input.path
  )
}

export async function usesHtmlDocumentStorageV2(): Promise<boolean> {
  try {
    return (
      (await readWorkspaceStorageLayoutAt(getWorkspaceRoot())).kind === "v2"
    )
  } catch (error) {
    if (error instanceof BoundedFileReadError && error.reason === "missing") {
      return false
    }
    throw error
  }
}

export async function resolveHtmlDocumentStorageV2(
  spaceId: string,
  path: string
): Promise<HtmlDocumentStorageV2Owner | null> {
  const analyzed = analyzeDocumentPath(path)
  if (!analyzed.safe || !analyzed.comparisonKey) return null
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
  })
  const matches = catalog.entries.filter(
    (entry) =>
      entry.kind === "document" &&
      analyzeDocumentPath(entry.descriptor.path).comparisonKey ===
        analyzed.comparisonKey
  )
  const entry = matches.length === 1 ? matches[0] : undefined
  if (
    !entry ||
    entry.kind !== "document" ||
    entry.descriptor.path !== path ||
    entry.descriptor.format.id !== BUILTIN_DOCUMENT_FORMATS.html ||
    entry.descriptor.format.sourceVersion !== 1 ||
    entry.handle.storageProfile !==
      DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile ||
    entry.handle.source.kind !== "file" ||
    entry.handle.source.relativePath !== `docs/${path}.html` ||
    entry.handle.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    return null
  }
  return {
    documentId: entry.handle.documentId,
    identity: entry.handle.identity,
    path: entry.descriptor.path,
    sourceRelativePath: entry.handle.source.relativePath,
    title: entry.descriptor.title,
    ...(entry.descriptor.updatedAt
      ? { updatedAt: entry.descriptor.updatedAt }
      : {}),
    archived: Boolean(entry.handle.archived),
  }
}

export async function htmlDocumentSourceExistsV2(
  spaceId: string,
  path: string
): Promise<boolean> {
  return Boolean(await resolveHtmlDocumentStorageV2(spaceId, path))
}

/** Caller must hold the common document namespace lock. */
export async function materializeHtmlDocumentStorageV2(
  spaceId: string,
  path: string
): Promise<HtmlDocumentStorageV2Owner | null> {
  const owner = await resolveHtmlDocumentStorageV2(spaceId, path)
  if (!owner || owner.identity === "durable") return owner
  const documentId = mintDocumentId()
  await updateDocumentInventory(spaceId, {
    upsert: [
      {
        documentId,
        path: owner.path,
        format: HTML_FORMAT,
        source: {
          kind: "file",
          relativePath: owner.sourceRelativePath,
        },
      },
    ],
    remove: [owner.documentId],
  })
  return { ...owner, documentId, identity: "durable" }
}

async function sourceBytes(
  spaceId: string,
  owner: HtmlDocumentStorageV2Owner
): Promise<Uint8Array> {
  return readBoundedRegularFileBytes(
    resolve(getWorkspaceRoot(), "spaces", spaceId, owner.sourceRelativePath),
    DOCUMENT_GENERATION_MAX_ENTRY_BYTES
  )
}

async function portableState(
  owner: HtmlDocumentStorageV2Owner,
  spaceId: string
) {
  if (owner.identity !== "durable") return null
  const state = await readDocumentPortableStateV2({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    documentId: owner.documentId,
  })
  if (
    state &&
    (state.manifest.logicalPath !== owner.path ||
      state.manifest.format.id !== HTML_FORMAT.id ||
      state.manifest.format.sourceVersion !== HTML_FORMAT.sourceVersion)
  ) {
    throw new Error("HTML document state owner mismatch")
  }
  return state
}

export async function readHtmlDocumentStorageV2(input: {
  spaceId: string
  path: string
}): Promise<{
  owner: HtmlDocumentStorageV2Owner
  widget: WidgetFile
  html: string
  sourceBytes: Uint8Array
} | null> {
  const owner = await resolveHtmlDocumentStorageV2(input.spaceId, input.path)
  if (!owner) return null
  return readHtmlDocumentStorageV2Owner(input.spaceId, owner)
}

async function readHtmlDocumentStorageV2Owner(
  spaceId: string,
  owner: HtmlDocumentStorageV2Owner
): Promise<{
  owner: HtmlDocumentStorageV2Owner
  widget: WidgetFile
  html: string
  sourceBytes: Uint8Array
}> {
  const [bytes, state, archive] = await Promise.all([
    sourceBytes(spaceId, owner),
    portableState(owner, spaceId),
    getDocArchiveInfo(spaceId, owner.path),
  ])
  const fallback = defaultWidget({
    path: owner.path,
    title: owner.title,
    updatedAt: owner.updatedAt,
    archive,
  })
  const properties = parsePropertiesEnvelope(
    state ? entryAt(state.entries, HTML_DOCUMENT_PROPERTIES_ENTRY) : undefined,
    owner.path,
    archive
  )
  const widget = properties
    ? properties.sourceSha256 === sourceHash(bytes)
      ? properties.widget
      : parseHtmlDocumentWidgetFile(
          { ...properties.widget, permissions: DENIED_PERMISSIONS },
          owner.path
        )
    : fallback
  return {
    owner,
    widget,
    html: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    sourceBytes: bytes,
  }
}

export async function listHtmlDocumentsStorageV2(input: {
  spaceId: string
  includeArchived?: boolean
  includeAliasShadows?: boolean
}): Promise<WidgetFile[]> {
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId: input.spaceId,
  })
  const owners = catalog.entries.flatMap((entry) => {
    if (
      entry.kind !== "document" ||
      entry.descriptor.format.id !== BUILTIN_DOCUMENT_FORMATS.html ||
      entry.descriptor.format.sourceVersion !== 1 ||
      entry.handle.storageProfile !==
        DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile ||
      entry.handle.source.kind !== "file" ||
      entry.handle.source.relativePath !==
        `docs/${entry.descriptor.path}.html` ||
      entry.handle.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error"
      )
    ) {
      return []
    }
    return [
      {
        documentId: entry.handle.documentId,
        identity: entry.handle.identity,
        path: entry.descriptor.path,
        sourceRelativePath: entry.handle.source.relativePath,
        title: entry.descriptor.title,
        ...(entry.descriptor.updatedAt
          ? { updatedAt: entry.descriptor.updatedAt }
          : {}),
        archived: Boolean(entry.handle.archived),
      } satisfies HtmlDocumentStorageV2Owner,
    ]
  })
  const results = await mapWithConcurrency(owners, 4, async (owner) => {
    try {
      return (await readHtmlDocumentStorageV2Owner(input.spaceId, owner)).widget
    } catch {
      return null
    }
  })
  const widgets = results.filter(
    (widget): widget is WidgetFile =>
      widget !== null && (Boolean(input.includeArchived) || !widget.archive)
  )
  return widgets.sort((left, right) => left.name.localeCompare(right.name))
}

async function writeState(input: {
  spaceId: string
  owner: HtmlDocumentStorageV2Owner & { identity: "durable" }
  entries: DocumentGenerationPayloadEntry[]
  expectedRevision?: string | null
  updatedAt?: string
}) {
  return writeDocumentPortableStateV2({
    workspaceRoot: getWorkspaceRoot(),
    spaceId: input.spaceId,
    documentId: input.owner.documentId,
    logicalPath: input.owner.path,
    format: HTML_FORMAT,
    stateVersion: HTML_DOCUMENT_PORTABLE_STATE_VERSION,
    entries: input.entries,
    registry: createBuiltinDocumentFormatRegistry(),
    ...(input.expectedRevision !== undefined
      ? { expectedRevision: input.expectedRevision }
      : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  })
}

function requireDurable(
  owner: HtmlDocumentStorageV2Owner
): HtmlDocumentStorageV2Owner & { identity: "durable" } {
  if (owner.identity !== "durable") {
    throw new Error("HTML document requires a stable ID before mutation")
  }
  return owner as HtmlDocumentStorageV2Owner & { identity: "durable" }
}

export async function writeHtmlDocumentStorageV2(input: {
  spaceId: string
  owner: HtmlDocumentStorageV2Owner
  widget: WidgetFile
  html: string
}): Promise<void> {
  const owner = requireDurable(input.owner)
  const prior = await portableState(owner, input.spaceId)
  const bytes = new TextEncoder().encode(input.html)
  const properties = propertiesEnvelope(input.widget, sourceHash(bytes))
  const entries = [
    ...withoutEntry(prior?.entries ?? [], HTML_DOCUMENT_PROPERTIES_ENTRY),
    {
      path: HTML_DOCUMENT_PROPERTIES_ENTRY,
      bytes: encodeJson(properties),
    },
  ]
  const published = await writeState({
    spaceId: input.spaceId,
    owner,
    entries,
    expectedRevision: prior?.manifest.revision ?? null,
    updatedAt: input.widget.updatedAt,
  })
  const absoluteSource = resolve(
    getWorkspaceRoot(),
    "spaces",
    input.spaceId,
    owner.sourceRelativePath
  )
  try {
    await ensureRealDocumentStorageDirectory(
      getWorkspaceRoot(),
      dirname(absoluteSource)
    )
    await atomicWriteText(absoluteSource, input.html)
  } catch (error) {
    if (prior) {
      await writeState({
        spaceId: input.spaceId,
        owner,
        entries: prior.entries,
        expectedRevision: published.revision,
        updatedAt: prior.manifest.updatedAt,
      }).catch(() => undefined)
    }
    throw error
  }
}

export async function writeHtmlDocumentPropertiesV2(input: {
  spaceId: string
  owner: HtmlDocumentStorageV2Owner
  widget: WidgetFile
}): Promise<void> {
  const owner = requireDurable(input.owner)
  const [prior, bytes] = await Promise.all([
    portableState(owner, input.spaceId),
    sourceBytes(input.spaceId, owner),
  ])
  await writeState({
    spaceId: input.spaceId,
    owner,
    entries: [
      ...withoutEntry(prior?.entries ?? [], HTML_DOCUMENT_PROPERTIES_ENTRY),
      {
        path: HTML_DOCUMENT_PROPERTIES_ENTRY,
        bytes: encodeJson(propertiesEnvelope(input.widget, sourceHash(bytes))),
      },
    ],
    expectedRevision: prior?.manifest.revision ?? null,
    updatedAt: input.widget.updatedAt,
  })
}

export async function readHtmlDocumentRuntimeStateV2(input: {
  spaceId: string
  path: string
}): Promise<Record<string, unknown>> {
  const owner = await resolveHtmlDocumentStorageV2(input.spaceId, input.path)
  if (!owner || owner.identity !== "durable") return {}
  const state = await portableState(owner, input.spaceId)
  const entry = state
    ? entryAt(state.entries, HTML_DOCUMENT_RUNTIME_STATE_ENTRY)
    : undefined
  return (entry && decodeObject(entry.bytes)) ?? {}
}

export async function writeHtmlDocumentRuntimeStateV2(input: {
  spaceId: string
  path: string
  state: Record<string, unknown>
}): Promise<Record<string, unknown>> {
  const resolved = await resolveHtmlDocumentStorageV2(input.spaceId, input.path)
  if (!resolved) throw new Error(`HTML document not found: ${input.path}`)
  const owner = requireDurable(resolved)
  const prior = await portableState(owner, input.spaceId)
  await writeState({
    spaceId: input.spaceId,
    owner,
    entries: [
      ...withoutEntry(prior?.entries ?? [], HTML_DOCUMENT_RUNTIME_STATE_ENTRY),
      {
        path: HTML_DOCUMENT_RUNTIME_STATE_ENTRY,
        bytes: encodeJson(input.state),
      },
    ],
    expectedRevision: prior?.manifest.revision ?? null,
  })
  return input.state
}

export async function rebindHtmlDocumentSourceV2(input: {
  spaceId: string
  path: string
}): Promise<void> {
  const resolved = await resolveHtmlDocumentStorageV2(input.spaceId, input.path)
  if (!resolved || resolved.identity !== "durable") return
  const [prior, bytes, archive] = await Promise.all([
    portableState(resolved, input.spaceId),
    sourceBytes(input.spaceId, resolved),
    getDocArchiveInfo(input.spaceId, input.path),
  ])
  if (!prior) return
  const properties = parsePropertiesEnvelope(
    entryAt(prior.entries, HTML_DOCUMENT_PROPERTIES_ENTRY),
    resolved.path,
    archive
  )
  if (!properties || properties.sourceSha256 === sourceHash(bytes)) return
  await writeState({
    spaceId: input.spaceId,
    owner: requireDurable(resolved),
    entries: [
      ...withoutEntry(prior.entries, HTML_DOCUMENT_PROPERTIES_ENTRY),
      {
        path: HTML_DOCUMENT_PROPERTIES_ENTRY,
        bytes: encodeJson(
          propertiesEnvelope(properties.widget, sourceHash(bytes))
        ),
      },
    ],
    expectedRevision: prior.manifest.revision,
  })
}

export async function htmlDocumentSourceInfoV2(input: {
  spaceId: string
  path: string
}): Promise<{ exists: boolean; sourcePath?: string }> {
  const owner = await resolveHtmlDocumentStorageV2(input.spaceId, input.path)
  if (!owner) return { exists: false }
  const sourcePath = resolve(
    getWorkspaceRoot(),
    "spaces",
    input.spaceId,
    owner.sourceRelativePath
  )
  const info = await lstat(sourcePath).catch(() => null)
  return { exists: Boolean(info?.isFile()), sourcePath }
}
