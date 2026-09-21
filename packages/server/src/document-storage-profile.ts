import type { DocumentFormatClaim, DocumentSource } from "@worktable/types"
import {
  DOCUMENT_ARCHIVE_ADAPTER_IDS,
  type DocumentArchiveAdapterId,
} from "./document-archive-adapter.ts"
import {
  DOCUMENT_DELETE_ADAPTER_IDS,
  type DocumentDeleteAdapterId,
} from "./document-delete-adapter.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
  type DocumentFormatRegistry,
} from "./document-format-registry.ts"

export const DOCUMENT_STORAGE_PROFILE_IDS = {
  legacyDocFile: "legacy-doc-file",
  legacyHtmlBundle: "legacy-html-bundle",
  coreBundle: "core-document-bundle",
} as const

export type DocumentStorageProfileId =
  (typeof DOCUMENT_STORAGE_PROFILE_IDS)[keyof typeof DOCUMENT_STORAGE_PROFILE_IDS]

export interface DocumentStorageProfile {
  id: DocumentStorageProfileId
  managedExactRename: boolean
  managedPrefixRename: boolean
  deleteAdapter: DocumentDeleteAdapterId | null
  archiveAdapter: DocumentArchiveAdapterId | null
  matches: (
    format: DocumentFormatClaim,
    source: DocumentSource,
    registry: DocumentFormatRegistry
  ) => boolean
  sourceForLogicalPath?: (
    format: DocumentFormatClaim,
    logicalPath: string,
    registry?: DocumentFormatRegistry
  ) => DocumentSource | null
}

const builtinFormatRegistry = createBuiltinDocumentFormatRegistry()

function registeredFileExtension(
  format: DocumentFormatClaim,
  registry: DocumentFormatRegistry = builtinFormatRegistry
): string | null {
  return registry.fileSource(format)?.source.extension ?? null
}

// Keep the persisted V1 profile id stable while making its behavior apply to
// every registered managed-file format.
const REGISTERED_FILE_PROFILE: DocumentStorageProfile = {
  id: DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile,
  managedExactRename: true,
  managedPrefixRename: true,
  deleteAdapter: DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc,
  archiveAdapter: DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyDocMetadata,
  matches(format, source, registry) {
    const suffix = registeredFileExtension(format, registry)
    return (
      source.kind === "file" &&
      source.relativePath.startsWith("docs/") &&
      suffix !== null &&
      source.relativePath.endsWith(suffix)
    )
  },
  sourceForLogicalPath(format, logicalPath, registry) {
    const suffix = registeredFileExtension(format, registry)
    return suffix
      ? { kind: "file", relativePath: `docs/${logicalPath}${suffix}` }
      : null
  },
}

const LEGACY_HTML_BUNDLE_PROFILE: DocumentStorageProfile = {
  id: DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle,
  managedExactRename: true,
  managedPrefixRename: true,
  deleteAdapter: DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml,
  archiveAdapter: DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest,
  matches(format, source) {
    return (
      format.id === BUILTIN_DOCUMENT_FORMATS.html &&
      format.sourceVersion === 1 &&
      source.kind === "bundle" &&
      source.manifestPath === undefined &&
      source.relativePath.startsWith("widgets/") &&
      !source.relativePath.endsWith(".wtdoc")
    )
  },
  sourceForLogicalPath(format, logicalPath) {
    return format.id === BUILTIN_DOCUMENT_FORMATS.html &&
      format.sourceVersion === 1
      ? { kind: "bundle", relativePath: `widgets/${logicalPath}` }
      : null
  },
}

const CORE_BUNDLE_PROFILE: DocumentStorageProfile = {
  id: DOCUMENT_STORAGE_PROFILE_IDS.coreBundle,
  managedExactRename: false,
  managedPrefixRename: false,
  deleteAdapter: null,
  archiveAdapter: null,
  matches(_format, source) {
    return source.kind === "bundle" && source.relativePath.endsWith(".wtdoc")
  },
}

/**
 * Code-owned storage contracts. Profiles choose lifecycle machinery; the
 * format registry supplies the canonical extension for managed files.
 */
export class DocumentStorageProfileRegistry {
  readonly #byId = new Map<DocumentStorageProfileId, DocumentStorageProfile>()

  constructor(profiles: readonly DocumentStorageProfile[]) {
    for (const profile of profiles) {
      if (this.#byId.has(profile.id)) {
        throw new Error(`duplicate document storage profile: ${profile.id}`)
      }
      this.#byId.set(profile.id, profile)
    }
  }

  get(id: DocumentStorageProfileId): DocumentStorageProfile {
    const profile = this.#byId.get(id)
    if (!profile) throw new Error(`unknown document storage profile: ${id}`)
    return profile
  }

  resolve(
    format: DocumentFormatClaim,
    source: DocumentSource,
    registry: DocumentFormatRegistry = builtinFormatRegistry
  ): DocumentStorageProfileId | null {
    const matches = [...this.#byId.values()].filter((profile) =>
      profile.matches(format, source, registry)
    )
    if (matches.length > 1) {
      throw new Error("document source matches multiple storage profiles")
    }
    return matches[0]?.id ?? null
  }
}

export const documentStorageProfiles = new DocumentStorageProfileRegistry([
  REGISTERED_FILE_PROFILE,
  LEGACY_HTML_BUNDLE_PROFILE,
  CORE_BUNDLE_PROFILE,
])

/**
 * Stable logical-path grammar for new documents. It is intentionally not
 * derived from the open format-adapter registry: installing a future adapter
 * must not make an existing logical path nonportable after the fact.
 */
export const RESERVED_DOCUMENT_SOURCE_SUFFIXES = [
  ".html",
  ".json",
  ".md",
  ".wtdoc",
] as const
