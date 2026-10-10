import type { AgentAccess } from "@worktable/types"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { formatPairingCode, normalizePairingCode } from "./pairing-store.ts"

// ============================================================
// Connection requests (an agent asks; the owner approves)
// ============================================================
//
// The other way to start a pairing. An agent that knows only Worktable's
// address asks to connect and shows its owner a short code and a link. The
// owner opens the link signed in, checks the code, chooses the agent's name,
// icon, and access, and approves. Nothing secret is stored: when the agent
// next polls, Worktable creates an ordinary pairing session with those
// choices and hands its one-time code to that agent alone, which then pairs
// as usual.

const REQUEST_TTL_MS = 15 * 60 * 1000
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000
/** Waiting requests from one sender: enough for a few computers behind it. */
const MAX_PENDING_PER_SOURCE = 3
/** All waiting requests, a bound on storage only. */
const MAX_PENDING = 100
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ" // no vowels: no words
const USER_CODE_LENGTH = 8

export type ConnectionRequestTarget =
  | { kind: "agent-adapter"; adapter: string; installationId: string }
  | { kind: "mcp-client"; client: string | null }

/** What the owner chose when approving. */
export interface ConnectionApproval {
  displayName: string
  icon: string | null
  access: AgentAccess
}

export interface ConnectionRequestView {
  userCode: string
  target: ConnectionRequestTarget
  hostname: string | null
  suggestedName: string | null
  createdAt: string
  expiresAt: string
}

interface StoredConnectionRequest {
  userCodeHash: string
  pollTokenHash: string
  target: ConnectionRequestTarget
  hostname: string | null
  suggestedName: string | null
  createdAt: string
  expiresAt: string
  status: "pending" | "approved" | "denied" | "delivered"
  approval?: ConnectionApproval
  /** Who asked, hashed: one sender cannot crowd out everyone else. */
  sourceHash?: string
}

export type ConnectionRequestPoll =
  | { status: "pending" | "denied" | "expired" }
  | { status: "approved"; code: string }

function requestsFile(): string {
  return join(ensureAppDir(), "connection-requests.json")
}

async function loadRequests(): Promise<StoredConnectionRequest[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(requestsFile(), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  if (!Array.isArray(parsed)) return []
  const cutoff = Date.now() - PURGE_AFTER_MS
  return (parsed as StoredConnectionRequest[]).filter(
    (request) => Date.parse(request.expiresAt) > cutoff
  )
}

let tmpCounter = 0

async function saveRequests(requests: StoredConnectionRequest[]) {
  const file = requestsFile()
  const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`
  await writeFile(tmp, JSON.stringify(requests, null, 2), "utf8")
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

let mutationQueue: Promise<unknown> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const locked = () =>
    withCrossProcessLock(
      `${requestsFile()}.lock`,
      { label: "Connection requests" },
      fn
    )
  const next = mutationQueue.then(locked, locked)
  mutationQueue = next.catch(() => undefined)
  return next
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === right.length && timingSafeEqual(left, right)
}

function generateUserCode(): string {
  let code = ""
  for (const byte of randomBytes(USER_CODE_LENGTH)) {
    code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
  }
  return code
}

function isLive(request: StoredConnectionRequest, now: number): boolean {
  return Date.parse(request.expiresAt) > now
}

function toView(
  request: StoredConnectionRequest,
  userCode: string
): ConnectionRequestView {
  return {
    userCode: formatPairingCode(userCode),
    target: request.target,
    hostname: request.hostname,
    suggestedName: request.suggestedName,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  }
}

export class ConnectionRequestLimitError extends Error {}

/** An agent asks to connect. Returns its code, and the secret it polls with. */
export async function createConnectionRequest(input: {
  target: ConnectionRequestTarget
  hostname: string | null
  suggestedName: string | null
  /** The sender, as requestSource reports it. */
  source: string
}): Promise<{ userCode: string; pollToken: string; expiresAt: string }> {
  return serialized(async () => {
    const now = Date.now()
    const requests = await loadRequests()
    const pending = requests.filter(
      (request) => request.status === "pending" && isLive(request, now)
    )
    const sourceHash = hash(`source:${input.source}`)
    if (
      pending.filter((request) => request.sourceHash === sourceHash).length >=
      MAX_PENDING_PER_SOURCE
    ) {
      throw new ConnectionRequestLimitError(
        "Agents from this address are already waiting for approval. Approve them, or try again once they expire."
      )
    }
    if (pending.length >= MAX_PENDING) {
      throw new ConnectionRequestLimitError(
        "Too many agents are waiting for approval. Try again later."
      )
    }
    const userCode = generateUserCode()
    const pollToken = randomBytes(32).toString("base64url")
    const expiresAt = new Date(now + REQUEST_TTL_MS).toISOString()
    requests.push({
      userCodeHash: hash(userCode),
      pollTokenHash: hash(pollToken),
      target: input.target,
      hostname: input.hostname,
      suggestedName: input.suggestedName,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      status: "pending",
      sourceHash,
    })
    await saveRequests(requests)
    return { userCode: formatPairingCode(userCode), pollToken, expiresAt }
  })
}

function findByUserCode(
  requests: StoredConnectionRequest[],
  rawCode: string
): StoredConnectionRequest | undefined {
  const presented = hash(normalizePairingCode(rawCode))
  let match: StoredConnectionRequest | undefined
  for (const request of requests) {
    if (sameHash(request.userCodeHash, presented)) match = request
  }
  return match
}

/** A pending request, as its owner sees it before approving. */
export async function getConnectionRequest(
  rawCode: string
): Promise<ConnectionRequestView | null> {
  const request = findByUserCode(await loadRequests(), rawCode)
  return request && request.status === "pending" && isLive(request, Date.now())
    ? toView(request, normalizePairingCode(rawCode))
    : null
}

/** Settle a pending request. Returns null when it is gone, settled, or expired. */
export async function settleConnectionRequest(
  rawCode: string,
  approval: ConnectionApproval | null
): Promise<ConnectionRequestView | null> {
  return serialized(async () => {
    const requests = await loadRequests()
    const request = findByUserCode(requests, rawCode)
    if (
      !request ||
      request.status !== "pending" ||
      !isLive(request, Date.now())
    ) {
      return null
    }
    if (approval) {
      request.status = "approved"
      request.approval = approval
    } else {
      request.status = "denied"
    }
    await saveRequests(requests)
    return toView(request, normalizePairingCode(rawCode))
  })
}

/**
 * The asking agent checks on its request. Once approved, `createPairing`
 * makes the pairing with the owner's choices, and its code goes to this agent.
 */
export async function pollConnectionRequest(
  pollToken: string,
  createPairing: (
    target: ConnectionRequestTarget,
    approval: ConnectionApproval
  ) => Promise<string>
): Promise<ConnectionRequestPoll | null> {
  return serialized(async () => {
    const requests = await loadRequests()
    const presented = hash(pollToken)
    const request = requests.find((candidate) =>
      sameHash(candidate.pollTokenHash, presented)
    )
    if (!request) return null
    if (request.status === "denied") return { status: "denied" }
    if (request.status === "delivered" || !isLive(request, Date.now())) {
      return { status: "expired" }
    }
    if (request.status === "pending" || !request.approval) {
      return { status: "pending" }
    }
    const code = await createPairing(request.target, request.approval)
    request.status = "delivered"
    await saveRequests(requests)
    return { status: "approved", code }
  })
}
