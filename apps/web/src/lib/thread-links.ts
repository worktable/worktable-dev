function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function sameSpaceDocRoute(spaceId: string, url: URL): string | null {
  const match = url.pathname.match(
    /^\/spaces\/([^/]+)\/(?:documents|docs|widgets)\/(.+)$/
  )
  if (!match || decodeSegment(match[1]!) !== spaceId) return null
  return `/spaces/${match[1]!}/documents/${match[2]!}${url.search}${url.hash}`
}

/**
 * Project portable and agent-local Worktable Doc links onto this browser's
 * origin. External links remain external and react-markdown applies its own
 * protocol allowlist before rendering them.
 */
export function renderThreadLinkHref(
  locationInput: ThreadLocation | string,
  authoredHref: string,
  worktableOrigins: readonly string[] = []
): string | null {
  const location =
    typeof locationInput === "string"
      ? ({ kind: "space", spaceId: locationInput } as const)
      : locationInput
  const href = authoredHref.trim()
  if (!href || href.startsWith("#")) return authoredHref
  if (href.startsWith("//")) return authoredHref

  if (location.kind === "worktable") {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return authoredHref
    if (
      href.startsWith("/spaces/") ||
      href.startsWith("/threads/") ||
      href.startsWith("/settings") ||
      href.startsWith("/api/")
    ) {
      return authoredHref
    }
    // Worktable threads have no Space or document base. Letting a relative
    // path through would make the browser resolve it against /threads/ and
    // accidentally navigate to a bogus thread route.
    return null
  }

  const { spaceId } = location

  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href)
      const knownOrigins = new Set(
        worktableOrigins.flatMap((origin) => {
          try {
            return [new URL(origin).origin]
          } catch {
            return []
          }
        })
      )
      if (!knownOrigins.has(url.origin)) return authoredHref
      return sameSpaceDocRoute(spaceId, url) ?? authoredHref
    } catch {
      return authoredHref
    }
  }

  if (!href.startsWith("/")) return authoredHref
  if (
    href.startsWith("/spaces/") ||
    href.startsWith("/threads/") ||
    href.startsWith("/settings") ||
    href.startsWith("/api/")
  ) {
    return authoredHref
  }

  const [pathAndQuery, hash = ""] = href.split("#", 2)
  const [path, query = ""] = pathAndQuery!.split("?", 2)
  const encodedPath = path!
    .slice(1)
    .split("/")
    .map((segment) => encodeURIComponent(decodeSegment(segment) ?? segment))
    .join("/")
  return `/spaces/${encodeURIComponent(spaceId)}/documents/${encodedPath}${
    query ? `?${query}` : ""
  }${hash ? `#${hash}` : ""}`
}
import type { ThreadLocation } from "@worktable/types"
