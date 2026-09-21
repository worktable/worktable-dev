import { quickdrawFormat } from "./quickdraw-format.ts"
import {
  DocumentCompanionKeySchema,
  DocumentFormatIdSchema,
  type DocumentFormatClaim,
  type DocumentFormatId,
  type DocumentHealth,
  type DocumentRenderDisposition,
  type DocumentSource,
  type DocumentTextProjection,
} from "@worktable/types"
import {
  projectHtmlText,
  projectMarkdownText,
  projectRichText,
} from "./document-projections.ts"

export interface DocumentOperationBudget {
  maxInputBytes: number
  maxOutputBytes: number
  maxDepth: number
  maxElements: number
  timeoutMs: number
}

export interface DocumentInspection {
  title?: string
  summary?: string
  headings?: string[]
}

export interface PreparedDocumentWrite {
  bytes: Uint8Array
}

/**
 * The canonical on-disk shape for a format stored as one managed file under
 * a space's docs directory. The discovery version applies before a durable
 * inventory claim exists.
 */
export interface RegisteredDocumentFileSource {
  extension: string
  discoveryVersion: number
}

export const DOCUMENT_RENDER_DISPOSITIONS = {
  trustedComponent: "trusted-component",
  opaqueSandbox: "opaque-sandbox",
  attachmentOnly: "attachment-only",
} as const

export interface DocumentFormatCapabilityHints {
  authoring: "none" | "specialized" | "replace"
  publicProjection: "none" | "safe"
  execution: "none" | "sandboxed"
}

/**
 * Code-owned format registration. Source, renderer identity, and fixed render
 * disposition are declarations; content hooks receive a core-bounded reader,
 * never a path or ambient filesystem/network authority. The browser owns the
 * trusted renderer implementation, and authorization remains separate.
 */
export interface ServerDocumentFormatRegistration {
  id: DocumentFormatId
  extensions: readonly string[]
  sourceVersions: readonly number[]
  fileSource?: RegisteredDocumentFileSource
  rendererKey: string | null
  renderDisposition: DocumentRenderDisposition
  capabilities: DocumentFormatCapabilityHints
  /** Exact authored companions captured and restored with every generation. */
  versionedCompanionKeys: readonly string[]
  /** Portable format-owned state policy; derived caches never belong here. */
  portableState: "none" | "durable" | "versioned"
  /** Read-only locator for histories written by released path-keyed stores. */
  legacyVersionKind?: "docs" | "widgets"
  /** Larger bounded sources, such as drawings with embedded raster images. */
  projectionMaxInputBytes?: number
  inspect?: (input: {
    source: DocumentSource
    read: (maxBytes: number) => Promise<Uint8Array>
    budget: DocumentOperationBudget
    signal: AbortSignal
  }) => Promise<DocumentInspection>
  projectText?: (input: {
    source: DocumentSource
    read: (maxBytes: number) => Promise<Uint8Array>
    budget: DocumentOperationBudget
    signal: AbortSignal
  }) => Promise<DocumentTextProjection>
  /**
   * Validate and, when the format requires it, normalize one complete authored
   * source replacement. The kernel bounds both sides of this call and retains
   * all filesystem, identity, fencing, version, and lifecycle authority.
   */
  prepareWrite?: (input: {
    bytes: Uint8Array
    sourceVersion: number
    budget: DocumentOperationBudget
    signal: AbortSignal
  }) => Promise<PreparedDocumentWrite>
}

