import { Hono } from "hono";
import { requireScope } from "../auth.ts";
import { search } from "../search-index.ts";
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

  const results = await search(query, {
    spaceId,
    searchBlocks,
    includeArchived,
    maxResults,
    documentAccess: commonDocuments ? "common" : "legacy",
  });

  return c.json({ results });
});
