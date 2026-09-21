import { requireScope, requireHumanWorkspaceOwner, restWriteActor } from "../auth.ts";
import { documentSourceDisposition } from "../content-disposition.ts";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { WIDGET_RESERVED_SEGMENTS, WidgetIdSchema, type WidgetFile } from "@worktable/types";
import { readSpace, slugifyDocPath } from "../store.ts";
import { getWidgetPath, listWidgets, readWidget, readWidgetDocument, setWidgetArchived, updateWidgetMetadata, withWidgetWriteLock, writeWidget } from "../widget-store.ts";
import { createRecord, deleteRecord, queryRecords, queryTargetCollections, readWidgetState, RecordQueryError, updateRecord, writeWidgetState } from "../record-store.ts";
import { applyWidgetTheme, buildWidgetFile, getBlockingWidgetIssue, injectWidgetRuntime, validateWidgetHtml } from "../widget-authoring.ts";
import { captureWidgetContentForOverwrite, captureWidgetVersionContent, getWidgetProvenance, getWidgetVersion, listWidgetVersions, recordWidgetVersion } from "../widget-version-store.ts";
import { invalidateSearchIndex, noteRecordMutated } from "../search-index.ts";
import { decorateWidgetsWithFreshness, evictWidgetFreshness, getWidgetFreshness } from "../widget-freshness.ts";
import { wsManager } from "../ws.ts";
import { deleteHtmlDocument } from "../html-document-delete.ts";
import { moveHtmlDocument } from "../html-document-move.ts";
import { createHtmlDocument } from "../html-document-create.ts";
import { ManagedDocumentAdmissionError } from "../document-identity-admission.ts";
import {
  HtmlDocumentPathConflictError,
  withCanonicalHtmlDocumentPath,
} from "../html-document-path.ts";
import {
  htmlDocumentSourceExistsV2,
  isHtmlDocumentPath,
  usesHtmlDocumentStorageV2,
} from "../html-document-storage-v2.ts";

export const widgetsRouter: Hono = new Hono();

widgetsRouter.use("*", async (c, next) => {
  const rest = parseWidgetTarget(c)?.rest;
  const read = c.req.method === "GET" || c.req.method === "HEAD" ||
    (c.req.method === "POST" && rest?.length === 3 && rest[0] === "records" && rest[2] === "query");
  return requireScope(read ? "widgets:read" : "widgets:write")(c, next);
});

const WidgetPermissionsInputSchema = z.object({
  network: z.boolean().optional(),
  records: z.record(z.string(), z.object({
    read: z.boolean().optional(),
    create: z.boolean().optional(),
    update: z.boolean().optional(),
    delete: z.boolean().optional(),
  })).optional(),
  state: z.object({ read: z.boolean().optional(), write: z.boolean().optional() }).optional(),
});

function normalizeWidgetPermissions(input: z.infer<typeof WidgetPermissionsInputSchema> | undefined) {
  if (!input) return undefined;
  return {
    network: input.network ?? false,
    records: input.records ?? {},
    state: { read: input.state?.read ?? true, write: input.state?.write ?? true },
  };
}

const CreateWidgetSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  html: z.string().min(1),
  createdBy: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  permissions: WidgetPermissionsInputSchema.optional(),
});

const PutWidgetSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  html: z.string().min(1),
  updatedBy: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  permissions: WidgetPermissionsInputSchema.optional(),
});

const PatchWidgetSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  updatedBy: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const MoveWidgetSchema = z.object({
  newPath: z.string().min(1),
});

const ArchiveWidgetSchema = z.object({
  reason: z.string().optional(),
  archivedBy: z.string().optional(),
});

// Widgets render in an opaque-origin sandbox; this CSP is the real egress control.
// By default a widget may only talk same-origin (its brokered /records + /state via
// the parent). The `network` permission is the opt-in that
// widens connect-src to allow outbound HTTPS and WebSockets. Scripts/styles/assets stay locked to
// inline + data/blob regardless — external resource loading is never granted here.
//
// The `sandbox allow-scripts` directive forces an OPAQUE origin even when this
// content is loaded as a top-level document (the "Open in new tab" action serves
// /content directly, outside the iframe's sandbox attribute). Without it, authored
// widget JS would run at the real app origin there and its fetch to /review or
// /versions/checkpoint would carry Sec-Fetch-Site: same-origin and pass the human
// trust-anchor gate. In-iframe use is unaffected — the iframe already sandboxes to
// an opaque origin, and the broker validates event.source, not the frame origin.
function buildWidgetCsp(network: boolean): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    network ? "connect-src 'self' ws: wss: https:" : "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function canRecord(widget: { permissions?: { records?: Record<string, { read?: boolean; create?: boolean; update?: boolean; delete?: boolean }> } }, collectionId: string, action: "read" | "create" | "update" | "delete"): boolean {
  const permission = widget.permissions?.records?.[collectionId] ?? widget.permissions?.records?.["*"];
  return !!permission?.[action];
}

async function ensureWidgetAccess(spaceId: string, widgetId: string, collectionId: string, action: "read" | "create" | "update" | "delete") {
  const { data: widget, error } = await readWidget(spaceId, widgetId);
  if (error || !widget) return { widget: null, response: new Response(JSON.stringify({ error: error ?? "Widget not found", code: "NOT_FOUND" }), { status: 404, headers: { "Content-Type": "application/json" } }) };
  if (!canRecord(widget, collectionId, action)) return { widget: null, response: new Response(JSON.stringify({
    error: `Widget lacks ${action} permission for ${collectionId}`,
    code: "FORBIDDEN",
    missingPermission: `permissions.records.${collectionId}.${action}`,
    suggestedPermissions: { records: { [collectionId]: { [action]: true } } },
  }), { status: 403, headers: { "Content-Type": "application/json" } }) };
  return { widget, response: null };
}

