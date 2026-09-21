import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { ensureAppDir } from "./app-storage.ts";
import { isHosted } from "./hosted.ts";

// ============================================================
// Owner-password session store (machine-local credential authority)
// ============================================================
//
// When the server is exposed (authRequired()), the web/REST/WS surfaces are
// gated behind a single OWNER PASSWORD delivered as a signed, httpOnly session
// cookie. This module is the only authority for that credential.
//
// Persistence mirrors token-store.ts: ensureAppDir() (0o700 dir), atomic
// tmp+rename writes, chmod 0o600. The on-disk file `session.json` lives under
// the app data root, NEVER the workspace — the owner credential is machine-
// local and survives a workspace switch (a documented asymmetry vs tokens,
// which are workspace-bound).
//
// SINGLE HMAC SCHEME, ONE VERIFIER. We do NOT mix Hono's signed-cookie helper
// with a hand-rolled verifier (signature-format drift risk). Instead we sign
// the payload ourselves — HMAC-SHA256(secret, name + "." + payload), base64url
// — and route BOTH the Context path (verifyOwnerSessionCookie) and the raw
// Request path (verifyRawCookieHeader, used by the WS handshake) through one
// verifySignedValue(). The cookie value is `<payloadB64url>.<sigB64url>`.

export const SESSION_COOKIE_NAME = "wt_session";

// 7 days. Shorter than a typical 30d session because plain-http is a
// warned-but-supported exposure mode (a cookie can't be Secure there).
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const PAYLOAD_VERSION = 1;

interface SessionPayload {
  v: number;
  sub: "owner";
  iat: number;
  exp: number;
}

