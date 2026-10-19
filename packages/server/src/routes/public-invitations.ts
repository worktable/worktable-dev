import { Hono } from "hono"
import { INVITATION_HEADER } from "@worktable/hosted-contract"
import { gatewayAdmits, isHosted } from "../hosted.ts"
import {
  assertRoomToJoin,
  PlanFullError,
  requestBilling,
} from "../hosted-billing.ts"
import { invitationPreview } from "../team-invitations.ts"
import { TeamAccessError } from "../team-policy.ts"
import { ensureWorkspaceManifest } from "../workspace.ts"
import { admitWorkspaceRequest } from "../workspace-request-lifecycle.ts"

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
    const worktableName = ensureWorkspaceManifest().name
    // Joining checks the same room, so a full plan says so before sign-up.
    try {
      assertRoomToJoin(requestBilling(c.req.raw))
    } catch (error) {
      if (!(error instanceof PlanFullError)) throw error
      const { inviterName } = preview
      return c.json(
        {
          error: error.message,
          code: error.code,
          worktableName,
          ...(inviterName ? { inviterName } : {}),
        },
        409
      )
    }
    return c.json({ worktableName, ...preview })
  } finally {
    release()
  }
})
