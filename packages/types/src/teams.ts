export type TeamRole = "owner" | "member"
export type SpaceVisibility = "shared" | "restricted"
export type SpaceAccessLevel = "read" | "edit" | "manage"
/** Team-agent access to threads that belong to the Worktable, not a Space. */
export type WorktableThreadAccess = "none" | "read" | "edit"

export interface TeamMember {
  id: string
  userId: string
  actorId: string
  name: string
  email: string
  role: TeamRole
}

export interface SpaceAccessGrant {
  subjectType: "member" | "agent"
  subjectId: string
  access: SpaceAccessLevel
}

export interface SpaceAccessPolicy {
  spaceId: string
  visibility: SpaceVisibility
  grants: SpaceAccessGrant[]
}

export interface TeamAgent {
  id: string
  actorId: string
  name: string
  platform: string
  ownership: "personal" | "team"
  memberId: string | null
  /** null follows the member; a list narrows personal-agent access. */
  spaceIds: string[] | null
  mode: "on-demand" | "always-on"
  active: boolean
  scopeCeiling: string[] | null
  icon: string | null
  /** Team agents only; personal agents follow their member unless narrowed. */
  worktableThreads: WorktableThreadAccess
}

export interface TeamStatus {
  enabled: boolean
  worktableId: string
  member: TeamMember | null
  operator: boolean
  policyRevision: number
}
