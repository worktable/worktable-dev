import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureAppDir } from "./app-storage.ts";
import { withCrossProcessLock } from "./cross-process-lock.ts";
export { remoteMcpUrl } from "./workspace-origin.ts";

// ============================================================
// Pairing sessions (remote agent connect)
// ============================================================
//
// A pairing session is a short-lived, single-use handshake between the
// Settings "Connect remote agent" flow and the connector running on the
// machine where the coding agent lives. The owner creates a session and
// receives a CODE (shown once, never stored — only its sha256 is). The
// connector redeems the code and gets back the MCP endpoint plus a freshly
// minted scoped bearer; it then reports install progress and commits verified
// completion against the same session. Possession of the code is the
// redemption credential: codes are 50 bits of Crockford base32, single-use,
// and expire quickly.
//
// Sessions are machine-local operational state (like tokens and the owner
// session), so they live in app-private storage — never the workspace.
// Persistence mirrors token-store.ts: atomic tmp+rename, chmod 0o600.

/** How long a pairing code can be redeemed after creation. */
export const PAIRING_TTL_MS = 15 * 60 * 1000;

/** Expired/finished sessions are dropped from disk after this long. */
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Progress events are capped so a hostile code-holder can't grow the file. */
const MAX_EVENTS = 50;
const MAX_DETAIL_LENGTH = 500;

// Crockford base32: no I, L, O, U — unambiguous to read aloud or retype.
// 32 symbols divide 256 evenly, so `byte & 31` introduces no modulo bias.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10; // 50 bits

export type PairingProgressEvent =
  | "redeemed"
  | "config_written"
  | "verifying"
  | "verified"
  | "failed"
  // The connector wrote one or more configs, then restored every attempted
  // config to its pre-run state. This explicit assertion is safe to revoke.
  | "rolled_back"
  // The connector's EXPLICIT assertion that it wrote no config anywhere.
  // Distinct from "failed" because token revocation hangs off it: inferring
  // "nothing was written" from a missing config_written event would revoke
  // a working credential whenever that best-effort report was dropped.
  | "failed_no_config";

export type ConnectorProgressEvent = Exclude<
  PairingProgressEvent,
  "redeemed" | "verified"
>;

/** Progress events the connector may report (redeemed is server-recorded). */
export const CONNECTOR_PROGRESS_EVENTS: readonly ConnectorProgressEvent[] = [
  "config_written",
  "verifying",
  "failed",
  "rolled_back",
  "failed_no_config",
];

export interface PairingEvent {
  at: string;
  event: PairingProgressEvent;
  detail?: string;
}

export interface PairingRedeemer {
  hostname: string | null;
  client: string | null;
  installationId?: string | null;
  /** The connector installed every detected MCP client under one credential. */
  all?: boolean;
}

export type PairingTarget =
  | {
      kind: "mcp-client";
      client: string | null;
      displayName?: string;
    }
  | {
      kind: "agent-adapter";
      adapter: string;
      participantName: string;
      defaultSpaceId?: string;
    };

interface StoredPairingSession {
  /** Public handle for status polling. Carries no redemption authority. */
  id: string;
  /** sha256 hex of the normalized code. The code itself is never stored. */
  codeHash: string;
  /** Client selected in Settings, or null for connector auto-detect. */
  requestedClient: string | null;
  /** Typed destination for this pairing. */
  target: PairingTarget;
  scopes: string[];
  /** The MCP endpoint the connector should configure, resolved at creation. */
  mcpUrl: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedBy: PairingRedeemer | null;
  /** Id of the token minted at redemption, for the Connections table link. */
  tokenId: string | null;
  outcome: "verified" | "failed" | null;
  events: PairingEvent[];
}

export type PairingStatus =
  | "pending"
  | "expired"
  | "redeemed"
  | "verified"
  | "failed";

/** Everything about a session except the code hash, plus derived status. */
export interface PairingSessionView extends Omit<
  StoredPairingSession,
  "codeHash"
> {
  status: PairingStatus;
}

export type RedeemFailureReason = "not_found" | "expired" | "already_redeemed";

export type RedeemResult =
  | { ok: true; session: PairingSessionView }
  | { ok: false; reason: RedeemFailureReason };

export type PairingTargetResult =
  | { ok: true; client: string | null; target: PairingTarget }
  | { ok: false; reason: RedeemFailureReason };

export type ProgressResult =
  | { ok: true; session: PairingSessionView }
  | { ok: false; reason: "not_found" | "not_redeemed" };

export type PairingCompletionResult =
  | { ok: true; session: PairingSessionView }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_redeemed"
        | "token_mismatch"
        | "already_failed";
    };

