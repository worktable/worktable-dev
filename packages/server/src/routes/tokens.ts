import { Hono } from "hono";
import { requireMintAuth, requireScope, trustedLocalIdentity } from "../auth.ts";
import { isHosted } from "../hosted.ts";
import {
  createToken,
  isValidScope,
  listTokens,
  revokeToken,
} from "../token-store.ts";

// ============================================================
// Token management API
// ============================================================
//
// Backs the "create agent token" UI. Local-trust policy: bare local
// requests act as owner (same trust as the rest of REST today), but a
// presented bearer must carry tokens:manage — a narrow-scoped agent
// token cannot mint itself a broader one.

export const tokensRouter = new Hono();

// Hosted has one routable credential model: AS-issued OAuth bearers. Local wt_
// tokens live inside one tenant, so the Cloud gateway cannot use them to decide
// which tenant a request belongs to. Close this surface explicitly before its
// local-owner middleware can turn a valid Cloud principal into a misleading
// 401 (and send the browser through sign-in again).
tokensRouter.use("*", async (c, next) => {
  if (isHosted()) {
    return c.json(
      {
        error:
          "Local access tokens are not available on Worktable Cloud; connect agents with OAuth.",
        code: "HOSTED_DISABLED",
      },
      403
    );
  }
  return next();
});

tokensRouter.use("*", trustedLocalIdentity());
// When exposed (WORKTABLE_REQUIRE_AUTH=1), an unauthenticated request cannot
// mint/manage tokens over HTTP — a verifying bearer OR a valid owner-session
// cookie (the browser Settings owner) is required. Mounted before the scope
// check so an unauthenticated remote request is 401'd, not 403'd.
tokensRouter.use("*", requireMintAuth());
tokensRouter.use("*", requireScope("tokens:manage"));

tokensRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid JSON body", code: "BAD_REQUEST" }, 400);
  }
  const { scopes, agent } = body as { scopes?: unknown; agent?: unknown };

  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    !scopes.every((s) => typeof s === "string" && isValidScope(s))
  ) {
    return c.json(
      {
        error:
          'scopes must be a non-empty array of scope strings ("*", "docs:*", "docs:read", ...)',
        code: "BAD_REQUEST",
      },
      400
    );
  }
  if (agent !== undefined && agent !== null && typeof agent !== "string") {
    return c.json({ error: "agent must be a string or null", code: "BAD_REQUEST" }, 400);
  }

  const identity = c.get("identity");
  const requestedAgent = agent as string | null | undefined;
  // Token management permits delegation, not promotion from an agent to a
  // human principal. Empty labels also classify as human in the token store.
  const delegatedAgent = identity.principal.type === "human"
    ? requestedAgent ?? null
    : requestedAgent?.trim() || identity.agent || identity.principal.id;
  const { token, metadata } = await createToken({
    scopes,
    agent: delegatedAgent,
  });
  // The full token string is shown exactly once; only its hash persists.
  return c.json({ token, metadata }, 201);
});

tokensRouter.get("/", async (c) => {
  return c.json({ tokens: await listTokens() });
});

tokensRouter.delete("/:id", async (c) => {
  const revoked = await revokeToken(c.req.param("id"));
  if (!revoked) {
    return c.json({ error: "Token not found", code: "NOT_FOUND" }, 404);
  }
  return c.json({ ok: true });
});
