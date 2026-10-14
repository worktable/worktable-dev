import { queryOptions, useQuery } from "@tanstack/react-query";
import { listDocs, resolveDocumentReferences } from "./docs-api";
import { abandonableRead } from "./http";

// ── Query Keys ──────────────────────────────────────────────

// Reference lookups sit beside the list, never under it, so a document
// named "references" cannot share a key with them. A document's content is
// read by revision (documents-queries.ts).
export const docQueryKeys = {
  docs: (spaceId: string) => ["spaces", spaceId, "docs"] as const,
  referencesIn: (spaceId: string) =>
    ["spaces", spaceId, "doc-references"] as const,
  references: (spaceId: string, paths: unknown[]) =>
    ["spaces", spaceId, "doc-references", paths] as const,
};

export const documentReferencesQueryOptions = (spaceId: string, paths: unknown[]) =>
  queryOptions({
    queryKey: docQueryKeys.references(spaceId, paths),
    queryFn: (context) =>
      abandonableRead(context, (read) =>
        resolveDocumentReferences(spaceId, paths, read)
      ),
    staleTime: 30_000,
    enabled: paths.length > 0,
  });

// ── Query Options ───────────────────────────────────────────

export const spaceDocsQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: docQueryKeys.docs(spaceId),
    queryFn: () => listDocs(spaceId, true),
    staleTime: 30_000,
  });

// ── Hooks ───────────────────────────────────────────────────

export function useSpaceDocs(spaceId: string) {
  return useQuery(spaceDocsQueryOptions(spaceId));
}
