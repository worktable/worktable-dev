import type { ActivityEvent } from "@worktable/types"
import {
  type PersonalSetup,
  type SetupEvidence,
  type SetupItemId,
} from "@worktable/types/setup"
import { logError } from "./debug-log.ts"
import { participantKey } from "./participant-store.ts"
import {
  movePersonSetup,
  readPersonSetup,
  updatePersonSetup,
} from "./personal-navigation-store.ts"
import { accessSnapshot } from "./team-access.ts"
import { requireTeamDatabase, teamsEnabled } from "./team-database.ts"
import { invitationDetails } from "./team-invitations.ts"
import { findTeamMember, findTeamMemberById } from "./team-members.ts"
import { currentRequestIdentity, teamMemberForIdentity } from "./team-policy.ts"
import type { TokenIdentity } from "./token-store.ts"
import { wsManager } from "./ws.ts"

/**
 * Without Teams there is one person, whichever way they reach the
 * Worktable, so their setup has one fixed key.
 */
export const OWNER_SETUP_KEY = "owner"

/**
 * Whose setup an identity advances: a member's own, or the member's whose
 * personal agent it is. Team agents belong to nobody's setup.
 */
export function setupKeyForIdentity(
  identity: TokenIdentity | undefined
): string | null {
  if (!teamsEnabled()) return OWNER_SETUP_KEY
  if (!identity) return null
  if (identity.agent || identity.principal.type !== "human") {
    const memberId = identity.team?.memberId
    return memberId
      ? (accessSnapshot()?.participantKeys.get(memberId) ?? null)
      : null
  }
  return teamMemberForIdentity(identity) ? participantKey(identity) : null
}

/** A member's own setup key, read where their enrollment stored it. */
function memberSetupKey(actorId: string | undefined): string | null {
  if (!actorId) return null
  return (
    requireTeamDatabase()
      .query<{ participant_key: string | null }, [string]>(
        "SELECT participant_key FROM wt_actors WHERE id = ?"
      )
      .get(actorId)?.participant_key ?? null
  )
}

/**
 * Runs when an invitation is accepted, after enrollment: the inviter's team
 * has grown, and the new member has joined the Space they were invited to.
 * Acceptance waits for both, so the new member's first page already sees
 * that they joined.
 */
export async function noteInvitationAcceptedForSetup(
  invitation: { id: string; inviterId: string },
  memberId: string
): Promise<void> {
  await completeSetupItem(
    memberSetupKey(findTeamMember(invitation.inviterId)?.actorId),
    "invite-team"
  )
  const spaceId = invitationDetails(invitation.id)?.startSpaceId
  await completeSetupItem(
    memberSetupKey(findTeamMemberById(memberId)?.actorId),
    "join-space",
    spaceId ? { spaceId } : undefined
  )
}

/** The setup key for the person who owns a preferences key from a request. */
export function setupKeyForPerson(preferencesKey: string): string {
  return teamsEnabled() ? preferencesKey : OWNER_SETUP_KEY
}

function storedSetup(key: string): PersonalSetup | undefined {
  try {
    return readPersonSetup(key)
  } catch {
    return undefined
  }
}

/** What the person's windows show: their setup as stored, or a fresh one. */
export function setupSummary(key: string): PersonalSetup {
  return storedSetup(key) ?? { items: {} }
}

function notifySetupChanged(key: string): void {
  const message = { type: "setup_changed" as const }
  if (key === OWNER_SETUP_KEY) wsManager.sendToPeople(() => true, message)
  else wsManager.sendToPerson(key, message)
}

/** Save a change to one person's setup and tell their open windows. */
export async function changeSetup(
  key: string,
  change: (current: PersonalSetup) => PersonalSetup | null
): Promise<PersonalSetup | null> {
  const saved = await updatePersonSetup(key, (stored) =>
    change(stored ?? { items: {} })
  )
  if (saved) notifySetupChanged(key)
  return saved
}

function evidence(details: Omit<SetupEvidence, "at"> = {}): SetupEvidence {
  return { at: new Date().toISOString(), ...details }
}

/**
 * Complete an item the first time it happens. Checked in memory first, so a
 * finished item costs nothing on the write path it observes. Never rejects:
 * callers on a write path need not wait for it.
 */
export async function completeSetupItem(
  key: string | null,
  item: SetupItemId,
  details?: Omit<SetupEvidence, "at">
): Promise<void> {
  if (!key || storedSetup(key)?.items[item]) return
  await changeSetup(key, (setup) =>
    setup.items[item]
      ? null
      : { ...setup, items: { ...setup.items, [item]: evidence(details) } }
  ).catch((error) => {
    console.warn("[setup] could not save progress:", logError(error))
  })
}

/** The person behind the current request, as far as setup is concerned. */
function currentSetupKey(): string | null {
  return setupKeyForIdentity(currentRequestIdentity())
}

/** An agent connected and made its first call. */
export function noteAgentCallForSetup(identity: TokenIdentity | undefined): void {
  void completeSetupItem(setupKeyForIdentity(identity), "connect-agent")
}

/** A person paired an agent. */
export function noteAgentPairedForSetup(key: string | null): void {
  void completeSetupItem(key, "connect-agent")
}

/** An agent's first doc, or its first edit, is its first task done. */
export function observeActivityForSetup(event: ActivityEvent): void {
  if (event.actor.kind !== "agent") return
  if (event.action !== "doc.created" && event.action !== "doc.edited") return
  void completeSetupItem(currentSetupKey(), "first-task", {
    ...(event.spaceId ? { spaceId: event.spaceId } : {}),
    ...(event.target.kind === "doc" ? { path: event.target.path } : {}),
  })
}

/** When Teams turns on, the owner's setup moves to their member key. */
export async function moveOwnerSetup(memberKey: string): Promise<void> {
  try {
    await movePersonSetup(OWNER_SETUP_KEY, memberKey)
  } catch (error) {
    console.warn("[setup] could not carry setup over:", logError(error))
  }
}
