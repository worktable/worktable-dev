import { resolveDocLinkTarget } from "@worktable/types"

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

/**
 * Project an authored doc link to its browser destination without changing the
 * authored value. External URLs and fragment-only links pass through intact.
 */
export function renderDocLinkHref(
  spaceId: string,
  fromDocPath: string,
  authoredHref: string
): string {
  const resolved = resolveDocLinkTarget(fromDocPath, authoredHref)
  if (!resolved) return authoredHref

  return `/spaces/${encodeURIComponent(spaceId)}/documents/${encodePath(resolved.docPath)}${resolved.suffix}`
}
