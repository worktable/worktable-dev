import { z } from "zod"
import { DrawingBindingSchema } from "./quickdraw-document.ts"

const coordinate = z.number().finite().min(-10_000_000).max(10_000_000)
const dimension = coordinate.positive()
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value))
const color = z.enum([
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
])
const size = z.enum(["s", "m", "l", "xl"])
const font = z.enum(["draw", "sans", "serif", "mono"])
const dash = z.enum(["draw", "solid", "dashed", "dotted"])
export const DrawingRegionSchema = z
  .object({ x: coordinate, y: coordinate, w: dimension, h: dimension })
  .strict()
export const DrawingPreviewSchema = z
  .object({
    mode: z.enum(["all", "changed", "none"]).optional(),
    format: z.enum(["png", "svg"]).optional(),
    theme: z.enum(["light", "dark"]).optional(),
    region: DrawingRegionSchema.optional().describe(
      "Crop the image only. The top-level region also filters returned objects."
    ),
    ids: z.array(id).min(1).max(500).optional(),
    width: z.number().int().min(128).max(2048).optional(),
    background: z.boolean().optional(),
    labels: z
      .boolean()
      .optional()
      .describe(
        "Overlay short numbers, with preview.labels mapping each number to its stable object id."
      ),
  })
  .strict()
export const DrawingObjectTypeSchema = z.enum([
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "hexagon",
  "star",
  "text",
  "note",
  "arrow",
  "line",
  "draw",
  "highlight",
  "image",
])
const fields = {
  x: coordinate.optional(),
  y: coordinate.optional(),
  rotation: coordinate.optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  color: color.optional(),
  size: size.optional(),
  font: font.optional(),
  dash: dash.optional(),
  fill: z.enum(["none", "semi", "solid", "pattern"]).optional(),
  text: z.string().max(50_000).optional(),
  labelSize: size.optional(),
  startBinding: DrawingBindingSchema.partial({ anchor: true })
    .nullable()
    .optional()
    .describe(
      "Arrow/line start attached to a box, image, text, or note. shapeId accepts an earlier batch ref; anchor defaults to right. null detaches."
    ),
  endBinding: DrawingBindingSchema.partial({ anchor: true })
    .nullable()
    .optional()
    .describe(
      "Arrow/line end attached to a box, image, text, or note. shapeId accepts an earlier batch ref; anchor defaults to left. null detaches."
    ),
  dx: coordinate.optional(),
  dy: coordinate.optional(),
  bend: coordinate.optional(),
  points: z
    .array(coordinate)
    .min(3)
    .max(300_000)
    .refine(
      (p) => p.length % 3 === 0,
      "points must contain x,y,pressure triples"
    )
    .optional(),
  assetId: id.optional(),
  scale: dimension.optional(),
  align: z.enum(["start", "middle", "end"]).optional(),
}
export const DrawingObjectSchema = z
  .object({ type: DrawingObjectTypeSchema, ...fields })
  .strict()
export const DrawingOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      ref: id.optional(),
      object: DrawingObjectSchema,
    })
    .strict(),
  z
    .object({ op: z.literal("update"), id, changes: z.object(fields).strict() })
    .strict(),
  z
    .object({ op: z.literal("move"), id, x: coordinate, y: coordinate })
    .strict(),
  z
    .object({
      op: z.literal("resize"),
      id,
      width: dimension,
      height: dimension.optional(),
    })
    .strict(),
  z.object({ op: z.literal("rotate"), id, rotation: coordinate }).strict(),
  z
    .object({
      op: z.literal("duplicate"),
      id,
      ref: id.optional(),
      x: coordinate.optional(),
      y: coordinate.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("reorder"),
      id,
      position: z.enum(["front", "back"]),
    })
    .strict(),
  z.object({ op: z.literal("remove"), id }).strict(),
  z
    .object({
      op: z.literal("title"),
      title: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      op: z.literal("import_image"),
      ref: id,
      width: dimension,
      height: dimension,
      dataUrl: z
        .string()
        .max(8 * 1024 * 1024)
        .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/),
    })
    .strict(),
])
const address = { spaceId: z.string().min(1), path: z.string().min(1) }
const readFields = {
  ...address,
  expectedRevision: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Require this current source revision before rendering or inspecting, including when selecting a historical version."
    ),
  ids: z.array(id).min(1).max(500).optional(),
  text: z.string().max(1000).optional(),
  types: z.array(DrawingObjectTypeSchema).min(1).optional(),
  region: DrawingRegionSchema.optional(),
  offset: z.number().int().min(0).max(5000).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  versionId: z.string().min(1).optional(),
  preview: DrawingPreviewSchema.optional(),
}
export const DrawingsReadRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect"), ...readFields }).strict(),
  z.object({ action: z.literal("query"), ...readFields }).strict(),
  z.object({ action: z.literal("render"), ...readFields }).strict(),
  z
    .object({
      action: z.literal("changes"),
      ...address,
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
])
const writeFields = {
  ...address,
  requestId: z.string().min(1).max(128),
  preview: DrawingPreviewSchema.optional(),
}
export const DrawingsWriteRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      ...writeFields,
      title: z.string().trim().min(1).max(200),
      operations: z.array(DrawingOperationSchema).max(500).optional(),
      previewOnly: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("edit"),
      ...writeFields,
      expectedRevision: z.string().min(1),
      operations: z.array(DrawingOperationSchema).min(1).max(500),
      previewOnly: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("undo"),
      ...writeFields,
      expectedRevision: z.string().min(1),
      changeId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("redo"),
      ...writeFields,
      expectedRevision: z.string().min(1),
      changeId: z.string().min(1),
    })
    .strict(),
])
export const DrawingsReadInput = z.strictObject({
  request: DrawingsReadRequestSchema,
})
export const DrawingsWriteInput = z.strictObject({
  request: DrawingsWriteRequestSchema,
})
export type DrawingsReadRequest = z.infer<typeof DrawingsReadRequestSchema>
export type DrawingsWriteRequest = z.infer<typeof DrawingsWriteRequestSchema>
export type DrawingOperation = z.infer<typeof DrawingOperationSchema>
export type DrawingObject = z.infer<typeof DrawingObjectSchema>
export type DrawingPreview = z.infer<typeof DrawingPreviewSchema>
