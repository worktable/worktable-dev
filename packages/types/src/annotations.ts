import { z } from "zod";

export const AnnotationCategorySchema = z.enum(["comment", "instruction"]);

export const AnnotationStatusSchema = z.enum(["open", "resolved"]);

export const AnnotationAuthorSchema = z.object({
  type: z.enum(["user", "agent", "system"]),
  id: z.string(),
  name: z.string().optional(),
});

export const AnnotationTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("doc"),
    docPath: z.string().min(1),
  }),
  z.object({
    type: z.literal("block"),
    docPath: z.string().min(1),
    blockId: z.string().min(1),
    blockType: z.string().optional(),
    quote: z.string().optional(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    blockTextHash: z.string().optional(),
  }),
  z.object({
    type: z.literal("text"),
    docPath: z.string().min(1),
    blockId: z.string().min(1),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    quote: z.string().optional(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
  }),
  z.object({
    // HTML doc (widget) annotations are DOC-LEVEL only: the sandboxed iframe's
    // cross-origin wall makes block/span anchoring impossible, so the target
    // carries just the widget id (slash-joined segments, like the storage id).
    type: z.literal("widget"),
    widgetId: z.string().min(1),
  }),
  z.object({
    type: z.literal("view"),
    viewId: z.string().min(1),
    blockId: z.string().optional(),
  }),
  z.object({
    type: z.literal("list"),
    listId: z.string().min(1),
    itemId: z.string().optional(),
  }),
  z.object({
    type: z.literal("space"),
  }),
]);

export const AnnotationMessageSchema = z.object({
  id: z.string(),
  author: AnnotationAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
});

export const AnnotationSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  target: AnnotationTargetSchema,
  category: AnnotationCategorySchema,
  status: AnnotationStatusSchema.default("open"),
  title: z.string().optional(),
  body: z.string(),
  author: AnnotationAuthorSchema,
  labels: z.array(z.string()).default([]),
  thread: z.array(AnnotationMessageSchema).default([]),
  resolution: z
    .object({
      resolvedAt: z.string(),
      resolvedBy: z.string(),
      reason: z.string().optional(),
      status: AnnotationStatusSchema,
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const AnnotationFileSchema = z.object({
  type: z.literal("worktable.annotations"),
  version: z.literal(1),
  spaceId: z.string(),
  revision: z.string(),
  updatedAt: z.string(),
  annotations: z.array(AnnotationSchema),
});

export type AnnotationCategory = z.infer<typeof AnnotationCategorySchema>;
export type AnnotationStatus = z.infer<typeof AnnotationStatusSchema>;
export type AnnotationAuthor = z.infer<typeof AnnotationAuthorSchema>;
export type AnnotationTarget = z.infer<typeof AnnotationTargetSchema>;
export type AnnotationMessage = z.infer<typeof AnnotationMessageSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationFile = z.infer<typeof AnnotationFileSchema>;

export interface AnnotationContext {
  targetExists: boolean;
  selectorMatch: "exact" | "fuzzy" | "stale" | "missing";
  docPath?: string;
  block?: unknown;
  beforeBlocks?: unknown[];
  afterBlocks?: unknown[];
  excerpt?: string;
}
