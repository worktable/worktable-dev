import { Hono } from "hono"
import { gatewayAdmits, isHosted } from "../hosted.ts"
import { invitationPreview } from "../team-invitations.ts"
import { TeamAccessError } from "../team-policy.ts"
import { ensureWorkspaceManifest } from "../workspace.ts"
import { admitWorkspaceRequest } from "../workspace-request-lifecycle.ts"

/** The invitation id the Cloud gateway took from the person's link. */
export const INVITATION_HEADER = "x-worktable-invitation"

/**
 * Before sign-in, the Cloud gateway names the Worktable and the inviter on
 * the page an invitation link opens. The invitation id is the capability;
 * anyone without it learns nothing.
 */
export const publicInvitationsRouter = new Hono()

publicInvitationsRouter.get("/", (c) => {
  c.header("Cache-Control", "no-store")
  const invitationId = c.req.header(INVITATION_HEADER) ?? ""
  if (
    !isHosted() ||
    !gatewayAdmits(c.req.raw) ||
    !invitationId ||
    invitationId.length > 200
  )
    return c.body(null, 404)
  const release = admitWorkspaceRequest("read")
  if (!release) return c.body(null, 503)
  try {
    const preview = invitationPreview(invitationId)
    if (preview instanceof TeamAccessError)
      return c.json({ error: preview.message, code: preview.code }, 404)
    return c.json({
      worktableName: ensureWorkspaceManifest().name,
      ...preview,
    })
  } finally {
    release()
  }
})
