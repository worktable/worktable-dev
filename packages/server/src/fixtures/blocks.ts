/**
 * Tiny BlockNote block-array builder for fixtures. Produces stable ids (no RNG) and
 * the standard prop shape so generated `.json` docs are deterministic and valid.
 */
export interface BlockItem {
  id: string
  type: "heading" | "paragraph" | "codeBlock" | "mermaid"
  text: string
  /** Heading level (heading only). */
  level?: 1 | 2 | 3
  /** Code language (codeBlock only). */
  language?: string
  /** Diagram title (mermaid only). */
  title?: string
}

export function blockDoc(...items: BlockItem[]): unknown[] {
  return items.map((it) => {
    if (it.type === "codeBlock") {
      return {
        id: it.id,
        type: "codeBlock",
        props: { language: it.language ?? "text" },
        content: [{ type: "text", text: it.text, styles: {} }],
        children: [],
      }
    }
    if (it.type === "mermaid") {
      return {
        id: it.id,
        type: "mermaid",
        props: {
          data: it.text,
          title: it.title ?? "Untitled Diagram",
          collapsed: "false",
          locked: "false",
        },
        children: [],
      }
    }
    const props: Record<string, unknown> = {
      ...(it.type === "heading" ? { level: it.level ?? 1 } : {}),
      textColor: "default",
      backgroundColor: "default",
      textAlignment: "left",
    }
    return {
      id: it.id,
      type: it.type,
      props,
      content: [{ type: "text", text: it.text, styles: {} }],
      children: [],
    }
  })
}
