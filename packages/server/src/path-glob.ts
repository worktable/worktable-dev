/**
 * Minimal glob matching for extensionless document paths.
 *
 * Supported syntax: `*` matches any run of characters within one path
 * segment, `?` matches exactly one character within a segment, and a `**`
 * segment matches zero or more whole segments. Every other character is
 * literal. Matching never builds a regular expression from user input, and
 * both stages run in polynomial time, so hostile patterns cannot backtrack
 * exponentially.
 */

export const PATH_GLOB_MAX_LENGTH = 1024

export class PathGlobError extends Error {
  constructor(message: string) {
    super(`Invalid glob: ${message}`)
    this.name = "PathGlobError"
  }
}

type Segment = { kind: "globstar" } | { kind: "chars"; chars: string[] }

function parseSegments(pattern: string): Segment[] {
  if (pattern.length === 0) throw new PathGlobError("pattern is empty")
  if (pattern.length > PATH_GLOB_MAX_LENGTH) {
    throw new PathGlobError(
      `pattern is longer than ${PATH_GLOB_MAX_LENGTH} characters`
    )
  }
  if (pattern.startsWith("!")) {
    throw new PathGlobError("negation (!) is not supported")
  }
  const unsupported = pattern.match(/[[\]{}\\]/)
  if (unsupported) {
    throw new PathGlobError(
      `"${unsupported[0]}" is not supported; use *, ** and ? only`
    )
  }
  if (pattern.startsWith("/") || pattern.endsWith("/")) {
    throw new PathGlobError(
      "paths are relative to the Space; remove the leading or trailing /"
    )
  }
  return pattern.split("/").map((segment) => {
    if (segment.length === 0) throw new PathGlobError("empty path segment (//)")
    if (segment === "**") return { kind: "globstar" }
    if (segment.includes("**")) {
      throw new PathGlobError(
        "** must be a whole path segment, e.g. plans/**/notes"
      )
    }
    return { kind: "chars", chars: Array.from(segment) }
  })
}

/** Match one segment against `*` and `?` without backtracking blowup. */
function matchSegment(pattern: readonly string[], value: readonly string[]): boolean {
  let p = 0
  let v = 0
  let starP = -1
  let starV = 0
  while (v < value.length) {
    const token = pattern[p]
    if (token === "*") {
      starP = p
      starV = v
      p += 1
    } else if (token !== undefined && (token === "?" || token === value[v])) {
      p += 1
      v += 1
    } else if (starP >= 0) {
      p = starP + 1
      starV += 1
      v = starV
    } else {
      return false
    }
  }
  while (pattern[p] === "*") p += 1
  return p === pattern.length
}

/** Compile a glob into a predicate over `/`-separated, extensionless paths. */
export function compilePathGlob(pattern: string): (path: string) => boolean {
  const segments = parseSegments(pattern)
  return (path) => {
    const values = path.split("/").map((segment) => Array.from(segment))
    // reachable[j]: the pattern prefix processed so far can consume exactly
    // the first j path segments.
    let reachable = new Array<boolean>(values.length + 1).fill(false)
    reachable[0] = true
    for (const segment of segments) {
      const next = new Array<boolean>(values.length + 1).fill(false)
      if (segment.kind === "globstar") {
        let seen = false
        for (let j = 0; j <= values.length; j += 1) {
          seen ||= reachable[j]!
          next[j] = seen
        }
      } else {
        for (let j = 0; j < values.length; j += 1) {
          if (reachable[j] && matchSegment(segment.chars, values[j]!)) {
            next[j + 1] = true
          }
        }
      }
      reachable = next
    }
    return reachable[values.length]!
  }
}
