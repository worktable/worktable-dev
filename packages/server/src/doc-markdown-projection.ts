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

/**
 * The revision agents see for a Doc: its storage kind and a hash of its exact
 * stored bytes, e.g. `md:sha256:…`. A `.md` and a `.json` source with
 * identical bytes are different revisions.
 */
export function docRevisionId(revision: DocSourceRevision): string {
  const extension = revision.relativePath.slice(
    revision.relativePath.lastIndexOf(".") + 1
  )
  return `${extension}:sha256:${revision.sha256}`
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

// ---- lines ----
//
// `read` numbers lines by splitting on "\n", where a trailing newline ends the
// last line rather than starting an empty one. These helpers scan newline
// offsets, so a long Doc never becomes an array of line strings.

export function countMarkdownLines(content: string): number {
  if (content === "") return 0
  let newlines = 0
  for (
    let at = content.indexOf("\n");
    at !== -1;
    at = content.indexOf("\n", at + 1)
  ) {
    newlines += 1
  }
  return content.endsWith("\n") ? newlines : newlines + 1
}

/** Offset of the line after the one starting at `from`. */
function nextLineStart(content: string, from: number): number {
  const newline = content.indexOf("\n", from)
  return newline === -1 ? content.length : newline + 1
}

/**
 * Lines `offset` through `offset + limit - 1` (1-based) with their line
 * endings, so consecutive slices concatenate back to the exact content.
 */
export function sliceMarkdownLines(
  content: string,
  offset: number,
  limit: number | undefined
): { content: string; totalLines: number; startLine: number; endLine: number } {
  const totalLines = countMarkdownLines(content)
  if (offset > Math.max(totalLines, 1)) {
    throw new Error(
      `offset ${offset} is past the end of the Doc, which has ${totalLines} line${totalLines === 1 ? "" : "s"}`
    )
  }
  const endLine = Math.min(
    totalLines,
    limit === undefined ? totalLines : offset - 1 + limit
  )
  let start = 0
  for (let line = 1; line < offset; line += 1) {
    start = nextLineStart(content, start)
  }
  let end = start
  for (let line = offset; line <= endLine; line += 1) {
    end = nextLineStart(content, end)
  }
  return {
    content: content.slice(start, end),
    totalLines,
    startLine: offset,
    endLine,
  }
}

function forEachLine(
  content: string,
  visit: (line: string, index: number) => void
): void {
  let start = 0
  for (let index = 0; start < content.length; index += 1) {
    const newline = content.indexOf("\n", start)
    const end = newline === -1 ? content.length : newline
    visit(content.slice(start, end), index)
    start = end + 1
  }
}

// ---- grep ----

/** Returned match and context lines are cut to this many characters. */
export const GREP_LINE_CHARS = 2_000
/** One grep returns at most about this many characters of line text. */
export const GREP_RESULT_CHARS = 100_000
const LINE_TRUNCATION_MARKER = " …[line truncated]"
const DEFAULT_GREP_TIME_LIMIT_MS = 10_000

let grepTimeLimitMs = DEFAULT_GREP_TIME_LIMIT_MS

export function setGrepTimeLimitForTests(limitMs: number | null): void {
  grepTimeLimitMs = limitMs ?? DEFAULT_GREP_TIME_LIMIT_MS
}

function grepTimeoutError(): Error {
  return new Error(
    `grep stopped after ${grepTimeLimitMs / 1000} seconds. Narrow spaceId or pathPrefix, or simplify the pattern.`
  )
}

/**
 * Runs in a worker, so a regex that backtracks badly is stopped by terminating
 * the worker instead of blocking the server. It is serialized with toString(),
 * so it must stay self-contained. Its line splitting matches forEachLine.
 */
function regexWorkerMain(): void {
  const scope = globalThis as unknown as {
    onmessage: (event: { data: Record<string, unknown> }) => void
    postMessage: (message: unknown) => void
  }
  let regex: RegExp | undefined
  scope.onmessage = (event) => {
    const data = event.data
    if (typeof data.pattern === "string") {
      regex = new RegExp(data.pattern, data.flags as string)
      return
    }
    const content = data.content as string
    const hits: number[] = []
    let start = 0
    for (let index = 0; start < content.length; index += 1) {
      const newline = content.indexOf("\n", start)
      const end = newline === -1 ? content.length : newline
      if (regex?.test(content.slice(start, end))) hits.push(index)
      start = end + 1
    }
    scope.postMessage({ id: data.id, hits })
  }
}

let regexWorkerUrl: string | undefined

/** One worker per regex grep, terminated when the grep ends or times out. */
class RegexLineMatcher {
  private worker: Worker | undefined
  private nextId = 0
  private readonly pattern: string
  private readonly flags: string

  constructor(pattern: string, flags: string) {
    this.pattern = pattern
    this.flags = flags
  }

  /** 0-based indexes of matching lines, in order. */
  matchingLines(content: string, deadline: number): Promise<number[]> {
    if (!this.worker) {
      regexWorkerUrl ??= URL.createObjectURL(
        new Blob([`(${regexWorkerMain.toString()})()`], {
          type: "application/javascript",
        })
      )
      this.worker = new Worker(regexWorkerUrl)
      this.worker.postMessage({ pattern: this.pattern, flags: this.flags })
    }
    const worker = this.worker
    const id = (this.nextId += 1)
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        worker.removeEventListener("message", onMessage)
        worker.removeEventListener("error", onError)
      }
      const onMessage = (event: MessageEvent) => {
        if (event.data?.id !== id) return
        finish()
        resolve(event.data.hits as number[])
      }
      const onError = (event: ErrorEvent) => {
        finish()
        this.close()
        reject(new Error(`grep failed: ${event.message}`))
      }
      const timer = setTimeout(
        () => {
          finish()
          this.close()
          reject(grepTimeoutError())
        },
        Math.max(0, deadline - performance.now())
      )
      worker.addEventListener("message", onMessage)
      worker.addEventListener("error", onError)
      worker.postMessage({ id, content })
    })
  }

  close(): void {
    this.worker?.terminate()
    this.worker = undefined
  }
}

