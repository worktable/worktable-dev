import {
  queryOptions,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { listDocs, readDoc, resolveDocumentReferences, writeDoc } from "./docs-api";
import type { DocMeta } from "./docs-api";

// ── Query Keys ──────────────────────────────────────────────

export const docQueryKeys = {
  docs: (spaceId: string) => ["spaces", spaceId, "docs"] as const,
  doc: (spaceId: string, path: string) =>
    ["spaces", spaceId, "docs", path] as const,
  references: (spaceId: string, paths: unknown[]) =>
    ["spaces", spaceId, "docs", "references", paths] as const,
};

export const documentReferencesQueryOptions = (spaceId: string, paths: unknown[]) =>
  queryOptions({
    queryKey: docQueryKeys.references(spaceId, paths),
    queryFn: () => resolveDocumentReferences(spaceId, paths),
    staleTime: 30_000,
    enabled: paths.length > 0,
  });

// ── Query Options ───────────────────────────────────────────

export const spaceDocsQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: docQueryKeys.docs(spaceId),
    queryFn: () => listDocs(spaceId),
    staleTime: 30_000,
  });

export const docQueryOptions = (spaceId: string, path: string) =>
  queryOptions({
    queryKey: docQueryKeys.doc(spaceId, path),
    queryFn: () => readDoc(spaceId, path),
    staleTime: 10_000,
    enabled: !!path,
  });

// ── Hooks ───────────────────────────────────────────────────

export function useSpaceDocs(spaceId: string) {
  return useQuery(spaceDocsQueryOptions(spaceId));
}

export function useDoc(spaceId: string, path: string) {
  return useQuery(docQueryOptions(spaceId, path));
}

export function useDocMutation(spaceId: string, path: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (content: unknown[]) => writeDoc(spaceId, path, content),
    onSuccess: (result) => {
      // Optimistically update the cache
      queryClient.setQueryData<DocMeta>(
        docQueryKeys.doc(spaceId, path),
        (old) =>
          old
            ? { ...old, updatedAt: result.updatedAt, provenance: result.provenance }
            : undefined
      );
    },
  });
}
