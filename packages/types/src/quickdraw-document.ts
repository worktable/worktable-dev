import { z } from "zod"

export const QUICKDRAW_FORMAT = "worktable.quickdraw"
export const QUICKDRAW_MAX_BYTES = 8 * 1024 * 1024
const number = z.number().finite().min(-10_000_000).max(10_000_000)
const dimension = number.positive()
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
const ink = { color, size }
const text = {
  ...ink,
  text: z.string().max(50_000),
  font,
  scale: dimension.optional(),
}
const shape = {
  id,
  typeName: z.literal("shape"),
  x: number,
  y: number,
  rot: number,
  z: number,
}
const stroke = z
  .object({
    ...ink,
    pts: z
      .array(number)
      .min(3)
      .max(300_000)
      .refine((pts) => pts.length % 3 === 0),
    dash: dash.optional(),
    done: z.boolean().optional(),
    isPen: z.boolean().optional(),
  })
  .strict()
const line = z
  .object({ ...ink, dx: number, dy: number, bend: number.optional(), dash })
  .strict()
const shapeSchema = z.discriminatedUnion("type", [
  z.object({ ...shape, type: z.literal("draw"), props: stroke }).strict(),
  z.object({ ...shape, type: z.literal("highlight"), props: stroke }).strict(),
  z.object({ ...shape, type: z.literal("arrow"), props: line }).strict(),
  z.object({ ...shape, type: z.literal("line"), props: line }).strict(),
  z
    .object({
      ...shape,
      type: z.literal("text"),
      props: z
        .object({
          ...text,
          autosize: z.boolean().optional(),
          w: dimension.optional(),
          align: z.enum(["start", "middle", "end"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...shape,
      type: z.literal("note"),
      props: z.object(text).strict(),
    })
    .strict(),
  z
    .object({
      ...shape,
      type: z.literal("geo"),
      props: z
        .object({
          ...ink,
          w: dimension,
          h: dimension,
          geo: z.enum([
            "rectangle",
            "ellipse",
            "triangle",
            "diamond",
            "hexagon",
            "star",
          ]),
          dash,
          fill: z.enum(["none", "semi", "solid", "pattern"]),
          font,
          label: z.string().max(50_000).optional(),
          labelSize: size.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...shape,
      type: z.literal("image"),
      props: z.object({ w: dimension, h: dimension, assetId: id }).strict(),
    })
    .strict(),
])
const assetSchema = z
  .object({
    id,
    typeName: z.literal("asset"),
    w: dimension,
    h: dimension,
    // Sources render in the trusted app. Never allow remote URLs or active SVG.
    src: z
      .string()
      .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/),
  })
  .strict()

export const QuickdrawDocumentSchema = z
  .object({
    type: z.literal(QUICKDRAW_FORMAT),
    version: z.literal(1),
    title: z.string().trim().min(1).max(200),
    snapshot: z
      .object({
        document: z
          .object({ store: z.record(id, z.union([shapeSchema, assetSchema])) })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const records = doc.snapshot.document.store
    if (Object.keys(records).length > 5_000)
      ctx.addIssue({ code: "custom", message: "Drawing has too many objects" })
    for (const [key, record] of Object.entries(records)) {
      if (key !== record.id)
        ctx.addIssue({
          code: "custom",
          message: "Drawing object ID does not match its key",
        })
      if (
        record.typeName === "shape" &&
        record.type === "image" &&
        records[record.props.assetId]?.typeName !== "asset"
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Drawing image is missing its asset",
        })
      }
    }
  })

export type QuickdrawDocument = z.infer<typeof QuickdrawDocumentSchema>

export function parseQuickdrawDocument(bytes: Uint8Array): QuickdrawDocument {
  if (bytes.byteLength > QUICKDRAW_MAX_BYTES)
    throw new Error("Drawing exceeds the 8 MB limit")
  const result = QuickdrawDocumentSchema.safeParse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  )
  if (!result.success) throw new Error("Invalid or unsupported drawing source")
  return result.data
}

export function emptyQuickdrawDocument(
  title = "Untitled drawing"
): QuickdrawDocument {
  return {
    type: QUICKDRAW_FORMAT,
    version: 1,
    title,
    snapshot: { document: { store: {} } },
  }
}
