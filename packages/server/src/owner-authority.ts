import type { TokenIdentity } from "./token-store.ts"
import { isHosted } from "./hosted.ts"
import { getOwnerSubject } from "./oauth-jwt.ts"

/**
 * Whether a resolved identity may inspect owner-wide collaboration state.
 *
 * Local owner authority is the explicit `*` grant. Hosted browser authority
 * instead comes from the gateway-attested WorkOS owner principal carried by a
 * browser assertion. A human-shaped scoped token alone is never owner authority.
 */
export function hasWorkspaceOwnerAuthority(
  identity: Pick<
    TokenIdentity,
    "agent" | "credentialClass" | "principal" | "scopes"
  >
): boolean {
  if (identity.scopes.includes("*")) return true
  if (
    !isHosted() ||
    identity.credentialClass !== "browser" ||
    identity.agent !== null
  ) {
    return false
  }
  const ownerSubject = getOwnerSubject()
  return Boolean(
    ownerSubject &&
    identity.principal.type === "human" &&
    identity.principal.id === `workos:${ownerSubject}` &&
    identity.principal.authorizedBy === undefined
  )
}
