import type { TeamMember } from "@worktable/types"
import type { TokenIdentity } from "./token-store.ts"
import {
  currentTeamWorktable,
  requireTeamDatabase,
  TeamStateError,
} from "./team-database.ts"
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
  const worktable = currentTeamWorktable()
  if (!worktable) throw new TeamStateError()
  const binding = requireTeamDatabase()
    .query<
      { participant_key: string },
      [string, string]
    >("SELECT participant_key FROM wt_actors WHERE worktable_id = ? AND id = ?")
    .get(worktable.id, member.actorId)
  if (!binding) throw new TeamStateError()
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
      participantKey: binding.participant_key,
    },
    team: {
      worktableId: worktable.id,
      userId: member.userId,
      memberId: member.id,
    },
  }
}
