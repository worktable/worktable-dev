/**
 * Who may direct this OpenClaw from a Worktable thread.
 *
 * A thread message that runs is a full OpenClaw turn with the agent's tools on
 * the computer OpenClaw runs on, so the rule is the operator's: the person who
 * connected it, the other agents that person connected, and whoever that
 * person chose to trust in the channel's settings. OpenClaw's own gates never
 * see a refused message.
 */

/** The oldest Worktable that says, with each message, who connected whom. */
export const OWNER_TELLING_WORKTABLE_VERSION = "0.1.45"

const MEMBER_ID = /^ptc_[A-Za-z0-9_-]{12,}$/

export function memberId(value: unknown): string | undefined {
  return typeof value === "string" && MEMBER_ID.test(value) ? value : undefined
}

/** The operator's settings, under `channels.worktable`. */
export interface WorktableAccess {
  /**
   * The thread member who approved the connection, as recorded at pairing.
   * Worktable names the owner with each message; this stands in where it
   * does not.
   */
  ownerMemberId?: string
  /** Agents the owner connected. On unless the owner turns it off. */
  trustOwnAgents: boolean
  /** The owner's opt-ins. Both are off unless the owner turns them on. */
  trustAllMembers: boolean
  trustAllAgents: boolean
}

/**
 * Every person and agent a Worktable lists is its one person, or that
 * person's: an older Worktable that has no teammates.
 */
export const ONE_PERSON = Symbol("one person")

/** What is known for one message about who connected whom. */
export interface Ownership {
  /** Whether this Worktable says who connected its agents. */
  told: boolean
  /** The person who connected this OpenClaw. */
  owner?: string | typeof ONE_PERSON
  /** The person who connected the author, when the author is an agent. */
  authorOwner?: string
}

/**
 * Who connected this OpenClaw and the message's author. Worktable is the
 * authority and says so with each delivery, so a connection made by any
 * earlier plugin has its owner without connecting again. An older Worktable
 * does not say: with one person in it everyone is that person or theirs, and
 * otherwise the owner recorded at pairing stands.
 */
export async function resolveOwnership(
  connectedBy: unknown,
  recordedOwner: string | undefined,
  isOnePersonWorktable: () => Promise<boolean>
): Promise<Ownership> {
  if (connectedBy && typeof connectedBy === "object") {
    const said = connectedBy as Record<string, unknown>
    return {
      told: true,
      // An agent the team owns has nobody; its pairing recorded who approved.
      owner: memberId(said.recipient) ?? recordedOwner,
      authorOwner: memberId(said.author),
    }
  }
  if (await isOnePersonWorktable()) return { told: false, owner: ONE_PERSON }
  return { told: false, owner: recordedOwner }
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
  ownership: Ownership,
  author: AccessAuthor,
  name: string
): AccessDecision {
  const { owner } = ownership
  if (!owner) {
    // Nobody is known to have connected it, so nobody is let in, whatever
    // else is set.
    return ownership.told
      ? {
          allowed: false,
          code: "OWNER_UNKNOWN",
          message: `Connect ${name} to Worktable again before it can answer.`,
        }
      : {
          allowed: false,
          code: "WORKTABLE_TOO_OLD",
          message: `Update this Worktable to ${OWNER_TELLING_WORKTABLE_VERSION} or later before ${name} can answer.`,
        }
  }
  if (author.kind === "human") {
    // The owner is a person the thread lists; an id alone is not enough.
    if (owner === ONE_PERSON || author.id === owner) {
      return { allowed: true, owner: true }
    }
    return access.trustAllMembers
      ? { allowed: true, owner: false }
      : {
          allowed: false,
          code: "NOT_OWNER",
          message: `Only the person who connected ${name} can direct it.`,
        }
  }
  if (author.kind === "agent") {
    // An agent with nobody on record is not the owner's own.
    const ownAgent =
      owner === ONE_PERSON ||
      (ownership.authorOwner !== undefined && ownership.authorOwner === owner)
    return (ownAgent && access.trustOwnAgents) || access.trustAllAgents
      ? { allowed: true, owner: false }
      : {
          allowed: false,
          code: "AGENT_NOT_TRUSTED",
          message: `${name} does not take direction from this agent.`,
        }
  }
  // An author Worktable does not describe is never trusted.
  return {
    allowed: false,
    code: "NOT_OWNER",
    message: `Only the person who connected ${name} can direct it.`,
  }
}

/** Whether two saved Worktable addresses are the same, trailing slashes aside. */
export function sameAddress(a: unknown, b: unknown): boolean {
  const bare = (value: unknown) =>
    typeof value === "string" ? value.replace(/\/+$/, "") : undefined
  return bare(a) !== undefined && bare(a) === bare(b)
}

/**
 * The owner and trust settings a connection keeps when its address or token
 * is replaced. The two opt-ins describe one Worktable's members as one person
 * approved them, so a different Worktable or approver starts without them.
 * Turning the owner's own agents off is a restriction, and stays.
 */
export function accessSettingsToKeep(
  section: Record<string, unknown> | undefined,
  next: { server: unknown; ownerMemberId: unknown }
): Partial<WorktableAccess> {
  const restricted =
    section?.trustOwnAgents === false ? { trustOwnAgents: false } : {}
  const owner = memberId(next.ownerMemberId)
  if (!owner) return restricted
  const sameConnection =
    sameAddress(section?.server, next.server) &&
    section?.ownerMemberId === owner
  return {
    ownerMemberId: owner,
    ...restricted,
    ...(sameConnection && section?.trustAllMembers === true
      ? { trustAllMembers: true }
      : {}),
    ...(sameConnection && section?.trustAllAgents === true
      ? { trustAllAgents: true }
      : {}),
  }
}
