import {
  queryOptions,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { listDocs, readDoc, resolveDocumentReferences, writeDoc } from "./docs-api";
import type { DocMeta } from "./docs-api";
import { abandonableRead } from "./http";
import {
  spaceReadMark,
  spaceUnchangedSince,
  spaceValidatedLive,
  trackSpaceRead,
  type SpaceMark,
} from "./space-observation";

// ── Query Keys ──────────────────────────────────────────────

// A document and its reference lookups sit beside the list, never under it:
// refreshing the list cannot refetch a document's content, and a document
// named "references" cannot share a key with reference lookups.
export const docQueryKeys = {
  docs: (spaceId: string) => ["spaces", spaceId, "docs"] as const,
  doc: (spaceId: string, path: string) =>
    ["spaces", spaceId, "doc", path] as const,
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

const docReadKey = (spaceId: string, path: string) =>
  `doc\0${spaceId}\0${path}`;

export const docQueryOptions = (spaceId: string, path: string) =>
  queryOptions({
    queryKey: docQueryKeys.doc(spaceId, path),
    queryFn: (context) =>
      trackSpaceRead(spaceId, docReadKey(spaceId, path), () =>
        abandonableRead(context, (read) => readDoc(spaceId, path, read))
      ),
    staleTime: 10_000,
    enabled: !!path,
  });

// The route and the renderer can load separate copies of this module.
const openStartsGlobal = globalThis as typeof globalThis & {
  __worktableDocumentOpenStarts?: Map<string, number>;
};
const openStarts =
  openStartsGlobal.__worktableDocumentOpenStarts ??
  (openStartsGlobal.__worktableDocumentOpenStarts = new Map());

/** A navigation to this document began; reads from now on validate it. */
export function noteDocumentOpen(spaceId: string, path: string): void {
  openStarts.set(docReadKey(spaceId, path), performance.now());
}

export function documentOpenStartedAt(spaceId: string, path: string): number | undefined {
  return openStarts.get(docReadKey(spaceId, path));
}

/**
 * The cached document is current enough to open without reading it again:
 * it was read on a live socket with nothing new since, or read after this
 * open began with no change arriving since.
 */
export function docReadCurrent(
  spaceId: string,
  path: string,
  openStartedAt: number
): boolean {
  const mark: SpaceMark | undefined = spaceReadMark(docReadKey(spaceId, path));
  if (!mark) return false;
  return (
    spaceValidatedLive(spaceId, mark) ||
    (mark.at >= openStartedAt && spaceUnchangedSince(spaceId, mark))
  );
}

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
