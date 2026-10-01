import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js"

const RESULT_MEDIA = Symbol("Worktable result media")
type WithMedia = Record<string, unknown> & { [RESULT_MEDIA]?: ContentBlock[] }

/** Attach media privately: binary travels once in MCP content, never structured JSON. */
export function withResultMedia<T extends Record<string, unknown>>(
  data: T,
  content: ContentBlock[]
): T {
  return Object.assign(data, { [RESULT_MEDIA]: content })
}

export function takeResultMedia(value: unknown): {
  data: unknown
  content: ContentBlock[]
} {
  if (!value || typeof value !== "object" || !(RESULT_MEDIA in value))
    return { data: value, content: [] }
  const data = { ...(value as WithMedia) }
  const content = data[RESULT_MEDIA] ?? []
  delete data[RESULT_MEDIA]
  return { data, content }
}