// ---- Path parsing ------------------------------------------------------------
//
// Widget ids are slash-joined canonical segments (`plans/q3-redesign`), so the
// framework's single-segment `:widgetId` param cannot carry them. Instead each
// method registers a `/*` catch-all and the id/action boundary is parsed here.
// The parse is unambiguous because reserved names (records, state, content,
// archive, restore) are forbidden inside NESTED widget ids: the FIRST reserved
// segment in the sub-path is the boundary between the widget id and the action.
// One carve-out: the position immediately after /widgets/ can never be an
// action, so a reserved word there is a legacy FLAT widget id (valid before
// path-style ids) and the boundary moves past it. The extracted id is
// validated against WidgetIdSchema after per-segment decoding, so
// traversal/encoding artifacts (`..`, `%2e%2e`, empty segments) can never
// reach the legacy store. V2 uses a collision-free encoded route and the
// common document-path validator instead.

const RESERVED_BOUNDARIES = new Set<string>(WIDGET_RESERVED_SEGMENTS);

type WidgetTarget = { widgetId: string; rest: string[] };

function parseWidgetTarget(c: Context): WidgetTarget | null {
  // Full request path: /api/spaces/<spaceId>/widgets/<...sub>
  const parts = c.req.path.split("/").filter((part) => part.length > 0);
  if (parts.length < 5 || parts[0] !== "api" || parts[1] !== "spaces" || parts[3] !== "widgets") return null;
  const sub = parts.slice(4);
  if (sub[0] === "__document" && sub[1]) {
    try {
      const widgetId = Buffer.from(sub[1], "base64url").toString("utf8");
      return isHtmlDocumentPath(widgetId)
        ? {
            widgetId,
            rest: sub.slice(2).map((segment) => decodeURIComponent(segment)),
          }
        : null;
    } catch {
      return null;
    }
  }
  let boundary = sub.findIndex((segment) => RESERVED_BOUNDARIES.has(segment));
  if (boundary === -1) boundary = sub.length;
  if (boundary === 0) boundary = 1;
  let widgetId: string;
  let rest: string[];
  try {
    widgetId = sub.slice(0, boundary).map((segment) => decodeURIComponent(segment)).join("/");
    rest = sub.slice(boundary).map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (!WidgetIdSchema.safeParse(widgetId).success) return null;
  return { widgetId, rest };
}

// Logical move is a POST-only trailing action. Parse it separately instead of
// reserving `move` in WidgetIdSchema, which would invalidate existing nested
// ids that legitimately contain that segment.
function parseWidgetMoveTarget(c: Context): WidgetTarget | null {
  const parts = c.req.path.split("/").filter((part) => part.length > 0);
  if (
    parts.length < 6 ||
    parts[0] !== "api" ||
    parts[1] !== "spaces" ||
    parts[3] !== "widgets" ||
    parts.at(-1) !== "move"
  ) {
    return null;
  }
  try {
    const widgetId = parts
      .slice(4, -1)
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    return WidgetIdSchema.safeParse(widgetId).success
      ? { widgetId, rest: ["move"] }
      : null;
  } catch {
    return null;
  }
}

function widgetNotFound(c: Context) {
  return c.json({ error: "Widget not found", code: "NOT_FOUND" }, 404);
}

async function widgetArtifactsExist(
  spaceId: string,
  widgetId: string
): Promise<boolean> {
  return (await usesHtmlDocumentStorageV2())
    ? htmlDocumentSourceExistsV2(spaceId, widgetId)
    : existsSync(dirname(getWidgetPath(spaceId, widgetId)))
}

async function atCanonicalHtmlPath(
  c: Context,
  spaceId: string,
  widgetId: string,
  transaction: () => Promise<Response>,
  redirectCanonicalContent = false,
  materialize = false,
  transactionOwnsPathLock = false
) {
  try {
    return await withCanonicalHtmlDocumentPath(
      spaceId,
      widgetId,
      transaction,
      { materialize, transactionOwnsPathLock }
    );
  } catch (error) {
    if (error instanceof HtmlDocumentPathConflictError) {
      if (redirectCanonicalContent && error.canonicalPath) {
        const canonicalUrl = new URL(c.req.url);
        const canonicalId = Buffer.from(
          error.canonicalPath,
          "utf8"
        ).toString("base64url");
        canonicalUrl.pathname = `/api/spaces/${encodeURIComponent(spaceId)}/widgets/__document/${canonicalId}/content`;
        return c.redirect(canonicalUrl.toString(), 307);
      }
      return c.json(
        {
          error: error.message,
          code: "CONFLICT",
          ...(error.canonicalPath ? { canonicalPath: error.canonicalPath } : {}),
        },
        409,
      );
    }
    throw error;
  }
}

// ---- Collection routes -------------------------------------------------------

widgetsRouter.get("/", async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const includeArchived = c.req.query("includeArchived") === "true";
  const { data: space, error } = await readSpace(spaceId);
  if (error || !space) return c.json({ error: error ?? "Space not found", code: "NOT_FOUND" }, 404);
  return c.json({ widgets: await decorateWidgetsWithFreshness(spaceId, await listWidgets(spaceId, { includeArchived })) });
});

