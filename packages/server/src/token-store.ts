import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { listSpaces } from "./store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"

// ============================================================
// Access tokens
// ============================================================
//
// The single credential shape the core understands:
//
//   { user, workspace, scopes, agent, principal }
//
// Who issues tokens differs per deployment (local mint today, control
// plane later); validation does not. Token string format:
//
//   wt_<id>_<secret>
//     id      6 random bytes, hex (12 chars) — public handle for list/revoke
//     secret  32 random bytes, base64url — never stored; only its sha256 is
//
// Tokens are persisted in app-private storage (see app-storage.ts),
// never in the workspace folder.

export type PrincipalType = "human" | "agent" | "system"

export interface RequestPrincipal {
  /** Stable opaque key written to provenance fields. */
  id: string
  type: PrincipalType
  displayName: string
  /** Human principal that delegated authority to an agent. */
  authorizedBy?: string
}

export interface TokenIdentity {
  user: string
  workspace: string
  /**
   * How the request credential was established. Runtime verifiers always set
   * this; omission remains fail-closed for older call sites and test fixtures.
   */
  credentialClass?: "local" | "browser" | "resource"
  /** Scope strings: "*", "docs:*", "docs:read", "tokens:manage", ... */
  scopes: string[]
  /** Agent label ("claude-code", ...) or null for human/owner credentials. */
  agent: string | null
  principal: RequestPrincipal
}

export interface TokenMetadata extends Omit<
  TokenIdentity,
  "principal" | "credentialClass"
> {
  principal: RequestPrincipal
  id: string
  createdAt: string
  revokedAt: string | null
  /**
   * When this token last verified successfully (throttled stamp; see
   * recordTokenUsage). The truthful "is this agent still connected" signal:
   * MCP is stateless, so last-seen is what connectivity actually means.
   */
  lastUsedAt: string | null
}

// lastUsedAt is NOT part of the stored credential record — it lives in the
// separate usage file (see recordTokenUsage) and is merged in at read time.
interface StoredToken extends Omit<TokenMetadata, "lastUsedAt" | "principal"> {
  /** sha256 hex of the secret part. The secret itself is never stored. */
  secretHash: string
}

const TOKEN_FORMAT = /^wt_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/
const SCOPE_FORMAT = /^(\*|[a-z][a-z0-9_-]*:(\*|[a-z][a-z0-9_-]*))$/

/** The current scope vocabulary (advertised in OAuth discovery metadata). */
export const KNOWN_SCOPES = [
  "*",
  "documents:read",
  "documents:write",
  "docs:read",
  "docs:write",
  "widgets:read",
  "widgets:write",
  "records:read",
  "records:write",
  "annotations:read",
  "annotations:write",
  "threads:read",
  "threads:write",
  "threads:participate",
  "search:read",
  "workspace:export",
  "tokens:manage",
]

// ============================================================
// Scope matching
// ============================================================

/** True if `scope` is a syntactically valid scope string. */
export function isValidScope(scope: string): boolean {
  return SCOPE_FORMAT.test(scope)
}

/**
 * True if the granted scopes satisfy the required scope.
 * "*" grants everything; "docs:*" grants any "docs:..." action.
 */
export function hasScope(granted: string[], required: string): boolean {
  for (const scope of granted) {
    if (scope === "*") return true
    if (scope === required) return true
    if (scope.endsWith(":*")) {
      const prefix = scope.slice(0, -1) // "docs:*" -> "docs:"
      if (required.startsWith(prefix)) return true
    }
  }
  return false
}

// ============================================================
// Persistence
// ============================================================

function tokensFile(): string {
  return join(ensureAppDir(), "tokens.json")
}

