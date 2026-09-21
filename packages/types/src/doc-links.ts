const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

export interface ResolvedDocLinkTarget {
  /** Canonical extensionless path relative to the space's docs root. */
  docPath: string
  /** Authored query and/or fragment, retained for the rendered destination. */
  suffix: string
}

function isExternalTarget(target: string): boolean {
  return (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    SCHEME_RE.test(target)
  )
}

/**
 * Resolve an authored doc link against the linking document's location.
 *
 * This is deliberately lexical: it does not touch storage or check whether the
 * target exists. Excess `..` segments clamp at the docs root, matching the
 * server's document-path sanitization contract.
 */
export function resolveDocLinkTarget(
  fromDocPath: string,
  rawTarget: string
): ResolvedDocLinkTarget | null {
  let target = rawTarget.trim()
  if (isExternalTarget(target)) return null

  const suffixIndex = target.search(/[#?]/)
  const suffix = suffixIndex === -1 ? "" : target.slice(suffixIndex)
  if (suffixIndex !== -1) target = target.slice(0, suffixIndex)
  if (target === "") return null

  try {
    target = decodeURIComponent(target)
  } catch {
    // Malformed percent-encoding remains a literal path, as authored.
  }

  target = target.replace(/\.(md|json)$/i, "")

  const absolute = target.startsWith("/")
  const baseSegments = absolute
    ? []
    : fromDocPath.split("/").slice(0, -1).filter(Boolean)

  const segments = [...baseSegments]
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  if (segments.length === 0) return null
  return { docPath: segments.join("/"), suffix }
}

/** Resolve only the canonical doc path, for graph/index consumers. */
export function resolveDocLink(
  fromDocPath: string,
  rawTarget: string
): string | null {
  return resolveDocLinkTarget(fromDocPath, rawTarget)?.docPath ?? null
}
