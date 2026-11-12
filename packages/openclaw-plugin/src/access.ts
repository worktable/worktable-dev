/**
 * Who may direct this OpenClaw from a Worktable thread.
 *
 * A thread message that runs is a full OpenClaw turn with the agent's tools on
 * the computer OpenClaw runs on, so the rule is the operator's: the person who
 * approved the connection, plus whoever that person chose to trust in the
 * channel's settings. OpenClaw's own gates never see a refused message.
 */

/** The oldest Worktable that names the approving member when it pairs. */
export const OWNER_NAMING_WORKTABLE_VERSION = "0.1.44"

const MEMBER_ID = /^ptc_[A-Za-z0-9_-]{12,}$/

export function memberId(value: unknown): string | undefined {
  return typeof value === "string" && MEMBER_ID.test(value) ? value : undefined
}

export interface WorktableAccess {
  /** The thread member who approved the connection, recorded at pairing. */
  ownerMemberId?: string
  /** The owner's opt-ins. Both are off unless the owner turns them on. */
  trustAllMembers: boolean
  trustAllAgents: boolean
}

export interface AccessAuthor {
  id: string
  /** What the thread says the author is; an unlisted author has no kind. */
  kind?: string
}

export type AccessDecision =
  | {
      allowed: true
      /** Only the owner's messages may carry OpenClaw commands. */
      owner: boolean
    }
  | { allowed: false; code: string; message: string }

export function decideAccess(
  access: WorktableAccess,
  author: AccessAuthor,
  name: string
): AccessDecision {
  if (!access.ownerMemberId) {
    // Nobody is on record, so nobody is let in, whatever else is set.
    return {
      allowed: false,
      code: "OWNER_UNKNOWN",
      message: `Connect ${name} to Worktable again before it can answer. This needs Worktable ${OWNER_NAMING_WORKTABLE_VERSION} or later.`,
    }
  }
  // The owner is a person the thread lists; an id alone is not enough.
  if (author.kind === "human" && author.id === access.ownerMemberId) {
    return { allowed: true, owner: true }
  }
  if (author.kind === "agent") {
    return access.trustAllAgents
      ? { allowed: true, owner: false }
      : {
          allowed: false,
          code: "AGENT_NOT_TRUSTED",
          message: `${name} does not take direction from other agents.`,
        }
  }
  // A person, or an author Worktable does not describe: never trusted as one.
  if (author.kind === "human" && access.trustAllMembers) {
    return { allowed: true, owner: false }
  }
  return {
    allowed: false,
    code: "NOT_OWNER",
    message: `Only the person who connected ${name} can direct it.`,
  }
}

/**
 * The owner and trust settings a connection keeps when its address or token
 * is replaced. They describe one Worktable's members as one person approved
 * them, so a different Worktable or approver starts closed.
 */
export function accessSettingsToKeep(
  section: Record<string, unknown> | undefined,
  next: { server: unknown; ownerMemberId: unknown }
): Partial<WorktableAccess> {
  const owner = memberId(next.ownerMemberId)
  if (!owner) return {}
  const sameConnection =
    section?.server === next.server && section?.ownerMemberId === owner
  return {
    ownerMemberId: owner,
    ...(sameConnection && section?.trustAllMembers === true
      ? { trustAllMembers: true }
      : {}),
    ...(sameConnection && section?.trustAllAgents === true
      ? { trustAllAgents: true }
      : {}),
  }
}
