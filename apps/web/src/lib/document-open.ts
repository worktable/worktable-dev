import type { QueryClient } from "@tanstack/react-query"
import type { DocumentPageResult } from "@worktable/types"
import {
  documentPageQueryOptions,
  documentPageValidated,
  documentPageValidatedLive,
  noteDocumentOpen,
  prefetchDocumentContent,
} from "./documents-queries.ts"
import {
  browserDocumentRenderer,
  previewDocumentRenderer,
} from "./document-renderers.tsx"
import { documentOpenHint, type DocumentOpenHint } from "./document-rows.ts"

// How a Doc opens: its page check, its content and its renderer start
// together, on a hover as on a click, so the page shows whole. The Doc route
// and the Library's open skill both open Docs this way.

function startDocumentReads(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  hint: DocumentOpenHint
): void {
  if (hint.renderer === "doc") {
    void prefetchDocumentContent(
      queryClient,
      spaceId,
      path,
      hint.revision
    ).catch(() => {})
  }
  if (typeof window === "undefined") return
  void previewDocumentRenderer(hint.renderer)
    .preload(hint.formatId)
    .catch(() => {})
}

function startDocumentReadsForPage(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  page: DocumentPageResult
): void {
  if (
    page.kind === "conflict" ||
    !page.renderer ||
    page.document.path !== path
  ) {
    return
  }
  if (typeof window !== "undefined") {
    void browserDocumentRenderer(page.renderer)
      ?.preload(page.document.format.id)
      .catch(() => {})
  }
  if (page.renderer.key === "doc" && page.revision) {
    void prefetchDocumentContent(
      queryClient,
      spaceId,
      path,
      page.revision,
      true
    ).catch(() => {})
  }
}

/**
 * Start opening a Doc, and resolve once the page can show it: at once when
 * the tab knows its content (the check validates it behind), otherwise when
 * the page check is in.
 */
export async function openDocument(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  { preload, cause }: { preload: boolean; cause: string }
): Promise<void> {
  const options = documentPageQueryOptions(spaceId, path)
  const opening = !preload && cause === "enter"
  if (opening) noteDocumentOpen(spaceId, path)
  // A hover, a tap and a click all start reading the content at the
  // revision the tab knows, beside the page check.
  const hint = documentOpenHint(queryClient, spaceId, path)
  if (hint) startDocumentReads(queryClient, spaceId, path, hint)
  // A cached check is reused (a hover preload's, say) only while the
  // Space's live socket proves nothing about this document changed since.
  const checkNow = (proven: boolean) =>
    queryClient.fetchQuery({
      ...options,
      staleTime: proven ? Infinity : 0,
      retry: false,
    })
  let check = checkNow(documentPageValidatedLive(spaceId, path))
  if (opening) {
    // A check already running when the open began (a tap's preload, say)
    // validates it only if the live socket proves it; otherwise check
    // once more after it.
    check = check.then((page) =>
      documentPageValidated(spaceId, path) ? page : checkNow(false)
    )
  }
  if (hint) {
    // Known content opens read-only at once; the check validates it.
    void check
      .then((page) =>
        startDocumentReadsForPage(queryClient, spaceId, path, page)
      )
      .catch(() => {})
    return
  }
  try {
    startDocumentReadsForPage(queryClient, spaceId, path, await check)
  } catch {
    // fetchQuery preserves prior data on a failed refresh. Remove it so a
    // missing or unreachable path cannot fall through to a stale renderer.
    queryClient.removeQueries({ queryKey: options.queryKey, exact: true })
  }
}
