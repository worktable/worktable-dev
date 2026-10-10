import type { AgentAccess } from "@worktable/types"
import { fetchJSON } from "./http.ts"

// Client for the /api/pairing surface backing the Settings "Connect remote
// agent" flow. Create/status are owner-gated (same posture as tokens);
// target/redeem/complete/progress belong to the connector on the agent
// machine, never to this UI.

export type PairingStatus =
  | "pending"
  | "expired"
  | "redeemed"
  | "verified"
  | "failed"

export interface PairingEvent {
  at: string
  event:
    | "redeemed"
    | "config_written"
    | "verifying"
    | "verified"
    | "failed"
    | "rolled_back"
    | "failed_no_config"
  detail?: string
}

export interface PairingCreated {
  id: string
  /** Formatted pairing code (ABCDE-FGHJK). Shown once; only its hash persists. */
  code: string
  expiresAt: string
  mcpUrl: string
  client: string | null
  target: PairingTarget
  scopes: string[]
  serverOrigin: string
  originSource: "env" | "config" | "resource" | "request" | "fallback"
}

export interface PairingSession {
  id: string
  status: PairingStatus
  requestedClient: string | null
  target: PairingTarget
  scopes: string[]
  mcpUrl: string
  createdAt: string
  expiresAt: string
  redeemedAt: string | null
  redeemedBy: {
    hostname: string | null
    client: string | null
    installationId?: string | null
  } | null
  tokenId: string | null
  outcome: "verified" | "failed" | null
  events: PairingEvent[]
}

export type PairingTarget =
  | {
      kind: "mcp-client"
      client: string | null
      displayName?: string
    }
  | {
      kind: "agent-adapter"
      adapter: string
      participantName: string
      defaultSpaceId?: string
    }

/** A verified terminal outcome always wins over stale failure events. */
export function latestPairingFailure(
  session: Pick<PairingSession, "status" | "events">
): PairingEvent | undefined {
  if (session.status === "verified") return undefined
  return [...session.events]
    .reverse()
    .find(
      (event) =>
        event.event === "failed" ||
        event.event === "rolled_back" ||
        event.event === "failed_no_config"
    )
}

export function shouldPollPairing(
  session: PairingSession | undefined
): boolean {
  if (!session) return true
  return !["verified", "failed", "expired"].includes(session.status)
}

export function createPairing(
  input: (
    | { client?: string | null; displayName?: string }
    | {
        target: Extract<PairingTarget, { kind: "agent-adapter" }>
      }
  ) & {
    /** What the agent may do; Worktable grants all of it when omitted. */
    access?: AgentAccess
  }
): Promise<PairingCreated> {
  return fetchJSON<PairingCreated>("/api/pairing", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function getPairing(id: string): Promise<PairingSession> {
  return fetchJSON<PairingSession>(`/api/pairing/${encodeURIComponent(id)}`)
}

/** An agent waiting for its owner to approve it. */
export interface ConnectionRequest {
  userCode: string
  target:
    | { kind: "agent-adapter"; adapter: string; installationId: string }
    | { kind: "mcp-client"; client: string | null }
  hostname: string | null
  suggestedName: string | null
  createdAt: string
  expiresAt: string
}

export function getConnectionRequest(
  code: string
): Promise<{ request: ConnectionRequest }> {
  return fetchJSON(`/api/pairing/requests/${encodeURIComponent(code)}`)
}

export function approveConnectionRequest(
  code: string,
  approval: { displayName: string; icon: string | null; access: AgentAccess }
): Promise<{ ok: true }> {
  return fetchJSON(
    `/api/pairing/requests/${encodeURIComponent(code)}/approve`,
    { method: "POST", body: JSON.stringify(approval) }
  )
}

export function denyConnectionRequest(code: string): Promise<{ ok: true }> {
  return fetchJSON(`/api/pairing/requests/${encodeURIComponent(code)}/deny`, {
    method: "POST",
  })
}
