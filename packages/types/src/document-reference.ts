/**
 * Portable identity for a classic Worktable document.
 *
 * Record YAML stores the decoded, extensionless path without a leading slash
 * (for example `specs/doc-urls-for-agents`). Origins and application routes
 * are deliberately not part of the value. This module is browser-safe so all
 * write surfaces can share the same grammar before the server enforces it.
 */
export type DocumentReferenceParseResult =
  | { path: string; error?: never }
  | { path?: never; error: string }

export type DocumentReferenceState = "available" | "archived" | "missing" | "invalid"

export interface ResolvedDocumentReference {
  storedPath: string
  resolvedPath: string | null
  title: string
  state: DocumentReferenceState
  /** Human-readable reason when state is invalid or alias resolution failed. */
  error?: string
}

const URI_SCHEME = /^[a-z][a-z\d+.-]*:/iu

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function parseDocumentReference(input: unknown): DocumentReferenceParseResult {
  if (typeof input !== "string") return { error: "must be a document path string" }
  if (!input) return { error: "must not be empty" }
  if (hasControlCharacter(input)) return { error: "must not contain control characters" }
  if (input.includes("\\")) return { error: "must use forward slashes" }
  if (URI_SCHEME.test(input) || input.startsWith("//")) return { error: "must not include an origin" }
  if (input.includes("?") || input.includes("#")) return { error: "must not include a query or fragment" }
  if (input.startsWith("/spaces/") || input === "/spaces") return { error: "must be a document path, not an application route" }

  let decoded: string
  try {
    decoded = decodeURIComponent(input)
  } catch {
    return { error: "contains malformed percent encoding" }
  }
  if (hasControlCharacter(decoded)) return { error: "must not contain control characters" }
  if (decoded.includes("\\")) return { error: "must use forward slashes" }
  if (URI_SCHEME.test(decoded) || decoded.startsWith("//")) return { error: "must not include an origin" }
  if (decoded.includes("?") || decoded.includes("#")) return { error: "must not include a query or fragment" }
  if (decoded.startsWith("/spaces/") || decoded === "/spaces") return { error: "must be a document path, not an application route" }

  let path = decoded.startsWith("/") ? decoded.slice(1) : decoded
  if (/\.(?:md|json)$/iu.test(path)) path = path.replace(/\.(?:md|json)$/iu, "")
  path = path.normalize("NFC")

  if (!path) return { error: "must not be empty" }
  // The current doc store removes every `..` substring during path
  // sanitization, so accepting one here would make the stored identity point
  // at a different file on read. Keep portable references invariant instead.
  if (path.includes("..")) return { error: "must not contain consecutive dots" }
  const segments = path.split("/")
  if (segments.some((segment) => !segment)) return { error: "must not contain empty path segments" }
  if (segments.some((segment) => segment === "." || segment === "..")) return { error: "must not contain dot path segments" }

  return { path }
}

export function isCanonicalDocumentReference(input: unknown): input is string {
  const parsed = parseDocumentReference(input)
  return "path" in parsed && parsed.path === input
}

export function encodeDocumentReferencePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/")
}

export function documentReferenceHref(spaceId: string, path: string): string {
  return `/spaces/${encodeURIComponent(spaceId)}/documents/${encodeDocumentReferencePath(path)}`
}

export function documentReferenceFallbackTitle(path: string): string {
  const slug = path.split("/").at(-1) || path
  return slug.replace(/[-_]+/g, " ").replace(/(^|\s)\p{L}/gu, (match) => match.toUpperCase())
}