// ============================================================
// Persistence
// ============================================================

function pairingFile(): string {
  return join(ensureAppDir(), "pairing.json");
}

async function loadSessions(): Promise<StoredPairingSession[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pairingFile(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  if (!Array.isArray(parsed)) return [];
  // Old finished/expired sessions are dropped on load; the trimmed list is
  // persisted by the next mutation's save.
  const cutoff = Date.now() - PURGE_AFTER_MS;
  return (parsed as StoredPairingSession[]).filter(
    (s) => Date.parse(s.expiresAt) > cutoff
  );
}

async function saveSessions(sessions: StoredPairingSession[]): Promise<void> {
  const file = pairingFile();
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(sessions, null, 2), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

// Redemption is single-use, so mutations must not interleave: two concurrent
// redeems of the same code must resolve to exactly one success. All writes
// are serialized through this queue. The in-process queue orders mutations
// within one process; the directory lock adds CROSS-process safety. The
// running server and the CLI's `worktable agent invite` both mutate this
// store, and each save rewrites the whole sessions array, so an unlocked
// interleave could drop a session or a redemption marker.

let mutationQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const locked = () =>
    withCrossProcessLock(
      `${pairingFile()}.lock`,
      { label: "Pairing store" },
      fn
    );
  const next = mutationQueue.then(locked, locked);
  mutationQueue = next.catch(() => undefined);
  return next;
}

// ============================================================
// Codes
// ============================================================

/** Uppercase and strip separators so "abcde-fghjk" redeems as ABCDEFGHJK. */
export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** Group for display: ABCDEFGHJK -> ABCDE-FGHJK. */
export function formatPairingCode(code: string): string {
  const normalized = normalizePairingCode(code);
  const mid = Math.ceil(normalized.length / 2);
  return `${normalized.slice(0, mid)}-${normalized.slice(mid)}`;
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte & 31];
  return code;
}

function hashCode(normalizedCode: string): string {
  return createHash("sha256").update(normalizedCode).digest("hex");
}

/**
 * Find the session matching a presented code. Every stored hash is compared
 * (no early exit) so lookup time does not depend on which — or whether any —
 * session matches.
 */
function findByCode(
  sessions: StoredPairingSession[],
  rawCode: string
): StoredPairingSession | null {
  const presented = Buffer.from(hashCode(normalizePairingCode(rawCode)), "hex");
  let match: StoredPairingSession | null = null;
  for (const session of sessions) {
    const expected = Buffer.from(session.codeHash, "hex");
    if (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    ) {
      match = session;
    }
  }
  return match;
}

// ============================================================
// Views
// ============================================================

function statusOf(session: StoredPairingSession, now: number): PairingStatus {
  if (session.outcome === "verified") return "verified";
  if (session.outcome === "failed") return "failed";
  if (session.redeemedAt) return "redeemed";
  if (Date.parse(session.expiresAt) <= now) return "expired";
  return "pending";
}

function toView(session: StoredPairingSession): PairingSessionView {
  const { codeHash, ...rest } = session;
  void codeHash;
  return { ...rest, status: statusOf(session, Date.now()) };
}

// ============================================================
// API
// ============================================================

export interface CreatePairingOptions {
  client?: string | null;
  target?: PairingTarget;
  scopes: string[];
  mcpUrl: string;
  /** Test seam; production always uses PAIRING_TTL_MS. */
  ttlMs?: number;
}

/**
 * Create a pairing session. The formatted code is returned exactly once and
 * cannot be recovered later — only its hash persists.
 */
export async function createPairingSession(
  options: CreatePairingOptions
): Promise<{ code: string; session: PairingSessionView }> {
  return serialized(async () => {
    const code = generateCode();
    const now = Date.now();
    const stored: StoredPairingSession = {
      id: randomBytes(6).toString("hex"),
      codeHash: hashCode(code),
      requestedClient: options.client ?? null,
      target: options.target ?? {
        kind: "mcp-client",
        client: options.client ?? null,
      },
      scopes: options.scopes,
      mcpUrl: options.mcpUrl,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(
        now + (options.ttlMs ?? PAIRING_TTL_MS)
      ).toISOString(),
      redeemedAt: null,
      redeemedBy: null,
      tokenId: null,
      outcome: null,
      events: [],
    };
    const sessions = await loadSessions();
    sessions.push(stored);
    await saveSessions(sessions);
    return { code: formatPairingCode(code), session: toView(stored) };
  });
}

