// ============================================================
// Who may grant an HTML Doc its permissions
// ============================================================
//
// An HTML Doc's Record and network permissions run with the session of
// whoever opens it, so the writer decides what a teammate's session does.
// With preview agent tools on, a write may grant only Record access its writer
// holds, and only a person may turn on network access. An agent's network
// request waits for a person, and an agent's edit to an allowed Doc asks again:
// the person allowed the code they saw.

import type { WidgetFile } from "@worktable/types"
import { hasScope, type TokenIdentity } from "./token-store.ts"
import type { WidgetValidationIssue } from "./widget-authoring.ts"

type Permissions = WidgetFile["permissions"]
type Requests = WidgetFile["requests"]

const RECORD_ACTIONS = ["read", "create", "update", "delete"] as const

/** A person using Worktable, not an agent acting for one. */
export function isPersonWriter(
  identity: Pick<TokenIdentity, "agent" | "principal"> | undefined
): boolean {
  return identity?.agent === null && identity.principal.type === "human"
}

/** A write whose permissions go beyond its writer's own access. */
export class HtmlPermissionError extends Error {
  readonly missingScope: string
  constructor(message: string, missingScope: string) {
    super(message)
    this.missingScope = missingScope
  }
}

/**
 * The permissions and requests a write saves. `requested` is what the write
 * sets, or undefined to keep the Doc's current permissions. Throws
 * HtmlPermissionError when the result grants Record access the writer lacks.
 */
export function authorizeHtmlPermissions(input: {
  requested: Permissions | undefined
  existing?: Pick<WidgetFile, "permissions" | "requests">
  identity: Pick<TokenIdentity, "agent" | "principal"> | undefined
  scopes: string[]
}): { permissions: Permissions | undefined; requests: Requests } {
  const { requested, existing, identity, scopes } = input
  const permissions = requested ?? existing?.permissions
  for (const [collectionId, grant] of Object.entries(permissions?.records ?? {})) {
    for (const action of RECORD_ACTIONS) {
      if (!grant[action]) continue
      const scope = action === "read" ? "records:read" : "records:write"
      if (hasScope(scopes, scope)) continue
      const collection = collectionId === "*" ? "every collection" : `"${collectionId}"`
      throw new HtmlPermissionError(
        `Nothing was written: the HTML Doc would ${action === "read" ? "read" : action} Records in ${collection} (permissions.records.${collectionId}.${action}), which needs ${scope}. This connection does not have it, so the Doc cannot have it either.`,
        scope
      )
    }
  }
  if (isPersonWriter(identity)) {
    // A person's own choice settles any open request.
    return {
      permissions,
      requests: requested === undefined && !permissions?.network ? existing?.requests : undefined,
    }
  }
  const wantsNetwork = Boolean(
    permissions?.network || (requested === undefined && existing?.requests?.network)
  )
  return {
    permissions: permissions && { ...permissions, network: false },
    requests: wantsNetwork ? { network: true } : undefined,
  }
}

/** What an agent is told when its network request waits for a person. */
export const NETWORK_REQUEST_WARNING: WidgetValidationIssue = {
  severity: "warning",
  code: "network_requested",
  message:
    "Network access is off until a person allows it on the HTML Doc in Worktable. Each agent edit asks again.",
}
