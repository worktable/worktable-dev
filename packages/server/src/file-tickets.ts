// ============================================================
// File links for agents
// ============================================================
//
// An agent with a shell moves a file's bytes outside its tool calls: an
// upload link takes them with `curl -T`, and a download link gives them
// back. A link carries the right of the request that made it, for one file
// and a few minutes: an upload link works once, a download link until it
// expires. The link's token is the only key, so only its hash is kept, in
// this process's memory: a restart ends every link.

import { createHash, randomBytes } from "node:crypto"
import type { RequestPrincipal, TokenIdentity } from "./token-store.ts"
import type { FileUploadMode } from "./file-uploads.ts"

/** How long a link works after it is made. */
export const FILE_TICKET_TTL_MS = 10 * 60_000
/** Links held at once; making one past this drops the oldest. */
const FILE_TICKETS_MAX = 10_000

interface TicketBase {
  spaceId: string
  path: string
  /**
   * Who made the link: the write or read runs as them, with their access
   * checked again. Absent where the request carried no team identity.
   */
  identity: TokenIdentity | null
  principal: RequestPrincipal
  /** The name a write is recorded under, as the tool call's would be. */
  actor: string
  expiresAt: number
}

export type FileTicket =
  | (TicketBase & { kind: "upload"; mode: FileUploadMode })
  | (TicketBase & { kind: "download" })

/** A file link's ticket, before its token. */
export type FileTicketInput =
  | Omit<Extract<FileTicket, { kind: "upload" }>, "expiresAt">
  | Omit<Extract<FileTicket, { kind: "download" }>, "expiresAt">

const tickets = new Map<string, FileTicket>()

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url")
}

function sweep(now: number): void {
  for (const [hash, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(hash)
  }
}

/** Make a link: its token, and when it stops working. */
export function issueFileTicket(
  input: FileTicketInput,
  now = Date.now()
): { token: string; expiresAt: number } {
  sweep(now)
  if (tickets.size >= FILE_TICKETS_MAX) {
    const oldest = tickets.keys().next().value
    if (oldest !== undefined) tickets.delete(oldest)
  }
  const token = randomBytes(32).toString("base64url")
  const expiresAt = now + FILE_TICKET_TTL_MS
  tickets.set(tokenHash(token), { ...input, expiresAt } as FileTicket)
  return { token, expiresAt }
}

/**
 * The ticket a link's token names, while it works. An upload link is used
 * up here, before its bytes arrive, so a second send can't write twice.
 */
export function redeemFileTicket(
  token: string,
  kind: FileTicket["kind"],
  now = Date.now()
): FileTicket | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const hash = tokenHash(token)
  const ticket = tickets.get(hash)
  if (!ticket || ticket.kind !== kind) return null
  if (ticket.expiresAt <= now) {
    tickets.delete(hash)
    return null
  }
  if (ticket.kind === "upload") tickets.delete(hash)
  return ticket
}

/** Forget every link; tests use this. */
export function clearFileTickets(): void {
  tickets.clear()
}
