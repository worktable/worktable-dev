// ============================================================
// Markdown projection of Docs for line-addressed agent reads
// ============================================================
//
// `worktable_docs_read` returns a Doc as Markdown, numbers its lines for
// ranged reads, and greps it line by line. All three must see the same text,
// so they share this projection. Converting BlockNote JSON to Markdown is the
// expensive step; results are cached by the exact source revision, so a stale
// entry can never be served. Change events only release memory early.

import { onDocContentChanged } from "./content-events.ts"
import { blocksToMarkdownSafe } from "./markdown.ts"
import {
  getDocArchiveInfoMap,
  listDocs,
  readDocSourceSnapshot,
  type DocSourceRevision,
  type DocSourceSnapshot,
} from "./store.ts"
import { onWorkspaceChange } from "./workspace-events.ts"

/** The revision agents see for a Doc: a hash of its exact stored bytes. */
export function docRevisionId(revision: DocSourceRevision): string {
  return `sha256:${revision.sha256}`
}

interface CachedProjection {
  revision: string
  markdown: string | null
}

const MAX_CACHED_DOCS = 1000
const MAX_CACHED_CHARS = 32 * 1024 * 1024
const cache = new Map<string, CachedProjection>()
let cachedChars = 0

const cacheKey = (spaceId: string, docPath: string) =>
  `${spaceId}\0${docPath}`

function forget(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  cachedChars -= entry.markdown?.length ?? 0
  cache.delete(key)
}

function forgetSpace(spaceId: string): void {
  const prefix = `${spaceId}\0`
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) forget(key)
  }
}

function remember(key: string, entry: CachedProjection): void {
  forget(key)
  cache.set(key, entry)
  cachedChars += entry.markdown?.length ?? 0
  // Map iteration order is insertion order; hits re-insert, so the first key
  // is the least recently used.
  while (cache.size > MAX_CACHED_DOCS || cachedChars > MAX_CACHED_CHARS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    forget(oldest)
  }
}

onDocContentChanged((spaceId, docPath) => forget(cacheKey(spaceId, docPath)))
onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    cache.clear()
    cachedChars = 0
  } else if (
    event.type === "space" ||
    event.type === "doc" ||
    event.type === "docAliases" ||
    event.type === "documentCorpus"
  ) {
    forgetSpace(event.spaceId)
  }
})

/**
 * Markdown for one source snapshot: `.md` source as stored, BlockNote JSON
 * converted. Null when the snapshot is unreadable or conversion fails.
 */
export async function docMarkdownProjection(
  spaceId: string,
  docPath: string,
  snapshot: DocSourceSnapshot
): Promise<string | null> {
  const { result } = snapshot
  if (result.storedAs === "md" && typeof result.data === "string") {
    return result.data
  }
  if (!Array.isArray(result.data) || !snapshot.revision) return null

  const key = cacheKey(spaceId, docPath)
  const revision = docRevisionId(snapshot.revision)
  const cached = cache.get(key)
  if (cached?.revision === revision) {
    remember(key, cached)
    return cached.markdown
  }
  const markdown = await blocksToMarkdownSafe(result.data)
  remember(key, { revision, markdown })
  return markdown
}

/**
 * Lines as `read` numbers them: split on "\n", where a trailing newline ends
 * the last line rather than starting an empty one.
 */
