import { basename } from "node:path";
import { Hono } from "hono";
import {
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  DEFAULT_AGENT_TOKEN_SCOPES,
} from "@worktable/types";
import {
  requireMintAuth,
  requireScope,
  trustedLocalIdentity,
} from "../auth.ts";
import {
  CONNECTOR_PROGRESS_EVENTS,
  completePairingSession,
  createPairingSession,
  getPairingTarget,
  getPairingSession,
  recordPairingProgress,
  redeemPairingSession,
  remoteMcpUrl,
  attachPairingToken,
  type ConnectorProgressEvent,
  type PairingTarget,
} from "../pairing-store.ts";
import {
  createToken,
  finalizeAgentTokenRotation,
  hasScope,
  isValidScope,
  listTokens,
  revokeToken,
  tokenIdFromToken,
  verifyToken,
} from "../token-store.ts";
import { resolveParticipant } from "../participant-store.ts";
import { upsertAgentConnection } from "../agent-connection-store.ts";
import { readSpace } from "../store.ts";
import { getWorkspaceRoot } from "../workspace.ts";
import { resolveOrigin } from "./system.ts";

// ============================================================
// Pairing API (remote agent connect)
// ============================================================
//
// Two trust surfaces on one router, deliberately split:
//
//   Owner surface (create, status): the same gate stack as /api/tokens —
//   creating a pairing IS minting a token, one redemption later. Bare local
//   requests act as owner; exposed installs demand a session cookie or a
//   tokens:manage bearer.
//
//   Connector surface (target, redeem, complete, progress): target/redeem/
//   progress use the pairing code; reliable completion additionally requires
//   the exact minted bearer. These calls come from the remote agent machine,
//   so this router must be mounted OUTSIDE the global /api/* identity
//   middleware (like /api/mcp), or exposed installs would 401 the redeem that
//   is the entire point of the flow.
//
// The minted credential is always a scoped local wt_ token (never owner),
// minted in-process here — the /api/tokens mint gate is not involved, and
// pairing scopes are capped below owner ("*"/tokens:manage are refused), so
// a leaked pairing code is at worst a content-scoped agent credential.

/**
 * A pairing-minted token must stay below owner/token-management power. This
 * is a GRANT check, not a literal blocklist: "*", "tokens:manage", and
 * "tokens:*" all satisfy hasScope(..., "tokens:manage") and are refused.
 */
function scopeGrantsOwnerPower(scope: string): boolean {
  return hasScope([scope], "tokens:manage");
}

const SUPPORTED_CLIENTS = new Set<string>(CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS);
const AGENT_ADAPTER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const AGENT_ADAPTER_INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

// Redemption is guarded by a lockout window instead of per-IP limiting (the
// server often sits behind a tunnel that collapses client IPs): too many
// failed code presentations and the code surface refuses everyone until the
// window drains. Codes carry 50 bits, so online guessing is hopeless anyway;
// this bounds log noise and probing.
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES_PER_WINDOW = 30;
let codeFailures: number[] = [];

function codeSurfaceLocked(): boolean {
  const cutoff = Date.now() - FAILURE_WINDOW_MS;
  codeFailures = codeFailures.filter((at) => at > cutoff);
  return codeFailures.length >= MAX_FAILURES_PER_WINDOW;
}

function recordCodeFailure(): void {
  codeFailures.push(Date.now());
}

/** Test seam: the lockout window is process-global state. */
export function resetPairingRateLimitForTests(): void {
  codeFailures = [];
}

function sanitizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .replace(/[^\w.-]/g, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : null;
}

function parseClient(value: unknown): { ok: boolean; client: string | null } {
  if (value === undefined || value === null) return { ok: true, client: null };
  if (typeof value === "string" && SUPPORTED_CLIENTS.has(value)) {
    return { ok: true, client: value };
  }
  return { ok: false, client: null };
}