export interface GrepPattern {
  pattern: string
  regex: boolean
  caseSensitive: boolean
}

/** Reject a pattern before any Doc is read. */
export function validateGrepPattern(options: GrepPattern): void {
  if (/[\r\n]/.test(options.pattern)) {
    throw new Error(
      "grep matches one line at a time; pattern cannot contain a line break"
    )
  }
  if (!options.regex) return
  try {
    new RegExp(options.pattern, options.caseSensitive ? "" : "i")
  } catch (err) {
    throw new Error(
      `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export interface DocGrepMatch {
  spaceId: string
  docPath: string
  revision: string
  line: number
  text: string
  before: string[]
  after: string[]
  lineTruncated?: true
}

export interface DocGrepSkip {
  spaceId: string
  docPath: string
  reason: "unreadable" | "conversion-failed"
}

/**
 * Match every active Doc in the given Spaces line by line, in Space then path
 * order. Counts every match; returns at most `maxResults` within the
 * character budget, and names the Docs it could not search.
 */
export async function grepDocs(
  options: GrepPattern & {
    spaceIds: string[]
    pathPrefix?: string
    includeArchived: boolean
    context: number
    maxResults: number
  }
): Promise<{ matches: DocGrepMatch[]; total: number; skipped: DocGrepSkip[] }> {
  validateGrepPattern(options)
  const { pathPrefix, context, maxResults } = options
  const deadline = performance.now() + grepTimeLimitMs
  const needle = options.caseSensitive
    ? options.pattern
    : options.pattern.toLowerCase()
  const lineMatches = (line: string) =>
    options.caseSensitive
      ? line.includes(needle)
      : line.toLowerCase().includes(needle)
  // Regex matching runs off the main thread; literal matching stays here.
  const regex = options.regex
    ? new RegexLineMatcher(options.pattern, options.caseSensitive ? "" : "i")
    : undefined
  const matches: DocGrepMatch[] = []
  const skipped: DocGrepSkip[] = []
  let total = 0
  let budget = GREP_RESULT_CHARS
  // Once maxResults or the budget is reached, later matches are only counted.
  let collecting = true

  const clip = (line: string, match: DocGrepMatch): string => {
    let text = line
    if (line.length > GREP_LINE_CHARS) {
      text = `${line.slice(0, GREP_LINE_CHARS)}${LINE_TRUNCATION_MARKER}`
      match.lineTruncated = true
    }
    budget -= text.length
    return text
  }

  try {
    for (const spaceId of options.spaceIds) {
      const paths = (await listDocs(spaceId))
        .filter(
          (path) =>
            !pathPrefix ||
            path === pathPrefix ||
            path.startsWith(`${pathPrefix}/`)
        )
        .sort()
      const archived = options.includeArchived
        ? new Map()
        : await getDocArchiveInfoMap(spaceId, paths)
      for (const docPath of paths) {
        if (archived.has(docPath)) continue
        const snapshot = await readDocSourceSnapshot(spaceId, docPath)
        if (!snapshot.revision || snapshot.result.error) {
          skipped.push({ spaceId, docPath, reason: "unreadable" })
          continue
        }
        const markdown = await docMarkdownProjection(spaceId, docPath, snapshot)
        if (markdown === null) {
          skipped.push({ spaceId, docPath, reason: "conversion-failed" })
          continue
        }
        const revision = docRevisionId(snapshot.revision)
        const hits = regex && (await regex.matchingLines(markdown, deadline))
        let nextHit = 0
        const recent: string[] = []
        let open: Array<{ match: DocGrepMatch; remaining: number }> = []
        forEachLine(markdown, (line, index) => {
          if ((index & 0xff) === 0 && performance.now() > deadline) {
            throw grepTimeoutError()
          }
          for (const pending of open) {
            pending.match.after.push(clip(line, pending.match))
            pending.remaining -= 1
          }
          open = open.filter((pending) => pending.remaining > 0)
          let hit: boolean
          if (hits) {
            hit = hits[nextHit] === index
            if (hit) nextHit += 1
          } else {
            hit = lineMatches(line)
          }
          if (hit) {
            total += 1
            if (matches.length >= maxResults || budget <= 0) collecting = false
            if (collecting) {
              const match: DocGrepMatch = {
                spaceId,
                docPath,
                revision,
                line: index + 1,
                text: "",
                before: [],
                after: [],
              }
              match.text = clip(line, match)
              match.before = recent.map((previous) => clip(previous, match))
              matches.push(match)
              if (context > 0) open.push({ match, remaining: context })
            }
          }
          if (context > 0) {
            recent.push(line)
            if (recent.length > context) recent.shift()
          }
        })
      }
    }
  } finally {
    regex?.close()
  }
  return { matches, total, skipped }
}
