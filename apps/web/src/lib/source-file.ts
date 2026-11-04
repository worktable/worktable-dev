// The Space file a shown image loads, read back from its URL. Only the
// image viewer needs this, so it stays out of the module every Doc loads;
// the URL it reads is the one fileSourceUrl in file-embeds.ts writes.

import { BASE_URL } from "./http"

/** A Space's file, as a URL from fileSourceUrl names it. */
export interface SourceFile {
  spaceId: string
  path: string
  version: string | null
  at?: string
}

/**
 * The Space file a fileSourceUrl URL loads, or null for any other URL, such
 * as an image a Doc embeds from the web.
 */
export function sourceFileOf(url: string): SourceFile | null {
  const page = globalThis.location?.href ?? "http://localhost/"
  let source: URL
  let spaces: URL
  try {
    source = new URL(url, page)
    spaces = new URL(`${BASE_URL}/api/spaces/`, page)
  } catch {
    return null
  }
  if (
    source.origin !== spaces.origin ||
    !source.pathname.startsWith(spaces.pathname)
  )
    return null
  const spaceId = /^([^/]+)\/documents\/file$/.exec(
    source.pathname.slice(spaces.pathname.length)
  )?.[1]
  const path = source.searchParams.get("path")
  if (!spaceId || !path) return null
  const at = source.searchParams.get("at")
  try {
    return {
      spaceId: decodeURIComponent(spaceId),
      path,
      version: source.searchParams.get("v"),
      ...(at ? { at } : {}),
    }
  } catch {
    // A Doc can embed any URL, including one that isn't validly encoded.
    return null
  }
}
