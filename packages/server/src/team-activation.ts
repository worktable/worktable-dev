import { initialSpaceVisibility } from "./getting-started.ts"
import { moveOwnerSetup } from "./personal-setup.ts"
import {
  beginTeamInitialization,
  finishTeamInitialization,
  recoverTeamInitialization,
  getInitialTeamOrganization,
} from "./team-initialization.ts"
import { pauseLinkForTeamActivation } from "./linked-runtime.ts"
import { randomUUID } from "node:crypto"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { getTeamAuth } from "./team-auth.ts"
import {
  currentTeamWorktable,
  currentWorktableId,
  openTeamDatabase,
  teamDatabasePath,
  writeTeamMarker,
} from "./team-database.ts"
import { findTeamMember } from "./team-members.ts"
import { identityForTeamMember } from "./team-identity.ts"
import { TeamAccessError } from "./team-policy.ts"
import { listSpaces } from "./store.ts"
import { listAgentConnections } from "./agent-connection-store.ts"
import { participantsByKey, participantKey } from "./participant-store.ts"
import { hasScope, listTokens, type TokenIdentity } from "./token-store.ts"
import { isHosted } from "./hosted.ts"
import {
  getWorkspaceRoot,
  workspaceCacheKey,
} from "./workspace.ts"

let initializationHookForTests: (() => void) | null = null
export function setLocalTeamInitializationHookForTests(
  hook: (() => void) | null
): void {
  initializationHookForTests = hook
}

export interface TeamOwnerSetup {
  name: string
  email: string
  password: string
}

/** Caller must have established the pre-Teams owner's authority over the original request. */
export async function activateLocalTeams(
  origin: string,
  setup: TeamOwnerSetup,
  bootstrap: TokenIdentity
) {
  if (
    isHosted() ||
    bootstrap.principal.type !== "human" ||
    !hasScope(bootstrap.scopes, "*") ||
    bootstrap.team
  ) {
    throw new TeamAccessError("The local owner must enable Teams")
  }
  recoverTeamInitialization()
  openTeamDatabase(true)
  return withCrossProcessLock(
    `${teamDatabasePath()}.activation.lock`,
    { label: "Team activation" },
    async () => {
      if (currentTeamWorktable())
        throw new TeamAccessError("Teams is already enabled")
      const worktableId = currentWorktableId()
      const rootKey = workspaceCacheKey()
      const spaces = await listSpaces()
      const credentials = (await listTokens()).filter(
        (token) =>
          token.workspace === getWorkspaceRoot() &&
          !token.revokedAt &&
          token.agent
      )
      const [legacyConnections, legacyParticipants] = await Promise.all([
        listAgentConnections(),
        participantsByKey(),
      ])
      const auth = await getTeamAuth(origin)
      // An interrupted setup may already have created this account.
      const context = await auth.$context
      const existing = await context.internalAdapter.findUserByEmail(
        setup.email.toLowerCase()
      )
      // Before activation completes, the only accounts are leftovers of an
      // interrupted attempt by this same local owner, so the password chosen
      // now replaces the earlier one.
      if (existing)
        await context.internalAdapter.updatePassword(
          existing.user.id,
          await context.password.hash(setup.password)
        )
      const signedIn = existing
        ? await auth.api.signInEmail({
            body: { email: setup.email, password: setup.password },
            returnHeaders: true,
          })
        : await auth.api.signUpEmail({ body: setup, returnHeaders: true })
      const user = signedIn.response.user
      beginTeamInitialization("local", user.id)
      const { organizationId, ownerMemberId } =
        await getInitialTeamOrganization(origin, user.id, {
          replaceUnfinished: true,
        })
      await pauseLinkForTeamActivation()
      const db = openTeamDatabase()!
      try {
        db.transaction(() => {
          db.query(
            "INSERT INTO wt_worktables(id, organization_id, root_key) VALUES (?, ?, ?)"
          ).run(worktableId, organizationId, rootKey)
          db.query(
            "INSERT INTO wt_actors(id, worktable_id, user_id, name, participant_key) VALUES (?, ?, ?, ?, ?)"
          ).run(
            bootstrap.principal.id,
            worktableId,
            user.id,
            user.name,
            participantKey(bootstrap)
          )
          db.query(
            "INSERT INTO wt_enrollments(id, worktable_id, user_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?)"
          ).run(
            ownerMemberId,
            worktableId,
            user.id,
            bootstrap.principal.id,
            Date.now()
          )
          // Preserve the operator authority the original local owner already had.
          db.query(
            "INSERT INTO wt_operators(worktable_id, user_id) VALUES (?, ?)"
          ).run(worktableId, user.id)
          for (const space of spaces)
            db.query(
              "INSERT INTO wt_space_policy(worktable_id, space_id, visibility) VALUES (?, ?, ?)"
            ).run(worktableId, space.id, initialSpaceVisibility(space))
          // Preserve the single person's existing labelled agents and their participants.
          const migrated = new Map<string, string>()
          for (const credential of credentials) {
            const key = participantKey(credential)
            let agentId = migrated.get(key)
            if (!agentId) {
              agentId = `agt_${randomUUID()}`
              migrated.set(key, agentId)
              const participant = legacyParticipants.get(key)
              const legacy = legacyConnections.find(
                (connection) =>
                  participant && connection.participant?.id === participant.id
              )
              db.query(
                "INSERT INTO wt_agents(id, worktable_id, actor_id, participant_key, name, platform, ownership, member_id, icon, mode) VALUES (?, ?, ?, ?, ?, ?, 'personal', ?, ?, ?)"
              ).run(
                agentId,
                worktableId,
                `agent:${randomUUID()}`,
                key,
                legacy?.displayName ??
                  participant?.name ??
                  credential.principal.displayName,
                legacy?.platform ?? credential.agent!,
                ownerMemberId,
                legacy?.icon ?? null,
                legacy?.mode ?? "on-demand"
              )
            }
            db.query(
              "INSERT INTO wt_agent_credentials(credential_key, agent_id, sponsor_member_id) VALUES (?, ?, ?)"
            ).run(credential.principal.id, agentId, ownerMemberId)
          }
          // Written before commit: a crash cannot turn a migrated database into solo mode.
          writeTeamMarker(worktableId)
          initializationHookForTests?.()
        })()
        finishTeamInitialization()
      } catch (error) {
        recoverTeamInitialization()
        throw error
      }
      const member = findTeamMember(user.id)!
      // The owner's first steps carry over to their new team identity.
      await moveOwnerSetup(participantKey(bootstrap))
      return {
        headers: signedIn.headers,
        member,
        identity: identityForTeamMember(member),
      }
    }
  )
}
