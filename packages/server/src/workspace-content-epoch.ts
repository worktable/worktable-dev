import type { MiddlewareHandler } from "hono"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { isHosted } from "./hosted.ts"

export function isWorkspaceContentMutation(
  method: string,
  pathname: string
): boolean {
  return (
    !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
    ["/api/spaces", "/api/threads", "/api/shares"].some(
      (root) => pathname === root || pathname.startsWith(`${root}/`)
    )
  )
}

/** Fence old browser bodies across a clear/import; never transparently replay them. */
export const requireWorkspaceContentEpoch: MiddlewareHandler = async (
  c,
  next
) => {
  // Hosted clear remains disabled until its gateway forwards this fence.
  if (
    isHosted() ||
    !isWorkspaceContentMutation(c.req.method, new URL(c.req.url).pathname)
  )
    return next()
  const browser =
    Boolean(c.req.header("Sec-Fetch-Site") || c.req.header("Origin")) &&
    !c.req.header("Authorization")
  const supplied = c.req.header("X-Worktable-Content-Epoch")
  if (
    (browser || supplied) &&
    supplied !== (await getWorkspaceCollaborationEpoch())
  ) {
    return c.json(
      {
        code: "WORKSPACE_CHANGED",
        error:
          "This workspace changed. Reload before editing; the previous edit was not applied.",
      },
      409
    )
  }
  return next()
}
