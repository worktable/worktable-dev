import { requireScope, requireWorkspaceOwner, restWriteActor } from "../auth.ts";
import { Hono } from "hono";
import { z } from "zod";
import {
  listSpaces,
  listDocsDetailed,
  getSpaceArchiveInfo,
  mutateSpace,
  readSpace,
  writeSpace,
  deleteSpace,
  setSpaceArchived,
  slugify,
  deduplicateSlug,
} from "../store.ts";
import { listWidgets } from "../widget-store.ts";
import { decorateWidgetsWithFreshness } from "../widget-freshness.ts";
import { buildSpaceIndex } from "../space-index.ts";
import type { SpaceFile } from "@worktable/types";
import { wsManager } from "../ws.ts";

export const spacesRouter = new Hono();

const ArchiveSpaceSchema = z.object({
  archivedBy: z.string().optional(),
  reason: z.string().optional(),
});

// GET /api/spaces — list all spaces (with doc paths for sidebar)
spacesRouter.get("/", requireScope("docs:read"), requireScope("widgets:read"), async (c) => {
  const includeArchived = c.req.query("includeArchived") === "true";
  const spaces = await listSpaces();
  const filteredSpaces = includeArchived
    ? spaces
    : spaces.filter((space) => !getSpaceArchiveInfo(space));

  // Bundle doc paths and widget metadata per space to avoid N+1 sidebar fetches.
  const spacesWithDocs = await Promise.all(
    filteredSpaces.map(async (space) => {
      const [docs, widgets] = await Promise.all([
        listDocsDetailed(space.id, { includeArchived }),
        listWidgets(space.id, { includeArchived }),
      ]);
      return { ...space, docs, widgets };
    })
  );

  return c.json({ spaces: spacesWithDocs });
});

// POST /api/spaces — create a new space
const CreateSpaceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  group: z.string().optional(),
  createdBy: z.string().optional(),
});

spacesRouter.post("/", requireScope("docs:write"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, 400);
  }

  const parsed = CreateSpaceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    );
  }

  const { name, description, icon, group, createdBy = "user" } = parsed.data;

  // Deduplicate slug
  const existingSpaces = await listSpaces();
  const existingSlugs = existingSpaces.map((s) => s.id);
  const baseSlug = slugify(name);
  const spaceId = await deduplicateSlug(baseSlug, existingSlugs);

  const now = new Date().toISOString();
  const space: SpaceFile = {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name,
    description,
    icon,
    group,
    createdAt: now,
    updatedAt: now,
    createdBy: restWriteActor(c, createdBy),
    settings: {},
  };

  await writeSpace(space);
  return c.json({ spaceId }, 201);
});

spacesRouter.post("/:spaceId/archive", requireWorkspaceOwner(), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const body = await c.req.json().catch(() => ({}));
  const parsed = ArchiveSpaceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  }

  const { space, error } = await setSpaceArchived(
    spaceId,
    true,
    restWriteActor(c, parsed.data.archivedBy),
    parsed.data.reason
  );
  if (error || !space) {
    return c.json({ error: error ?? "Not found", code: "NOT_FOUND" }, 404);
  }

  wsManager.broadcastAll({ type: "spaces_changed" });
  return c.json({ ok: true, space });
});

spacesRouter.post("/:spaceId/restore", requireWorkspaceOwner(), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const { space, error } = await setSpaceArchived(spaceId, false);
  if (error || !space) {
    return c.json({ error: error ?? "Not found", code: "NOT_FOUND" }, 404);
  }

  wsManager.broadcastAll({ type: "spaces_changed" });
  return c.json({ ok: true, space });
});

// GET /api/spaces/:spaceId/index — server-generated space index (computed,
// never stored, not agent-writable). Registered before GET /:spaceId so the
// literal segment is matched first.
spacesRouter.get("/:spaceId/index", requireScope("docs:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const index = await buildSpaceIndex(spaceId);
  if (!index) {
    return c.json({ error: `Space not found: ${spaceId}`, code: "NOT_FOUND" }, 404);
  }
  return c.json({ index });
});

// GET /api/spaces/:spaceId — space + widgets
spacesRouter.get("/:spaceId", requireScope("docs:read"), requireScope("widgets:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const { data: space, error } = await readSpace(spaceId);

  if (error || !space) {
    return c.json({ error: error ?? "Not found", code: "NOT_FOUND" }, 404);
  }

  const widgets = await decorateWidgetsWithFreshness(spaceId, await listWidgets(spaceId, { includeArchived: true }));
  return c.json({ space, widgets });
});

// PUT /api/spaces/:spaceId/doc-order — persist common document-tree ordering.
// The established docOrder/docSort keys remain portable and backward
// compatible as more formats join the shared namespace.
const DocOrderSchema = z
  .object({
    order: z.array(z.string().min(1)).max(10_000).optional(),
    sort: z.enum(["custom", "alphabetical", "updated"]).optional(),
  })
  .refine((v) => v.order !== undefined || v.sort !== undefined, {
    message: "Provide order and/or sort",
  });

spacesRouter.put("/:spaceId/doc-order", requireWorkspaceOwner(), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, 400);
  }

  const parsed = DocOrderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    );
  }

  const { data: updated, error: mutationError } = await mutateSpace(
    spaceId,
    (space) => {
      const settings = { ...space.settings };
      if (parsed.data.order !== undefined) {
        settings["docOrder"] = parsed.data.order;
      }
      if (parsed.data.sort !== undefined) {
        settings["docSort"] = parsed.data.sort;
      }
      return {
        ...space,
        settings,
        updatedAt: new Date().toISOString(),
      };
    }
  );
  if (mutationError || !updated) {
    return c.json(
      { error: mutationError ?? "Not found", code: "NOT_FOUND" },
      404
    );
  }
  return c.json({ space: updated });
});

// PUT /api/spaces/:spaceId — update space metadata
const UpdateSpaceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  group: z.string().optional(),
});

spacesRouter.put("/:spaceId", requireWorkspaceOwner(), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, 400);
  }

  const parsed = UpdateSpaceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    );
  }

  // Treat empty-string group as "no group"
  const fields = { ...parsed.data };
  if (fields.group === "") {
    fields.group = undefined;
  }

  const { data: updated, error: mutationError } = await mutateSpace(
    spaceId,
    (space) => ({
      ...space,
      ...fields,
      updatedAt: new Date().toISOString(),
    })
  );
  if (mutationError || !updated) {
    return c.json(
      { error: mutationError ?? "Not found", code: "NOT_FOUND" },
      404
    );
  }
  return c.json({ space: updated });
});

// DELETE /api/spaces/:spaceId — delete a space and all its contents
spacesRouter.delete("/:spaceId", requireWorkspaceOwner(), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const { data: space, error } = await readSpace(spaceId);

  if (error || !space) {
    return c.json({ error: error ?? "Not found", code: "NOT_FOUND" }, 404);
  }

  await deleteSpace(spaceId);
  return new Response(null, { status: 204 });
});
