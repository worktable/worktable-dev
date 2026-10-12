import { Hono } from "hono";
import type { SearchResult, WithContentRevision } from "@worktable/types";
import { requireScope } from "../auth.ts";
import { withContentRevisions } from "../document-content-revision.ts";
import { searchWithStatus } from "../search-index.ts";
import { hasScope } from "../token-store.ts";

export const searchRouter = new Hono();

searchRouter.use("*", requireScope("search:read"));

searchRouter.get("/", async (c) => {
  const query = c.req.query("query")?.trim() ?? "";
  if (!query) {
    return c.json({ error: "Missing query", code: "BAD_REQUEST" }, 400);
  }

  const commonDocuments = c.req.query("documentMode") === "common";
  if (
    commonDocuments &&
    !hasScope(c.get("identity")?.scopes ?? [], "documents:read")
  ) {
    return c.json({ error: "Forbidden", required: "documents:read" }, 403);
  }

  const spaceId = c.req.query("spaceId") || undefined;
  const searchBlocks = c.req.query("searchBlocks") !== "false";
  const includeArchived = c.req.query("includeArchived") === "true";
  const maxResultsRaw = c.req.query("maxResults");
  const maxResults = maxResultsRaw ? Math.max(1, Math.min(100, Number(maxResultsRaw) || 20)) : 20;

  const { results, complete } = await searchWithStatus(query, {
    spaceId,
    searchBlocks,
    includeArchived,
    maxResults,
    documentAccess: commonDocuments ? "common" : "legacy",
  });

  // Document results open by content revision.
  const rows = await withContentRevisions(
    results,
    (result) =>
      result.type === "doc" && result.path && result.documentView
        ? { spaceId: result.spaceId, path: result.path }
        : null,
    (result, revision): WithContentRevision<SearchResult> => ({
      ...result,
      revision,
    })
  );

  // While the index is still building, more matches may exist; the client
  // asks again shortly.
  return c.json({ results: rows, ...(complete ? {} : { indexing: true }) });
});