interface StoredSession {
  /** Argon2id hash of the owner password (Bun.password), or null if unset. */
  passwordHash: string | null;
  /** base64url-encoded 32-byte HMAC secret used to sign session cookies. */
  secret: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Persistence
// ============================================================

function sessionFile(): string {
  return join(ensureAppDir(), "session.json");
}

async function loadSession(): Promise<StoredSession | null> {
  try {
    const raw = await readFile(sessionFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["secret"] !== "string") return null;
    return {
      passwordHash:
        typeof obj["passwordHash"] === "string" ? obj["passwordHash"] : null,
      secret: obj["secret"],
      createdAt:
        typeof obj["createdAt"] === "string"
          ? obj["createdAt"]
          : new Date().toISOString(),
      updatedAt:
        typeof obj["updatedAt"] === "string"
          ? obj["updatedAt"]
          : new Date().toISOString(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function saveSession(session: StoredSession): Promise<void> {
  const file = sessionFile();
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(session, null, 2), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

function freshSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Load the session record, creating a fresh one (with a new HMAC secret and no
 * password) on first use. The HMAC secret must exist before any cookie can be
 * issued or verified.
 */
async function ensureSession(): Promise<StoredSession> {
  const existing = await loadSession();
  if (existing) return existing;
  const now = new Date().toISOString();
  const created: StoredSession = {
    passwordHash: null,
    secret: freshSecret(),
    createdAt: now,
    updatedAt: now,
  };
  await saveSession(created);
  return created;
}

// ============================================================
// Owner password API
// ============================================================

/** True once an owner password has been set. */
export async function hasOwnerPassword(): Promise<boolean> {
  const session = await loadSession();
  return Boolean(session?.passwordHash);
}

/**
 * Synchronous owner-password existence check for the bind-time guard in
 * startServer (which is synchronous and must refuse to bind an exposed server
 * before any listener exists). Never creates the file.
 */
export function hasOwnerPasswordSync(): boolean {
  try {
    const raw = readFileSync(sessionFile(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed["passwordHash"] === "string" && parsed["passwordHash"].length > 0;
  } catch {
    return false;
  }
}

/** Set (or replace) the owner password. Hashed with Argon2id (Bun.password). */
export async function setOwnerPassword(password: string): Promise<void> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Owner password must be a non-empty string");
  }
  const session = await ensureSession();
  session.passwordHash = await Bun.password.hash(password, "argon2id");
  session.updatedAt = new Date().toISOString();
  await saveSession(session);
}

/** Verify a presented owner password against the stored hash. */
export async function verifyOwnerPassword(password: string): Promise<boolean> {
  const session = await loadSession();
  if (!session?.passwordHash) return false;
  try {
    return await Bun.password.verify(password, session.passwordHash);
  } catch {
    return false;
  }
}

/** The HMAC secret used to sign session cookies, creating it on first use. */
export async function getSessionSecret(): Promise<string> {
  return (await ensureSession()).secret;
}

/**
 * Rotate the HMAC secret ("sign out everywhere"): every previously issued
 * cookie immediately fails verification. The owner password is preserved.
 */
export async function rotateSessionSecret(): Promise<void> {
  const session = await ensureSession();
  session.secret = freshSecret();
  session.updatedAt = new Date().toISOString();
  await saveSession(session);
}

// ============================================================
// Cookie signing — single scheme, single verifier
// ============================================================

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(secret: string, name: string, payloadB64: string): string {
  return createHmac("sha256", secret)
    .update(`${name}.${payloadB64}`)
    .digest("base64url");
}

function signValue(secret: string, name: string, payload: SessionPayload): string {
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = sign(secret, name, payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * The one verifier both the Context and raw-Request paths route through. Returns
 * the payload only when the signature matches the current secret, the subject is
 * "owner", and the cookie has not expired.
 */
function verifySignedValue(
  secret: string,
  name: string,
  value: string
): SessionPayload | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = value.slice(0, dot);
  const presentedSig = value.slice(dot + 1);
  const expectedSig = sign(secret, name, payloadB64);
  const a = Buffer.from(presentedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as SessionPayload;
  } catch {
    return null;
  }
  if (payload.sub !== "owner") return null;
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

// ============================================================
// Cookie options
// ============================================================

/**
 * Centralized cookie attributes. SameSite lives here as a single constant so a
 * future widget-cookie requirement is a one-line flip to "None" (which would in
 * turn force Secure / https-only). `secure` is set only when the request is
 * https, since plain-http exposure is a warned-but-supported mode.
 */
function cookieOpts(isHttps: boolean) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: isHttps,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

function requestIsHttps(c: Context): boolean {
  // Reflect the actual request scheme. We deliberately do NOT trust
  // X-Forwarded-Proto (the user fronts their own tunnel; trust-proxy is out of
  // scope), so Secure is set only when this hop is genuinely https.
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

// ============================================================
// Cookie helpers (Context path)
// ============================================================

/** Issue a fresh signed owner session cookie on the response. */
export async function issueSessionCookie(c: Context): Promise<void> {
  const secret = await getSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    v: PAYLOAD_VERSION,
    sub: "owner",
    iat: now,
    exp: now + SESSION_MAX_AGE_SECONDS,
  };
  const value = signValue(secret, SESSION_COOKIE_NAME, payload);
  setCookie(c, SESSION_COOKIE_NAME, value, cookieOpts(requestIsHttps(c)));
}

/** Verify the owner session cookie on an inbound Context. */
export async function verifyOwnerSessionCookie(c: Context): Promise<boolean> {
  // Hosted tenant instances have no owner-session surface: identity arrives
  // only as gateway-issued bearers. A stale cookie (e.g. an app-data dir
  // reused from a non-hosted run) must not authenticate anything, so both
  // verifiers fail closed here rather than at each call site.
  if (isHosted()) return false;
  const value = getCookie(c, SESSION_COOKIE_NAME);
  if (!value) return false;
  const secret = await getSessionSecret();
  return verifySignedValue(secret, SESSION_COOKIE_NAME, value) !== null;
}

/** Clear the owner session cookie (logout). */
export function clearSessionCookie(c: Context): void {
  setCookie(c, SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "Lax",
    secure: requestIsHttps(c),
    path: "/",
    maxAge: 0,
  });
}

// ============================================================
// Raw-Request verifier (WS handshake)
// ============================================================

function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * Verify the owner session cookie straight off a raw Cookie header. Used by the
 * WebSocket upgrade path (which has no Hono Context). Routes through the SAME
 * verifySignedValue() as the Context path, so the two can never drift.
 */
export async function verifyRawCookieHeader(
  header: string | null | undefined
): Promise<boolean> {
  // Same hosted fail-closed rule as verifyOwnerSessionCookie above.
  if (isHosted()) return false;
  if (!header) return false;
  const value = parseCookieHeader(header)[SESSION_COOKIE_NAME];
  if (!value) return false;
  const secret = await getSessionSecret();
  return verifySignedValue(secret, SESSION_COOKIE_NAME, value) !== null;
}
