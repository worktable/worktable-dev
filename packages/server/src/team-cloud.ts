import { initialSpaceVisibility } from "./getting-started.ts"
import {
  beginTeamInitialization,
  finishTeamInitialization,
  recoverTeamInitialization,
  getInitialTeamOrganization,
} from "./team-initialization.ts"
import { randomUUID } from "node:crypto"
import { APIError } from "better-auth/api"
import {
  admitWorkspaceRequest,
  waitForWorkspaceAdmission,
  WRITE_ADMISSION_WAIT_MS,
} from "./workspace-request-lifecycle.ts"
import { ENV } from "@worktable/hosted-contract"
import type { TokenIdentity } from "./token-store.ts"
import {
  bindVerifiedCloudIdentity,
  cloudTeamSessionHeaders,
  getTeamAuth,
} from "./team-auth.ts"
import {
  currentTeamWorktable,
  currentWorktableId,
  openTeamDatabase,
  requireTeamDatabase,
  teamDatabasePath,
  writeTeamMarker,
} from "./team-database.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { noteAgentPairedForSetup, setupKeyForIdentity } from "./personal-setup.ts"
import {
  ensureWorkspaceManifest,
  workspaceCacheKey,
  getWorkspaceRoot,
  writeWorkspaceManifest,
} from "./workspace.ts"
import { findTeamMember } from "./team-members.ts"
import {
  invitationLandingSpace,
  maskEmail,
  unavailableInvitation,
} from "./team-invitations.ts"
import { accessSnapshot } from "./team-access.ts"
import { identityForTeamMember } from "./team-identity.ts"
import { listSpaces } from "./store.ts"
import { isHosted } from "./hosted.ts"
import {
  bindTeamAgentCredential,
  createTeamAgent,
  updateTeamAgent,
  resolveTeamAgentCredential,
  TeamAccessError,
} from "./team-policy.ts"

let initializationHookForTests: (() => void) | null = null
export function setCloudTeamInitializationHookForTests(
  hook: (() => void) | null
): void {
  initializationHookForTests = hook
}

/**
 * `enrollment` admits a verified non-member. `"deferred"` admits one without
 * binding their identity yet, for the acceptance route, which binds only
 * after the invitation is checked.
 */
