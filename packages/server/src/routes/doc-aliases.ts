import { requireScope, requireWorkspaceOwner } from "../auth.ts";
import { Hono } from "hono";
import { readDocAliases, retireDocAlias, type AliasKind } from "../doc-aliases.ts";

export const docAliasesRouter = new Hono();

docAliasesRouter.get("/", requireScope("documents:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const result = await readDocAliases(spaceId);
  if (!result.aliases) {
    return c.json({ error: result.error, code: "ALIAS_STATE_CORRUPT" }, 409);
  }
  return c.json({ aliases: result.aliases });
});

docAliasesRouter.delete("/:kind/*", requireWorkspaceOwner(), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const kind = c.req.param("kind") as AliasKind;
  if (kind !== "exact" && kind !== "prefix") {
    return c.json({ error: "Alias kind must be exact or prefix", code: "BAD_REQUEST" }, 400);
  }
  if (c.req.query("acknowledgeLinkRetargeting") !== "true") {
    return c.json(
      {
        error:
          "Retiring an alias can change what existing links mean. Retry with acknowledgeLinkRetargeting=true.",
        code: "ACKNOWLEDGEMENT_REQUIRED",
      },
      409
    );
  }
  const marker = `/api/spaces/${spaceId}/doc-aliases/${kind}/`;
  const path = decodeURIComponent(c.req.path.slice(marker.length));
  if (!path) return c.json({ error: "Missing alias path", code: "BAD_REQUEST" }, 400);
  try {
    const removed = await retireDocAlias(spaceId, path, kind);
    if (!removed) return c.json({ error: "Alias not found", code: "NOT_FOUND" }, 404);
    return c.json({ ok: true, path, kind });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Alias retirement failed", code: "CONFLICT" },
      409
    );
  }
});
