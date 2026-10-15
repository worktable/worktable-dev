import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import type { Options as SanitizeSchema } from "rehype-sanitize"
import type { Options as MarkdownOptions } from "react-markdown"

// HTML in a Markdown Doc renders inside the signed-in app, so only a safe
// subset survives: formatting such as <details>, <kbd>, <sub> and <mark>,
// tables and plain containers. Scripts, styles, frames, forms, event
// handlers and inline styles are removed. This is GitHub's schema plus the
// few formatting tags it omits. Loaded only for Docs that contain HTML.
const schema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "abbr",
    "caption",
    "figcaption",
    "figure",
    "mark",
    "small",
    "u",
  ],
  // Ids are namespaced below instead, once, so footnote links keep working.
  clobberPrefix: "",
}

const USER_PREFIX = "user-content-"

type HastNode = {
  type: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/**
 * Authored ids and names cannot collide with the app's own elements. Links
 * to them within the Doc follow the new names.
 */
function namespaceIds() {
  const namespace = (value: string) =>
    value.startsWith(USER_PREFIX) ? value : USER_PREFIX + value
  const visit = (node: HastNode) => {
    if (node.type === "element" && node.properties) {
      for (const key of ["id", "name"]) {
        const value = node.properties[key]
        if (typeof value === "string") node.properties[key] = namespace(value)
      }
      const href = node.properties.href
      if (typeof href === "string" && href.length > 1 && href.startsWith("#"))
        node.properties.href = `#${namespace(href.slice(1))}`
    }
    node.children?.forEach(visit)
  }
  return visit
}

export const markdownHtmlPlugins: NonNullable<MarkdownOptions["rehypePlugins"]> =
  [rehypeRaw, [rehypeSanitize, schema], namespaceIds]
