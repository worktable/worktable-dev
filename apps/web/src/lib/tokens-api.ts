import { fetchJSON, fetchVoid } from "./http.ts"

// Client for the /api/tokens surface backing the Settings "Connections" group.
// Follows system-api.ts conventions (fetchJSON/fetchVoid carry credentials and
// drive the 401 → login redirect).

export interface TokenMetadata {
  /** 12-char hex handle (the `id` segment of `wt_<id>_<secret>`). */
  id: string
  /** Owner/user the credential belongs to (e.g. "owner"). */
  user: string
  /** Agent label, or null for a human/owner credential. */
  agent: string | null
  /** Granted scopes, e.g. ["docs:*", "search:read"] or ["*"]. */
  scopes: string[]
  /** Absolute workspace root the token is bound to. */
  workspace: string
  createdAt: string
  /** ISO timestamp once revoked; null while active. */
  revokedAt: string | null
  /** When the token last verified successfully (throttled); null = never seen. */
  lastUsedAt: string | null
}

export interface MintTokenInput {
  scopes: string[]
  agent?: string | null
}

export interface MintTokenResult {
  /** Full token string, shown exactly once: "wt_<id>_<secret>". */
  token: string
  metadata: TokenMetadata
}

export function listTokens(): Promise<TokenMetadata[]> {
  return fetchJSON<{ tokens: TokenMetadata[] }>("/api/tokens").then(
    (r) => r.tokens
  )
}

export function mintToken(input: MintTokenInput): Promise<MintTokenResult> {
  return fetchJSON<MintTokenResult>("/api/tokens", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function revokeToken(id: string): Promise<void> {
  return fetchVoid(`/api/tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
}
