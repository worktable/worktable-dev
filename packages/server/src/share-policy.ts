import type { ShareLinkLevel } from "@worktable/types"
import { teamsEnabled } from "./team-database.ts"
import { canAccessSpace, teamMemberForIdentity } from "./team-policy.ts"
import type { TokenIdentity } from "./token-store.ts"

// ============================================================
// Who may do what with share links
// ============================================================
//
// Every decision about links goes through authorizeShareAction. Only people
// reach it: an agent is denied whatever its scopes. With the default owner
// policy, owners and the managers of a Space share its documents; the owner
// policy that narrows or widens this comes with its own change.

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
      code: "FORBIDDEN" | "LEVEL_NOT_AVAILABLE"
    }

const ALLOWED: ShareDecision = { allowed: true }
const FORBIDDEN: ShareDecision = {
  allowed: false,
  status: 403,
  code: "FORBIDDEN",
}

/** The levels links can have today. Comment and use come later. */
const AVAILABLE_LEVELS: ReadonlySet<ShareLinkLevel> = new Set(["view"])

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

/**
 * Decide one action on links in a Space. `spaceId` is null only for
 * overseeing every Space. `level` is the level being given or kept.
 */
export function authorizeShareAction(
  identity: TokenIdentity | undefined,
  action: ShareAction,
  spaceId: string | null,
  level: ShareLinkLevel = "view"
): ShareDecision {
  if (
    !identity ||
    identity.agent !== null ||
    identity.principal.type !== "human" ||
    identity.operatorVerification
  ) {
    return FORBIDDEN
  }
  if (
    (action === "create" || action === "manage") &&
    !AVAILABLE_LEVELS.has(level)
  ) {
    return { allowed: false, status: 400, code: "LEVEL_NOT_AVAILABLE" }
  }
  // Solo: the person the router admitted owns this Worktable.
  if (!teamsEnabled()) return ALLOWED
  const member = teamMemberForIdentity(identity)
  if (!member) return FORBIDDEN
  if (member.role === "owner") return ALLOWED
  if (spaceId === null) return FORBIDDEN
  const access = action === "read" ? "read" : "manage"
  return canAccessSpace(spaceId, access, identity) ? ALLOWED : FORBIDDEN
}