async function loadTokens(): Promise<StoredToken[]> {
  try {
    const raw = await readFile(tokensFile(), "utf8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as StoredToken[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

// Unique per write: concurrent writers sharing one pid-derived tmp path can
// interleave (one rename wins, the other ENOENTs or ships the wrong bytes).
let tmpCounter = 0

function tmpPathFor(file: string): string {
  return `${file}.tmp-${process.pid}-${tmpCounter++}`
}

// Mutations are load-mutate-save on a shared file; interleaving two of them
// loses whichever wrote first (e.g. concurrent pairing redeems minting
// tokens). All writes to tokens.json and token-usage.json are serialized
// through this queue (single-process server).
let mutationQueue: Promise<unknown> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const locked = () =>
    withCrossProcessLock(
      `${tokensFile()}.lock`,
      { label: "Access token state" },
      fn
    )
  const next = mutationQueue.then(locked, locked)
  mutationQueue = next.catch(() => undefined)
  return next
}

async function saveTokens(tokens: StoredToken[]): Promise<void> {
  const file = tokensFile()
  const tmp = tmpPathFor(file)
  await writeFile(tmp, JSON.stringify(tokens, null, 2), "utf8")
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

async function notifyParticipantsChanged(): Promise<void> {
  try {
    notifyWorkspaceChange({ type: "participants" })
    for (const space of await listSpaces()) {
      notifyWorkspaceChange({ type: "participants", spaceId: space.id })
    }
  } catch (error) {
    console.error(
      "[tokens] credential state changed, but participant invalidation failed:",
      error
    )
  }
}

function toMetadata(
  token: StoredToken,
  usage?: Record<string, string>
): TokenMetadata {
  return {
    id: token.id,
    user: token.user,
    workspace: token.workspace,
    scopes: token.scopes,
    agent: token.agent,
    createdAt: token.createdAt,
    revokedAt: token.revokedAt,
    principal: principalForStoredToken(token),
    lastUsedAt: usage?.[token.id] ?? null,
  }
}

function principalForStoredToken(token: StoredToken): RequestPrincipal {
  return {
    id: `local-token:${token.id}`,
    type: token.agent ? "agent" : "human",
    displayName: token.agent ?? token.user,
    ...(token.agent ? { authorizedBy: "local:owner" } : {}),
  }
}

// ============================================================
// Usage stamps (last seen)
// ============================================================
//
// lastUsedAt lives in its own file, NOT tokens.json: usage stamps happen on
// the hot verify path and must never race a revocation write on the
// credential file. Losing a stamp is harmless; losing a revocation is not.
// Best-effort by design — a stamp failure never fails verification.

const USAGE_STAMP_INTERVAL_MS = 60_000

/** In-memory throttle: at most one disk write per token per interval. */
const usageStampedAt = new Map<string, number>()

function usageFile(): string {
  return join(ensureAppDir(), "token-usage.json")
}

async function loadUsage(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(usageFile(), "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    const usage: Record<string, string> = {}
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "string") usage[id] = at
    }
    return usage
  } catch {
    // Missing or corrupt usage data degrades to "never seen", never to an error.
    return {}
  }
}

async function recordTokenUsage(id: string): Promise<void> {
  const now = Date.now()
  const last = usageStampedAt.get(id)
  if (last !== undefined && now - last < USAGE_STAMP_INTERVAL_MS) return
  usageStampedAt.set(id, now)
  try {
    // Serialized like every other store write: two tokens verifying at once
    // must not lose one stamp to a load/save interleave (the throttle entry
    // is already set, so a swallowed write would stay invisible for 60s).
    await serialized(async () => {
      const usage = await loadUsage()
      usage[id] = new Date(now).toISOString()
      const file = usageFile()
      const tmp = tmpPathFor(file)
      await writeFile(tmp, JSON.stringify(usage, null, 2), "utf8")
      await chmod(tmp, 0o600)
      await rename(tmp, file)
    })
  } catch {
    // Best-effort: verification must not depend on the stamp landing.
  }
}

// ============================================================
// API
// ============================================================

export interface CreateTokenOptions {
  scopes: string[]
  agent?: string | null
  user?: string
  workspace?: string
}

/** Extract the public token handle without accepting a malformed bearer. */
export function tokenIdFromToken(raw: string): string | null {
  return TOKEN_FORMAT.exec(raw)?.[1] ?? null
}

/** Mint inside an already-serialized mutation. Never call directly. */
async function mintTokenLocked(
  options: CreateTokenOptions
): Promise<{ token: string; metadata: TokenMetadata }> {
  if (options.scopes.length === 0) {
    throw new Error("Token must have at least one scope")
  }
  for (const scope of options.scopes) {
    if (!isValidScope(scope)) throw new Error(`Invalid scope: ${scope}`)
  }

  const id = randomBytes(6).toString("hex")
  const secret = randomBytes(32).toString("base64url")
  const stored: StoredToken = {
    id,
    secretHash: createHash("sha256").update(secret).digest("hex"),
    user: options.user ?? "owner",
    workspace: options.workspace ?? getWorkspaceRoot(),
    scopes: options.scopes,
    agent: options.agent ?? null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  }

  const tokens = await loadTokens()
  tokens.push(stored)
  await saveTokens(tokens)

  return { token: `wt_${id}_${secret}`, metadata: toMetadata(stored) }
}

/**
 * Mint a new token. The full token string is returned exactly once and
 * cannot be recovered later.
 */
export async function createToken(
  options: CreateTokenOptions
): Promise<{ token: string; metadata: TokenMetadata }> {
  return serialized(() => mintTokenLocked(options))
}

/** List token metadata. Secret hashes are never exposed. */
export async function listTokens(): Promise<TokenMetadata[]> {
  const usage = await loadUsage()
  return (await loadTokens()).map((token) => toMetadata(token, usage))
}

/**
 * Revoke every active token carrying this agent label, then mint a fresh one.
 * Re-connecting the same client+machine rotates its credential instead of
 * accumulating rows (same bounding rule as the CLI's managed-config token).
 */
export async function rotateAgentToken(options: {
  agent: string
  scopes: string[]
}): Promise<{ token: string; metadata: TokenMetadata }> {
  // One serialized step for revoke + mint: concurrent redeems must each get
  // a token that survives (interleaved load/saves would drop one mint).
  return serialized(async () => {
    const tokens = await loadTokens()
    // Rotation is scoped to the CURRENT workspace: tokens are workspace-bound,
    // and a same-label token minted for another workspace must keep working
    // when the user switches back to it.
    const workspace = getWorkspaceRoot()
    let changed = false
    for (const token of tokens) {
      if (
        token.agent === options.agent &&
        token.workspace === workspace &&
        !token.revokedAt
      ) {
        token.revokedAt = new Date().toISOString()
        changed = true
      }
    }
    if (changed) await saveTokens(tokens)
    return mintTokenLocked({ scopes: options.scopes, agent: options.agent })
  })
}

/**
 * Retire a freshly verified agent token's active predecessors for its label
 * and workspace. Pairing uses this two-phase form so the credential
 * already present in a client config remains valid until its replacement has
 * been written and verified successfully. Tokens minted later are preserved:
 * a delayed completion from an older pairing must never revoke newer config.
 */
export async function finalizeAgentTokenRotations(
  ids: string[],
  options: { retireAgentLabels?: string[] } = {}
): Promise<boolean> {
  const result = await serialized(async () => {
    const tokens = await loadTokens()
    const winnerIds = new Set(ids)
    if (winnerIds.size === 0 || winnerIds.size !== ids.length) {
      return { ok: false, changed: false }
    }
    const winners = ids.map((id) => {
      const index = tokens.findIndex((token) => token.id === id)
      return { index, token: tokens[index] }
    })
    if (
      winners.some(({ token }) => !token || token.revokedAt || !token.agent) ||
      new Set(
        winners.map(
          ({ token }) => `${token!.workspace}\0${token!.agent as string}`
        )
      ).size !== winners.length
    ) {
      return { ok: false, changed: false }
    }

    const retirementBoundaries = new Map<string, number>()
    for (const { index, token } of winners) {
      retirementBoundaries.set(
        token!.workspace,
        Math.min(retirementBoundaries.get(token!.workspace) ?? index, index)
      )
    }
    const retiredLabels = new Set(options.retireAgentLabels ?? [])

    let changed = false
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!
      if (winnerIds.has(token.id) || token.revokedAt) continue
      const replacedByWinner = winners.some(
        ({ index: winnerIndex, token: winner }) =>
          index < winnerIndex &&
          token.agent === winner!.agent &&
          token.workspace === winner!.workspace
      )
      const retirementBoundary = retirementBoundaries.get(token.workspace)
      const retiredLegacyLabel =
        token.agent !== null &&
        retiredLabels.has(token.agent) &&
        retirementBoundary !== undefined &&
        index < retirementBoundary
      if (replacedByWinner || retiredLegacyLabel) {
        token.revokedAt = new Date().toISOString()
        changed = true
      }
    }
    if (changed) await saveTokens(tokens)
    return { ok: true, changed }
  })
  if (result.changed) {
    await notifyParticipantsChanged()
  }
  return result.ok
}

