export interface ExternalLinkProps {
  target?: "_blank"
  rel?: "noopener noreferrer"
}

const NEW_TAB_PROPS = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const

const LOOPBACK_HOST_ALIASES = ["localhost", "127.0.0.1"] as const

function addWorktableOrigin(origins: Set<string>, candidate: URL): void {
  origins.add(candidate.origin)

  if (
    !LOOPBACK_HOST_ALIASES.some((hostname) => hostname === candidate.hostname)
  ) {
    return
  }

  for (const hostname of LOOPBACK_HOST_ALIASES) {
    const alias = new URL(candidate.href)
    alias.hostname = hostname
    origins.add(alias.origin)
  }
}

/** Normalize every browser origin that belongs to this Worktable instance. */
export function worktableLinkOrigins(
  pageOrigin: string,
  configuredBaseUrl = ""
): string[] {
  const origins = new Set<string>()

  for (const candidate of [pageOrigin, configuredBaseUrl]) {
    if (!candidate) continue
    try {
      addWorktableOrigin(origins, new URL(candidate, pageOrigin))
    } catch {
      // A malformed configured API URL must not make same-origin links external.
    }
  }

  return [...origins]
}

/**
 * Open off-origin web destinations in a separate tab. Worktable destinations
 * and non-web schemes retain normal browser behavior.
 */
export function externalLinkProps(
  href: string,
  worktableOrigins: readonly string[]
): ExternalLinkProps {
  const baseOrigin = worktableOrigins[0]
  if (!baseOrigin) return {}

  try {
    const url = new URL(href, baseOrigin)
    if (url.protocol !== "http:" && url.protocol !== "https:") return {}
    return worktableOrigins.includes(url.origin) ? {} : NEW_TAB_PROPS
  } catch {
    return {}
  }
}
