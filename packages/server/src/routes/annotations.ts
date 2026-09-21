import { requireScope, restWriteActor } from "../auth.ts";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { AnnotationTargetSchema, WidgetIdSchema, type AnnotationAuthor, type AnnotationTarget } from "@worktable/types";
import {
  createAnnotation,
  getAnnotationContext,
  listAnnotations,
  readAnnotation,
  replyAnnotation,
  resolveAnnotation,
  updateAnnotation,
} from "../annotation-store.ts";
import { wsManager } from "../ws.ts";
import {
  isHtmlDocumentPath,
  usesHtmlDocumentStorageV2,
} from "../html-document-storage-v2.ts";

const AnnotationCategorySchema = z.enum(["comment", "instruction"]);
const AnnotationStatusSchema = z.enum(["open", "resolved"]);
const AnnotationAuthorSchema = z.object({
  type: z.enum(["user", "agent", "system"]),
  id: z.string(),
  name: z.string().optional(),
});
// The target union is imported from @worktable/types — the single source of
// truth shared with the store and MCP — so a variant added there (e.g. the
// widget target) can never drift out of this surface.

// The shared union still carries legacy space/view/list variants, but the
// store only persists doc/block/text/widget-backed annotations — reject the
// rest at the boundary with a 400 instead of letting the store throw a 500.
const StorableAnnotationTargetSchema = AnnotationTargetSchema.refine(
  (target) => ["doc", "block", "text", "widget"].includes(target.type),
  { message: "Annotation target must be doc, block, text, or widget" }
);

const CreateAnnotationSchema = z.object({
  target: StorableAnnotationTargetSchema,
  category: AnnotationCategorySchema,
  body: z.string().min(1),
  title: z.string().optional(),
  author: AnnotationAuthorSchema.optional(),
  labels: z.array(z.string()).optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateAnnotationSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  status: AnnotationStatusSchema.optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  updatedBy: z.string().optional(),
});

const ReplySchema = z.object({
  body: z.string().min(1),
  author: AnnotationAuthorSchema.optional(),
});

const ResolveSchema = z.object({
  reason: z.string().optional(),
  resolvedBy: z.string().optional(),
});

export const annotationsRouter = new Hono();

function annotationAuthor(c: Context, requested?: AnnotationAuthor): AnnotationAuthor {
  const principal = c.get("identity").principal;
  if (principal.type === "human") return requested ?? { type: "user", id: "user", name: "User" };
  return { type: principal.type, id: principal.id };
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function broadcast(spaceId: string, annotationId: string, data: unknown) {
  wsManager.broadcast(spaceId, { type: "annotation_update", spaceId, data: { annotationId, ...(data as Record<string, unknown>) } });
}

annotationsRouter.get("/", requireScope("annotations:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  if (!spaceId) return c.json({ error: "Missing spaceId", code: "BAD_REQUEST" }, 400);
  const docPath = c.req.query("docPath");
  const widgetId = c.req.query("widgetId");
  const blockId = c.req.query("blockId");
  const status = parseCsv(c.req.query("status"));
  const category = parseCsv(c.req.query("category"));
  const includeResolved = c.req.query("includeResolved") === "true";
  const limit = Number(c.req.query("limit") ?? 100);
  const offset = Number(c.req.query("offset") ?? 0);
  const result = await listAnnotations(spaceId, {
    target: docPath
      ? { docPath, ...(blockId ? { blockId } : {}) }
      : widgetId
        ? { widgetId }
        : undefined,
    status: status as never,
    category: category as never,
    createdBy: c.req.query("createdBy"),
    labels: parseCsv(c.req.query("labels")),
    includeResolved,
    limit: Number.isFinite(limit) ? limit : 100,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  return c.json(result);
});

annotationsRouter.post("/", requireScope("annotations:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const body = await c.req.json().catch(() => null);
  const parsed = CreateAnnotationSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  if (parsed.data.target.type === "widget") {
    const valid = (await usesHtmlDocumentStorageV2())
      ? isHtmlDocumentPath(parsed.data.target.widgetId)
      : WidgetIdSchema.safeParse(parsed.data.target.widgetId).success;
    if (!valid) {
      return c.json({ error: `Invalid widget id "${parsed.data.target.widgetId}" in annotation target`, code: "VALIDATION_ERROR" }, 400);
    }
  }
  const result = await createAnnotation(spaceId, {
    ...parsed.data,
    target: parsed.data.target as AnnotationTarget,
    author: annotationAuthor(c, parsed.data.author),
  });
  broadcast(spaceId, result.annotation.id, { annotation: result.annotation, event: "created" });
  return c.json({ ok: true, annotationId: result.annotation.id, annotation: result.annotation, created: result.created });
});

annotationsRouter.get("/:annotationId", requireScope("annotations:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const annotationId = c.req.param("annotationId") ?? "";
  const annotation = await readAnnotation(spaceId, annotationId);
  const includeTargetContext = c.req.query("includeTargetContext") === "true";
  const context = includeTargetContext ? await getAnnotationContext(spaceId, annotationId) : undefined;
  return c.json({ annotation, context });
});

annotationsRouter.patch("/:annotationId", requireScope("annotations:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const annotationId = c.req.param("annotationId") ?? "";
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateAnnotationSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const { updatedBy, ...patch } = parsed.data;
  const annotation = await updateAnnotation(spaceId, annotationId, patch as never, restWriteActor(c, updatedBy));
  broadcast(spaceId, annotation.id, { annotation, event: "updated" });
  return c.json({ ok: true, annotation });
});

annotationsRouter.post("/:annotationId/replies", requireScope("annotations:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const annotationId = c.req.param("annotationId") ?? "";
  const body = await c.req.json().catch(() => null);
  const parsed = ReplySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const result = await replyAnnotation(spaceId, annotationId, parsed.data.body, annotationAuthor(c, parsed.data.author));
  broadcast(spaceId, result.annotation.id, { annotation: result.annotation, event: "replied" });
  return c.json({ ok: true, replyId: result.replyId, annotation: result.annotation });
});

annotationsRouter.post("/:annotationId/resolve", requireScope("annotations:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const annotationId = c.req.param("annotationId") ?? "";
  const body = await c.req.json().catch(() => ({}));
  const parsed = ResolveSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  const annotation = await resolveAnnotation(spaceId, annotationId, parsed.data.reason, restWriteActor(c, parsed.data.resolvedBy));
  broadcast(spaceId, annotation.id, { annotation, event: "resolved" });
  return c.json({ ok: true, annotation });
});

annotationsRouter.get("/:annotationId/context", requireScope("annotations:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const annotationId = c.req.param("annotationId") ?? "";
  return c.json({ context: await getAnnotationContext(spaceId, annotationId) });
});
