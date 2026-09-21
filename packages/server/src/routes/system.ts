import { Hono } from "hono";
import type { Context } from "hono";
import {
  authRequired,
  isHostedBrowserOwner,
  isLocalOwner,
  mcpBearerRequired,
  publicSurfaceAuthRequired,
} from "../auth.ts";
import { getReleaseInfo } from "../release-info.ts";
import {
  checkForUpdate,
  getCachedUpdateCheck,
  type UpdateCheckResult,
} from "../update-check.ts";
import { getEffectiveUpdateStatus, startUpdate } from "../update-runner.ts";
import {
  getServerSettings,
  SettingsValidationError,
  updateServerSettingsWithResult,
  type ServerSettingsPatch,
} from "../settings-store.ts";
import { normalizePublicUrl } from "../public-origin.ts";
import { hasOwnerPassword } from "../session-store.ts";
import { getHostedDocumentSharingConfig, isHosted } from "../hosted.ts";
import { runRetentionSweep } from "../version-retention.ts";
import {
  localMcpEndpoint,
  remoteMcpUrl,
  resolveWorkspaceOriginForRequest,
  type WorkspaceOriginSource,
} from "../workspace-origin.ts";

// ============================================================
// System / install control surface
// ============================================================
//
// Read-only system state for the in-app Settings drawer. Mounted under
// /api/system. The version surface is non-sensitive (the same string /health
// already returns), so it needs no owner gate; the write surface added later
// (POST /api/system/update) does.

export const systemRouter = new Hono();

function selfManagedVersionPayload(check: UpdateCheckResult) {
  const release = getReleaseInfo();
  return {
    current: release.version,
    sourceUrl: release.sourceUrl,
    canUpdate: release.canUpdate,
    hasEmbeddedInstaller: release.hasEmbeddedInstaller,
    latest: check.latest,
    updateAvailable: check.updateAvailable,
    checkedAt: check.checkedAt,
    lastAttemptAt: check.lastAttemptAt,
    checkTtlRemainingMs: check.checkTtlRemainingMs,
    checkStatus: check.checkStatus,
  };
}

