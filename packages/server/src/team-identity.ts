import type { TeamMember } from "@worktable/types"
import type { TokenIdentity } from "./token-store.ts"
import { accessSnapshot } from "./team-access.ts"
import { TeamStateError } from "./team-database.ts"
import { getWorkspaceRoot } from "./workspace.ts"

export const TEAM_HUMAN_SCOPES = [
  "documents:*",
  "docs:*",
  "widgets:*",
  "records:*",
  "annotations:*",
  "threads:*",
  "search:read",
  "workspace:export",
  "tokens:manage",
]

export function identityForTeamMember(
  member: TeamMember,
  credentialClass: "local" | "browser" = "local"
): TokenIdentity {
  const current = accessSnapshot()
  const participantKey = current?.participantKeys.get(member.id)
  if (!current || !participantKey) throw new TeamStateError()
  const worktable = current.worktable
  return {
    user: member.userId,
    workspace: getWorkspaceRoot(),
    credentialClass,
    scopes: [...TEAM_HUMAN_SCOPES],
    agent: null,
    principal: {
      id: member.actorId,
      type: "human",
      displayName: member.name,
      participantKey,
    },
    team: {
      worktableId: worktable.id,
      userId: member.userId,
      memberId: member.id,
    },
  }
}
