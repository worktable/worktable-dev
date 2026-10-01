// Both validated document records and Quickdraw's live canvas records share
// this shape. Keep comparison independent of the browser engine package.
type ComparableRecord =
  | { typeName: "asset" }
  | {
      typeName: "shape"
      type: string
      x: number
      y: number
      rot: number
      props: Record<string, unknown>
    }

// Bound endpoint coordinates are derived from current text metrics. Everything
// authored remains significant, including the world position of a free end.
function authoredRecord(record: ComparableRecord) {
  if (
    record.typeName !== "shape" ||
    (record.type !== "arrow" && record.type !== "line") ||
    (!record.props.startBinding && !record.props.endBinding)
  )
    return { value: record, freeEnds: [], coordinateScale: 1 }
  const { x, y, rot, props, ...identity } = record
  const { dx: rawDx, dy: rawDy, ...authoredProps } = props
  const dx = typeof rawDx === "number" ? rawDx : 0
  const dy = typeof rawDy === "number" ? rawDy : 0
  const endpoint = (end: boolean) => {
    const sign = end ? 0.5 : -0.5
    const c = Math.cos(rot),
      s = Math.sin(rot)
    return {
      x: x + dx / 2 + sign * (dx * c - dy * s),
      y: y + dy / 2 + sign * (dx * s + dy * c),
    }
  }
  return {
    value: [identity, authoredProps],
    freeEnds: [
      ...(!props.startBinding ? [endpoint(false)] : []),
      ...(!props.endBinding ? [endpoint(true)] : []),
    ],
    coordinateScale: Math.max(
      1,
      Math.abs(x),
      Math.abs(y),
      Math.abs(dx),
      Math.abs(dy)
    ),
  }
}

/** Compare immutable records by authored intent. Bound endpoint geometry may
 * change with font metrics; bindings, free endpoints and all other fields must
 * still agree. Keep the comparator local to one history/reversal operation. */
export function createDrawingRecordComparator() {
  // The persisted schema normalizes property order. Compare JSON values, not
  // insertion order, and cache large image/stroke records during stack replay.
  const serialized = new WeakMap<
    ComparableRecord,
    {
      json: string
      freeEnds: { x: number; y: number }[]
      coordinateScale: number
    }
  >()
  const serialize = (record: ComparableRecord | undefined) => {
    if (!record) return undefined
    let value = serialized.get(record)
    if (value === undefined) {
      const authored = authoredRecord(record)
      const json = JSON.stringify(authored.value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]])
            )
          : item
      )
      value = {
        json,
        freeEnds: authored.freeEnds,
        coordinateScale: authored.coordinateScale,
      }
      serialized.set(record, value)
    }
    return value
  }
  return (a: ComparableRecord | undefined, b: ComparableRecord | undefined) => {
    if (a === b) return true
    const left = serialize(a),
      right = serialize(b)
    if (!left || !right || left.json !== right.json) return false
    // Re-expressing an unchanged free end after its bound end moves can lose a
    // few floating-point bits. Only computed coordinates get this tolerance.
    const epsilon =
      Number.EPSILON * 8 * Math.max(left.coordinateScale, right.coordinateScale)
    return (
      left.freeEnds.length === right.freeEnds.length &&
      left.freeEnds.every((point, index) => {
        const other = right.freeEnds[index]!
        return (
          Math.abs(point.x - other.x) <= epsilon &&
          Math.abs(point.y - other.y) <= epsilon
        )
      })
    )
  }
}
