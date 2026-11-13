import type { LinkGrant, ShareLinkAccess, ShareTarget } from "@worktable/types"
import { fetchJSON, HttpError } from "./http.ts"

/** How long to wait before asking again after the tool or sharing changed. */
export const PREVIEW_CHANGED_RETRY_MS = 1_000

/**
 * The server refuses a check or a save of live data when the tool, its
 * collections or sharing changed while it ran, as right after an agent made
 * or edited the tool. Asking again a moment later usually succeeds.
 */
export function previewChanged(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 503 &&
    (error.body as { code?: unknown } | null)?.code === "LINK_PREVIEW_CHANGED"
  )
}

/**
 * Why the server refused a link change, as it said it, so the dialog can
 * show it instead of asking to try again. Null when the request didn't reach
 * a refusal (offline, or the server failed).
 */
export function refusalReason(error: unknown): string | null {
  if (
    !(error instanceof HttpError) ||
    error.status < 400 ||
    error.status >= 500
  )
    return null
  const body = error.body as { error?: unknown; issues?: unknown } | null
  const messages = Array.isArray(body?.issues)
    ? body.issues.flatMap((issue: { message?: unknown } | null) =>
        typeof issue?.message === "string" ? [issue.message] : []
      )
    : []
  if (messages.length > 0) return messages.join(" ")
  return typeof body?.error === "string" && body.error ? body.error : null
}

/** Runs `request`, and once more after a pause if the tool had just changed. */
export async function retryOnPreviewChange<T>(
  request: () => Promise<T>
): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (!previewChanged(error)) throw error
    await new Promise((resolve) =>
      setTimeout(resolve, PREVIEW_CHANGED_RETRY_MS)
    )
    return request()
  }
}

/**
 * What a live link opens, with counts; an explicit check creates no link.
 * Callers wrap it, with any save that follows, in `retryOnPreviewChange`.
 */
export function checkShareLinkAccess(
  target: ShareTarget,
  options: { grant?: LinkGrant; observe: boolean; linkId?: string }
): Promise<ShareLinkAccess> {
  return fetchJSON<ShareLinkAccess>("/api/shares/links/access", {
    method: "POST",
    body: JSON.stringify({ target, ...options }),
  })
}
