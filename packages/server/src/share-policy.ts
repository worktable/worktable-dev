import {
  type ShareLinkBlockedBy,
  type ShareLinkLevel,
  type SharingPolicy,
  type TeamMember,
} from "@worktable/types"
import {
  readSharingPolicy,
  ShareLinksStoreError,
  type StoredShareLink,
} from "./share-links-store.ts"
import {
  accessSnapshot,
  levelAtLeast,
  memberLevel,
  type AccessSnapshot,
} from "./team-access.ts"
import { teamsEnabled } from "./team-database.ts"
import { canAccessSpace, teamMemberForIdentity } from "./team-policy.ts"
import type { TokenIdentity } from "./token-store.ts"

// ============================================================
// Who may do what with share links
// ============================================================
//
// Every decision about links goes through authorizeShareAction, and every
// view of a link through linkBlockedBy, so the owner policy applies both when
// a link is made and each time it is used: tightening it cuts off existing
// links at their next view, and loosening it lets them open again. Only
// people reach these decisions: an agent is denied whatever its scopes.

export type ShareAction =
  /** See a document's links. */
  | "read"
  /** Make a link. */
  | "create"
  /** Change or revoke a link. */
  | "manage"
  /** List every link of a Space, or of the Worktable without one. */
  | "oversee"

export type ShareDecision =
  | { allowed: true }
  | {
      allowed: false
      status: 400 | 403
      code:
        | "FORBIDDEN"
        | "LEVEL_NOT_AVAILABLE"
        | "SHARING_PAUSED"
        | "SPACE_NOT_ALLOWED"
      /** Why a link can't be made here, for the share dialog. */
      blockedBy?: "paused" | "space" | "sharer"
    }

const ALLOWED: ShareDecision = { allowed: true }
const FORBIDDEN: ShareDecision = {
  allowed: false,
  status: 403,
  code: "FORBIDDEN",
}
const NOT_A_SHARER: ShareDecision = { ...FORBIDDEN, blockedBy: "sharer" }
const PAUSED: ShareDecision = {
  allowed: false,
  status: 403,
  code: "SHARING_PAUSED",
  blockedBy: "paused",
}
const SPACE_NOT_ALLOWED: ShareDecision = {
  allowed: false,
  status: 403,
  code: "SPACE_NOT_ALLOWED",
  blockedBy: "space",
}

const AVAILABLE_LEVELS: ReadonlySet<string> = new Set<ShareLinkLevel>(["view", "comment"])

const DAY_MS = 86_400_000

// ── The policy in force ──────────────────────────────────────

/** The owner policy in force, read again only when it changed. */
export function currentSharingPolicy(): SharingPolicy {
  return readSharingPolicy().policy
}

function spaceAllowed(policy: SharingPolicy, spaceId: string): boolean {
  return (
    policy.spaces.mode === "all" || policy.spaces.spaceIds.includes(spaceId)
  )
}

/** When the policy's longest expiry ends a link, or null without one. */
function capOf(
  link: Pick<StoredShareLink, "createdAt">,
  policy: SharingPolicy
): number | null {
  return policy.maxExpiryDays === null
    ? null
    : link.createdAt + policy.maxExpiryDays * DAY_MS
}

/** The earlier of a link's own expiry and the policy's longest expiry. */
export function effectiveExpiresAt(
  link: Pick<StoredShareLink, "createdAt" | "expiresAt">,
  policy: SharingPolicy
): number | null {
  const cap = capOf(link, policy)
  if (cap === null) return link.expiresAt
  return link.expiresAt === null ? cap : Math.min(link.expiresAt, cap)
}

/**
 * Whether an expiry chosen for a new or edited link fits the policy's
 * longest expiry. A little slack covers a browser clock ahead of the
 * server's; the link still stops at its cap whatever it was given.
 */
export function expiryAllowed(
  expiresAt: number | null,
  policy: SharingPolicy,
  now = Date.now()
): boolean {
  if (policy.maxExpiryDays === null) return true
  return (
    expiresAt !== null &&
    expiresAt <= now + policy.maxExpiryDays * DAY_MS + 60 * 60_000
  )
}

// ── Sharers ──────────────────────────────────────────────────

/** Whether the owner policy lets a member make links in a Space. */
function memberMayShare(
  snapshot: AccessSnapshot,
  member: Pick<TeamMember, "id" | "role">,
  spaceId: string,
  policy: SharingPolicy
): boolean {
  if (member.role === "owner") return true
  const level = memberLevel(snapshot, member, spaceId)
  switch (policy.whoMayShare) {
    case "owners":
      return false
    case "space-managers":
      return levelAtLeast(level, "manage")
    case "editors":
      return levelAtLeast(level, "edit")
  }
}

/**
 * Whether a link's creator may still share in its Space. A link that names
 * no member belongs to its Space, so only the policy and the Space stop it:
 * links moved from the earlier format record no creator, and links made
 * before Teams was on record the person's own id (`local:owner`,
 * `workos:<subject>`), which never names a member. Reads only the access
 * snapshot, which is rebuilt only when team access changes.
 */
export function creatorMayShare(
  createdById: string,
  spaceId: string,
  policy: SharingPolicy
): boolean {
  const snapshot = accessSnapshot()
  if (!snapshot || createdById === "" || createdById.includes(":")) return true
  const member = snapshot.members.get(createdById)
  return Boolean(member && memberMayShare(snapshot, member, spaceId, policy))
}

/** The sharer as a link records it: the member in Teams, else the person. */
export function sharerOf(identity: TokenIdentity): {
  id: string
  name: string
} {
  const member = teamsEnabled() ? teamMemberForIdentity(identity) : null
  return member
    ? { id: member.id, name: member.name }
    : { id: identity.principal.id, name: identity.principal.displayName }
}