function canonicalExtension(extension: string): string {
  const normalized = extension.startsWith(".") ? extension : `.${extension}`
  if (!/^\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(normalized)) {
    throw new Error(`invalid document extension: ${extension}`)
  }
  return normalized
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export class DocumentFormatRegistry {
  readonly #byId = new Map<DocumentFormatId, ServerDocumentFormatRegistration>()
  readonly #byExtension = new Map<string, ServerDocumentFormatRegistration>()

  constructor(registrations: readonly ServerDocumentFormatRegistration[]) {
    for (const adapter of registrations) {
      const id = DocumentFormatIdSchema.parse(adapter.id)
      if (this.#byId.has(id)) {
        throw new Error(`duplicate document format id: ${id}`)
      }
      if (
        adapter.sourceVersions.length === 0 ||
        adapter.sourceVersions.some(
          (version) => !Number.isSafeInteger(version) || version < 1
        )
      ) {
        throw new Error(`invalid source versions for document format: ${id}`)
      }
      if (
        new Set(adapter.sourceVersions).size !== adapter.sourceVersions.length
      ) {
        throw new Error(`duplicate source version for document format: ${id}`)
      }
      const extensions = adapter.extensions.map(canonicalExtension)
      if (new Set(extensions).size !== extensions.length) {
        throw new Error(`duplicate extension within document format: ${id}`)
      }
      for (const extension of extensions) {
        for (const existing of this.#byExtension.keys()) {
          if (
            existing === extension ||
            existing.endsWith(extension) ||
            extension.endsWith(existing)
          ) {
            throw new Error(
              `ambiguous document extensions: ${existing} and ${extension}`
            )
          }
        }
      }
      const fileSource = adapter.fileSource
        ? {
            extension: canonicalExtension(adapter.fileSource.extension),
            discoveryVersion: adapter.fileSource.discoveryVersion,
          }
        : undefined
      if (
        fileSource &&
        (!extensions.includes(fileSource.extension) ||
          !adapter.sourceVersions.includes(fileSource.discoveryVersion))
      ) {
        throw new Error(
          `invalid registered file source for document format: ${id}`
        )
      }
      if (
        adapter.rendererKey !== null &&
        !/^[a-z][a-z0-9-]{0,63}$/.test(adapter.rendererKey)
      ) {
        throw new Error(`invalid document renderer key for format: ${id}`)
      }
      if (
        (adapter.rendererKey === null) !==
        (adapter.renderDisposition ===
          DOCUMENT_RENDER_DISPOSITIONS.attachmentOnly)
      ) {
        throw new Error(
          `document renderer and disposition disagree for format: ${id}`
        )
      }
      if (
        (adapter.capabilities.execution === "sandboxed") !==
        (adapter.renderDisposition ===
          DOCUMENT_RENDER_DISPOSITIONS.opaqueSandbox)
      ) {
        throw new Error(
          `document execution and disposition disagree for format: ${id}`
        )
      }
      if (
        adapter.capabilities.authoring === "replace" &&
        (!fileSource || !adapter.prepareWrite)
      ) {
        throw new Error(
          `replaceable document format requires a managed file source and write adapter: ${id}`
        )
      }
      if (adapter.prepareWrite && adapter.capabilities.authoring === "none") {
        throw new Error(
          `non-authorable document format cannot register a write adapter: ${id}`
        )
      }
      const versionedCompanionKeys = adapter.versionedCompanionKeys.map((key) =>
        DocumentCompanionKeySchema.parse(key)
      )
      if (
        new Set(versionedCompanionKeys).size !== versionedCompanionKeys.length
      ) {
        throw new Error(`duplicate versioned companion key for format: ${id}`)
      }
      const normalized = {
        ...adapter,
        id,
        extensions,
        versionedCompanionKeys,
        ...(fileSource ? { fileSource } : {}),
      }
      this.#byId.set(id, normalized)
      for (const extension of extensions) {
        this.#byExtension.set(extension, normalized)
      }
    }
  }

  get(formatId: string): ServerDocumentFormatRegistration | undefined {
    return this.#byId.get(formatId as DocumentFormatId)
  }

  forFilename(filename: string): ServerDocumentFormatRegistration | undefined {
    const lower = filename.toLowerCase()
    for (const [extension, adapter] of this.#byExtension) {
      if (lower.endsWith(extension)) return adapter
    }
    return undefined
  }

  fileSource(format: DocumentFormatClaim):
    | {
        registration: ServerDocumentFormatRegistration
        source: RegisteredDocumentFileSource
      }
    | undefined {
    const adapter = this.get(format.id)
    if (
      !adapter?.fileSource ||
      !adapter.sourceVersions.includes(format.sourceVersion)
    ) {
      return undefined
    }
    return { registration: adapter, source: adapter.fileSource }
  }

  fileSourceForFilename(filename: string):
    | {
        registration: ServerDocumentFormatRegistration
        source: RegisteredDocumentFileSource
      }
    | undefined {
    // Managed source names are canonical and case-sensitive. The broader
    // forFilename lookup remains case-insensitive for import classification.
    for (const adapter of this.#byId.values()) {
      if (
        adapter.fileSource &&
        filename.endsWith(adapter.fileSource.extension)
      ) {
        return { registration: adapter, source: adapter.fileSource }
      }
    }
    return undefined
  }

  fileSourceFormats(): DocumentFormatClaim[] {
    return [...this.#byId.values()].flatMap((adapter) =>
      adapter.fileSource
        ? [
            {
              id: adapter.id,
              sourceVersion: adapter.fileSource.discoveryVersion,
            },
          ]
        : []
    )
  }

  extensions(): string[] {
    return [...this.#byExtension.keys()].sort(compareStrings)
  }

  health(format: DocumentFormatClaim): DocumentHealth {
    const adapter = this.get(format.id)
    if (!adapter) return "unsupported-format"
    return adapter.sourceVersions.includes(format.sourceVersion)
      ? "supported"
      : "unsupported-version"
  }
}

export const BUILTIN_DOCUMENT_FORMATS = {
  markdown: "worktable.markdown",
  richText: "worktable.rich-text",
  html: "worktable.html",
  excalidraw: "worktable.excalidraw",
} as const satisfies Record<string, DocumentFormatId>

export const BUILTIN_DOCUMENT_COMPANIONS = {
  htmlPermissions: "worktable.html-permissions",
} as const

function decodeAuthoredUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

function validateRichTextStructure(
  value: unknown,
  budget: DocumentOperationBudget,
  signal: AbortSignal
): void {
  if (!Array.isArray(value)) {
    throw new Error("Rich-text source must contain a block array")
  }
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let elements = 0
  while (stack.length > 0) {
    if (signal.aborted) throw signal.reason
    const current = stack.pop()!
    elements += 1
    if (elements > budget.maxElements || current.depth > budget.maxDepth) {
      throw new Error("Rich-text source exceeds its structural limit")
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        stack.push({ value: entry, depth: current.depth + 1 })
      }
      continue
    }
    if (current.value && typeof current.value === "object") {
      for (const entry of Object.values(
        current.value as Record<string, unknown>
      )) {
        stack.push({ value: entry, depth: current.depth + 1 })
      }
    }
  }
}

export function createBuiltinDocumentFormatRegistry(): DocumentFormatRegistry {
  return new DocumentFormatRegistry([
    quickdrawFormat,
    {
      id: BUILTIN_DOCUMENT_FORMATS.markdown,
      extensions: [".md"],
      sourceVersions: [1],
      fileSource: { extension: ".md", discoveryVersion: 1 },
      rendererKey: "doc",
      renderDisposition: DOCUMENT_RENDER_DISPOSITIONS.trustedComponent,
      capabilities: {
        authoring: "specialized",
        publicProjection: "safe",
        execution: "none",
      },
      versionedCompanionKeys: [],
      portableState: "none",
      legacyVersionKind: "docs",
      projectText: projectMarkdownText,
      async prepareWrite({ bytes }) {
        decodeAuthoredUtf8(bytes)
        return { bytes: bytes.slice() }
      },
    },
    {
      id: BUILTIN_DOCUMENT_FORMATS.richText,
      extensions: [".json"],
      sourceVersions: [1],
      fileSource: { extension: ".json", discoveryVersion: 1 },
      rendererKey: "doc",
      renderDisposition: DOCUMENT_RENDER_DISPOSITIONS.trustedComponent,
      capabilities: {
        authoring: "specialized",
        publicProjection: "safe",
        execution: "none",
      },
      versionedCompanionKeys: [],
      portableState: "none",
      legacyVersionKind: "docs",
      projectText: projectRichText,
      async prepareWrite({ bytes, budget, signal }) {
        const parsed = JSON.parse(decodeAuthoredUtf8(bytes)) as unknown
        validateRichTextStructure(parsed, budget, signal)
        return { bytes: bytes.slice() }
      },
    },
    {
      id: BUILTIN_DOCUMENT_FORMATS.html,
      extensions: [".html"],
      sourceVersions: [1],
      fileSource: { extension: ".html", discoveryVersion: 1 },
      rendererKey: "html",
      renderDisposition: DOCUMENT_RENDER_DISPOSITIONS.opaqueSandbox,
      capabilities: {
        authoring: "specialized",
        publicProjection: "safe",
        execution: "sandboxed",
      },
      versionedCompanionKeys: [BUILTIN_DOCUMENT_COMPANIONS.htmlPermissions],
      portableState: "durable",
      legacyVersionKind: "widgets",
      projectText: projectHtmlText,
    },
    {
      id: BUILTIN_DOCUMENT_FORMATS.excalidraw,
      extensions: [".excalidraw"],
      sourceVersions: [1],
      fileSource: { extension: ".excalidraw", discoveryVersion: 1 },
      rendererKey: null,
      renderDisposition: DOCUMENT_RENDER_DISPOSITIONS.attachmentOnly,
      capabilities: {
        authoring: "none",
        publicProjection: "none",
        execution: "none",
      },
      versionedCompanionKeys: [],
      portableState: "none",
    },
  ])
}
