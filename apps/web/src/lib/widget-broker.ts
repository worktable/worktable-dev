/**
 * Validate + normalize a widget-brokered Worktable API path.
 *
 * Widgets render in a sandboxed (opaque-origin) iframe and cannot fetch /api
 * directly when the install is exposed (the credentialed request sends
 * `Origin: null` and is blocked by the same-origin CORS policy, and a SameSite
 * cookie won't attach). Instead the widget asks the PARENT (same-origin,
 * authenticated) to make the call. To keep that safe, the parent will only proxy
 * the widget's OWN endpoints — `/api/spaces/<spaceId>/widgets/<widgetId>/...` —
 * never arbitrary `/api` paths (e.g. `/api/tokens`) or other spaces/widgets.
 *
 * Returns the same-origin `pathname + search` to fetch, or `null` if the request
 * must be rejected. URL parsing normalizes `..` traversal and blocks cross-origin
 * targets.
 */
import { htmlDocumentApiPath } from "./html-document-api-path.ts"
export function resolveWidgetApiTarget(
  rawPath: string,
  spaceId: string,
  widgetId: string,
  origin: string
): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null
  let url: URL
  try {
    url = new URL(rawPath, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  // Only the permission-checked runtime surfaces — `/state` and `/records/...` —
  // may be brokered. Other routes under the widget prefix (archive, restore,
  // content, the widget resource itself) are OWNER-authenticated and skip widget
  // permission checks; a sandboxed widget must NOT reach them through the parent.
  //
  // Widget ids are slash-joined segments, so these prefix checks stay sound only
  // because the server forbids reserved names (records, state, content, archive,
  // restore) inside NESTED ids: no sibling widget's path can ever sit inside
  // `<base>records/` or collide with `<base>state`. (A flat id may be a reserved
  // word — legacy compat — but a flat widget has no nested siblings, so the
  // prefix checks remain unambiguous.)
  const base = `${htmlDocumentApiPath(spaceId, widgetId)}/`
  const isState = url.pathname === `${base}state`
  const isRecords = url.pathname.startsWith(`${base}records/`)
  if (!isState && !isRecords) return null
  return url.pathname + url.search
}
