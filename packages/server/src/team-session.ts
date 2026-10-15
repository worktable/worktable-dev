import type { TokenIdentity } from "./token-store.ts"
import { getTeamAuth } from "./team-auth.ts"
import { currentTeamWorktable } from "./team-database.ts"
import { findTeamMember } from "./team-members.ts"
import { identityForTeamMember } from "./team-identity.ts"
import { isHosted } from "./hosted.ts"
import { resolveWorkspaceOriginForRequest } from "./workspace-origin.ts"

export async function verifyTeamSession(
  request: Request
): Promise<TokenIdentity | null> {
  if (isHosted() || !currentTeamWorktable()) return null
  const auth = await getTeamAuth(
    resolveWorkspaceOriginForRequest(request).origin
  )
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  })
  if (!session) return null
  const member = findTeamMember(session.user.id)
  return member
    ? {
        ...identityForTeamMember(member),
        sessionId: session.session.id,
        credentialExpiresAt: session.session.expiresAt.getTime(),
      }
    : null
}
