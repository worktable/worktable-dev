// ============================================================
// What else uses a document or its folder
// ============================================================
//
// Before a Doc and its folder are deleted, people see which of the files
// in it other Docs still use, and keep those by default. Agents get the same
// default. Uses come from the link graph: links and embeds.

import { analyzeDocumentPath, documentPathKeyIsAtOrBelow } from "./document-path.ts"
import { readDocumentCatalogSnapshot } from "./document-query.ts"
import { getSpaceLinkGraph } from "./link-graph.ts"

export interface DocumentUses {
  documentId: string
  path: string
  title: string
  formatId: string
  /** Documents outside the deleted set that link to or embed this one. */
  usedBy: string[]
}

/** The document at `path` and everything in its folder, with their outside uses. */
export async function usesAtOrBelow(
  spaceId: string,
  path: string
): Promise<DocumentUses[]> {
  const key = analyzeDocumentPath(path).comparisonKey
  if (!key) return []
  const catalog = await readDocumentCatalogSnapshot(spaceId)
  const inside = catalog.entries.flatMap((entry) => {
    if (entry.kind !== "document") return []
    const entryKey = analyzeDocumentPath(entry.descriptor.path).comparisonKey
    return entryKey && documentPathKeyIsAtOrBelow(entryKey, key) ? [entry] : []
  })
  const set = new Set(inside.map((entry) => entry.descriptor.path))
  const graph = await getSpaceLinkGraph(spaceId)
  return inside.map((entry) => ({
    documentId: entry.descriptor.documentId,
    path: entry.descriptor.path,
    title: entry.descriptor.title,
    formatId: entry.descriptor.format.id,
    usedBy: (graph.inbound.get(entry.descriptor.path) ?? []).filter(
      (source) => !set.has(source)
    ),
  }))
}