/** Look up a session by its public id (status polling). */
export async function getPairingSession(
  id: string
): Promise<PairingSessionView | null> {
  const session = (await loadSessions()).find((s) => s.id === id);
  return session ? toView(session) : null;
}

/**
 * Resolve a code's requested client without consuming it so the remote
 * connector can preflight the exact destination before redemption.
 */
export async function getPairingTarget(
  rawCode: string
): Promise<PairingTargetResult> {
  const session = findByCode(await loadSessions(), rawCode);
  if (!session) return { ok: false, reason: "not_found" };
  if (session.redeemedAt) return { ok: false, reason: "already_redeemed" };
  if (Date.parse(session.expiresAt) <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    client: session.requestedClient,
    target: session.target,
  };
}

/**
 * Redeem a code: single-use, only while unexpired. Marks the session redeemed
 * and records who redeemed it; the caller mints the token and attaches it.
 */
export async function redeemPairingSession(
  rawCode: string,
  redeemedBy: PairingRedeemer
): Promise<RedeemResult> {
  return serialized(async () => {
    const sessions = await loadSessions();
    const session = findByCode(sessions, rawCode);
    if (!session) return { ok: false, reason: "not_found" as const };
    if (session.redeemedAt)
      return { ok: false, reason: "already_redeemed" as const };
    if (Date.parse(session.expiresAt) <= Date.now()) {
      return { ok: false, reason: "expired" as const };
    }
    session.redeemedAt = new Date().toISOString();
    session.redeemedBy = redeemedBy;
    session.events.push({ at: session.redeemedAt, event: "redeemed" });
    await saveSessions(sessions);
    return { ok: true as const, session: toView(session) };
  });
}

/** Link the token minted at redemption to its session (Connections table). */
export async function attachPairingToken(
  id: string,
  tokenId: string
): Promise<void> {
  await serialized(async () => {
    const sessions = await loadSessions();
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    session.tokenId = tokenId;
    await saveSessions(sessions);
  });
}

/**
 * Reliably commit successful connector verification. Both the one-use code
 * and the bearer minted for this exact session are required; retries are
 * idempotent so a lost HTTP response cannot strand the rotation protocol.
 */
export async function completePairingSession(
  rawCode: string,
  tokenId: string,
  beforeCommit?: (session: PairingSessionView) => Promise<void>
): Promise<PairingCompletionResult> {
  return serialized(async () => {
    const sessions = await loadSessions();
    const session = findByCode(sessions, rawCode);
    if (!session) return { ok: false, reason: "not_found" as const };
    if (!session.redeemedAt) {
      return { ok: false, reason: "not_redeemed" as const };
    }
    if (!session.tokenId || session.tokenId !== tokenId) {
      return { ok: false, reason: "token_mismatch" as const };
    }
    if (session.outcome === "failed") {
      return { ok: false, reason: "already_failed" as const };
    }

    // Bearer-authenticated completion writes its terminal status only after
    // these durable side effects. The callback is idempotent.
    await beforeCommit?.(toView(session));

    const at = new Date().toISOString();
    if (session.outcome !== "verified" && session.events.length < MAX_EVENTS) {
      session.events.push({ at, event: "verified" });
    }
    session.outcome = "verified";
    await saveSessions(sessions);
    return { ok: true as const, session: toView(session) };
  });
}

/**
 * Append a connector progress event. The code keeps authenticating progress
 * for as long as the (already redeemed) session survives on disk, so a
 * verification that finishes just past the redemption window still lands.
 */
export async function recordPairingProgress(
  rawCode: string,
  event: ConnectorProgressEvent,
  detail?: string
): Promise<ProgressResult> {
  return serialized(async () => {
    const sessions = await loadSessions();
    const session = findByCode(sessions, rawCode);
    if (!session) return { ok: false, reason: "not_found" as const };
    if (!session.redeemedAt)
      return { ok: false, reason: "not_redeemed" as const };
    const duplicateRevocationCommit =
      (event === "rolled_back" || event === "failed_no_config") &&
      session.events.some((existing) => existing.event === event);
    if (!duplicateRevocationCommit && session.events.length < MAX_EVENTS) {
      session.events.push({
        at: new Date().toISOString(),
        event,
        ...(detail ? { detail: detail.slice(0, MAX_DETAIL_LENGTH) } : {}),
      });
    }
    // Only authenticated completion may mark a pairing verified. Explicit
    // failure events remain terminal so unused credentials can be retired.
    if (
      (event === "failed" ||
        event === "rolled_back" ||
        event === "failed_no_config") &&
      session.outcome === null
    ) {
      session.outcome = "failed";
    }
    await saveSessions(sessions);
    return { ok: true as const, session: toView(session) };
  });
}
