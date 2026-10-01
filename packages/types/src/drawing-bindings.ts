import type { QuickdrawDocument } from "./quickdraw-document.ts"

type Records = QuickdrawDocument["snapshot"]["document"]["store"]
type Shape = Extract<Records[string], { typeName: "shape" }>
type Connector = Extract<Shape, { type: "arrow" | "line" }>
type Bounds = { x: number; y: number; w: number; h: number }
export type DrawingBinding = NonNullable<Connector["props"]["startBinding"]>

export function isDrawingBindingTarget(
  record: Records[string] | undefined
): record is Shape {
  return (
    record?.typeName === "shape" &&
    ["geo", "image", "text", "note"].includes(record.type)
  )
}

const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b)
const geometryChanged = (a: Shape, b: Shape) =>
  a.x !== b.x ||
  a.y !== b.y ||
  a.rot !== b.rot ||
  ("dx" in a.props &&
    "dx" in b.props &&
    (a.props.dx !== b.props.dx || a.props.dy !== b.props.dy))

function endpoint(shape: Connector, end: boolean) {
  const { dx, dy } = shape.props
  const sign = end ? 0.5 : -0.5
  const c = Math.cos(shape.rot),
    s = Math.sin(shape.rot)
  return {
    x: shape.x + dx / 2 + sign * (dx * c - dy * s),
    y: shape.y + dy / 2 + sign * (dx * s + dy * c),
  }
}

function anchorPoint(target: Shape, binding: DrawingBinding, bounds: Bounds) {
  const { anchor } = binding
  const ux = anchor === "left" ? 0 : anchor === "right" ? 1 : 0.5
  const uy = anchor === "top" ? 0 : anchor === "bottom" ? 1 : 0.5
  const dx = (ux - 0.5) * bounds.w,
    dy = (uy - 0.5) * bounds.h
  const c = Math.cos(target.rot),
    s = Math.sin(target.rot)
  return {
    x: target.x + bounds.x + bounds.w / 2 + dx * c - dy * s,
    y: target.y + bounds.y + bounds.h / 2 + dx * s + dy * c,
  }
}

/** Materialize optional connector attachments as ordinary Quickdraw geometry.
 * Call inside the same transaction as target changes, so history contains both.
 * Bounds come from the runtime's text measurement (canvas or headless renderer).
 */
export function drawingBindingUpdates(
  records: Records,
  bounds: (shape: Shape) => Bounds,
  options: {
    /** Original records changed by a direct canvas gesture. Omit during undo or remote refresh. */
    previous?: Records
    /** New user-created copies lose attachments; remote additions keep them. */
    addedIds?: ReadonlySet<string>
  } = {}
): Shape[] {
  const updates: Shape[] = []
  const measured = new Map<string, Bounds>()
  const targetBounds = (id: string) => {
    let value = measured.get(id)
    if (!value) {
      value = bounds(records[id] as Shape)
      measured.set(id, value)
    }
    return value
  }
  for (const record of Object.values(records)) {
    if (
      record.typeName !== "shape" ||
      (record.type !== "arrow" && record.type !== "line")
    )
      continue
    if (!record.props.startBinding && !record.props.endBinding) continue
    const next: Connector = { ...record, props: { ...record.props } }
    const old = options.previous?.[record.id]
    const dragged = old?.typeName === "shape" && geometryChanged(old, record)
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = next.props[key]
      if (!binding) continue
      const target = records[binding.shapeId]
      const oldTarget = options.previous?.[binding.shapeId]
      // Moving a group containing its connector and target preserves attachment.
      const targetChanged =
        oldTarget?.typeName === "shape" &&
        target?.typeName === "shape" &&
        (geometryChanged(oldTarget, target) ||
          !equal(oldTarget.props, target.props))
      const unchangedBinding =
        old?.typeName === "shape" &&
        (old.type === "arrow" || old.type === "line") &&
        equal(old.props[key], binding)
      if (
        !isDrawingBindingTarget(target) ||
        options.addedIds?.has(record.id) ||
        (dragged && unchangedBinding && !targetChanged)
      )
        delete next.props[key]
    }
    if (next.props.startBinding || next.props.endBinding) {
      const startBinding = next.props.startBinding,
        endBinding = next.props.endBinding
      const start = startBinding
        ? anchorPoint(
            records[startBinding.shapeId] as Shape,
            startBinding,
            targetBounds(startBinding.shapeId)
          )
        : endpoint(record, false)
      const end = endBinding
        ? anchorPoint(
            records[endBinding.shapeId] as Shape,
            endBinding,
            targetBounds(endBinding.shapeId)
          )
        : endpoint(record, true)
      next.x = start.x
      next.y = start.y
      next.rot = 0
      next.props.dx = end.x - start.x
      next.props.dy = end.y - start.y
    }
    if (!equal(next, record)) updates.push(next)
  }
  return updates
}
