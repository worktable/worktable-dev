import {
  drawingBindingUpdates,
  isDrawingBindingTarget,
} from "./drawing-bindings.ts"
import {
  parseQuickdrawDocument,
  type QuickdrawDocument,
} from "./quickdraw-document.ts"
import type { DrawingObject, DrawingOperation } from "./drawing-operations.ts"
export type DrawingRecord =
  QuickdrawDocument["snapshot"]["document"]["store"][string]
type RecordValue = DrawingRecord
export type DrawingShape = Extract<DrawingRecord, { typeName: "shape" }>
type Shape = DrawingShape
export type DrawingBounds = { x: number; y: number; w: number; h: number }
const geoTypes = new Set([
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "hexagon",
  "star",
])
const encode = (drawing: QuickdrawDocument) =>
  new TextEncoder().encode(JSON.stringify(drawing))
export function drawingCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(drawingCanonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${drawingCanonical(v)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "undefined"
}
const equal = (a: unknown, b: unknown) =>
  drawingCanonical(a) === drawingCanonical(b)
function invalid(message: string): never {
  throw new Error(message)
}
function objectType(shape: Shape) {
  return shape.type === "geo" ? shape.props.geo : shape.type
}
function textOf(shape: Shape) {
  return shape.type === "text" || shape.type === "note"
    ? shape.props.text
    : shape.type === "geo"
      ? (shape.props.label ?? "")
      : ""
}
export function drawingDiff(
  before: QuickdrawDocument,
  after: QuickdrawDocument
) {
  const a = before.snapshot.document.store,
    b = after.snapshot.document.store
  const addedIds = Object.keys(b).filter((id) => !a[id])
  const removedIds = Object.keys(a).filter((id) => !b[id])
  const changedIds = Object.keys(b).filter(
    (id) => a[id] && !equal(a[id], b[id])
  )
  const label = (record: RecordValue) => {
    const text =
      record.typeName === "shape"
        ? textOf(record).replace(/\s+/g, " ").trim()
        : ""
    return text
      ? JSON.stringify(text.length > 60 ? `${text.slice(0, 59)}…` : text)
      : record.typeName === "asset"
        ? "image asset"
        : objectType(record)
  }
  const details = (
    [
      ["added", addedIds],
      ["changed", changedIds],
      ["removed", removedIds],
    ] as const
  ).flatMap(([kind, ids]) => {
    if (!ids.length) return []
    const examples = ids.slice(0, 3).map((id) => {
      const oldLabel = a[id] ? label(a[id]) : undefined
      const newLabel = b[id] ? label(b[id]) : undefined
      return kind === "changed" && oldLabel !== newLabel
        ? `${oldLabel} → ${newLabel}`
        : (newLabel ?? oldLabel)
    })
    return [
      `${kind} ${ids.length} item${ids.length === 1 ? "" : "s"} (${examples.join(", ")}${ids.length > 3 ? ", …" : ""})`,
    ]
  })
  if (before.title !== after.title)
    details.push(
      `changed title to ${JSON.stringify(after.title.slice(0, 100))}`
    )
  return {
    addedIds,
    removedIds,
    changedIds,
    titleChanged: before.title !== after.title,
    description: (details.join("; ") || "no content changes").slice(0, 2000),
  }
}
function propsFor(
  type: DrawingObject["type"],
  fields: Omit<DrawingObject, "type">,
  existing?: Shape["props"]
): Shape["props"] {
  const allowed = new Set(["x", "y", "rotation"])
  const common = ["color", "size"]
  if (geoTypes.has(type))
    for (const k of [
      ...common,
      "width",
      "height",
      "font",
      "dash",
      "fill",
      "text",
      "labelSize",
    ])
      allowed.add(k)
  else if (type === "text")
    for (const k of [...common, "text", "font", "scale", "width", "align"])
      allowed.add(k)
  else if (type === "note")
    for (const k of [...common, "text", "font", "scale", "width"])
      allowed.add(k)
  else if (type === "arrow" || type === "line")
    for (const k of [
      ...common,
      "dx",
      "dy",
      "bend",
      "dash",
      "startBinding",
      "endBinding",
    ])
      allowed.add(k)
  else if (type === "draw" || type === "highlight")
    for (const k of [...common, "points", "dash"]) allowed.add(k)
  else for (const k of ["width", "height", "assetId"]) allowed.add(k)
  if (type === "note" && fields.height !== undefined)
    invalid(
      "Notes preserve their proportions; set width only and height follows the text content"
    )
  for (const key of Object.keys(fields))
    if (!allowed.has(key))
      invalid(
        `${key} is not supported for ${type}; supported fields: ${[...allowed].join(", ")}`
      )
  let props: Record<string, unknown>
  if (existing) props = { ...existing }
  else if (geoTypes.has(type))
    props = {
      geo: type,
      w: 180,
      h: 100,
      color: "black",
      size: "m",
      dash: "solid",
      fill: "none",
      font: "sans",
    }
  else if (type === "text" || type === "note")
    props = {
      text: "",
      color: type === "note" ? "yellow" : "black",
      size: "m",
      font: "sans",
      ...(type === "text" ? { autosize: true } : {}),
    }
  else if (type === "arrow" || type === "line")
    props = { dx: 160, dy: 0, color: "black", size: "m", dash: "solid" }
  else if (type === "draw" || type === "highlight")
    props = {
      pts: [],
      color: type === "highlight" ? "yellow" : "black",
      size: "m",
      done: true,
    }
  else props = { w: 240, h: 160, assetId: "" }
  const names: Record<string, string> = {
    width: "w",
    height: "h",
    points: "pts",
    text: geoTypes.has(type) ? "label" : "text",
  }
  for (const [key, value] of Object.entries(fields))
    if (
      !["x", "y", "rotation"].includes(key) &&
      value !== undefined &&
      !(type === "note" && key === "width")
    )
      if ((key === "startBinding" || key === "endBinding") && value === null)
        delete props[key]
      else props[names[key] ?? key] = value
  if (type === "note" && fields.width !== undefined)
    props.scale = fields.width / 200
  if (type === "text" && fields.width !== undefined) props.autosize = false
  return props as Shape["props"]
}

/** Apply one bounded batch in memory. Validation of the complete source is the commit boundary. */
export function applyDrawingOperations(
  before: QuickdrawDocument,
  operations: DrawingOperation[],
  ids: string[],
  localBounds: (shape: Shape) => DrawingBounds
) {
  const drawing = structuredClone(before),
    store = drawing.snapshot.document.store
  const references: Record<string, string> = Object.create(null)
  const mint = (kind: string, index: number) => `${kind}:${ids[index]}`
  const resolve = (id: string) => references[id] ?? id
  const shape = (id: string): Shape => {
    const record = store[resolve(id)]
    if (!record || record.typeName !== "shape")
      invalid(`Object ${id} does not identify a shape`)
    return record
  }
  const detach = (record: Shape) => {
    if (record.type === "arrow" || record.type === "line") {
      delete record.props.startBinding
      delete record.props.endBinding
    }
  }
  const resolveFields = (fields: Omit<DrawingObject, "type">) => {
    if (fields.assetId) fields.assetId = resolve(fields.assetId)
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = fields[key]
      if (!binding) continue
      const shapeId = resolve(binding.shapeId)
      if (!isDrawingBindingTarget(store[shapeId]))
        invalid(
          `Binding ${binding.shapeId} must identify an existing box, image, text, or note`
        )
      fields[key] = {
        shapeId,
        anchor: binding.anchor ?? (key === "startBinding" ? "right" : "left"),
      }
    }
  }
  const remember = (ref: string | undefined, id: string) => {
    if (ref) {
      if (references[ref] || store[ref])
        invalid(`Reference ${ref} is already in use`)
      references[ref] = id
    }
  }
  const top = () =>
    Math.max(
      0,
      ...Object.values(store)
        .filter((r): r is Shape => r.typeName === "shape")
        .map((r) => r.z)
    ) + 1
  operations.forEach((operation, index) => {
    try {
      if (operation.op === "title") {
        drawing.title = operation.title
        return
      }
      if (operation.op === "import_image") {
        const id = mint("asset", index)
        if (store[id])
          invalid(`Generated asset ID already exists; use a new requestId`)
        remember(operation.ref, id)
        store[id] = {
          id,
          typeName: "asset",
          w: operation.width,
          h: operation.height,
          src: operation.dataUrl,
        }
        return
      }
      if (operation.op === "add") {
        const id = mint("shape", index)
        if (store[id])
          invalid(`Generated shape ID already exists; use a new requestId`)
        remember(operation.ref, id)
        const { type, ...fields } = operation.object
        resolveFields(fields)
        store[id] = {
          id,
          typeName: "shape",
          type: geoTypes.has(type) ? "geo" : type,
          x: fields.x ?? 0,
          y: fields.y ?? 0,
          rot: fields.rotation ?? 0,
          z: top(),
          props: propsFor(type, fields),
        } as Shape
        return
      }
      if (operation.op === "remove") {
        const id = resolve(operation.id)
        if (!store[id]) invalid(`Object ${operation.id} does not exist`)
        delete store[id]
        return
      }
      const current = shape(operation.id)
      if (operation.op === "duplicate") {
        const id = mint("shape", index)
        if (store[id])
          invalid(`Generated shape ID already exists; use a new requestId`)
        remember(operation.ref, id)
        store[id] = {
          ...structuredClone(current),
          id,
          x: operation.x ?? current.x + 24,
          y: operation.y ?? current.y + 24,
          z: top(),
        }
        detach(store[id] as Shape)
        return
      }
      if (operation.op === "move") {
        detach(current)
        current.x = operation.x
        current.y = operation.y
        return
      }
      if (operation.op === "rotate") {
        detach(current)
        current.rot = operation.rotation
        return
      }
      if (operation.op === "reorder") {
        current.z =
          operation.position === "front"
            ? top()
            : Math.min(
                0,
                ...Object.values(store)
                  .filter((r): r is Shape => r.typeName === "shape")
                  .map((r) => r.z)
              ) - 1
        return
      }
      if (operation.op === "resize") {
        if (current.type === "geo" || current.type === "image") {
          current.props.w = operation.width
          current.props.h = operation.height ?? current.props.h
        } else if (current.type === "text") {
          if (operation.height !== undefined)
            invalid(
              "Text height follows its content; resize text with width only"
            )
          current.props.w = operation.width
          current.props.autosize = false
        } else if (current.type === "note") {
          if (operation.height !== undefined)
            invalid(
              "Notes preserve their proportions; resize a note with width only"
            )
          current.props.scale = operation.width / 200
        } else
          invalid(
            `Resize is not supported for ${current.type}; update endpoints (dx, dy) or stroke points instead`
          )
        return
      }
      const fields = { ...operation.changes }
      resolveFields(fields)
      if (
        [fields.x, fields.y, fields.rotation, fields.dx, fields.dy].some(
          (value) => value !== undefined
        )
      )
        detach(current)
      if (fields.x !== undefined) current.x = fields.x
      if (fields.y !== undefined) current.y = fields.y
      if (fields.rotation !== undefined) current.rot = fields.rotation
      current.props = propsFor(objectType(current), fields, current.props)
    } catch (error) {
      if (error instanceof Error)
        invalid(`Operation ${index + 1} (${operation.op}): ${error.message}`)
      throw error
    } finally {
      // These operations cannot alter a target's bounds or a connector's
      // attachments. Keep them available without native text measurement.
      // Geometry-changing operations still reconcile immediately so later
      // operations in the batch see the updated endpoints.
      if (
        operation.op !== "title" &&
        operation.op !== "import_image" &&
        operation.op !== "reorder"
      ) {
        for (const connector of drawingBindingUpdates(store, localBounds))
          store[connector.id] = connector
      }
    }
  })
  let validated: QuickdrawDocument
  try {
    validated = parseQuickdrawDocument(encode(drawing))
  } catch (error) {
    invalid(
      `Drawing batch is invalid: ${error instanceof Error ? error.message : String(error)}. Check image asset references, required stroke points, and drawing limits.`
    )
  }
  return { drawing: validated, references, ...drawingDiff(before, validated) }
}
