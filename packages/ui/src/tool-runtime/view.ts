/** The renderer's complete input language. No authored HTML, CSS rules, URLs,
 * event handlers, or DOM objects pass through this boundary. */
export interface ToolViewNode {
  tag: string
  key?: string
  props?: Record<string, string | number | boolean>
  style?: Record<string, string | number>
  on?: Partial<Record<"click" | "input" | "change" | "submit", string>>
  children?: ToolView[]
}
export type ToolView = string | number | ToolViewNode

const HTML_TAGS = new Set([
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "span",
  "strong",
  "em",
  "small",
  "code",
  "pre",
  "blockquote",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "button",
  "input",
  "select",
  "option",
  "textarea",
  "label",
  "form",
  "details",
  "summary",
  "progress",
  "meter",
])
const TOOL_SVG_TAGS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "title",
  "desc",
])
const NODE_KEYS = new Set(["tag", "key", "props", "style", "on", "children"])
const STRING_PROPS = new Set([
  "title",
  "placeholder",
  "value",
  "name",
  "aria-label",
  "aria-description",
])
const BOOLEAN_PROPS = new Set([
  "disabled",
  "checked",
  "selected",
  "multiple",
  "required",
  "readOnly",
  "open",
])
const NUMBER_PROPS = new Set([
  "min",
  "max",
  "step",
  "maxLength",
  "rows",
  "cols",
  "colSpan",
  "rowSpan",
])
const SVG_NUMBERS = new Set([
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "stroke-width",
  "opacity",
])
const ENUM_STYLES: Record<string, readonly string[]> = {
  display: [
    "block",
    "inline",
    "inline-block",
    "flex",
    "inline-flex",
    "grid",
    "none",
  ],
  flexDirection: ["row", "column", "row-reverse", "column-reverse"],
  flexWrap: ["wrap", "nowrap"],
  alignItems: ["start", "end", "center", "stretch", "baseline"],
  justifyContent: [
    "start",
    "end",
    "center",
    "space-between",
    "space-around",
    "space-evenly",
  ],
  textAlign: ["start", "end", "left", "right", "center"],
  fontWeight: ["normal", "medium", "bold", "400", "500", "600", "700"],
  fontFamily: ["sans", "display", "mono"],
  whiteSpace: ["normal", "pre", "pre-wrap", "nowrap"],
  overflow: ["auto", "hidden", "visible"],
  overflowX: ["auto", "hidden", "visible"],
  overflowY: ["auto", "hidden", "visible"],
  borderStyle: ["solid", "dashed", "dotted", "none"],
}
const LENGTH_STYLES = new Set([
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "gap",
  "rowGap",
  "columnGap",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "borderWidth",
  "borderRadius",
  "fontSize",
  "letterSpacing",
])
const COLORS: Record<string, string> = {
  background: "var(--ad-bg)",
  surface: "var(--ad-surface)",
  surface2: "var(--ad-surface-2)",
  text: "var(--ad-text)",
  muted: "var(--ad-muted)",
  border: "var(--ad-border)",
  accent: "var(--ad-accent)",
  accentSoft: "var(--ad-accent-soft)",
  danger: "var(--ad-danger)",
  warning: "var(--ad-warning)",
  success: "var(--ad-success)",
  transparent: "transparent",
  currentColor: "currentColor",
  none: "none",
}
const COLOR_STYLES = new Set(["color", "backgroundColor", "borderColor"])
const ACTION = /^[A-Za-z0-9_.:-]{1,100}$/

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.")
  return value as Record<string, unknown>
}
function color(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid color.")
  if (Object.hasOwn(COLORS, value)) return COLORS[value]!
  if (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value)) return value
  throw new Error("Use a semantic color or a hex color.")
}
function finite(value: unknown, minimum = -4096, maximum = 4096): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error("Invalid numeric value.")
  return value
}
function length(value: unknown): string | number {
  if (typeof value === "number") return finite(value, 0)
  if (value === "auto" || value === "100%") return value
  if (typeof value === "string") {
    const match = /^(\d+(?:\.\d+)?)(px|rem|em|%|vh|vw)$/.exec(value)
    if (match && Number(match[1]) <= (match[2] === "px" ? 4096 : 100))
      return value
  }
  throw new Error("Invalid length.")
}

/** Canonicalize a parsed JSON tree before touching the DOM. Unknown fields are
 * errors, including resource attributes and CSS escape tricks. */
