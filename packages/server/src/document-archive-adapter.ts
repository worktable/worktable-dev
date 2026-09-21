import { posix } from "node:path"
import {
  ArchiveInfoSchema,
  ArchiveInfoSchemaV1,
  WidgetFileSchema,
} from "@worktable/types"
import { z } from "zod"
import {
  deleteYamlTopLevelValue,
  parseCanonicalYaml,
  rewriteYamlTopLevelValue,
} from "./yaml.ts"

export const DOCUMENT_ARCHIVE_ADAPTER_IDS = {
  legacyDocMetadata: "legacy-doc-metadata-v1",
  legacyWidgetManifest: "legacy-widget-manifest-v1",
} as const

export type DocumentArchiveAdapterId =
  (typeof DOCUMENT_ARCHIVE_ADAPTER_IDS)[keyof typeof DOCUMENT_ARCHIVE_ADAPTER_IDS]

export const DocumentArchiveAdapterIdSchema = z.enum([
  DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyDocMetadata,
  DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest,
])

const ArchiveFieldStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("null") }).strict(),
  z
    .object({
      kind: z.literal("archive"),
      value: z.record(z.string(), z.unknown()),
    })
    .strict(),
])

export type ArchiveFieldState = z.infer<typeof ArchiveFieldStateSchema>

export interface ArchiveFieldUpdate {
  logicalPath: string
  state: ArchiveFieldState
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseJsonObject(raw: Buffer): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw.toString("utf8"))
  } catch {
    throw new Error("Document archive metadata is not valid JSON")
  }
  if (!isObject(value)) {
    throw new Error("Document archive metadata must contain an object")
  }
  return value
}

function archiveState(
  adapterId: DocumentArchiveAdapterId,
  value: unknown,
  present: boolean
): ArchiveFieldState {
  if (!present) return { kind: "absent" }
  if (value === null) return { kind: "null" }
  const schema =
    adapterId === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest
      ? ArchiveInfoSchemaV1
      : ArchiveInfoSchema
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      "Document archive metadata contains an invalid archive field"
    )
  }
  // Validate the fields Worktable understands without dropping additional
  // fields that a newer writer may need restored during compensation.
  return { kind: "archive", value: value as Record<string, unknown> }
}

function parseDocMetadata(raw: Buffer | null): Record<string, unknown> {
  if (!raw) return { version: 1, docs: {} }
  const root = parseJsonObject(raw)
  if (root["version"] !== 1 || !isObject(root["docs"])) {
    throw new Error("Document archive metadata has an unsupported shape")
  }
  return root
}

function parseWidgetMetadata(
  raw: Buffer | null,
  logicalPath: string
): Record<string, unknown> {
  if (!raw) throw new Error("HTML document metadata is missing")
  let value: unknown
  try {
    value = parseCanonicalYaml(raw.toString("utf8"))
  } catch {
    throw new Error("HTML document metadata is invalid")
  }
  const parsed = WidgetFileSchema.safeParse(value)
  if (!parsed.success || parsed.data.id !== logicalPath || !isObject(value)) {
    throw new Error("HTML document metadata disagrees with its path")
  }
  return value
}

export function archiveMetadataRelativePath(
  adapterId: DocumentArchiveAdapterId,
  logicalPaths: readonly string[]
): string {
  if (logicalPaths.length === 0) {
    throw new Error("Document archive metadata mutation is empty")
  }
  if (adapterId === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyDocMetadata) {
    return "docs.meta.json"
  }
  if (logicalPaths.length !== 1) {
    throw new Error("HTML archive metadata mutations must target one document")
  }
  return posix.join("widgets", logicalPaths[0]!, "widget.yaml")
}