export async function resolveVerifiedCloudMember(
  origin: string,
  proof: NonNullable<TokenIdentity["cloudIdentity"]>,
  enrollment: boolean | "deferred" = false,
  initialWorktableName?: string
): Promise<TokenIdentity | null> {
  if (!isHosted()) return null
  recoverTeamInitialization()
  if (!currentTeamWorktable()) {
    const release =
      admitWorkspaceRequest() ??
      ((await waitForWorkspaceAdmission("write", WRITE_ADMISSION_WAIT_MS))
        ? admitWorkspaceRequest()
        : null)
    if (!release)
      throw new APIError("SERVICE_UNAVAILABLE", {
        code: "WORKTABLE_BUSY",
        message: "Team setup is paused for a backup. Try again shortly.",
      })
    try {
      await withCrossProcessLock(
        `${teamDatabasePath()}.activation.lock`,
        { label: "Cloud Worktable" },
        async () => {
          openTeamDatabase(true)
          if (currentTeamWorktable()) return
          if (proof.subject !== process.env[ENV.OWNER_SUBJECT])
            throw new TeamAccessError(
              "The initial owner must open this Worktable first"
            )
          if (initialWorktableName)
            writeWorkspaceManifest({
              ...ensureWorkspaceManifest(),
              name: initialWorktableName,
            })
          const worktableId = currentWorktableId()
          const userId = await bindVerifiedCloudIdentity(origin, proof)
          beginTeamInitialization("cloud", userId)
          const { organizationId, ownerMemberId } =
            await getInitialTeamOrganization(origin, userId)
          const db = requireTeamDatabase()
          const spaces = await listSpaces()
          const actorId = `human:${randomUUID()}`
          try {
            db.transaction(() => {
              db.query(
                "INSERT INTO wt_worktables(id, organization_id, root_key) VALUES (?, ?, ?)"
              ).run(worktableId, organizationId, workspaceCacheKey())
              db.query(
                "INSERT INTO wt_actors(id, worktable_id, user_id, name, participant_key) VALUES (?, ?, ?, ?, ?)"
              ).run(
                actorId,
                worktableId,
                userId,
                proof.name,
                `principal:${actorId}`
              )
              db.query(
                "INSERT INTO wt_enrollments(id, worktable_id, user_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?)"
              ).run(ownerMemberId, worktableId, userId, actorId, Date.now())
              for (const space of spaces)
                db.query(
                  "INSERT INTO wt_space_policy(worktable_id, space_id, visibility) VALUES (?, ?, ?)"
                ).run(worktableId, space.id, initialSpaceVisibility(space))
              writeTeamMarker(worktableId)
              initializationHookForTests?.()
            })()
            finishTeamInitialization()
          } catch (error) {
            recoverTeamInitialization()
            throw error
          }
        }
      )
    } finally {
      release()
    }
  }
  const known = accessSnapshot()?.bindings.get(
    `${proof.issuer}\0${proof.subject}`
  )
  let binding: { user_id: string } | null = known
    ? { user_id: known.userId }
    : null
  // Most requests carry an unchanged identity: read it without the lock.
  const unchanged =
    known !== undefined &&
    known.email?.toLowerCase() === proof.email.toLowerCase() &&
    (!proof.companyId || proof.companyId === known.companyId)
  if (enrollment === "deferred" && !binding)
    return {
      user: `pending:${proof.subject}`,
      workspace: getWorkspaceRoot(),
      credentialClass: "browser",
      scopes: [],
      agent: null,
      principal: {
        id: `workos:${proof.subject}`,
        type: "human",
        displayName: proof.name,
      },
      cloudIdentity: proof,
    }
  if (enrollment === true || (binding && !unchanged)) {
    const release =
      admitWorkspaceRequest() ??
      ((await waitForWorkspaceAdmission("write", WRITE_ADMISSION_WAIT_MS))
        ? admitWorkspaceRequest()
        : null)
    if (!release)
      throw new APIError("SERVICE_UNAVAILABLE", {
        code: "WORKTABLE_BUSY",
        message: "Team sign-in is paused for a backup. Try again shortly.",
      })
    try {
      binding = { user_id: await bindVerifiedCloudIdentity(origin, proof) }
    } finally {
      release()
    }
  }
  if (!binding)
    throw new TeamAccessError(
      "You are not a member of this Worktable",
      "MEMBERSHIP_REQUIRED"
    )
  const member = findTeamMember(binding.user_id)
  if (member) return { ...identityForTeamMember(member), cloudIdentity: proof }
  if (!enrollment)
    throw new TeamAccessError(
      "You are no longer a member of this Worktable",
      "MEMBERSHIP_REQUIRED"
    )
  return {
    user: binding.user_id,
    workspace: getWorkspaceRoot(),
    credentialClass: "browser",
    scopes: [],
    agent: null,
    principal: {
      id: `workos:${proof.subject}`,
      type: "human",
      displayName: proof.name,
    },
    cloudIdentity: proof,
  }
}

/**
 * Only the invitation acceptance route admits an identified non-member. A
 * Cloud invitation is emailed to one address and only that verified address
 * can accept it; a forwarded link does not make someone else a member.
 */
