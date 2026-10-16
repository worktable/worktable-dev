import type {
  SpaceAccessPolicy,
  TeamAgent,
  TeamMember,
  TeamStatus,
} from "@worktable/types"
import { fetchJSON } from "./http"
export const getTeamStatus = () => fetchJSON<TeamStatus>("/api/team")
export const getTeamMembers = () =>
  fetchJSON<{ members: TeamMember[] }>("/api/team/members").then(
    (result) => result.members
  )
export const getTeamAgents = () =>
  fetchJSON<{ agents: TeamAgent[] }>("/api/team/agents").then(
    (result) => result.agents
  )
export const getSpaceAccess = (id: string) =>
  fetchJSON<SpaceAccessPolicy>(`/api/team/spaces/${encodeURIComponent(id)}`)
export const setSpaceAccess = (policy: SpaceAccessPolicy) =>
  fetchJSON<SpaceAccessPolicy>(
    `/api/team/spaces/${encodeURIComponent(policy.spaceId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        visibility: policy.visibility,
        grants: policy.grants,
      }),
    }
  )
export const activateTeams = (owner: {
  name: string
  email: string
  password: string
}) =>
  fetchJSON("/api/team/activate", {
    method: "POST",
    body: JSON.stringify(owner),
  })
export const inviteTeamMember = (email: string) =>
  fetchJSON<{ url: string }>("/api/team/invitations", {
    method: "POST",
    body: JSON.stringify({ email }),
  })
export const changeMemberRole = (id: string, role: TeamMember["role"]) =>
  fetchJSON(`/api/team/members/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  })
export const removeTeamMember = (id: string) =>
  fetchJSON(`/api/team/members/${encodeURIComponent(id)}`, { method: "DELETE" })
export interface TeamInvitation {
  id: string
  email: string
  status: string
}
export const getTeamInvitations = () =>
  fetchJSON<{ invitations: TeamInvitation[] }>("/api/team/invitations").then(
    (result) => result.invitations
  )
export const cancelTeamInvitation = (id: string) =>
  fetchJSON(`/api/team/invitations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })

export const registerTeamAgent = (name: string) =>
  fetchJSON<{ agent: TeamAgent }>("/api/team/agents", {
    method: "POST",
    body: JSON.stringify({ name, platform: "other", ownership: "team" }),
  })
export const setTeamAgentWorktableThreads = (
  id: string,
  worktableThreads: TeamAgent["worktableThreads"]
) =>
  fetchJSON<{ agent: TeamAgent }>(`/api/team/agents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ worktableThreads }),
  })
export interface PasswordResetLink {
  url: string
  expiresAt: string
}
export const issueMemberPasswordReset = (id: string) =>
  fetchJSON<PasswordResetLink>(
    `/api/team/members/${encodeURIComponent(id)}/password-reset`,
    { method: "POST" }
  )
export const issueInvitationPasswordReset = (id: string) =>
  fetchJSON<PasswordResetLink>(
    `/api/team/invitations/${encodeURIComponent(id)}/password-reset`,
    { method: "POST" }
  )
export const setMemberOperator = (id: string, operator: boolean) =>
  fetchJSON(`/api/team/members/${encodeURIComponent(id)}/operator`, {
    method: "PUT",
    body: JSON.stringify({ operator }),
  })
