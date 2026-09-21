/**
 * The small public subset of Worktable's hosted-agent protocol used by the
 * OpenClaw adapter. A private repository parity test keeps these values aligned
 * with the Worktable server contract without making the published adapter
 * depend on private workspace packages.
 */
export const AGENT_PRESENTATION_HEADERS = {
  ADAPTER: "x-worktable-agent-adapter",
  INSTALLATION: "x-worktable-agent-installation",
  LABEL: "x-worktable-agent-label",
  MACHINE: "x-worktable-agent-machine",
} as const

export type AuthorizationServerMetadataName =
  | "oauth-authorization-server"
  | "openid-configuration"

/** Issuer equality is exact except for an optional trailing slash. */
export function sameAuthorizationServerIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "")
}

/**
 * Candidate discovery URLs in each specification's preferred order. RFC 8414
 * inserts the well-known segment before an issuer path, while OIDC appends it.
 */
export function authorizationServerMetadataCandidates(
  authorizationServer: string,
  name: AuthorizationServerMetadataName
): URL[] {
  const issuer = new URL(authorizationServer)
  const path = issuer.pathname.replace(/\/+$/, "")
  const inserted = new URL(`/.well-known/${name}${path}`, issuer.origin)
  if (!path) return [inserted]
  const appended = new URL(`${path}/.well-known/${name}`, issuer.origin)
  return name === "openid-configuration"
    ? [appended, inserted]
    : [inserted, appended]
}