function parseAgentAdapterTarget(value: unknown):
  | {
      ok: true;
      target: Extract<PairingTarget, { kind: "agent-adapter" }>;
    }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "target must be an object" };
  }
  const target = value as Record<string, unknown>;
  if (
    target.kind !== "agent-adapter" ||
    typeof target.adapter !== "string" ||
    !AGENT_ADAPTER_ID.test(target.adapter)
  ) {
    return {
      ok: false,
      error:
        "adapter must be a lowercase agent-adapter identifier (letters, digits, and hyphens)",
    };
  }
  if (
    typeof target.participantName !== "string" ||
    target.participantName.trim().length === 0 ||
    target.participantName.trim().length > 100
  ) {
    return { ok: false, error: "participantName must be 1–100 characters" };
  }
  if (
    target.defaultSpaceId !== undefined &&
    (typeof target.defaultSpaceId !== "string" ||
      target.defaultSpaceId.trim().length === 0)
  ) {
    return { ok: false, error: "defaultSpaceId must be a non-empty string" };
  }
  return {
    ok: true,
    target: {
      kind: "agent-adapter",
      adapter: target.adapter,
      participantName: target.participantName.trim(),
      ...(typeof target.defaultSpaceId === "string"
        ? { defaultSpaceId: target.defaultSpaceId.trim() }
        : {}),
    },
  };
}

// ---- Owner surface -------------------------------------------------------

const ownerSurface = new Hono();
ownerSurface.use("*", trustedLocalIdentity());
ownerSurface.use("*", requireMintAuth());
ownerSurface.use("*", requireScope("tokens:manage"));

// POST /api/pairing — create a pairing session. The code is shown exactly
// once; only its hash persists.
ownerSurface.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    client?: unknown;
    displayName?: unknown;
    scopes?: unknown;
    target?: unknown;
  } | null;

  if (body?.client !== undefined && body?.target !== undefined) {
    return c.json(
      {
        error: "client and target cannot both be supplied",
        code: "BAD_REQUEST",
      },
      400
    );
  }

  let target: Extract<PairingTarget, { kind: "agent-adapter" }> | undefined;
  if (body?.target !== undefined) {
    const parsed = parseAgentAdapterTarget(body.target);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, code: "BAD_REQUEST" }, 400);
    }
    target = parsed.target;
    if (target.defaultSpaceId) {
      const space = await readSpace(target.defaultSpaceId);
      if (!space.data) {
        return c.json(
          {
            error: "defaultSpaceId must identify an existing Space",
            code: "BAD_REQUEST",
          },
          400
        );
      }
    }
    if (body.scopes !== undefined) {
      return c.json(
        {
          error: "agent adapter scopes are fixed by Worktable",
          code: "BAD_REQUEST",
        },
        400
      );
    }
  }

  const { ok: clientOk, client } = parseClient(target ? null : body?.client);
  if (!clientOk) {
    return c.json(
      {
        error: `client must be one of: ${[...SUPPORTED_CLIENTS].join(", ")}`,
        code: "BAD_REQUEST",
      },
      400
    );
  }

  const displayName =
    !target && typeof body?.displayName === "string"
      ? body.displayName.trim()
      : undefined;
  if (
    !target &&
    body?.displayName !== undefined &&
    (!displayName || displayName.length > 100)
  ) {
    return c.json(
      {
        error: "displayName must be 1–100 characters",
        code: "BAD_REQUEST",
      },
      400
    );
  }

  let scopes = target ? ["threads:*"] : [...DEFAULT_AGENT_TOKEN_SCOPES];
  if (body?.scopes !== undefined) {
    if (
      !Array.isArray(body.scopes) ||
      body.scopes.length === 0 ||
      !body.scopes.every((s) => typeof s === "string" && isValidScope(s))
    ) {
      return c.json(
        {
          error: "scopes must be a non-empty array of scope strings",
          code: "BAD_REQUEST",
        },
        400
      );
    }
    const forbidden = body.scopes.find(scopeGrantsOwnerPower);
    if (forbidden) {
      // Pairing mints on code possession alone, so it is capped to content
      // scopes. Owner-power tokens go through the explicit mint UI instead.
      return c.json(
        {
          error: `scope not allowed for pairing: ${forbidden}`,
          code: "BAD_REQUEST",
        },
        400
      );
    }
    scopes = body.scopes;
  }

  const { origin, originSource } = resolveOrigin(c);
  const mcpUrl = remoteMcpUrl(origin);
  const { code, session } = await createPairingSession({
    client,
    target: target ?? {
      kind: "mcp-client",
      client,
      ...(displayName ? { displayName } : {}),
    },
    scopes,
    mcpUrl,
  });

  return c.json(
    {
      id: session.id,
      code,
      expiresAt: session.expiresAt,
      mcpUrl,
      client,
      target: session.target,
      scopes,
      serverOrigin: origin,
      // Surfaced so the UI can warn when the origin was merely inferred — a
      // loopback or request-derived origin is usually wrong for a REMOTE agent.
      originSource,
    },
    201
  );
});

