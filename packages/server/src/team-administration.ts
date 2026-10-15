import type { TeamRole } from "@worktable/types"
import type { TokenIdentity } from "./token-store.ts"
import { cloudTeamSessionHeaders, getTeamAuth } from "./team-auth.ts"
import { currentTeamWorktable, teamDatabasePath } from "./team-database.ts"
import { findTeamMemberById, listTeamMembers } from "./team-members.ts"
import {
  requireTeamHuman,
  requireTeamOwner,
  TeamAccessError,
} from "./team-policy.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { isHosted } from "./hosted.ts"

export async function teamAdministrativeContext(
  origin: string,
  request: Request,
  identity: TokenIdentity
) {
  const member = requireTeamHuman(identity)
  const auth = await getTeamAuth(origin)
  const headers = isHosted()
    ? await cloudTeamSessionHeaders(auth, member.userId)
    : request.headers
  return { auth, headers, member, worktable: currentTeamWorktable()! }
}

/** Serialize ownership changes across processes, and recheck authority after waiting. */
export async function changeTeamMembership(
  origin: string,
  request: Request,
  identity: TokenIdentity,
  memberId: string,
  role: TeamRole | null
): Promise<void> {
  return withCrossProcessLock(
    `${teamDatabasePath()}.members.lock`,
    { label: "Team membership" },
    async () => {
      requireTeamOwner(identity)
      const member = findTeamMemberById(memberId)
      if (!member)
        throw new TeamAccessError("This person is no longer a member")
      if (
        member.role === "owner" &&
        role !== "owner" &&
        listTeamMembers().filter((item) => item.role === "owner").length === 1
      ) {
        throw new TeamAccessError("The Worktable must keep at least one owner")
      }
      const { auth, headers, worktable } = await teamAdministrativeContext(
        origin,
        request,
        identity
      )
      if (role === null)
        await auth.api.removeMember({
          headers,
          body: {
            organizationId: worktable.organizationId,
            memberIdOrEmail: memberId,
          },
        })
      else
        await auth.api.updateMemberRole({
          headers,
          body: { organizationId: worktable.organizationId, memberId, role },
        })
    }
  )
}