widgetsRouter.post("/", async (c) => {
  const denied = appOnlyOr403(c, "Creating an HTML doc");
  if (denied) return denied;
  const spaceId = c.req.param("spaceId") ?? "";
  const { data: space, error } = await readSpace(spaceId);
  if (error || !space) return c.json({ error: error ?? "Space not found", code: "NOT_FOUND" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = CreateWidgetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);

  const storageV2 = await usesHtmlDocumentStorageV2();
  if (
    parsed.data.id !== undefined &&
    (storageV2
      ? !isHtmlDocumentPath(parsed.data.id)
      : !WidgetIdSchema.safeParse(parsed.data.id).success)
  ) {
    return c.json({
      error: storageV2
        ? `Invalid HTML document path "${parsed.data.id}".`
        : `Invalid widget id "${parsed.data.id}". Ids are slash-separated segments of lowercase letters, digits, and hyphens; nested ids may not use reserved segment names (records, state, content, archive, restore, versions, review).`,
      code: "VALIDATION_ERROR",
    }, 400);
  }
  const permissions = normalizeWidgetPermissions(parsed.data.permissions);
  const warnings = validateWidgetHtml(parsed.data.html, permissions);
  const blockingIssue = getBlockingWidgetIssue(warnings);
  if (blockingIssue) return c.json({ error: blockingIssue.message, code: blockingIssue.code, warnings }, 400);
  let outcome: { data?: WidgetFile; error?: string };
  try {
    outcome = await createHtmlDocument({
      spaceId,
      explicitId: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.description,
      html: parsed.data.html,
      createdBy: restWriteActor(c, parsed.data.createdBy),
      metadata: parsed.data.metadata,
      permissions,
      versionSource: "rest-api",
      versionUpdatedBy: restWriteActor(c, parsed.data.createdBy),
    });
  } catch (error) {
    if (error instanceof ManagedDocumentAdmissionError) {
      return c.json({ error: error.message, code: "CONFLICT" }, 409);
    }
    throw error;
  }
  if (!outcome.data) return c.json({ error: outcome.error ?? "Write failed", code: "VALIDATION_ERROR" }, 400);
  const id = outcome.data.id;
  invalidateSearchIndex();
  wsManager.broadcast(spaceId, { type: "widget_update", spaceId, widgetId: id, data: outcome.data });
  return c.json({ widget: outcome.data, widgetId: id, warnings }, 201);
});

// ---- Handlers ----------------------------------------------------------------

async function handleGetContent(c: Context, spaceId: string, widgetId: string) {
  const { data: document, error } = await readWidgetDocument(spaceId, widgetId);
  if (error || !document) return c.json({ error: error ?? "Widget not found", code: "NOT_FOUND" }, 404);
  const { widget, html: data } = document;
  // format=raw returns the authored source (no theme/runtime injection) — the
  // portable form used by Copy HTML. Content-Disposition keeps a directly
  // opened URL from rendering as a live page outside the sandboxed frame.
  if (c.req.query("format") === "raw") {
    const filename = widgetId.split("/").pop() ?? widgetId;
    return new Response(data, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": buildWidgetCsp(false),
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": documentSourceDisposition(`${filename}.html`),
      },
    });
  }
  const themedHtml = injectWidgetRuntime(applyWidgetTheme(data, c.req.query("theme")), spaceId, widgetId);
  return new Response(themedHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": buildWidgetCsp(widget.permissions?.network ?? false),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleGetState(c: Context, spaceId: string, widgetId: string) {
  const { data: widget, error } = await readWidget(spaceId, widgetId);
  if (error || !widget) return c.json({ error: error ?? "Widget not found", code: "NOT_FOUND" }, 404);
  if (widget.permissions.state?.read === false) return c.json({ error: "Widget state read is not allowed", code: "FORBIDDEN", missingPermission: "permissions.state.read", suggestedPermissions: { state: { read: true } } }, 403);
  return c.json({ state: await readWidgetState(spaceId, widgetId) });
}

async function handlePutState(c: Context, spaceId: string, widgetId: string) {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ state: z.record(z.string(), z.unknown()) }).safeParse(body);
  // Keep authorization and the state write on one widget generation so bundle
  // deletion can serialize before moving the directory.
  return withWidgetWriteLock(spaceId, widgetId, async () => {
    const { data: widget, error } = await readWidget(spaceId, widgetId);
    if (error || !widget) return c.json({ error: error ?? "Widget not found", code: "NOT_FOUND" }, 404);
    if (widget.permissions.state?.write === false) return c.json({ error: "Widget state write is not allowed", code: "FORBIDDEN", missingPermission: "permissions.state.write", suggestedPermissions: { state: { write: true } } }, 403);
    if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
    const state = await writeWidgetState(spaceId, widgetId, parsed.data.state);
    return c.json({ state });
  });
}

async function handleRecordsQuery(c: Context, spaceId: string, widgetId: string, collectionId: string) {
  const denied = await requireScope("records:read")(c, async () => {});
  if (denied) return denied;
  const access = await ensureWidgetAccess(spaceId, widgetId, collectionId, "read");
  if (access.response) return access.response;
  const body = await c.req.json().catch(() => ({}));
  try {
    // Cross-collection reach (expand, backlinks, relation-path predicates) is
    // a read of the target collection — the widget needs read permission on
    // every collection the query touches, not just the one it names.
    for (const target of await queryTargetCollections(spaceId, collectionId, body ?? {})) {
      if (!canRecord(access.widget!, target, "read")) {
        return c.json({
          error: `Widget lacks read permission for ${target} (reached via expand/backlinks/relation path)`,
          code: "FORBIDDEN",
          missingPermission: `permissions.records.${target}.read`,
          suggestedPermissions: { records: { [target]: { read: true } } },
        }, 403);
      }
    }
    return c.json(await queryRecords(spaceId, collectionId, body ?? {}));
  } catch (err) {
    if (err instanceof RecordQueryError) return c.json({ error: err.message, code: "VALIDATION_ERROR" }, 400);
    throw err;
  }
}