// GET /api/pairing/:id — status polling for the Settings flow.
ownerSurface.get("/:id", async (c) => {
  const session = await getPairingSession(c.req.param("id"));
  if (!session) {
    return c.json(
      { error: "Pairing session not found", code: "NOT_FOUND" },
      404
    );
  }
  return c.json(session);
});

// ---- Code surface --------------------------------------------------------

export const pairingRouter = new Hono();

// POST /api/pairing/target — resolve the server-selected client without
// consuming its single-use code so local preflight remains precise.
pairingRouter.post("/target", async (c) => {
  if (codeSurfaceLocked()) {
    return c.json(
      { error: "Too many attempts, try again later", code: "RATE_LIMITED" },
      429
    );
  }
  const body = (await c.req.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  if (!body || typeof body.code !== "string" || body.code.trim().length === 0) {
    return c.json({ error: "code is required", code: "BAD_REQUEST" }, 400);
  }

  const result = await getPairingTarget(body.code);
  if (!result.ok) {
    if (result.reason === "not_found") recordCodeFailure();
    return c.json(
      {
        error:
          result.reason === "not_found"
            ? "Unknown or invalid code"
            : result.reason === "expired"
              ? "Pairing code expired — create a new one in Settings"
              : "Pairing code already used — create a new one in Settings",
        code:
          result.reason === "not_found"
            ? "INVALID_CODE"
            : result.reason === "expired"
              ? "EXPIRED"
              : "ALREADY_REDEEMED",
      },
      result.reason === "not_found" ? 404 : 410
    );
  }
  return c.json({ client: result.client });
});

// POST /api/pairing/redeem — the connector trades the code for the endpoint
// plus a freshly minted scoped bearer. Single-use.
pairingRouter.post("/redeem", async (c) => {
  if (codeSurfaceLocked()) {
    return c.json(
      { error: "Too many attempts, try again later", code: "RATE_LIMITED" },
      429
    );
  }
  const body = (await c.req.json().catch(() => null)) as {
    code?: unknown;
    hostname?: unknown;
    installationId?: unknown;
    client?: unknown;
    detectedClient?: unknown;
    all?: unknown;
  } | null;
  if (!body || typeof body.code !== "string" || body.code.trim().length === 0) {
    return c.json({ error: "code is required", code: "BAD_REQUEST" }, 400);
  }

  const hostname = sanitizeHostname(body.hostname);
  // Two distinct client signals so the token label can mirror what actually
  // gets installed: `client` is an explicit --client override (wins over the
  // pairing's choice, because the connector installs it), `detectedClient` is
  // the connector's single-detection hint (only used when neither the flag
  // nor the pairing named a client). `all` installs every detected client, so
  // the label falls back to the generic agent@host that every --all run
  // rewrites consistently.
  const { ok: clientOk, client: explicitClient } = parseClient(body.client);
  const { ok: detectedOk, client: detectedClient } = parseClient(
    body.detectedClient
  );
  if (!clientOk || !detectedOk) {
    return c.json(
      {
        error: `client must be one of: ${[...SUPPORTED_CLIENTS].join(", ")}`,
        code: "BAD_REQUEST",
      },
      400
    );
  }
  const installAll = body.all === true;
  const hasClientOverrides =
    body.client !== undefined ||
    body.detectedClient !== undefined ||
    installAll;
  const target = await getPairingTarget(body.code);
  const pendingAdapterTarget =
    target.ok && target.target.kind === "agent-adapter" ? target.target : null;
  const adapterPairing = pendingAdapterTarget !== null;
  const installationId =
    typeof body.installationId === "string" ? body.installationId.trim() : "";
  if (adapterPairing && !AGENT_ADAPTER_INSTALLATION_ID.test(installationId)) {
    return c.json(
      {
        error:
          "installationId is required for an agent adapter and must be a stable opaque identifier",
        code: "BAD_REQUEST",
      },
      400
    );
  }
  if (hasClientOverrides && adapterPairing) {
    return c.json(
      {
        error: "client overrides are not valid for an agent adapter",
        code: "BAD_REQUEST",
      },
      400
    );
  }
  if (adapterPairing && pendingAdapterTarget.defaultSpaceId) {
    const space = await readSpace(pendingAdapterTarget.defaultSpaceId);
    if (!space.data) {
      return c.json(
        {
          error:
            "The OpenClaw home Space no longer exists. Create a new pairing for an existing Space.",
          code: "PAIRING_TARGET_UNAVAILABLE",
        },
        409
      );
    }
  }

  const result = await redeemPairingSession(body.code, {
    hostname,
    client: installAll
      ? null
      : (explicitClient ??
        (target.ok ? target.client : null) ??
        detectedClient),
    ...(installAll ? { all: true } : {}),
    ...(adapterPairing ? { installationId } : {}),
  });
  if (!result.ok) {
    if (result.reason === "not_found") {
      recordCodeFailure();
      return c.json(
        { error: "Unknown or invalid code", code: "INVALID_CODE" },
        404
      );
    }
    // Expired and already-redeemed both mean "this code will never work
    // again" — 410 tells the connector to have the user start over.
    return c.json(
      {
        error:
          result.reason === "expired"
            ? "Pairing code expired — create a new one in Settings"
            : "Pairing code already used — create a new one in Settings",
        code: result.reason === "expired" ? "EXPIRED" : "ALREADY_REDEEMED",
      },
      410
    );
  }

  const session = result.session;
  const adapterTarget =
    session.target.kind === "agent-adapter" ? session.target : null;
  if (adapterTarget && hasClientOverrides) {
    await recordPairingProgress(
      body.code,
      "failed_no_config",
      "Agent-adapter pairing does not accept MCP client overrides."
    );
    return c.json(
      {
        error: "client overrides are not valid for an agent adapter",
        code: "BAD_REQUEST",
      },
      400
    );
  }
  // The label mirrors the connector's install decision exactly (it installs
  // explicit ?? pairing's choice ?? detected; --all installs the detected
  // set, which only the generic label rewrites consistently).
  const labelClient = installAll
    ? null
    : (explicitClient ?? session.requestedClient ?? detectedClient);
  // What the connector should install when not --all: the explicit override
  // wins over the pairing's choice, since that is what the flag means.
  const client = installAll
    ? null
    : (explicitClient ?? session.requestedClient);
  // Generic MCP clients retain the historical hostname identity. Agent
  // adapters supply their own persisted, collision-resistant installation
  // identity because hostnames are neither unique nor stable across
  // containers and copied machines.
  const host = hostname ?? `unknown-${session.id.slice(0, 6)}`;
  const agentLabel = adapterTarget
    ? `${adapterTarget.adapter}@${installationId}`
    : `${labelClient ?? "agent"}@${host}`;
  // Mint without revoking the previous same-label credential. The connector
  // may still need to restore that credential-bearing config if installation
  // or verification fails. Authenticated completion finalizes the rotation.
  const { token, metadata } = await createToken({
    agent: agentLabel,
    scopes: session.scopes,
  });
  try {
    await attachPairingToken(session.id, metadata.id);
    if (adapterTarget) {
      await resolveParticipant(
        { agent: metadata.agent, principal: metadata.principal },
        {
          name: adapterTarget.participantName,
          defaultSpaceId: adapterTarget.defaultSpaceId ?? null,
        }
      );
    }
  } catch {
    const setupTarget = adapterTarget
      ? "the adapter participant"
      : "the pairing credential";
    await revokeToken(metadata.id).catch(() => false);
    await recordPairingProgress(
      body.code,
      "failed_no_config",
      `Worktable could not establish ${setupTarget}.`
    ).catch(() => undefined);
    return c.json(
      {
        error: `Worktable could not establish ${setupTarget}. Create a new pairing and reconnect.`,
        code: "PARTICIPANT_SETUP_FAILED",
      },
      409
    );
  }

  return c.json({
    mcpUrl: session.mcpUrl,
    token,
    client,
    scopes: session.scopes,
    workspaceName: basename(getWorkspaceRoot()),
    ...(adapterTarget
      ? {
          participantName: adapterTarget.participantName,
          ...(adapterTarget.defaultSpaceId
            ? { defaultSpaceId: adapterTarget.defaultSpaceId }
            : {}),
        }
      : {}),
  });
});

// POST /api/pairing/complete — reliable, idempotent success commit. Unlike
// best-effort progress, this requires the bearer minted for the exact pairing
// and is safe to retry when the connector loses a response.
pairingRouter.post("/complete", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  if (!body || typeof body.code !== "string" || body.code.trim().length === 0) {
    return c.json({ error: "code is required", code: "BAD_REQUEST" }, 400);
  }

  const authorization = c.req.header("Authorization")?.trim() ?? "";
  const rawToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const tokenId = tokenIdFromToken(rawToken);
  if (!tokenId || !(await verifyToken(rawToken))) {
    return c.json(
      { error: "Valid pairing bearer required", code: "UNAUTHORIZED" },
      401
    );
  }

  const metadata = (await listTokens()).find((token) => token.id === tokenId);
  if (!metadata) {
    return c.json(
      {
        error: "Pairing credential is no longer available",
        code: "PAIRING_CREDENTIAL_UNAVAILABLE",
      },
      409
    );
  }

  const result = await completePairingSession(
    body.code,
    tokenId,
    async (session) => {
      const target = session.target;
      let connectionStored = true;
      if (target.kind === "agent-adapter") {
        const installationId = session.redeemedBy?.installationId;
        if (!installationId) {
          throw new Error(
            "Agent-adapter pairing is missing its installation identity"
          );
        }
        const participant = (
          await resolveParticipant(
            { agent: metadata.agent, principal: metadata.principal },
            {
              name: target.participantName,
              defaultSpaceId: target.defaultSpaceId ?? null,
            }
          )
        ).participant;
        connectionStored = await upsertAgentConnection({
          target: {
            kind: "agent-adapter",
            adapter: target.adapter,
            installationId,
          },
          mode: "always-on",
          participant,
          machine: session.redeemedBy?.hostname ?? null,
          credentialId: tokenId,
        });
      } else {
        connectionStored = await upsertAgentConnection({
          target: {
            kind: "mcp-client",
            clientId: session.redeemedBy?.all
              ? null
              : (session.redeemedBy?.client ?? session.requestedClient ?? null),
          },
          mode: "on-demand",
          participant: null,
          machine: session.redeemedBy?.hostname ?? null,
          credentialId: tokenId,
          displayName: target.displayName,
        });
      }
      if (!connectionStored) {
        // A newer completion already owns this semantic connection. The
        // superseded bearer must not survive invisibly outside the inventory.
        await revokeToken(tokenId);
        return;
      }
      await finalizeAgentTokenRotation(tokenId);
    }
  );
  if (!result.ok) {
    if (result.reason === "not_found") recordCodeFailure();
    return c.json(
      {
        error:
          result.reason === "not_found"
            ? "Unknown or invalid code"
            : result.reason === "not_redeemed"
              ? "Pairing not redeemed yet"
              : result.reason === "token_mismatch"
                ? "Bearer does not belong to this pairing"
                : "Pairing already failed",
        code:
          result.reason === "not_found"
            ? "INVALID_CODE"
            : result.reason === "not_redeemed"
              ? "NOT_REDEEMED"
              : result.reason === "token_mismatch"
                ? "TOKEN_MISMATCH"
                : "ALREADY_FAILED",
      },
      result.reason === "not_found" ? 404 : 409
    );
  }
  return c.json({ ok: true });
});

