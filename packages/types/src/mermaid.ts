import {
  MERMAID_THEME_CSS,
  MERMAID_THEME_VARIABLES,
} from "./mermaid-theme.generated.ts"

export type WorktableMermaidThemeMode = "light" | "dark"

// ── Mermaid block identity (single source of truth) ──────────
//
// The client (createReactBlockSpec) and the server's conversion editor
// (createBlockSpec) must register the exact same block type, prop names,
// and defaults — a mismatch silently degrades mermaid blocks to
// paragraphs during canonicalization. Both sides additionally spread
// BlockNote's `defaultProps` (backgroundColor/textColor/textAlignment)
// from their own @blocknote/core.

export const MERMAID_BLOCK_TYPE = "mermaid"

export const MERMAID_LANGUAGE_ALIASES = ["mermaid", "mmd"] as const

export type MermaidRepresentation =
  | "markdown-fence"
  | "escaped-markdown-fence"
  | "code-block"
  | "custom-block"

export interface MermaidDocumentIssue {
  code: "INVALID_MERMAID" | "EMPTY_MERMAID" | "UNPAIRED_ESCAPED_MERMAID_FENCE"
  representation: MermaidRepresentation
  diagramIndex: number
  message: string
  startLine?: number
  endLine?: number
  blockId?: string
}

export interface MermaidDocumentRepair {
  code: "ESCAPED_MERMAID_FENCE_REPAIRED"
  diagramIndex: number
  startLine: number
  endLine: number
}

export const DEFAULT_MERMAID_SOURCE = `flowchart TD
    A[Start] --> B{Is it?}
    B -->|Yes| C[OK]
    B -->|No| D[End]`

export const DEFAULT_MERMAID_TITLE = "Untitled Diagram"

export const mermaidBlockPropSchema = {
  data: { default: DEFAULT_MERMAID_SOURCE },
  title: { default: DEFAULT_MERMAID_TITLE },
  collapsed: { default: "false" },
  locked: { default: "false" },
} as const

type PortableBlock = Record<string, unknown>

export function isMermaidLanguage(value: unknown): boolean {
  return (
    typeof value === "string" &&
    MERMAID_LANGUAGE_ALIASES.includes(
      value.trim().toLowerCase() as (typeof MERMAID_LANGUAGE_ALIASES)[number]
    )
  )
}

export function isCustomMermaidBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    (block as PortableBlock).type === MERMAID_BLOCK_TYPE
  )
}

export function isMermaidCodeBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false
  const candidate = block as PortableBlock
  const props = candidate.props
  return (
    candidate.type === "codeBlock" &&
    !!props &&
    typeof props === "object" &&
    isMermaidLanguage((props as PortableBlock).language)
  )
}

function inlineText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return ""
      const text = (item as PortableBlock).text
      return typeof text === "string" ? text : ""
    })
    .join("")
}

export function getMermaidSource(block: unknown): string | null {
  if (!block || typeof block !== "object") return null
  const candidate = block as PortableBlock
  if (isCustomMermaidBlock(candidate)) {
    const props =
      candidate.props && typeof candidate.props === "object"
        ? (candidate.props as PortableBlock)
        : {}
    if ("data" in props) {
      return typeof props.data === "string" ? props.data : null
    }
    // Compatibility with the pre-Worktable custom block shape.
    if ("code" in props) {
      return typeof props.code === "string" ? props.code : null
    }
    return DEFAULT_MERMAID_SOURCE
  }
  if (isMermaidCodeBlock(candidate)) return inlineText(candidate.content)
  return null
}

export function toCanonicalMermaidBlock(block: unknown): unknown {
  if (!isCustomMermaidBlock(block) && !isMermaidCodeBlock(block)) return block

  const candidate = block as PortableBlock
  const existingProps =
    candidate.props &&
    typeof candidate.props === "object"
      ? (candidate.props as PortableBlock)
      : {}
  if (
    isCustomMermaidBlock(candidate) &&
    typeof existingProps.data === "string" &&
    typeof existingProps.title === "string" &&
    typeof existingProps.collapsed === "string" &&
    typeof existingProps.locked === "string" &&
    !("code" in existingProps) &&
    !("language" in existingProps) &&
    !("content" in candidate)
  ) {
    return block
  }

  const source = getMermaidSource(candidate) ?? ""
  const {
    code: _legacyCode,
    language: _language,
    ...preservedProps
  } = existingProps
  void _legacyCode
  void _language

  const { content: _content, ...rest } = candidate
  void _content
  return {
    ...rest,
    type: MERMAID_BLOCK_TYPE,
    props: {
      ...preservedProps,
      data: source,
      title:
        typeof existingProps.title === "string"
          ? existingProps.title
          : DEFAULT_MERMAID_TITLE,
      collapsed:
        typeof existingProps.collapsed === "string"
          ? existingProps.collapsed
          : "false",
      locked:
        typeof existingProps.locked === "string"
          ? existingProps.locked
          : "false",
    },
  }
}

export function normalizeMermaidBlocks(blocks: unknown[]): {
  blocks: unknown[]
  changed: boolean
} {
  let changed = false

  const normalize = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value
    const block = value as PortableBlock
    let next = toCanonicalMermaidBlock(block) as PortableBlock
    if (next !== block) changed = true

    if (Array.isArray(next.children)) {
      const previousChildren = next.children
      const children = next.children.map(normalize)
      if (children.some((child, index) => child !== previousChildren[index])) {
        next = { ...next, children }
        changed = true
      }
    }
    return next
  }

  const normalized = blocks.map(normalize)
  return { blocks: normalized, changed }
}

export function getWorktableMermaidConfig(
  themeMode: WorktableMermaidThemeMode
) {
  const isDark = themeMode === "dark"

  return {
    startOnLoad: false,
    theme: "base" as const,
    look: "classic" as const,
    darkMode: isDark,
    logLevel: "fatal" as const,
    securityLevel: "strict" as const,
    htmlLabels: true,
    fontFamily: "General Sans, system-ui, sans-serif",
    fontSize: 14,
    themeVariables: MERMAID_THEME_VARIABLES[themeMode],
    themeCSS: MERMAID_THEME_CSS[themeMode],
    flowchart: {
      curve: "linear" as const,
      useMaxWidth: true,
    },
    sequence: {
      mirrorActors: true,
      useMaxWidth: true,
    },
    er: {
      useMaxWidth: true,
    },
    gantt: {
      fontSize: 12,
    },
  }
}
