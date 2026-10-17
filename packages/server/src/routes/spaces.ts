import { noteSpaceCreatedForSetup } from "../personal-setup.ts";
import { teamsEnabled } from "../team-database.ts";
import { canAccessSpace, currentRequestIdentity, teamMemberForIdentity } from "../team-policy.ts";
import { accessSnapshot, spaceAccessKey } from "../team-access.ts";
import { requireScope, requireWorkspaceOwner, restWriteActor } from "../auth.ts";
import { Hono } from "hono";
import { z } from "zod";
import { RECOGNITION_COLORS } from "@worktable/types";
import {
  listSpaces,
  occupiedSpaceIds,
  mutateSpace,
  readSpace,
  writeSpace,
  deleteSpace,
  setSpaceArchived,
  slugify,
  deduplicateSlug,
} from "../store.ts";
import { buildSpaceIndex } from "../space-index.ts";
import {
  START_HERE_LIMIT,
  StartHerePinSchema,
  type ResolvedStartHerePin,
  type SpaceFile,
  type WithContentRevision,
} from "@worktable/types";
import { withContentRevisions } from "../document-content-revision.ts";
import { resolveStartHere, setStartHere, StartHereError } from "../space-start-here.ts";
import { wsManager } from "../ws.ts";
import { hasScope } from "../token-store.ts";

export const spacesRouter = new Hono();

function spaceView(space: SpaceFile) {
  if (!teamsEnabled()) return space;
  const identity = currentRequestIdentity();
  const member = identity ? teamMemberForIdentity(identity) : null;
  // The browser keys cached content by this per-Space value, so a change to
  // one Space's access leaves every other Space's cache in place.
  const accessKey = member ? spaceAccessKey(member.id, space.id) : null;
  return {
    ...space,
    permissions: {
      edit: canAccessSpace(space.id, "edit"),
      manage: canAccessSpace(space.id, "manage"),
      shared: accessSnapshot()?.visibility.get(space.id) === "shared",
      ...(accessKey ? { accessKey } : {}),
    },
  };
}

const ArchiveSpaceSchema = z.object({
  archivedBy: z.string().optional(),
  reason: z.string().optional(),
});

// GET /api/spaces — every Space, archived ones included. Each Space's
// documents are listed by /api/spaces/:spaceId/documents.
spacesRouter.get("/", requireScope("docs:read"), async (c) => {
  const spaces = await listSpaces();
  return c.json({ spaces: spaces.map(spaceView) });
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
  const existingSlugs = await occupiedSpaceIds();
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
  const identity = c.get("identity");
  noteSpaceCreatedForSetup(
    spaceId,
    Boolean(identity?.agent) || identity?.principal.type === "agent"
  );
  return c.json({ spaceId }, 201);
});

spacesRouter.post("/:spaceId/archive", requireScope("docs:write"), async (c) => {
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

spacesRouter.post("/:spaceId/restore", requireScope("docs:write"), async (c) => {
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

// GET /api/spaces/:spaceId — space + resolved pins
spacesRouter.get("/:spaceId", requireScope("docs:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const { data: space, error } = await readSpace(spaceId);

  if (error || !space) {
    return c.json({ error: error ?? "Not found", code: "NOT_FOUND" }, 404);
  }

  const pins = hasScope(c.get("identity").scopes, "documents:read")
    ? await withContentRevisions(
        await resolveStartHere(spaceId, space),
        (pin) => (pin.status === "missing" ? null : { spaceId, path: pin.path }),
        (pin, revision): WithContentRevision<ResolvedStartHerePin> => ({
          ...pin,
          revision,
        })
      )
    : [];
  return c.json({ space: spaceView(space), pins });
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

spacesRouter.put("/:spaceId/doc-order", async (c, next) => teamsEnabled() ? requireScope("docs:write")(c, next) : requireWorkspaceOwner()(c, next), async (c) => {
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

// PUT /api/spaces/:spaceId/pins — replace the Space's pinned docs
const PinsBodySchema = z.object({
  pins: z.array(StartHerePinSchema).max(START_HERE_LIMIT),
});

spacesRouter.put("/:spaceId/pins", requireScope("docs:write"), requireScope("documents:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const parsed = PinsBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  }
  try {
    return c.json({ pins: await setStartHere(spaceId, parsed.data.pins) });
  } catch (error) {
    if (error instanceof StartHereError) {
      return error.reason === "not-found"
        ? c.json({ error: error.message, code: "NOT_FOUND" }, 404)
        : c.json({ error: error.message, code: "VALIDATION_ERROR" }, 400);
    }
    throw error;
  }
});

// PUT /api/spaces/:spaceId — update space metadata
const UpdateSpaceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  group: z.string().optional(),
  /** A recognition color, or "" to return to the default. */
  color: z.union([z.enum(RECOGNITION_COLORS), z.literal("")]).optional(),
});

spacesRouter.put("/:spaceId", requireScope("docs:write"), async (c) => {
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
  const { color, ...fields } = parsed.data;
  if (fields.group === "") {
    fields.group = undefined;
  }

  // Name, description, icon, color and group change the Space for everyone.
  // The color lives in settings, outside the Space schema agents read.
  const { data: updated, error: mutationError } = await mutateSpace(
    spaceId,
    (space) => {
      const settings = { ...space.settings };
      if (color) settings.color = color;
      else if (color === "") delete settings.color;
      return {
        ...space,
        ...fields,
        settings,
        updatedAt: new Date().toISOString(),
      };
    },
    "manage"
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
spacesRouter.delete("/:spaceId", async (c, next) => {
  if (teamsEnabled()) {
    if (!canAccessSpace(c.req.param("spaceId"), "manage")) return c.json({ error: "Forbidden" }, 403);
    return next();
  }
  return requireWorkspaceOwner()(c, next);
}, async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const { data: space, error } = await readSpace(spaceId);

  if (error || !space) {
    return c.json({ error: error ?? "Not found", code: "NOT_FOUND" }, 404);
  }

  await deleteSpace(spaceId);
  return new Response(null, { status: 204 });
});