export async function acceptCloudTeamInvitation(
  origin: string,
  proof: NonNullable<TokenIdentity["cloudIdentity"]>,
  invitationId: string
): Promise<{ spaceId?: string }> {
  return withCrossProcessLock(
    `${teamDatabasePath()}.members.lock`,
    { label: "Team invitation" },
    async () => {
      // Refuse an unusable invitation or a different address before this
      // identity is bound, so a wrong-account attempt leaves nothing behind.
      const db = requireTeamDatabase()
      const invitation = db
        .query<
          {
            email: string
            status: string
            expiresAt: number | string
            organizationId: string
          },
          [string]
        >(
          "SELECT email, status, expiresAt, organizationId FROM invitation WHERE id = ?"
        )
        .get(invitationId)
      const unavailable = unavailableInvitation(
        invitation &&
          invitation.organizationId === currentTeamWorktable()!.organizationId
          ? invitation
          : null
      )
      if (unavailable) throw unavailable
      if (invitation!.email.toLowerCase() !== proof.email.toLowerCase())
        throw new TeamAccessError(
          `This invitation is for ${maskEmail(invitation!.email)}. Sign in with that address to join.`,
          "INVITATION_EMAIL_MISMATCH"
        )
      const identity = await resolveVerifiedCloudMember(origin, proof, true)
      if (!identity) throw new TeamAccessError()
      const userId = identity.team?.userId ?? identity.user
      const auth = await getTeamAuth(origin)
      const headers = await cloudTeamSessionHeaders(auth, userId)
      db.query(
        "INSERT OR IGNORE INTO wt_invitation_recipients(worktable_id, invitation_id, invited_email, recipient_user_id) VALUES (?, ?, ?, ?)"
      ).run(currentTeamWorktable()!.id, invitationId, invitation!.email, userId)
      await auth.api.acceptInvitation({ headers, body: { invitationId } })
      db.query(
        "UPDATE wt_invitation_recipients SET recipient_user_id = ?, accepted_at = ? WHERE worktable_id = ? AND invitation_id = ?"
      ).run(userId, Date.now(), currentTeamWorktable()!.id, invitationId)
      const spaceId = invitationLandingSpace(invitationId, userId)
      return spaceId ? { spaceId } : {}
    }
  )
}

export function cloudTeamMemberForSubject(issuer: string, subject: string) {
  const binding = accessSnapshot()?.bindings.get(`${issuer}\0${subject}`)
  return binding ? findTeamMember(binding.userId) : null
}

/** Called only after resource-token signature, issuer and exact audience verification. */
export async function resolveCloudTeamAgentCredential(
  identity: TokenIdentity,
  issuer = process.env[ENV.AUTH_SERVER_URL]?.trim()
): Promise<TokenIdentity | null> {
  const existing = resolveTeamAgentCredential(identity)
  if (
    existing ||
    !currentTeamWorktable() ||
    identity.principal.type !== "agent"
  )
    return existing
  const authorizedBy = identity.principal.authorizedBy
  if (!issuer || !authorizedBy?.startsWith("workos:")) return null
  const member = cloudTeamMemberForSubject(
    issuer,
    authorizedBy.slice("workos:".length)
  )
  if (!member) return null
  return withCrossProcessLock(
    `${teamDatabasePath()}.agents.lock`,
    { label: "Cloud agent connection" },
    async () => {
      const current = resolveTeamAgentCredential(identity)
      if (current) return current
      if (
        requireTeamDatabase()
          .query(
            "SELECT credential_key FROM wt_agent_credentials WHERE credential_key = ?"
          )
          .get(identity.principal.id)
      )
        return null
      const sponsor = identityForTeamMember(member)
      const agent = createTeamAgent(
        {
          name: identity.principal.displayName,
          platform: identity.agent ?? "agent",
          ownership: "personal",
        },
        sponsor
      )
      updateTeamAgent(agent.id, { scopeCeiling: identity.scopes }, sponsor)
      bindTeamAgentCredential(agent.id, identity.principal.id, sponsor, true)
      // An agent that signed in is connected, before it does anything else.
      noteAgentPairedForSetup(setupKeyForIdentity(sponsor))
      return resolveTeamAgentCredential(identity)
    }
  )
}