async function handleRecordCreate(c: Context, spaceId: string, widgetId: string, collectionId: string) {
  const denied = await requireScope("records:write")(c, async () => {});
  if (denied) return denied;
  const access = await ensureWidgetAccess(spaceId, widgetId, collectionId, "create");
  if (access.response) return access.response;
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ id: z.string().optional(), data: z.record(z.string(), z.unknown()), metadata: z.record(z.string(), z.unknown()).optional() }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const result = await createRecord(spaceId, collectionId, { ...parsed.data, createdBy: `widget:${widgetId}` });
  if (result.error || !result.data) return c.json({ error: result.error ?? "Write failed", code: "VALIDATION_ERROR" }, 400);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_update", spaceId, collectionId, recordId: result.data.id, data: result.data });
  return c.json({ record: result.data, recordId: result.data.id }, 201);
}

async function handleRecordPatch(c: Context, spaceId: string, widgetId: string, collectionId: string, recordId: string) {
  const denied = await requireScope("records:write")(c, async () => {});
  if (denied) return denied;
  const access = await ensureWidgetAccess(spaceId, widgetId, collectionId, "update");
  if (access.response) return access.response;
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ data: z.record(z.string(), z.unknown()).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const result = await updateRecord(spaceId, collectionId, recordId, { ...parsed.data, updatedBy: `widget:${widgetId}` });
  if (result.error || !result.data) return c.json({ error: result.error ?? "Update failed", code: "VALIDATION_ERROR" }, 400);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_update", spaceId, collectionId, recordId, data: result.data });
  return c.json({ record: result.data });
}

async function handleRecordDelete(c: Context, spaceId: string, widgetId: string, collectionId: string, recordId: string) {
  const denied = await requireScope("records:write")(c, async () => {});
  if (denied) return denied;
  const access = await ensureWidgetAccess(spaceId, widgetId, collectionId, "delete");
  if (access.response) return access.response;
  const result = await deleteRecord(spaceId, collectionId, recordId);
  if (result.error) return c.json({ error: result.error, code: "CONFLICT" }, 409);
  noteRecordMutated();
  wsManager.broadcast(spaceId, { type: "record_deleted", spaceId, collectionId, recordId });
  return c.json({ ok: true });
}

async function handleGetWidget(c: Context, spaceId: string, widgetId: string) {
  const { data, error } = await readWidget(spaceId, widgetId);
  if (error || !data) return c.json({ error: error ?? "Widget not found", code: "NOT_FOUND" }, 404);
  // Provenance rides along so clients can cache-bust the live iframe on
  // CONTENT changes: an external edit that touches only index.html never bumps
  // widget.yaml's updatedAt, but it does mint a new provenance contentHash.
  const provenance = await getWidgetProvenance(spaceId, widgetId);
  return c.json({ widget: data, provenance });
}

async function handlePutWidget(c: Context, spaceId: string, widgetId: string) {
  const denied = appOnlyOr403(c, "Editing an HTML doc");
  if (denied) return denied;
  const body = await c.req.json().catch(() => null);
  const parsed = PutWidgetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  // Capture the pre-write state so the version snapshot carries a real
  // `before` (an agent overwriting a widget must never destroy the prior
  // version silently — that undo layer is the point of widget history). The
  // whole capture→write→record is serialized per widget id so a concurrent
  // write can't interleave into a mixed snapshot or mixed on-disk state.
  const outcome = await withWidgetWriteLock(spaceId, widgetId, async () => {
    const { data: existing, error } = await readWidget(spaceId, widgetId);
    if (error || !existing) {
      return { kind: "not-found" as const, error: error ?? "Widget not found" };
    }
    const permissions = normalizeWidgetPermissions(parsed.data.permissions) ?? existing.permissions;
    const warnings = validateWidgetHtml(parsed.data.html, permissions);
    const blockingIssue = getBlockingWidgetIssue(warnings);
    if (blockingIssue) {
      return { kind: "invalid" as const, issue: blockingIssue, warnings };
    }
    const widget = buildWidgetFile({
      id: widgetId,
      name: parsed.data.name,
      description: parsed.data.description,
      updatedBy: restWriteActor(c, parsed.data.updatedBy),
      metadata: parsed.data.metadata,
      permissions,
      existing,
    });
    const beforeContent = await captureWidgetVersionContent(spaceId, widgetId);
    const result = await writeWidget(spaceId, widget, parsed.data.html);
    if (result.error || !result.data) {
      return { kind: "invalid" as const, error: result.error ?? "Write failed", warnings };
    }
    await recordWidgetVersion(spaceId, widgetId, beforeContent, { source: "rest-api", updatedBy: restWriteActor(c, parsed.data.updatedBy) });
    result.release?.();
    return { kind: "ok" as const, data: result.data, warnings };
  });
  if (outcome.kind === "not-found") {
    return c.json({ error: outcome.error, code: "NOT_FOUND" }, 404);
  }
  if (outcome.kind === "invalid") {
    return c.json({
      error: outcome.issue?.message ?? outcome.error ?? "Write failed",
      code: outcome.issue?.code ?? "VALIDATION_ERROR",
      warnings: outcome.warnings,
    }, 400);
  }
  invalidateSearchIndex();
  wsManager.broadcast(spaceId, { type: "widget_update", spaceId, widgetId, data: outcome.data });
  return c.json({ widget: outcome.data, warnings: outcome.warnings });
}