export function markdownLines(content: string): string[] {
  if (content === "") return []
  const lines = content.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * Lines `startLine` through `endLine` (1-based, inclusive) with their line
 * endings, so consecutive slices concatenate back to the exact content.
 */
export function sliceMarkdownLines(
  content: string,
  offset: number,
  limit: number | undefined
): { content: string; totalLines: number; startLine: number; endLine: number } {
  const lines = markdownLines(content)
  const totalLines = lines.length
  if (offset > Math.max(totalLines, 1)) {
    throw new Error(
      `offset ${offset} is past the end of the Doc, which has ${totalLines} line${totalLines === 1 ? "" : "s"}`
    )
  }
  const start = offset - 1
  const end = Math.min(totalLines, limit === undefined ? totalLines : start + limit)
  const selected = lines.slice(start, end)
  const endsWithNewline = end < totalLines || content.endsWith("\n")
  return {
    content:
      selected.length === 0
        ? ""
        : `${selected.join("\n")}${endsWithNewline ? "\n" : ""}`,
    totalLines,
    startLine: offset,
    endLine: end,
  }
}

// ---- grep ----

/** Regex matching examines at most this many characters of one line. */
const MAX_REGEX_LINE_CHARS = 10_000
/** One grep stops rather than holding the server for longer than this. */
export const GREP_TIME_LIMIT_MS = 10_000

export type LineMatcher = (line: string) => boolean

/**
 * Reject regex constructs whose backtracking can grow exponentially with the
 * line length: a repeated group that itself repeats or alternates, e.g.
 * `(a+)+` or `(a|ab)*`, and backreferences.
 */
function unsafeRegexReason(pattern: string): string | null {
  // Each open group records whether it contains a quantifier or alternation.
  const groups: Array<{ risky: boolean }> = []
  let inClass = false
  let lastClosedRisky = false
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    const closedRisky = lastClosedRisky
    lastClosedRisky = false
    if (char === "\\") {
      const next = pattern[i + 1] ?? ""
      if (!inClass && (/[1-9]/.test(next) || next === "k")) {
        return "backreferences are not supported"
      }
      i += 1
      continue
    }
    if (inClass) {
      if (char === "]") inClass = false
      continue
    }
    if (char === "[") {
      inClass = true
      continue
    }
    if (char === "(") {
      groups.push({ risky: false })
      continue
    }
    if (char === ")") {
      const group = groups.pop()
      lastClosedRisky = group?.risky ?? false
      if (group?.risky && groups.length > 0) groups[groups.length - 1].risky = true
      continue
    }
    const quantifier =
      char === "*" ||
      char === "+" ||
      (char === "{" && /^\{\d+(,\d*)?\}/.test(pattern.slice(i)))
    if (quantifier) {
      if (closedRisky) {
        return "a repeated group cannot contain another repetition or alternation"
      }
      if (groups.length > 0) groups[groups.length - 1].risky = true
      continue
    }
    if (char === "|" && groups.length > 0) {
      groups[groups.length - 1].risky = true
    }
  }
  return null
}

export function compileLineMatcher(options: {
  pattern: string
  regex: boolean
  caseSensitive: boolean
}): LineMatcher {
  const { pattern, regex, caseSensitive } = options
  if (/[\r\n]/.test(pattern)) {
    throw new Error("grep matches one line at a time; pattern cannot contain a line break")
  }
  if (!regex) {
    if (caseSensitive) return (line) => line.includes(pattern)
    const needle = pattern.toLowerCase()
    return (line) => line.toLowerCase().includes(needle)
  }
  const unsafe = unsafeRegexReason(pattern)
  if (unsafe) {
    throw new Error(`Regular expression rejected: ${unsafe}. Simplify the pattern.`)
  }
  let compiled: RegExp
  try {
    compiled = new RegExp(pattern, caseSensitive ? "" : "i")
  } catch (err) {
    throw new Error(
      `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return (line) =>
    compiled.test(
      line.length > MAX_REGEX_LINE_CHARS ? line.slice(0, MAX_REGEX_LINE_CHARS) : line
    )
}

export interface DocGrepMatch {
  spaceId: string
  docPath: string
  revision: string
  line: number
  text: string
  before: string[]
  after: string[]
}

/**
 * Match every active Doc in the given Spaces line by line, in Space then path
 * order. Counts every match; returns at most `maxResults`.
 */
export async function grepDocs(options: {
  spaceIds: string[]
  pathPrefix?: string
  includeArchived: boolean
  matcher: LineMatcher
  context: number
  maxResults: number
}): Promise<{ matches: DocGrepMatch[]; total: number }> {
  const { pathPrefix, matcher, context, maxResults } = options
  const deadline = performance.now() + GREP_TIME_LIMIT_MS
  const matches: DocGrepMatch[] = []
  let total = 0
  for (const spaceId of options.spaceIds) {
    const paths = (await listDocs(spaceId))
      .filter(
        (path) =>
          !pathPrefix || path === pathPrefix || path.startsWith(`${pathPrefix}/`)
      )
      .sort()
    const archived = options.includeArchived
      ? new Map()
      : await getDocArchiveInfoMap(spaceId, paths)
    for (const docPath of paths) {
      if (archived.has(docPath)) continue
      const snapshot = await readDocSourceSnapshot(spaceId, docPath)
      if (!snapshot.revision) continue
      const markdown = await docMarkdownProjection(spaceId, docPath, snapshot)
      if (markdown === null) continue
      const revision = docRevisionId(snapshot.revision)
      const lines = markdownLines(markdown)
      for (let index = 0; index < lines.length; index += 1) {
        if ((index & 0xff) === 0 && performance.now() > deadline) {
          throw new Error(
            `grep stopped after ${GREP_TIME_LIMIT_MS / 1000} seconds. Narrow spaceId or pathPrefix, or simplify the pattern.`
          )
        }
        if (!matcher(lines[index])) continue
        total += 1
        if (matches.length >= maxResults) continue
        matches.push({
          spaceId,
          docPath,
          revision,
          line: index + 1,
          text: lines[index],
          before: lines.slice(Math.max(0, index - context), index),
          after: lines.slice(index + 1, index + 1 + context),
        })
      }
    }
  }
  return { matches, total }
}
