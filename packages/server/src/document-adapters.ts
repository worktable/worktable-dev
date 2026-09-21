import { lstat, opendir } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  WidgetFileSchema,
  type DocumentFormatClaim,
  type DocumentSource,
} from "@worktable/types"
import { BoundedFileReadError, readBoundedRegularFile } from "./bounded-file.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
  type DocumentFormatRegistry,
} from "./document-format-registry.ts"
import { inspectDocumentSource } from "./document-inventory.ts"
import { parseCanonicalYaml } from "./yaml.ts"
import {
  readDocAliasesAt,
  reservedByAliasIn,
  type DocAliases,
} from "./doc-aliases.ts"

const LEGACY_WIDGET_METADATA_MAX_BYTES = 1024 * 1024
const LEGACY_CATALOG_MAX_ENTRIES = 100_000

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export interface SourceClaimDiagnostic {
  severity: "warning" | "error"
  code:
    | "unsafe-logical-path"
    | "nonportable-logical-path"
    | "source-symlink"
    | "source-special-file"
    | "widget-metadata-missing"
    | "widget-metadata-too-large"
    | "widget-metadata-invalid"
    | "widget-content-missing"
    | "inventory-source-mismatch"
    | "inventory-source-missing"
    | "source-ownership-overlap"
    | "bundle-manifest-mismatch"
  message: string
}

export interface DocumentSourceClaim {
  origin: "legacy-doc" | "legacy-html" | "inventory"
  path: string
  comparisonKey: string | null
  format: DocumentFormatClaim
  source: DocumentSource
  title: string
  updatedAt?: string
  archived?: boolean
  archiveProvider?: "legacy-doc-metadata"
  diagnostics: SourceClaimDiagnostic[]
}

function humanizePath(path: string): string {
  const leaf = path.split("/").pop() ?? path
  return (
    leaf
      .replace(/[-_]+/g, " ")
      .trim()
      .replace(/(^|\s)\p{L}/gu, (character) => character.toUpperCase()) || path
  )
}

function pathDiagnostics(path: string): {
  comparisonKey: string | null
  diagnostics: SourceClaimDiagnostic[]
} {
  const analysis = analyzeDocumentPath(path)
  const diagnostics: SourceClaimDiagnostic[] = []
  if (!analysis.safe) {
    diagnostics.push({
      severity: "error",
      code: "unsafe-logical-path",
      message: "legacy source resolves to an unsafe logical path",
    })
  } else if (!analysis.portable) {
    diagnostics.push({
      severity: "warning",
      code: "nonportable-logical-path",
      message: "legacy source is readable but not portable for new creation",
    })
  }
  return { comparisonKey: analysis.comparisonKey, diagnostics }
}

interface LegacyCatalogBudget {
  entries: number
}

async function readLegacyDirectory(
  directory: string,
  budget: LegacyCatalogBudget
) {
  try {
    const entries = []
    const handle = await opendir(directory)
    for await (const entry of handle) {
      budget.entries += 1
      if (budget.entries > LEGACY_CATALOG_MAX_ENTRIES) {
        throw new Error("document catalog exceeds its entry limit")
      }
      entries.push(entry)
    }
    return entries
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return []
    throw error
  }
}

async function scanLegacyDocDirectory(
  root: string,
  relativeSegments: string[],
  claims: DocumentSourceClaim[],
  aliases: DocAliases,
  budget: LegacyCatalogBudget,
  registry: DocumentFormatRegistry
): Promise<void> {
  const directory = join(root, ...relativeSegments)
  const entries = await readLegacyDirectory(directory, budget)
  entries.sort((a, b) => compareStrings(a.name, b.name))
  for (const entry of entries) {
    const segments = [...relativeSegments, entry.name]
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await scanLegacyDocDirectory(
        root,
        segments,
        claims,
        aliases,
        budget,
        registry
      )
      continue
    }
    if (!entry.isFile()) continue
    const registration = registry.fileSourceForFilename(entry.name)
    if (!registration) continue
    const { registration: format, source } = registration
    const logicalSegments = [
      ...relativeSegments,
      entry.name.slice(0, -source.extension.length),
    ]
    const path = logicalSegments.join("/")
    if (reservedByAliasIn(aliases, path)) continue
    const analyzed = pathDiagnostics(path)
    claims.push({
      origin: "legacy-doc",
      path,
      comparisonKey: analyzed.comparisonKey,
      format: {
        id: format.id,
        sourceVersion: source.discoveryVersion,
      },
      source: {
        kind: "file",
        relativePath: ["docs", ...segments].join("/"),
      },
      title: humanizePath(path),
      archiveProvider: "legacy-doc-metadata",
      diagnostics: analyzed.diagnostics,
    })
  }
}