export function readArchiveFieldStates(
  adapterId: DocumentArchiveAdapterId,
  raw: Buffer | null,
  logicalPaths: readonly string[]
): ArchiveFieldState[] {
  if (adapterId === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyDocMetadata) {
    const root = parseDocMetadata(raw)
    const docs = root["docs"] as Record<string, unknown>
    return logicalPaths.map((logicalPath) => {
      if (!Object.prototype.hasOwnProperty.call(docs, logicalPath)) {
        return { kind: "absent" }
      }
      const entry = docs[logicalPath]
      if (!isObject(entry)) {
        throw new Error("Document archive metadata entry is invalid")
      }
      return archiveState(
        adapterId,
        entry["archived"],
        Object.prototype.hasOwnProperty.call(entry, "archived")
      )
    })
  }

  if (logicalPaths.length !== 1) {
    throw new Error("HTML archive metadata mutations must target one document")
  }
  const metadata = parseWidgetMetadata(raw, logicalPaths[0]!)
  return [
    archiveState(
      adapterId,
      metadata["archive"],
      Object.prototype.hasOwnProperty.call(metadata, "archive")
    ),
  ]
}

function applyDocArchiveState(
  docs: Record<string, unknown>,
  update: ArchiveFieldUpdate
): void {
  const existing = Object.prototype.hasOwnProperty.call(
    docs,
    update.logicalPath
  )
    ? docs[update.logicalPath]
    : undefined
  const entry = existing === undefined ? {} : existing
  if (!isObject(entry)) {
    throw new Error("Document archive metadata entry is invalid")
  }
  if (update.state.kind === "absent") delete entry["archived"]
  else if (update.state.kind === "null") entry["archived"] = null
  else entry["archived"] = update.state.value
  if (Object.keys(entry).length === 0) delete docs[update.logicalPath]
  else {
    Object.defineProperty(docs, update.logicalPath, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
}

export function rewriteArchiveFieldStates(
  adapterId: DocumentArchiveAdapterId,
  raw: Buffer | null,
  updates: readonly ArchiveFieldUpdate[]
): Buffer | null {
  if (updates.length === 0) return raw
  if (adapterId === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyDocMetadata) {
    const root = parseDocMetadata(raw)
    const docs = root["docs"] as Record<string, unknown>
    for (const update of updates) applyDocArchiveState(docs, update)
    const rootKeys = Object.keys(root).filter(
      (key) => key !== "version" && key !== "docs"
    )
    if (Object.keys(docs).length === 0 && rootKeys.length === 0) return null
    return Buffer.from(`${JSON.stringify(root, null, 2)}\n`, "utf8")
  }

  if (updates.length !== 1) {
    throw new Error("HTML archive metadata mutations must target one document")
  }
  const update = updates[0]!
  parseWidgetMetadata(raw, update.logicalPath)
  const text = raw!.toString("utf8")
  const rewritten =
    update.state.kind === "absent"
      ? deleteYamlTopLevelValue(text, "archive")
      : rewriteYamlTopLevelValue(
          text,
          "archive",
          update.state.kind === "null" ? null : update.state.value
        )
  return Buffer.from(rewritten, "utf8")
}

export function serializeArchiveFieldState(state: ArchiveFieldState): Buffer {
  const parsed = ArchiveFieldStateSchema.parse(state)
  return Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8")
}

export function parseArchiveFieldState(
  adapterId: DocumentArchiveAdapterId,
  bytes: Buffer
): ArchiveFieldState {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("Document archive field recovery state is invalid")
  }
  const state = ArchiveFieldStateSchema.parse(value)
  if (state.kind === "archive") {
    return archiveState(adapterId, state.value, true)
  }
  return state
}

export function archiveFieldStatesEqual(
  left: ArchiveFieldState,
  right: ArchiveFieldState
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function isArchivedFieldState(state: ArchiveFieldState): boolean {
  return state.kind === "archive"
}

export function activeArchiveFieldState(
  adapterId: DocumentArchiveAdapterId
): ArchiveFieldState {
  return adapterId === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest
    ? { kind: "null" }
    : { kind: "absent" }
}
