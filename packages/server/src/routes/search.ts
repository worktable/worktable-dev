import { Hono } from "hono";
import {
  SEARCH_KINDS,
  type FoundResult,
  type SearchKind,
  type WithContentRevision,
} from "@worktable/types";
import { requireScope } from "../auth.ts";
import { withContentRevisions } from "../document-content-revision.ts";
import { searchWithStatus, shownCorrections } from "../search-index.ts";
import { withSkills } from "../skill-libraries.ts";
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
  // The app's order: archived results marked, after the rest.
  const archivedLast = includeArchived && c.req.query("archivedLast") === "true";
  const kindsRaw = c.req.query("kinds");
  const kinds = kindsRaw
    ?.split(",")
    .filter((kind): kind is SearchKind =>
      (SEARCH_KINDS as readonly string[]).includes(kind)
    );
  if (kindsRaw !== undefined && kinds?.length === 0) {
    return c.json({ error: "Unknown kinds", code: "BAD_REQUEST" }, 400);
  }
  const maxResultsRaw = c.req.query("maxResults");
  const maxResults = maxResultsRaw ? Math.max(1, Math.min(100, Number(maxResultsRaw) || 20)) : 20;

  const { results, complete, corrected } = await searchWithStatus(query, {
    spaceId,
    searchBlocks,
    includeArchived,
    archivedLast,
    ...(kinds ? { kinds } : {}),
    maxResults,
    documentAccess: commonDocuments ? "common" : "legacy",
    includeThreads: hasScope(c.get("identity")?.scopes ?? [], "threads:read"),
  });

  // Skills show only to a reader the Library itself would admit. A skill is
  // a Doc, so a search for other kinds has none.
  const found =
    hasScope(c.get("identity")?.scopes ?? [], "documents:read") &&
    (!kinds || kinds.includes("doc"))
      ? await withSkills(c.get("identity"), query, results, { spaceId, maxResults })
      : results;

  // Document results open by content revision.
  const rows = await withContentRevisions(
    found,
    (result) =>
      result.type === "doc" && result.path && result.documentView
        ? { spaceId: result.spaceId, path: result.path }
        : null,
    (result, revision): WithContentRevision<FoundResult> => ({
      ...result,
      revision,
    })
  );

  // While the index is still building, more matches may exist; the client
  // asks again shortly.
  // Words searched for in place of misspelled ones, to mark in the results
  // returned: skills can take a result's place.
  const shown = shownCorrections(corrected, rows);
  return c.json({
    results: rows,
    ...(complete ? {} : { indexing: true }),
    ...(shown.length > 0 ? { corrected: shown } : {}),
  });
});
