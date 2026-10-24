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
  /**
   * Documents that link to or embed this one and stay: those outside the
   * folder, and those in it that are kept because something uses them.
   */
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
  // What stays: anything a document outside uses, then anything those use,
  // until nothing more is needed. The Doc being deleted never stays.
  const kept = new Set<string>()
  const stays = (source: string) => !set.has(source) || kept.has(source)
  for (let changed = true; changed; ) {
    changed = false
    for (const entry of inside) {
      const entryPath = entry.descriptor.path
      if (entryPath === path || kept.has(entryPath)) continue
      if ((graph.inbound.get(entryPath) ?? []).some(stays)) {
        kept.add(entryPath)
        changed = true
      }
    }
  }
  return inside.map((entry) => ({
    documentId: entry.descriptor.documentId,
    path: entry.descriptor.path,
    title: entry.descriptor.title,
    formatId: entry.descriptor.format.id,
    usedBy: (graph.inbound.get(entry.descriptor.path) ?? []).filter(stays),
  }))
}
