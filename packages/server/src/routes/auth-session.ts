import { sameOriginRequestAllowed } from "../auth.ts";
import { SOURCE_URL } from "../release-info.ts";
import { Hono } from "hono";
import type { Context } from "hono";
import { authRequired } from "../auth.ts";
import { isHosted } from "../hosted.ts";
import {
  clearSessionCookie,
  hasOwnerPassword,
  issueSessionCookie,
  rotateSessionSecret,
  setOwnerPassword,
  verifyOwnerPassword,
  verifyOwnerSessionCookie,
} from "../session-store.ts";

// ============================================================
// Owner-password session API
// ============================================================
//
// Drives the web login page. These routes must be reachable WITHOUT a session
// cookie (login/status), so they are mounted OUTSIDE the /api/* identity
// middleware. They form the cookie surface only — MCP's bearer surface is
// untouched and cookies never authenticate /mcp.

export const authSessionRouter = new Hono();

// Hosted tenant instances have NO owner-password surface at all: identity is
// AS-issued bearers via the cloud gateway, and the instance boots without a
// password. That breaks the invariant the first-set path relies on ("exposed
// servers always have a password by the time this is reachable"), and
// isLoopbackRequest() below trusts the Host header — so on a passwordless
// hosted instance a remote request with `Host: localhost` could bootstrap the
// owner password and take over the cookie surface. Close the whole surface:
// every mutating route 403s in hosted mode (GET /status stays readable).
authSessionRouter.use(async (c, next) => {
  if (isHosted() && c.req.method !== "GET") {
    return c.json(
      {
        error: "Owner-password authentication is disabled on hosted instances",
        code: "HOSTED_DISABLED",
      },
      403
    );
  }
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOriginRequestAllowed(c.req.raw)) {
    return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
  }
  return next();
});

const MIN_PASSWORD_LENGTH = 8;

/**
 * A first-set of the owner password is only allowed loopback-only OR when no
 * password exists yet. We never expose a remotely-reachable unauthenticated
 * first-password set — the server refuses to serve exposed-without-password, so
 * by the time the surface is reachable a password already exists. Loopback
 * requests (the CLI/local operator) may always set the first password.
 */
function isLoopbackRequest(c: Context): boolean {
  try {
    const host = new URL(c.req.url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

// POST /auth/login — exchange the owner password for a session cookie.
authSessionRouter.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { password?: unknown }
    | null;
  const password =
    body && typeof body.password === "string" ? body.password : "";

  if (!(await hasOwnerPassword())) {
    return c.json({ error: "No owner password set", needsSetup: true }, 409);
  }
  if (!password || !(await verifyOwnerPassword(password))) {
    return c.json({ error: "Invalid password" }, 401);
  }
  await issueSessionCookie(c);
  return c.json({ ok: true });
});

// POST /auth/logout — clear the session cookie on this device.
authSessionRouter.post("/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// GET /auth/status — unauthenticated-safe surface state for the login page.
authSessionRouter.get("/status", async (c) => {
  return c.json({
    sourceUrl: SOURCE_URL,
    exposed: authRequired(),
    hasOwnerPassword: await hasOwnerPassword(),
    authenticated: await verifyOwnerSessionCookie(c),
  });
});

// POST /auth/password — set (first) or rotate the owner password.
//   first set: allowed only loopback OR when no password exists yet.
//   rotate:    requires a valid session cookie AND the current password.
authSessionRouter.post("/password", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { password?: unknown; currentPassword?: unknown }
    | null;
  const password =
    body && typeof body.password === "string" ? body.password : "";
  const currentPassword =
    body && typeof body.currentPassword === "string"
      ? body.currentPassword
      : "";

  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      400
    );
  }

  const alreadySet = await hasOwnerPassword();
  if (!alreadySet) {
    // First-set: never a remote unauthenticated bootstrap. Loopback only.
    if (!isLoopbackRequest(c)) {
      return c.json(
        { error: "First password can only be set locally" },
        403
      );
    }
    await setOwnerPassword(password);
    await issueSessionCookie(c);
    return c.json({ ok: true });
  }

  // Rotate: a valid session plus the current password.
  if (!(await verifyOwnerSessionCookie(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!currentPassword || !(await verifyOwnerPassword(currentPassword))) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }
  await setOwnerPassword(password);
  // Re-issue so the active device keeps a valid cookie under the same secret.
  await issueSessionCookie(c);
  return c.json({ ok: true });
});

// POST /auth/logout-everywhere — rotate the HMAC secret, invalidating every
// previously issued cookie. Requires a valid session.
authSessionRouter.post("/logout-everywhere", async (c) => {
  if (!(await verifyOwnerSessionCookie(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await rotateSessionSecret();
  clearSessionCookie(c);
  return c.json({ ok: true });
});
