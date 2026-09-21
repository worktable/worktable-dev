import {
  THREAD_IDENTITY_NAME_MAX_LENGTH,
  threadBodyMentionsIdentity,
} from "@worktable/types"

export interface ThreadMentionTarget {
  id: string
  name: string
  description?: string
}

export interface ThreadMentionQuery {
  start: number
  end: number
  query: string
}

export interface ThreadMentionSegment {
  text: string
  mention: boolean
}

const THREAD_MENTION_QUERY_PATTERN = new RegExp(
  `(?:^|[^\\p{L}\\p{N}_@])@([^\\n@]{0,${THREAD_IDENTITY_NAME_MAX_LENGTH}})$`,
  "u"
)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function threadMentionSegments(
  value: string,
  names: string[]
): ThreadMentionSegment[] {
  const alternatives = [...new Set(names)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
  if (alternatives.length === 0) return [{ text: value, mention: false }]

  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_@])(@(?:${alternatives.join("|")}))(?=$|[^\\p{L}\\p{N}_])`,
    "giu"
  )
  const segments: ThreadMentionSegment[] = []
  let offset = 0
  for (const match of value.matchAll(pattern)) {
    const leading = match[1] ?? ""
    const token = match[2] ?? ""
    const matchIndex = match.index ?? 0
    const tokenIndex = matchIndex + leading.length
    if (tokenIndex > offset) {
      segments.push({ text: value.slice(offset, tokenIndex), mention: false })
    }
    segments.push({ text: token, mention: true })
    offset = tokenIndex + token.length
  }
  if (offset < value.length) {
    segments.push({ text: value.slice(offset), mention: false })
  }
  return segments.length > 0 ? segments : [{ text: value, mention: false }]
}

export function threadMentionQuery(
  value: string,
  cursor: number
): ThreadMentionQuery | undefined {
  const prefix = value.slice(0, cursor)
  const match = THREAD_MENTION_QUERY_PATTERN.exec(prefix)
  if (!match) return undefined
  const query = match[1] ?? ""
  return {
    start: cursor - query.length - 1,
    end: cursor,
    query: query.trimStart(),
  }
}

export function insertThreadMention(
  value: string,
  mention: ThreadMentionQuery,
  target: ThreadMentionTarget
): { value: string; cursor: number } {
  const suffix = value.slice(mention.end)
  const token = `@${target.name}${/^\s/u.test(suffix) ? "" : " "}`
  return {
    value: `${value.slice(0, mention.start)}${token}${suffix}`,
    cursor: mention.start + token.length,
  }
}

export function retainedThreadMentionIds(
  value: string,
  selectedIds: string[],
  targets: ThreadMentionTarget[]
): string[] {
  const selected = new Set(selectedIds)
  return targets.flatMap((target) => {
    if (!selected.has(target.id)) return []
    return threadBodyMentionsIdentity(value, target.name) ? [target.id] : []
  })
}