// ── Decisions ────────────────────────────────────────────────

/**
 * Why a link that is neither revoked nor past its own expiry doesn't open
 * now, or null when it does. Checked on every view, so it costs no I/O: the
 * policy comes with the link, and the creator's access from the snapshot.
 */
export function linkBlockedBy(
  link: StoredShareLink,
  policy: SharingPolicy,
  now = Date.now()
): ShareLinkBlockedBy | null {
  if (policy.paused) return "paused"
  if (!spaceAllowed(policy, link.spaceId)) return "space"
  // A link from a later version that this one can't serve.
  if (!link.servable) return link.hasPassword ? "password" : "level"
  if (link.grant && !policy.liveLinks) return "level"
  if (!policy.levels.some((level) => level === link.level)) return "level"
  if (policy.requirePassword && !link.hasPassword) return "password"
  if (!creatorMayShare(link.createdById, link.spaceId, policy)) return "sharer"
  const cap = capOf(link, policy)
  if (cap !== null && cap <= now) return "expiry-cap"
  return null
}

/**
 * Whether the owner policy holds back a link of the earlier format, which
 * views still fall back to before the move at boot, or while its path names
 * more than one document. It names no creator and has
 * no password, so pause, Spaces, a required password and the longest expiry
 * decide. A store this version can't read holds a policy it can't check,
 * so the link stays closed.
 */
export function legacyShareHeldBack(
  share: { spaceId: string; createdAt: string },
  now = Date.now()
): boolean {
  let policy: SharingPolicy
  try {
    policy = currentSharingPolicy()
  } catch (error) {
    if (error instanceof ShareLinksStoreError) return true
    throw error
  }
  const cap = capOf({ createdAt: Date.parse(share.createdAt) }, policy)
  return (
    policy.paused ||
    !spaceAllowed(policy, share.spaceId) ||
    policy.requirePassword ||
    !policy.levels.includes("view") ||
    (cap !== null && !(cap > now))
  )
}

/** Whether the policy lets links into a Space now. */
function policyAllowsLinks(
  policy: SharingPolicy,
  spaceId: string
): ShareDecision {
  if (policy.paused) return PAUSED
  if (!spaceAllowed(policy, spaceId)) return SPACE_NOT_ALLOWED
  return ALLOWED
}

/**
 * Decide one action on links in a Space. `spaceId` is null only for
 * overseeing every Space. `level` is the level a new link gets or an edit
 * gives, and `creatorId` the creator of the link being managed, who may
 * manage it while still entitled to share. The policy is read only for
 * actions that need it.
 */
export function authorizeShareAction(
  identity: TokenIdentity | undefined,
  action: ShareAction,
  spaceId: string | null,
  options: {
    level?: ShareLinkLevel
    creatorId?: string
    policy?: SharingPolicy
  } = {}
): ShareDecision {
  if (
    !identity ||
    identity.agent !== null ||
    identity.principal.type !== "human" ||
    identity.operatorVerification
  ) {
    return FORBIDDEN
  }
  const policy = () => (options.policy ??= currentSharingPolicy())
  // A new link's level, or the one an edit gives; revoking needs none.
  const level =
    action === "create"
      ? (options.level ?? "view")
      : action === "manage"
        ? options.level
        : undefined
  if (
    level !== undefined &&
    (!AVAILABLE_LEVELS.has(level) ||
      !policy().levels.some((allowed) => allowed === level))
  ) {
    return { allowed: false, status: 400, code: "LEVEL_NOT_AVAILABLE" }
  }
  // Solo: the person the router admitted owns this Worktable.
  if (!teamsEnabled()) {
    return action === "create" ? policyAllowsLinks(policy(), spaceId!) : ALLOWED
  }
  const member = teamMemberForIdentity(identity)
  if (!member) return FORBIDDEN
  const owner = member.role === "owner"
  switch (action) {
    case "read":
      return owner ||
        (spaceId !== null && canAccessSpace(spaceId, "read", identity))
        ? ALLOWED
        : FORBIDDEN
    case "oversee":
      return owner ||
        (spaceId !== null && canAccessSpace(spaceId, "manage", identity))
        ? ALLOWED
        : FORBIDDEN
    case "manage":
      return owner ||
        (spaceId !== null &&
          (canAccessSpace(spaceId, "manage", identity) ||
            (options.creatorId === member.id &&
              memberMayShare(accessSnapshot()!, member, spaceId, policy()))))
        ? ALLOWED
        : FORBIDDEN
    case "create":
      if (
        spaceId === null ||
        !memberMayShare(accessSnapshot()!, member, spaceId, policy())
      ) {
        return NOT_A_SHARER
      }
      return policyAllowsLinks(policy(), spaceId)
  }
}

/**
 * Whether a document page offers Share to this person,
 * and whether they may make a link now. Those the policy lets share in the
 * Space see it even while it holds links back, so the dialog can say why;
 * the Space's managers see it to manage existing links. The caller has
 * checked that a solo reader is the owner.
 */
export function pageShareAccess(
  identity: TokenIdentity,
  spaceId: string
): { canCreate: boolean } | null {
  let policy: SharingPolicy
  try {
    policy = currentSharingPolicy()
  } catch (error) {
    // A store this version can't open shares nothing; the page still opens.
    if (error instanceof ShareLinksStoreError) return null
    throw error
  }
  if (!authorizeShareAction(identity, "read", spaceId, { policy }).allowed)
    return null
  return {
    canCreate: authorizeShareAction(identity, "create", spaceId, { policy })
      .allowed,
  }
}
