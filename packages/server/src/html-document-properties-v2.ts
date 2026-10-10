import {
  WidgetFileSchema,
  type DocumentId,
  type WidgetFile,
} from "@worktable/types"
import { analyzeDocumentPath } from "./document-path.ts"
import { readDocumentPortableStateV2 } from "./document-data-v2.ts"
import type { DocumentGenerationPayloadEntry } from "./document-version-store-v2.ts"

export const HTML_DOCUMENT_PROPERTIES_ENTRY = "html/properties.json"

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

export interface HtmlPropertiesEnvelope {
  type: "worktable.html-properties"
  version: 1
  sourceSha256: string
  widget: WidgetFile
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

export function parsePropertiesEnvelope(
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

/**
 * An HTML Doc's saved properties as one read of its portable state found
 * them: no state yet, state that does not belong to this document, or the
 * properties entry (absent when the state has none).
 */
export type HtmlDocumentPropertiesRead =
  | { kind: "none" }
  | { kind: "mismatch" }
  | { kind: "read"; entry: DocumentGenerationPayloadEntry | undefined }

/** Read saved display metadata without resolving the catalog again. */
export async function readHtmlDocumentPropertiesV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  path: string
}): Promise<HtmlDocumentPropertiesRead> {
  const state = await readDocumentPortableStateV2(input)
  if (!state) return { kind: "none" }
  if (
    state.manifest.logicalPath !== input.path ||
    state.manifest.format.id !== "worktable.html" ||
    state.manifest.format.sourceVersion !== 1
  ) {
    return { kind: "mismatch" }
  }
  return {
    kind: "read",
    entry: state.entries.find(
      (entry) => entry.path === HTML_DOCUMENT_PROPERTIES_ENTRY
    ),
  }
}

export function htmlDocumentTitleFromProperties(
  read: HtmlDocumentPropertiesRead,
  path: string
): string | undefined {
  return read.kind === "read"
    ? parsePropertiesEnvelope(read.entry, path, null)?.widget.name
    : undefined
}
