import type { ActivityEvent } from "@worktable/types"
import {
  HELP_STATE_MAX,
  type HelpEvent,
  type HelpEvidenceId,
  type HelpState,
  type PersonalSetup,
  type SetupEvidence,
  type SetupItemId,
} from "@worktable/types/setup"
import { logError } from "./debug-log.ts"
import { isGettingStartedSpaceId } from "./getting-started.ts"
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

/** The setup with an item completed, unless it already was. */
export function withSetupItem(
  setup: PersonalSetup,
  item: SetupItemId,
  details?: Omit<SetupEvidence, "at">
): PersonalSetup {
  return setup.items[item]
    ? setup
    : { ...setup, items: { ...setup.items, [item]: evidence(details) } }
}

/** Done for real: a skipped step still completes when it happens. */
function isDone(evidence: SetupEvidence | undefined): boolean {
  return Boolean(evidence && !evidence.skipped)
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
  if (!key || isDone(storedSetup(key)?.items[item])) return
  await changeSetup(key, (setup) =>
    isDone(setup.items[item])
      ? null
      : {
          ...setup,
          items: { ...setup.items, [item]: evidence(details) },
        }
  ).catch((error) => {
    console.warn("[setup] could not save progress:", logError(error))
  })
}

/**
 * Record help evidence the first time it happens, like completeSetupItem:
 * checked in memory first and never rejects, so write paths needn't wait.
 */
export async function completeHelpEvidence(
  key: string | null,
  id: HelpEvidenceId,
  details?: Omit<SetupEvidence, "at">
): Promise<void> {
  if (!key || storedSetup(key)?.helpEvidence?.[id]) return
  await changeSetup(key, (setup) =>
    setup.helpEvidence?.[id]
      ? null
      : {
          ...setup,
          helpEvidence: { ...setup.helpEvidence, [id]: evidence(details) },
        }
  ).catch((error) => {
    console.warn("[setup] could not save help progress:", logError(error))
  })
}

/** The help map after one event from the person's browser. */
export function withHelpEvent(
  setup: PersonalSetup,
  id: string,
  event: HelpEvent,
  version: number | undefined,
  now = new Date().toISOString()
): PersonalSetup {
  const help = { ...setup.help }
  const current: HelpState = help[id] ?? { shown: 0 }
  let next: HelpState | null
  switch (event) {
    case "shown":
      // A rewritten tip starts over.
      next =
        version !== undefined && current.version !== version
          ? { shown: 1, lastShownAt: now, version }
          : { ...current, shown: current.shown + 1, lastShownAt: now }
      break
    case "closed":
      next = { ...current, closedAt: now }
      break
    case "done":
      next = current.doneAt ? current : { ...current, doneAt: now }
      break
    case "optOut":
      next = { ...current, optedOut: true, closedAt: current.closedAt ?? now }
      break
    case "reset":
      next = null
      break
  }
  if (next) {
    delete help[id]
    help[id] = next
  } else delete help[id]
  // The oldest entries go first when the map is full.
  const ids = Object.keys(help)
  for (const old of ids.slice(0, Math.max(0, ids.length - HELP_STATE_MAX)))
    delete help[old]
  return { ...setup, help }
}

/** Every help entry forgotten, so tips show again from the start. */
export function withHelpReset(setup: PersonalSetup): PersonalSetup {
  const rest = { ...setup }
  delete rest.help
  delete rest.tryNextHidden
  return rest
}

/**
 * A second agent working for the same person. The first ids seen are kept,
 * so the second distinct one marks Try Next's Add Another Agent done.
 */
async function noteAgentForHelp(
  key: string | null,
  agentId: string | undefined
): Promise<void> {
  if (!key || !agentId) return
  const stored = storedSetup(key)
  if (stored?.helpEvidence?.["another-agent"]) return
  if (stored?.agentsSeen?.includes(agentId)) return
  await changeSetup(key, (setup) => {
    const seen = setup.agentsSeen ?? []
    if (seen.includes(agentId) || setup.helpEvidence?.["another-agent"])
      return null
    const agentsSeen = [...seen, agentId].slice(0, 5)
    return {
      ...setup,
      agentsSeen,
      ...(agentsSeen.length >= 2
        ? {
            helpEvidence: {
              ...setup.helpEvidence,
              "another-agent": evidence(),
            },
          }
        : {}),
    }
  }).catch((error) => {
    console.warn("[setup] could not save agents seen:", logError(error))
  })
}

/** The person behind the current request, as far as setup is concerned. */
function currentSetupKey(): string | null {
  return setupKeyForIdentity(currentRequestIdentity())
}

/** An agent connected and made its first call. */
export function noteAgentCallForSetup(identity: TokenIdentity | undefined): void {
  const key = setupKeyForIdentity(identity)
  void completeSetupItem(key, "connect-agent")
  void noteAgentForHelp(key, agentIdentityId(identity))
}

/**
 * Which agent made a call, by its app ("claude-code", "chatgpt"), so a
 * second app counts as another agent and a reconnect of the same one doesn't.
 */
function agentIdentityId(identity: TokenIdentity | undefined): string | undefined {
  return identity?.agent ?? undefined
}

/** A person paired an agent, or a member's agent first signed in. */
export function noteAgentPairedForSetup(key: string | null): Promise<void> {
  return completeSetupItem(key, "connect-agent")
}

/**
 * An agent's first doc, or its first edit, is its first task done. Work in
 * Getting Started doesn't count: the task is a Space of the person's own.
 */
export function observeActivityForSetup(event: ActivityEvent): void {
  observeActivityForHelp(event)
  if (event.actor.kind !== "agent") return
  if (event.action !== "doc.created" && event.action !== "doc.edited") return
  if (event.spaceId && isGettingStartedSpaceId(event.spaceId)) return
  void completeSetupItem(currentSetupKey(), "first-task", {
    ...(event.spaceId ? { spaceId: event.spaceId } : {}),
    ...(event.target.kind === "doc" ? { path: event.target.path } : {}),
  })
}

/**
 * What finishes help: the person's own actions, and an agent's HTML Doc made
 * for them. Each is recorded once; later events cost a memory check.
 */
function observeActivityForHelp(event: ActivityEvent): void {
  const key = currentSetupKey()
  if (!key) return
  const where = {
    ...(event.spaceId ? { spaceId: event.spaceId } : {}),
    ...(event.target.kind === "doc" ? { path: event.target.path } : {}),
  }
  const html =
    event.target.kind === "doc" && event.target.formatId === "worktable.html"
  if (event.actor.kind === "agent") {
    if (event.action === "doc.created" && html)
      void completeHelpEvidence(key, "html-doc-made", where)
    return
  }
  if (event.actor.kind !== "person") return
  switch (event.action) {
    case "doc.kept":
      void completeHelpEvidence(key, "temporary-kept", where)
      return
    case "comment.created":
      if (html) void completeHelpEvidence(key, "html-commented", where)
      return
    case "thread.started":
    case "thread.replied":
      void completeHelpEvidence(key, "thread-message")
      return
    case "records.added":
    case "records.updated":
      void completeHelpEvidence(key, "records-edited", where)
      return
  }
}

/** When Teams turns on, the owner's setup moves to their member key. */
export async function moveOwnerSetup(memberKey: string): Promise<void> {
  try {
    await movePersonSetup(OWNER_SETUP_KEY, memberKey)
  } catch (error) {
    console.warn("[setup] could not carry setup over:", logError(error))
  }
}