export async function finalizeAgentTokenRotation(id: string): Promise<boolean> {
  return finalizeAgentTokenRotations([id])
}

/** Revoke a token by id. Returns false if the id is unknown. */
export async function revokeToken(id: string): Promise<boolean> {
  const revoked = await serialized(async () => {
    const tokens = await loadTokens()
    const token = tokens.find((t) => t.id === id)
    if (!token) return undefined
    if (!token.revokedAt) {
      token.revokedAt = new Date().toISOString()
      await saveTokens(tokens)
    }
    return true
  })
  if (revoked === undefined) return false
  await notifyParticipantsChanged()
  return true
}

/** True if any unrevoked token exists (auth is "configured"). */
export async function hasActiveTokens(): Promise<boolean> {
  return (await loadTokens()).some((t) => !t.revokedAt)
}

/**
 * Verify a presented token string. Returns its identity, or null for
 * anything malformed, unknown, revoked, or minted for another workspace.
 */
export async function verifyToken(raw: string): Promise<TokenIdentity | null> {
  const match = TOKEN_FORMAT.exec(raw)
  if (!match) return null
  const [, id, secret] = match

  const tokens = await loadTokens()
  const stored = tokens.find((t) => t.id === id)
  if (!stored || stored.revokedAt) return null

  const presented = createHash("sha256").update(secret!).digest()
  const expected = Buffer.from(stored.secretHash, "hex")
  if (presented.length !== expected.length) return null
  if (!timingSafeEqual(presented, expected)) return null

  // Tokens are bound to the workspace they were minted for. A moved or
  // switched workspace invalidates them; re-mint rather than carry over.
  if (stored.workspace !== getWorkspaceRoot()) return null

  await recordTokenUsage(id!)

  return {
    user: stored.user,
    workspace: stored.workspace,
    credentialClass: "local",
    scopes: stored.scopes,
    agent: stored.agent,
    principal: principalForStoredToken(stored),
  }
}