export function validateToolView(input: unknown): ToolView {
  let count = 0
  let textCharacters = 0
  const keys = new Set<string>()
  const ancestors = new Set<object>()
  function text(value: unknown): string {
    if (typeof value !== "string" || value.length > 16_384)
      throw new Error("Invalid text.")
    textCharacters += value.length
    if (textCharacters > 128 * 1024)
      throw new Error("The view contains too much text.")
    return value
  }
  function walk(
    input: unknown,
    depth: number,
    namespace: "html" | "svg"
  ): ToolView {
    if (++count > 2048 || depth > 32) throw new Error("The view is too large.")
    if (typeof input === "string") return text(input)
    if (typeof input === "number")
      return finite(input, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    const value = object(input)
    if (ancestors.has(value)) throw new Error("The view contains a cycle.")
    ancestors.add(value)
    for (const key of Object.keys(value))
      if (!NODE_KEYS.has(key))
        throw new Error(`Unsupported view property: ${key}`)
    const tag = value.tag
    if (
      typeof tag !== "string" ||
      !(namespace === "svg" || tag === "svg" ? TOOL_SVG_TAGS : HTML_TAGS).has(
        tag
      )
    )
      throw new Error("Unsupported element.")
    const svg = namespace === "svg" || tag === "svg"
    const node: ToolViewNode = { tag }
    if (value.key !== undefined) {
      if (
        typeof value.key !== "string" ||
        !ACTION.test(value.key) ||
        keys.has(value.key)
      )
        throw new Error("Invalid or duplicate view key.")
      keys.add(value.key)
      node.key = value.key
    }
    if (value.props !== undefined) {
      node.props = Object.create(null) as NonNullable<ToolViewNode["props"]>
      for (const [key, prop] of Object.entries(object(value.props))) {
        let parsed: string | number | boolean
        if (svg) {
          if (SVG_NUMBERS.has(key)) parsed = finite(prop)
          else if (key === "fill" || key === "stroke") parsed = color(prop)
          else if (
            key === "viewBox" &&
            typeof prop === "string" &&
            /^-?[\d.]+(?:[ ,]+-?[\d.]+){3}$/.test(prop)
          )
            parsed = text(prop)
          else if (
            (key === "d" || key === "points") &&
            typeof prop === "string" &&
            /^[\d\s.,+eE\-MmLlHhVvCcSsQqTtAaZz]*$/.test(prop)
          )
            parsed = text(prop)
          else if (key === "aria-label") parsed = text(prop)
          else throw new Error(`Unsupported vector property: ${key}`)
        } else if (STRING_PROPS.has(key)) parsed = text(prop)
        else if (BOOLEAN_PROPS.has(key) && typeof prop === "boolean")
          parsed = prop
        else if (NUMBER_PROPS.has(key)) parsed = finite(prop)
        else if (
          key === "type" &&
          typeof prop === "string" &&
          [
            "button",
            "submit",
            "text",
            "number",
            "email",
            "search",
            "checkbox",
            "radio",
            "range",
            "date",
            "password",
          ].includes(prop)
        )
          parsed = prop
        else if (
          key === "role" &&
          typeof prop === "string" &&
          ["status", "alert", "group", "img", "presentation"].includes(prop)
        )
          parsed = prop
        else throw new Error(`Unsupported element property: ${key}`)
        node.props[key] = parsed
      }
    }
    if (value.style !== undefined) {
      node.style = Object.create(null) as NonNullable<ToolViewNode["style"]>
      for (const [key, prop] of Object.entries(object(value.style))) {
        let parsed: string | number
        if (COLOR_STYLES.has(key)) parsed = color(prop)
        else if (LENGTH_STYLES.has(key)) parsed = length(prop)
        else if (key === "opacity") parsed = finite(prop, 0, 1)
        else if (key === "flexGrow" || key === "flexShrink")
          parsed = finite(prop, 0, 100)
        else if (key === "lineHeight") parsed = finite(prop, 0.5, 4)
        else if (
          key === "gridTemplateColumns" &&
          typeof prop === "number" &&
          Number.isInteger(prop)
        )
          parsed = `repeat(${finite(prop, 1, 12)}, minmax(0, 1fr))`
        else if (
          Object.hasOwn(ENUM_STYLES, key) &&
          typeof prop === "string" &&
          ENUM_STYLES[key]!.includes(prop)
        ) {
          parsed =
            key === "fontFamily"
              ? {
                  sans: "var(--font-sans)",
                  display: "var(--font-display)",
                  mono: "var(--font-mono)",
                }[prop]!
              : prop
        } else throw new Error(`Unsupported style property: ${key}`)
        node.style[key] = parsed
      }
    }
    if (value.on !== undefined) {
      node.on = {}
      for (const [event, action] of Object.entries(object(value.on))) {
        if (
          !["click", "input", "change", "submit"].includes(event) ||
          typeof action !== "string" ||
          !ACTION.test(action)
        )
          throw new Error("Invalid view action.")
        node.on[event as keyof NonNullable<ToolViewNode["on"]>] = action
      }
    }
    if (value.children !== undefined) {
      if (!Array.isArray(value.children))
        throw new Error("Expected view children.")
      node.children = value.children.map((child) =>
        walk(child, depth + 1, svg ? "svg" : "html")
      )
    }
    ancestors.delete(value)
    return node
  }
  return walk(input, 0, "html")
}