// POST /api/pairing/progress — connector install/verify progress, shown live
// in the Settings flow. The (already redeemed) code authenticates.
pairingRouter.post("/progress", async (c) => {
  if (codeSurfaceLocked()) {
    return c.json(
      { error: "Too many attempts, try again later", code: "RATE_LIMITED" },
      429
    );
  }
  const body = (await c.req.json().catch(() => null)) as {
    code?: unknown;
    event?: unknown;
    detail?: unknown;
  } | null;
  if (!body || typeof body.code !== "string" || body.code.trim().length === 0) {
    return c.json({ error: "code is required", code: "BAD_REQUEST" }, 400);
  }
  const event = body.event;
  if (
    typeof event !== "string" ||
    !CONNECTOR_PROGRESS_EVENTS.includes(event as ConnectorProgressEvent)
  ) {
    return c.json(
      {
        error: `event must be one of: ${CONNECTOR_PROGRESS_EVENTS.join(", ")}`,
        code: "BAD_REQUEST",
      },
      400
    );
  }
  if (body.detail !== undefined && typeof body.detail !== "string") {
    return c.json(
      { error: "detail must be a string", code: "BAD_REQUEST" },
      400
    );
  }

  const result = await recordPairingProgress(
    body.code,
    event as ConnectorProgressEvent,
    body.detail as string | undefined
  );
  if (!result.ok) {
    if (result.reason === "not_found") recordCodeFailure();
    return c.json(
      result.reason === "not_found"
        ? { error: "Unknown or invalid code", code: "INVALID_CODE" }
        : { error: "Pairing not redeemed yet", code: "NOT_REDEEMED" },
      result.reason === "not_found" ? 404 : 409
    );
  }

  // failed_no_config and rolled_back are the connector's EXPLICIT assertions
  // that no config retains the minted token. Revoke it rather than let a
  // stranded credential accumulate. Revocation keys ONLY on these explicit
  // events: inferring zero writes from a missing best-effort config_written
  // report could kill a credential that a client still holds.
  // (The code holder already possesses the token, so letting them trigger
  // revocation is de-escalation only.)
  const session = result.session;
  // Code-only progress never retires a previous credential. Only /complete,
  // authenticated by the bearer minted for this exact pairing, may finalize
  // rotation.
  if (
    (event === "rolled_back" || event === "failed_no_config") &&
    session.outcome !== "verified" &&
    session.tokenId &&
    (event === "rolled_back" ||
      !session.events.some((e) => e.event === "config_written"))
  ) {
    await revokeToken(session.tokenId);
  }

  return c.json({ ok: true });
});

// Owner routes mount last so code-surface POSTs match first; a GET to one of
// those names falls through to the owner-gated :id lookup and 404s there.
pairingRouter.route("/", ownerSurface);