function sameOriginOrNonBrowserRequest(c: Context): boolean {
  const fetchSite = c.req.header("Sec-Fetch-Site")?.trim().toLowerCase();
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";

  const origin = c.req.header("Origin")?.trim();
  if (origin === undefined) return true;
  if (origin === "null") return false;
  try {
    const requestUrl = new URL(c.req.url);
    const forwardedHost = c.req
      .header("X-Forwarded-Host")
      ?.split(",")[0]
      ?.trim();
    const forwardedProto = c.req
      .header("X-Forwarded-Proto")
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    const protocol = forwardedProto ? `${forwardedProto}:` : requestUrl.protocol;
    if (protocol !== "http:" && protocol !== "https:") return false;
    const expectedOrigin = `${protocol}//${forwardedHost || requestUrl.host}`;
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

// GET /api/system/version — current build, whether the server can self-update,
// and the newest published release (from the shared update-check cache).
// `?cached=1` makes it a passive surface (same split as the CLI's post-command
// nudge): it reads only the cache the background checker keeps warm and never
// contacts the release host, so ambient UI (the app-shell update nudge) can
// poll it freely without overriding the user's auto-check preference.
systemRouter.get("/version", async (c) => {
  const release = getReleaseInfo();
  if (isHosted()) {
    return c.json({
      current: release.version,
      sourceUrl: release.sourceUrl,
      canUpdate: false,
      hasEmbeddedInstaller: false,
      latest: null,
      updateAvailable: false,
      checkedAt: null,
      lastAttemptAt: null,
      checkTtlRemainingMs: null,
      checkStatus: "managed" as const,
    });
  }
  const cached = c.req.query("cached") === "1";
  // Live path: cached within the TTL, so the common case is a filesystem read;
  // at most one short network fetch per TTL window, and none at all for source
  // builds (updateCheckSupported gates inside checkForUpdate).
  const check = cached
    ? getCachedUpdateCheck()
    : await checkForUpdate();
  return c.json(selfManagedVersionPayload(check));
});

// User-initiated cache bypass. POST plus same-origin Fetch Metadata/Origin
// checks prevent an arbitrary website from spending the implicit loopback
// owner's authority on repeated release-host requests.
systemRouter.post("/version/check", async (c) => {
  if (!isLocalOwner(c) || !sameOriginOrNonBrowserRequest(c)) {
    return c.json({ error: "Forbidden", required: "owner + same-origin" }, 403);
  }
  const check = await checkForUpdate({ force: true });
  return c.json(selfManagedVersionPayload(check));
});

export type DeploymentMode = "cloud" | "self-managed";

export interface DeploymentInfo {
  mode: DeploymentMode;
  capabilities: {
    cloudAccount: boolean;
    workspaceName: boolean;
    workspacePath: boolean;
    workspaceUrl: boolean;
    workspacePortability: boolean;
    editorSettings: boolean;
    historySettings: boolean;
    softwareUpdates: boolean;
    updateChecks: boolean;
    documentSharing: boolean;
  };
}

export function getDeploymentInfo(): DeploymentInfo {
  const cloud = isHosted();
  return {
    mode: cloud ? "cloud" : "self-managed",
    capabilities: {
      cloudAccount: cloud,
      workspaceName: true,
      workspacePath: !cloud,
      workspaceUrl: !cloud,
      workspacePortability: true,
      editorSettings: true,
      historySettings: true,
      softwareUpdates: !cloud,
      updateChecks: !cloud,
      documentSharing: getHostedDocumentSharingConfig() !== null,
    },
  };
}

// GET /api/system/deployment — authoritative product capabilities for this
// process. The web app uses this instead of inferring deployment from agent auth.
systemRouter.get("/deployment", (c) => c.json(getDeploymentInfo()));

// GET /api/system/update — the current/last update job's status. Read-only and
// non-sensitive (it's just lifecycle state), so it mirrors /version's open gate.
systemRouter.get("/update", (c) => {
  return c.json(getEffectiveUpdateStatus());
});

/**
 * Resolve the workspace origin. Precedence (strongest first):
 *   1. WORKTABLE_PUBLIC_URL env (trimmed, origin-only) → source "env"
 *   2. the settings store's `network.publicUrl` (origin-only) → source "config"
 *   3. WORKTABLE_RESOURCE_URL's origin → source "resource"
 *   4. the request origin, honoring valid HTTP X-Forwarded headers → "request"
 *   5. the configured local HOST/PORT → "fallback"
 *
 * `env` beats `config` so an operator can override the install's stored origin
 * per-process without editing settings.
 */

export function resolveOrigin(c: Context): {
  origin: string;
  originSource: WorkspaceOriginSource;
} {
  return resolveWorkspaceOriginForRequest(c.req.raw);
}

// GET /api/system/connection — how an MCP client reaches this install, and the
// workspace origin (for agent-facing doc URLs). Same open gate as /version: this
// is non-sensitive connection metadata the Settings "Connect an agent" card reads.
systemRouter.get("/connection", async (c) => {
  // reachable is about the bind/flag; authRequired is about the REST surface.
  // A configured public URL exposes a loopback bind through a tunnel/proxy, so
  // REST must require credentials even though the local bind is still loopback.
  const exposed = authRequired();
  const restAuthRequired = publicSurfaceAuthRequired();
  const { origin, originSource } = resolveOrigin(c);
  return c.json({
    mcpAuthMode: isHosted() ? "oauth" : "local-token",
    endpoint: localMcpEndpoint(),
    remoteMcpUrl: remoteMcpUrl(origin),
    reachable: exposed,
    authRequired: restAuthRequired,
    // /mcp needs a bearer once any token exists OR a public origin is configured
    // (a saved tunnel URL is an exposed front door even on a loopback bind), even
    // on loopback — the connect card must stop offering tokenless snippets. This
    // is the SAME gate requireIdentity() enforces, so the UI and server never
    // disagree about whether a token is required.
    mcpTokenRequired: await mcpBearerRequired(),
    origin,
    originSource,
    // "configured" = an explicit operator/owner/hosted value, as opposed to a
    // value inferred from the request or the loopback fallback.
    originConfigured:
      originSource === "env" ||
      originSource === "config" ||
      originSource === "resource",
  });
});

function enablesPublicUrl(patch: ServerSettingsPatch): boolean {
  const network = patch.network;
  if (!network || typeof network !== "object" || Array.isArray(network)) return false;
  const value = (network as Record<string, unknown>)["publicUrl"];
  if (typeof value !== "string") return false;
  const normalized = normalizePublicUrl(value);
  return normalized.ok && typeof normalized.value === "string";
}

/**
 * Mutating system actions are owner-only. The /api/* identity middleware
 * (trustedLocalIdentity) has already resolved the caller to an owner identity
 * — implicit owner on loopback, owner-session cookie or legacy owner bearer on
 * an exposed install — or 401'd them, so we gate on that resolved identity
 * rather than re-checking the cookie. This honors every owner credential the
 * rest of the REST surface accepts (the bug a cookie-only check introduced)
 * while still 403'ing a scoped agent token, which must not drive updates.
 */
// POST /api/system/update — trigger an in-place update. Body: { version? }.
systemRouter.post("/update", async (c) => {
  if (isHosted()) {
    return c.json(
      {
        error: "Software updates are managed by Worktable Cloud.",
        code: "HOSTED_DISABLED",
      },
      403,
    );
  }
  if (!isLocalOwner(c)) {
    return c.json({ error: "Forbidden", required: "owner" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { version?: unknown }
    | null;
  const version =
    body && typeof body.version === "string" ? body.version : undefined;

  const result = startUpdate({ version });
  if (!result.started) {
    // Already-running is a benign 409; an un-updatable build is a 409 too — the
    // UI shouldn't have offered the button, but defend the surface anyway.
    return c.json({ error: result.reason, status: result.status }, 409);
  }
  return c.json(result.status, 202);
});

// GET /api/system/settings — full server preferences for the Settings dialog.
// Same open gate as /version: these are non-sensitive user preferences, and the
// dialog must render them before any owner-gated mutation.
systemRouter.get("/settings", (c) => {
  return c.json(getServerSettings());
});

// PUT /api/system/settings — patch server preferences. Owner-only (same gate as
// POST /update). Strict: unknown keys or wrong-typed fields → 400. Returns the
// merged settings.
systemRouter.put("/settings", async (c) => {
  if (isHosted() ? !isHostedBrowserOwner(c) : !isLocalOwner(c)) {
    return c.json({ error: "Forbidden", required: "owner" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as ServerSettingsPatch | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected a JSON object body" }, 400);
  }
  if (isHosted() && ("updates" in body || "network" in body)) {
    const updateSettings = "updates" in body;
    return c.json(
      {
        error: updateSettings
          ? "Software updates are managed by Worktable Cloud."
          : "Workspace URL is managed by Worktable Cloud.",
        code: "HOSTED_DISABLED",
      },
      403,
    );
  }
  try {
    if (enablesPublicUrl(body) && !(await hasOwnerPassword())) {
      return c.json(
        { error: "Set an owner password before configuring a public URL" },
        409,
      );
    }
    const result = await updateServerSettingsWithResult(body);
    const merged = result.settings;
    // A retention-policy change triggers an immediate full sweep so the new
    // limit takes effect now, not at the next 24h tick. Awaited so the caller
    // (and tests) observe a consistent post-sweep state; the new policy is
    // passed explicitly to avoid any cache-read race. The change decision comes
    // from inside the serialized settings update, not a pre-queue snapshot.
    if (result.retentionChanged) {
      try {
        await runRetentionSweep(merged.history.retention, {
          expectedRetentionGeneration: result.retentionGeneration,
        });
      } catch (sweepErr) {
        console.error("[version-retention] policy-change sweep error:", sweepErr);
        return c.json(
          {
            error: "Retention sweep failed",
            code: "RETENTION_SWEEP_FAILED",
            settings: merged,
          },
          500,
        );
      }
    }
    return c.json(merged);
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});