async function handlePatchWidget(c: Context, spaceId: string, widgetId: string) {
  const denied = appOnlyOr403(c, "Editing an HTML doc");
  if (denied) return denied;
  const { data: existing, error } = await readWidget(spaceId, widgetId);
  if (error || !existing) return c.json({ error: error ?? "Widget not found", code: "NOT_FOUND" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = PatchWidgetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const outcome = await withWidgetWriteLock(spaceId, widgetId, async () => {
    const beforeContent = await captureWidgetVersionContent(spaceId, widgetId);
    const result = await updateWidgetMetadata(spaceId, widgetId, {
      name: parsed.data.name,
      description: parsed.data.description,
      metadata: parsed.data.metadata,
      updatedBy: restWriteActor(c, parsed.data.updatedBy),
    });
    if (result.error || !result.data) return { error: result.error ?? "Update failed" };
    await recordWidgetVersion(spaceId, widgetId, beforeContent, { source: "rest-api", updatedBy: restWriteActor(c, parsed.data.updatedBy) });
    result.release?.();
    return { data: result.data };
  });
  if (!outcome.data) return c.json({ error: outcome.error ?? "Update failed", code: "VALIDATION_ERROR" }, 400);
  invalidateSearchIndex();
  wsManager.broadcast(spaceId, { type: "widget_update", spaceId, widgetId, data: outcome.data });
  return c.json({ widget: outcome.data });
}

async function handleArchive(c: Context, spaceId: string, widgetId: string) {
  const body = await c.req.json().catch(() => ({}));
  const parsed = ArchiveWidgetSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const result = await setWidgetArchived(spaceId, widgetId, true, restWriteActor(c, parsed.data.archivedBy), parsed.data.reason);
  if (result.error || !result.data) return c.json({ error: result.error ?? "Widget not found", code: "NOT_FOUND" }, 404);
  invalidateSearchIndex();
  wsManager.broadcast(spaceId, { type: "widget_update", spaceId, widgetId, data: result.data });
  return c.json({ ok: true, widget: result.data });
}

async function handleRestore(c: Context, spaceId: string, widgetId: string) {
  const result = await setWidgetArchived(spaceId, widgetId, false, restWriteActor(c));
  if (result.error || !result.data) return c.json({ error: result.error ?? "Widget not found", code: "NOT_FOUND" }, 404);
  invalidateSearchIndex();
  wsManager.broadcast(spaceId, { type: "widget_update", spaceId, widgetId, data: result.data });
  return c.json({ ok: true, widget: result.data });
}

async function handleDeleteWidget(c: Context, spaceId: string, widgetId: string) {
  const result = await deleteHtmlDocument(spaceId, widgetId);
  if (!result.ok) {
    const status = result.kind === "not-found" ? 404 : 409;
    const code = result.kind === "not-found" ? "NOT_FOUND" : "CONFLICT";
    return c.json({ error: result.error, code }, status);
  }
  return c.json({ ok: true });
}

async function handleMoveWidget(c: Context, spaceId: string, widgetId: string) {
  const denied = appOnlyOr403(c, "Moving an HTML doc");
  if (denied) return denied;
  const body = await c.req.json().catch(() => null);
  const parsed = MoveWidgetSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  }
  const storageV2 = await usesHtmlDocumentStorageV2();
  const newPath = storageV2
    ? parsed.data.newPath
    : slugifyDocPath(parsed.data.newPath);
  if (
    !newPath ||
    (storageV2
      ? !isHtmlDocumentPath(newPath)
      : !WidgetIdSchema.safeParse(newPath).success)
  ) {
    return c.json({ error: "New HTML doc path is invalid", code: "VALIDATION_ERROR" }, 400);
  }
  const result = await moveHtmlDocument(spaceId, widgetId, newPath);
  if (!result.ok) {
    const status = result.kind === "not-found" ? 404 : 409;
    const code = result.kind === "not-found" ? "NOT_FOUND" : "CONFLICT";
    return c.json({ error: result.error, code }, status);
  }
  return c.json({
    ok: true,
    from: result.from,
    to: result.to,
    documentId: result.documentId,
  });
}

// ---- Version history -----------------------------------------------------------

async function handleListVersions(c: Context, spaceId: string, widgetId: string) {
  // Version discovery must survive a corrupt widget.yaml (the recovery entry
  // point — callers need the ids to restore): gate on the directory, not the
  // parseable metadata. A fully deleted widget (directory gone) 404s.
  const { data: widget } = await readWidget(spaceId, widgetId);
  if (!widget && !(await widgetArtifactsExist(spaceId, widgetId))) {
    return c.json({ error: "Widget not found", code: "NOT_FOUND" }, 404);
  }
  const all = c.req.query("all") === "true";
  const versions = await listWidgetVersions(spaceId, widgetId, { checkpointsOnly: !all });
  return c.json({ versions });
}

async function handleGetVersion(c: Context, spaceId: string, widgetId: string, versionId: string) {
  // History is deliberately left on disk after deletion (doc parity), but the
  // REST surface must not keep serving a deleted widget's snapshots. A corrupt
  // widget.yaml is exactly the recovery scenario the version UI exists for — and
  // the UI reads a snapshot before offering Restore — so gate on the widget
  // DIRECTORY, not parseable metadata, matching list/restore. Directory gone
  // (fully deleted) still 404s.
  const { data: widget } = await readWidget(spaceId, widgetId);
  if (!widget && !(await widgetArtifactsExist(spaceId, widgetId))) {
    return c.json({ error: "Widget not found", code: "NOT_FOUND" }, 404);
  }
  const snapshot = await getWidgetVersion(spaceId, widgetId, versionId);
  if (!snapshot) return c.json({ error: "Version not found", code: "NOT_FOUND" }, 404);
  return c.json({ version: snapshot });
}

// Rendered snapshot for the compare pane: theme-applied like the live /content
// endpoint but WITHOUT the runtime bridge — historical code must not make live
// records/state calls, so worktable.* is simply absent and the snapshot renders
// as a static view under the no-network CSP.
async function handleGetVersionContent(c: Context, spaceId: string, widgetId: string, versionId: string) {
  // Same corrupt-metadata tolerance as handleGetVersion: the compare pane must
  // render historical snapshots even when the live widget.yaml no longer parses.
  const { data: widget } = await readWidget(spaceId, widgetId);
  if (!widget && !(await widgetArtifactsExist(spaceId, widgetId))) {
    return c.json({ error: "Widget not found", code: "NOT_FOUND" }, 404);
  }
  const snapshot = await getWidgetVersion(spaceId, widgetId, versionId);
  if (!snapshot) return c.json({ error: "Version not found", code: "NOT_FOUND" }, 404);
  const themedHtml = applyWidgetTheme(snapshot.after.content.html, c.req.query("theme"));
  // Snapshots are truly static: script-src 'none' (not just connect-src) —
  // historical authored JS could otherwise exfiltrate snapshot-embedded data
  // by NAVIGATING the frame to an external URL, which no connect-src blocks.
  // The client compare iframe also omits allow-scripts as defense in depth.
  const snapshotCsp = buildWidgetCsp(false)
    .replace(/script-src [^;]+/, "script-src 'none'")
    .replace(/connect-src [^;]+/, "connect-src 'none'");
  return new Response(themedHtml, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": snapshotCsp,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleRestoreVersion(c: Context, spaceId: string, widgetId: string, versionId: string) {
  const denied = appOnlyOr403(c, "Restoring a version");
  if (denied) return denied;
  // Serialize capture→write→record per widget id (a concurrent edit during a
  // restore must not interleave). Restore is a recovery path — the current
  // widget.yaml may be corrupt — so use the overwrite-safe capture to snapshot
  // the existing index.html as `before`, honoring restore's save-current-first
  // promise.
  const outcome = await withWidgetWriteLock(spaceId, widgetId, async () => {
    const { data: existing, error } = await readWidget(spaceId, widgetId);
    // A corrupt widget.yaml (external edit gone wrong) is exactly the state
    // restore exists to recover from: proceed when the widget DIRECTORY still
    // exists even if its metadata no longer parses. A fully deleted widget
    // (directory gone) still 404s.
    if (!existing && !(await widgetArtifactsExist(spaceId, widgetId))) {
      return { kind: "not-found" as const, error: error ?? "Widget not found" };
    }
    const snapshot = await getWidgetVersion(spaceId, widgetId, versionId);
    if (!snapshot) {
      return { kind: "not-found" as const, error: "Version not found" };
    }
    const restored = snapshot.after.content;
    // Restore bypasses validateWidgetHtml's blocking gate on purpose: the
    // content was valid when persisted, and tightened rules must never lock
    // the user out of reverting. Archive state and creation provenance stay as
    // they are. Corrupt metadata falls back to the snapshot identity fields.
    const base: WidgetFile = existing ?? {
      version: 1,
      kind: "worktable.widget",
      id: widgetId,
      name: restored.widget.name,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.createdAt,
      createdBy: restWriteActor(c),
      permissions: restored.widget.permissions,
      metadata: restored.widget.metadata,
      runtime: restored.widget.runtime,
    };
    const existingWithoutDescription = { ...base };
    delete existingWithoutDescription.description;
    const widget = {
      ...existingWithoutDescription,
      name: restored.widget.name,
      ...(restored.widget.description !== undefined ? { description: restored.widget.description } : {}),
      permissions: restored.widget.permissions,
      metadata: restored.widget.metadata,
      runtime: restored.widget.runtime,
      updatedAt: new Date().toISOString(),
      updatedBy: restWriteActor(c),
    };
    const beforeContent = await captureWidgetContentForOverwrite(spaceId, widgetId);
    const result = await writeWidget(spaceId, widget, restored.html);
    if (result.error || !result.data) {
      return { kind: "invalid" as const, error: result.error ?? "Restore failed" };
    }
    // The watcher echo of this write dedups against the provenance hash recorded
    // here, so no external "filesystem" version is minted for the restore.
    const provenance = await recordWidgetVersion(spaceId, widgetId, beforeContent, {
      source: "version-restore",
      updatedBy: restWriteActor(c),
      checkpoint: true,
      checkpointLabel: "Restored Version",
    });
    result.release?.();
    return { kind: "ok" as const, data: result.data, provenance };
  });
  if (outcome.kind === "not-found") {
    return c.json({ error: outcome.error, code: "NOT_FOUND" }, 404);
  }
  if (outcome.kind === "invalid") {
    return c.json({ error: outcome.error, code: "VALIDATION_ERROR" }, 400);
  }
  invalidateSearchIndex();
  wsManager.broadcast(spaceId, { type: "widget_update", spaceId, widgetId, data: outcome.data });
  return c.json({ ok: true, widget: outcome.data, provenance: outcome.provenance });
}

async function handleCreateCheckpoint(c: Context, spaceId: string, widgetId: string) {
  const ownerDenied = await requireHumanWorkspaceOwner()(c, async () => {});
  if (ownerDenied) return ownerDenied;
  // A manual checkpoint stamps sourceCategory "human" — a trust anchor isHumanTouch
  // treats as reviewed — so it is gated exactly like /review. Without this, a
  // sandboxed (or new-tab served) widget could POST its own /versions/checkpoint
  // and launder itself into humanReviewed, bypassing the /review gate.
  const denied = appOnlyOr403(c, "Saving a checkpoint");
  if (denied) return denied;
  const { data: widget, error } = await readWidget(spaceId, widgetId);
  if (error || !widget) return c.json({ error: error ?? "Widget not found", code: "NOT_FOUND" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ label: z.string().optional() }).safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  // Serialize capture→record under the per-widget lock: without it, a concurrent
  // agent/REST write can land between the capture and recordWidgetVersion's
  // internal after-capture and get stamped as this human checkpoint.
  const result = await withWidgetWriteLock(spaceId, widgetId, async () => {
    const current = await captureWidgetVersionContent(spaceId, widgetId);
    if (!current) return { ok: false as const };
    const provenance = await recordWidgetVersion(spaceId, widgetId, current, {
      source: "rest-api",
      updatedBy: restWriteActor(c),
    }, {
      force: true,
      operation: "checkpoint",
      checkpoint: {
        meaningful: true,
        kind: "manual",
        label: parsed.data.label,
        sourceCategory: "human",
      },
    });
    return { ok: true as const, provenance };
  });
  if (!result.ok) return c.json({ error: "Widget content not found", code: "NOT_FOUND" }, 404);
  // A manual checkpoint changes the latest version id (freshness derives from
  // it) — evict and broadcast so this and other clients read fresh state,
  // matching the review route.
  evictWidgetFreshness(spaceId, widgetId);
  wsManager.broadcast(spaceId, { type: "widget_update", spaceId, widgetId, data: widget });
  return c.json({ ok: true, provenance: result.provenance });
}

// Mark-reviewed is REST-only BY DESIGN — it is never exposed over MCP, so an
// agent cannot mint a review checkpoint and launder its own output into
// "reviewed" (same invariant as docs, routes/docs.ts review handler).
// The review checkpoint is the human-only trust anchor: it stamps a version as
// human-reviewed (sourceCategory "human", updatedBy "user"). A widget renders in
// an opaque-origin sandbox, so ANY fetch it makes to the app origin is
// cross-origin: the POST carries `Origin: null` (and `Sec-Fetch-Site:
// cross-site`, a Forbidden header widget JS cannot forge). CORS blocks the widget
// from READING the response, but the review side-effect would still fire — so a
// widget could mark itself human-reviewed. Gate the route to genuine same-origin
// calls from the Worktable app. Non-browser callers (tests, CLI, tooling) send
// neither header and are unaffected; this holds in local no-auth mode too, where
// the WS/CORS origin gate does not run.
function isSameOriginAppRequest(c: Context): boolean {
  const secFetchSite = c.req.header("sec-fetch-site");
  if (secFetchSite) {
    // Forbidden header, unforgeable by page JS: it states the initiator's
    // relationship to this origin. Only the app's own page is "same-origin"
    // ("none" is a top-level user navigation). A sandboxed widget frame — or any
    // cross-origin site — is "cross-site"/"same-site" and rejected.
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }
  // No Sec-Fetch-Site (older browsers / non-browser tooling): fall back to Origin.
  const origin = c.req.header("origin");
  if (origin === undefined) return true; // non-browser caller (tests, CLI, MCP)
  if (origin === "null") return false; // opaque-origin (sandboxed widget) frame
  try {
    // Compare the FULL origin (scheme + host + port), not just host: a cross-scheme
    // page (http://app ↔ https://app) is cross-origin and must not pass the gate.
    return new URL(origin).origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

// Every route that records a widget VERSION with human-defaultable attribution
// (source "rest-api", updatedBy defaulting to "user" — which isHumanTouch reads as
// human) is a trust anchor: a sandboxed OR new-tab-served widget must not reach it,
// or agent-authored HTML could stamp its own latest version as human-touched /
// reviewed without ever calling /review. Guards create, PUT, PATCH, restore,
// review, and checkpoint. Returns a 403 Response to short-circuit, or null to
// proceed. Non-browser callers (tests, CLI, MCP) send neither header and pass.
function appOnlyOr403(c: Context, action: string): Response | null {
  if (isSameOriginAppRequest(c)) return null;
  return c.json({ error: `${action} can only be done from the Worktable app, not from widget content`, code: "FORBIDDEN" }, 403);
}

async function handleReview(c: Context, spaceId: string, widgetId: string) {
  const ownerDenied = await requireHumanWorkspaceOwner()(c, async () => {});
  if (ownerDenied) return ownerDenied;
  const denied = appOnlyOr403(c, "Marking reviewed");
  if (denied) return denied;
  const { data: widget, error } = await readWidget(spaceId, widgetId);
  if (error || !widget) return c.json({ error: error ?? "Widget not found", code: "NOT_FOUND" }, 404);
  // Serialize capture→record under the per-widget lock so a concurrent agent/REST
  // write can't land between capture and recordWidgetVersion's internal
  // after-capture and get recorded as the human-reviewed snapshot (which would
  // report humanReviewed on content the user never saw).
  const result = await withWidgetWriteLock(spaceId, widgetId, async () => {
    const current = await captureWidgetVersionContent(spaceId, widgetId);
    if (!current) return { ok: false as const };
    const provenance = await recordWidgetVersion(spaceId, widgetId, current, {
      source: "rest-api",
      updatedBy: restWriteActor(c),
    }, {
      force: true,
      operation: "checkpoint",
      checkpoint: {
        meaningful: true,
        kind: "review",
        label: "Reviewed",
        sourceCategory: "human",
      },
    });
    return { ok: true as const, provenance };
  });
  if (!result.ok) return c.json({ error: "Widget content not found", code: "NOT_FOUND" }, 404);
  evictWidgetFreshness(spaceId, widgetId);
  const freshness = await getWidgetFreshness(spaceId, widget);
  wsManager.broadcast(spaceId, { type: "widget_update", spaceId, widgetId, data: widget });
  return c.json({ ok: true, provenance: result.provenance, freshness });
}

// ---- Method dispatchers --------------------------------------------------------

widgetsRouter.get("/*", async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const target = parseWidgetTarget(c);
  if (!target) return widgetNotFound(c);
  const { widgetId, rest } = target;
  return atCanonicalHtmlPath(c, spaceId, widgetId, async () => {
    if (rest.length === 0) return handleGetWidget(c, spaceId, widgetId);
    if (rest.length === 1 && rest[0] === "content") return handleGetContent(c, spaceId, widgetId);
    if (rest.length === 1 && rest[0] === "state") return handleGetState(c, spaceId, widgetId);
    if (rest.length === 1 && rest[0] === "versions") return handleListVersions(c, spaceId, widgetId);
    if (rest.length === 2 && rest[0] === "versions" && rest[1]) return handleGetVersion(c, spaceId, widgetId, rest[1]);
    if (rest.length === 3 && rest[0] === "versions" && rest[1] && rest[2] === "content") return handleGetVersionContent(c, spaceId, widgetId, rest[1]);
    return widgetNotFound(c);
  }, rest.length === 1 && rest[0] === "content");
});

widgetsRouter.put("/*", async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const target = parseWidgetTarget(c);
  if (!target) return widgetNotFound(c);
  const { widgetId, rest } = target;
  return atCanonicalHtmlPath(
    c,
    spaceId,
    widgetId,
    async () => {
      if (rest.length === 0) return handlePutWidget(c, spaceId, widgetId);
      if (rest.length === 1 && rest[0] === "state") return handlePutState(c, spaceId, widgetId);
      return widgetNotFound(c);
    },
    false,
    true
  );
});

widgetsRouter.post("/*", async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const moveTarget = parseWidgetMoveTarget(c);
  if (moveTarget) return handleMoveWidget(c, spaceId, moveTarget.widgetId);
  const target = parseWidgetTarget(c);
  if (!target) return widgetNotFound(c);
  const { widgetId, rest } = target;
  if (rest.length === 1 && rest[0] === "move") {
    return handleMoveWidget(c, spaceId, widgetId);
  }
  const commonLifecycleMutation =
    rest.length === 1 &&
    (rest[0] === "archive" || rest[0] === "restore");
  return atCanonicalHtmlPath(
    c,
    spaceId,
    widgetId,
    async () => {
      if (rest.length === 1 && rest[0] === "archive") return handleArchive(c, spaceId, widgetId);
      if (rest.length === 1 && rest[0] === "restore") return handleRestore(c, spaceId, widgetId);
      if (rest.length === 1 && rest[0] === "review") return handleReview(c, spaceId, widgetId);
      if (rest.length === 2 && rest[0] === "versions" && rest[1] === "checkpoint") return handleCreateCheckpoint(c, spaceId, widgetId);
      if (rest.length === 3 && rest[0] === "versions" && rest[1] && rest[2] === "restore") return handleRestoreVersion(c, spaceId, widgetId, rest[1]);
      if (rest.length === 2 && rest[0] === "records" && rest[1]) return handleRecordCreate(c, spaceId, widgetId, rest[1]);
      if (rest.length === 3 && rest[0] === "records" && rest[1] && rest[2] === "query") return handleRecordsQuery(c, spaceId, widgetId, rest[1]);
      return widgetNotFound(c);
    },
    false,
    !commonLifecycleMutation,
    commonLifecycleMutation
  );
});

widgetsRouter.patch("/*", async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const target = parseWidgetTarget(c);
  if (!target) return widgetNotFound(c);
  const { widgetId, rest } = target;
  return atCanonicalHtmlPath(
    c,
    spaceId,
    widgetId,
    async () => {
      if (rest.length === 0) return handlePatchWidget(c, spaceId, widgetId);
      if (rest.length === 3 && rest[0] === "records" && rest[1] && rest[2]) return handleRecordPatch(c, spaceId, widgetId, rest[1], rest[2]);
      return widgetNotFound(c);
    },
    false,
    true
  );
});

widgetsRouter.delete("/*", async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const target = parseWidgetTarget(c);
  if (!target) return widgetNotFound(c);
  const { widgetId, rest } = target;
  if (rest.length === 0) return handleDeleteWidget(c, spaceId, widgetId);
  return atCanonicalHtmlPath(c, spaceId, widgetId, async () => {
    if (rest.length === 3 && rest[0] === "records" && rest[1] && rest[2]) return handleRecordDelete(c, spaceId, widgetId, rest[1], rest[2]);
    return widgetNotFound(c);
  });
});