export async function listLegacyDocClaims(
  spaceRoot: string,
  knownAliases?: DocAliases,
  registry: DocumentFormatRegistry = createBuiltinDocumentFormatRegistry()
): Promise<DocumentSourceClaim[]> {
  let aliases = knownAliases
  if (!aliases) {
    const result = await readDocAliasesAt(
      resolve(spaceRoot, "doc-aliases.json")
    )
    if (!result.aliases) {
      throw new Error(result.error ?? "Document aliases are unavailable")
    }
    aliases = result.aliases
  }
  const docsRoot = resolve(spaceRoot, "docs")
  let info
  try {
    info = await lstat(docsRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return []
  const claims: DocumentSourceClaim[] = []
  await scanLegacyDocDirectory(
    docsRoot,
    [],
    claims,
    aliases,
    { entries: 0 },
    registry
  )
  return claims
}

async function legacyHtmlClaimForDirectory(
  widgetsRoot: string,
  relativeSegments: string[],
  entries: Awaited<ReturnType<typeof readLegacyDirectory>>
): Promise<DocumentSourceClaim | null> {
  const directory = join(widgetsRoot, ...relativeSegments)
  const metadataEntry = entries.find((entry) => entry.name === "widget.yaml")
  if (!metadataEntry || relativeSegments.length === 0) return null

  const widgetId = relativeSegments.join("/")
  const analyzed = pathDiagnostics(widgetId)
  const diagnostics = [...analyzed.diagnostics]
  const metadataPath = join(directory, "widget.yaml")
  const htmlPath = join(directory, "index.html")
  let title = humanizePath(widgetId)
  let archived = false
  let updatedAt: string | undefined
  if (metadataEntry.isSymbolicLink()) {
    diagnostics.push({
      severity: "error",
      code: "source-symlink",
      message: "widget metadata cannot be a symbolic link",
    })
  } else if (!metadataEntry.isFile()) {
    diagnostics.push({
      severity: "error",
      code: "source-special-file",
      message: "widget metadata must be a regular file",
    })
  } else {
    try {
      const parsed = WidgetFileSchema.safeParse(
        parseCanonicalYaml(
          await readBoundedRegularFile(
            metadataPath,
            LEGACY_WIDGET_METADATA_MAX_BYTES
          )
        )
      )
      if (!parsed.success || parsed.data.id !== widgetId) {
        diagnostics.push({
          severity: "error",
          code: "widget-metadata-invalid",
          message: "widget metadata is invalid or disagrees with its path",
        })
      } else {
        title = parsed.data.name
        archived = Boolean(parsed.data.archive)
        updatedAt = parsed.data.updatedAt
      }
    } catch (error) {
      const reason =
        error instanceof BoundedFileReadError ? error.reason : "unreadable"
      diagnostics.push(
        reason === "missing"
          ? {
              severity: "error",
              code: "widget-metadata-missing",
              message: "widget metadata disappeared during discovery",
            }
          : reason === "symlink"
            ? {
                severity: "error",
                code: "source-symlink",
                message: "widget metadata cannot be a symbolic link",
              }
            : reason === "not-file"
              ? {
                  severity: "error",
                  code: "source-special-file",
                  message: "widget metadata must be a regular file",
                }
              : reason === "too-large"
                ? {
                    severity: "error",
                    code: "widget-metadata-too-large",
                    message: "widget metadata exceeds its inspection limit",
                  }
                : {
                    severity: "error",
                    code: "widget-metadata-invalid",
                    message: "widget metadata could not be read consistently",
                  }
      )
    }
  }
  let htmlInfo
  try {
    htmlInfo = await lstat(htmlPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    diagnostics.push({
      severity: "error",
      code: "widget-content-missing",
      message: "widget is missing index.html",
    })
  }
  if (htmlInfo) {
    if (htmlInfo.isSymbolicLink()) {
      diagnostics.push({
        severity: "error",
        code: "source-symlink",
        message: "widget HTML cannot be a symbolic link",
      })
    } else if (!htmlInfo.isFile()) {
      diagnostics.push({
        severity: "error",
        code: "source-special-file",
        message: "widget HTML must be a regular file",
      })
    }
  }
  return {
    origin: "legacy-html",
    path: widgetId,
    comparisonKey: analyzed.comparisonKey,
    format: { id: BUILTIN_DOCUMENT_FORMATS.html, sourceVersion: 1 },
    source: {
      kind: "bundle",
      relativePath: ["widgets", ...relativeSegments].join("/"),
    },
    title,
    ...(updatedAt ? { updatedAt } : {}),
    ...(archived ? { archived: true } : {}),
    diagnostics,
  }
}

async function scanLegacyWidgetDirectory(
  widgetsRoot: string,
  relativeSegments: string[],
  claims: DocumentSourceClaim[],
  budget: LegacyCatalogBudget
): Promise<void> {
  const directory = join(widgetsRoot, ...relativeSegments)
  const entries = await readLegacyDirectory(directory, budget)
  entries.sort((a, b) => compareStrings(a.name, b.name))
  const claim = await legacyHtmlClaimForDirectory(
    widgetsRoot,
    relativeSegments,
    entries
  )
  if (claim) {
    claims.push(claim)
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    await scanLegacyWidgetDirectory(
      widgetsRoot,
      [...relativeSegments, entry.name],
      claims,
      budget
    )
  }
}

export async function readLegacyHtmlClaim(
  spaceRoot: string,
  widgetId: string
): Promise<DocumentSourceClaim | null> {
  const analyzed = analyzeDocumentPath(widgetId)
  if (!analyzed.safe || !analyzed.comparisonKey) return null
  const relativeSegments = widgetId.split("/")
  const widgetsRoot = resolve(spaceRoot, "widgets")
  const source = {
    kind: "bundle" as const,
    relativePath: ["widgets", ...relativeSegments].join("/"),
  }
  const inspected = await inspectDocumentSource(spaceRoot, source)
  if (!inspected.safe) return null
  for (let length = 1; length < relativeSegments.length; length += 1) {
    const ancestorMetadata = join(
      widgetsRoot,
      ...relativeSegments.slice(0, length),
      "widget.yaml"
    )
    try {
      await lstat(ancestorMetadata)
      return null
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    }
  }
  const entries = await readLegacyDirectory(
    join(widgetsRoot, ...relativeSegments),
    { entries: 0 }
  )
  return legacyHtmlClaimForDirectory(widgetsRoot, relativeSegments, entries)
}

export async function listLegacyHtmlClaims(
  spaceRoot: string
): Promise<DocumentSourceClaim[]> {
  const widgetsRoot = resolve(spaceRoot, "widgets")
  let info
  try {
    info = await lstat(widgetsRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return []
  const claims: DocumentSourceClaim[] = []
  await scanLegacyWidgetDirectory(widgetsRoot, [], claims, { entries: 0 })
  return claims
}

export async function listLegacyDocumentClaims(
  spaceRoot: string,
  aliases?: DocAliases,
  registry: DocumentFormatRegistry = createBuiltinDocumentFormatRegistry()
): Promise<DocumentSourceClaim[]> {
  const [docs, html] = await Promise.all([
    listLegacyDocClaims(spaceRoot, aliases, registry),
    listLegacyHtmlClaims(spaceRoot),
  ])
  return [...docs, ...html].sort((a, b) =>
    compareStrings(a.source.relativePath, b.source.relativePath)
  )
}
