import { requireWorkspaceContentEpoch } from "./workspace-content-epoch.ts";
import { retireWorkspaceDerivedFiles } from "./workspace-reset-files.ts";
import { finalizeWorkspaceClearJob } from "./workspace-clear-jobs.ts";
import { Hono } from "hono";
import { cloudCallbackRouter, linkedRouter } from "./routes/linked.ts";
import { startLinkedRuntime } from "./linked-runtime.ts";
import { startWorkspaceBackupNotifier } from "./workspace-backup-notifier.ts";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { compressApiResponse } from "./http-compression.ts";
import { acceptsGzip } from "./http-compression.ts";
import { injectDocumentOpening } from "./document-opening.ts";
import { readDocumentPreloads } from "./document-preloads.ts";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { healthRouter } from "./routes/health.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { docsRouter } from "./routes/docs.ts";
import { documentsRouter } from "./routes/documents.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import { recordsRouter } from "./routes/records.ts";
import { annotationsRouter } from "./routes/annotations.ts";
import { threadsRouter } from "./routes/threads.ts";
import { searchRouter } from "./routes/search.ts";
import { tokensRouter } from "./routes/tokens.ts";
import { wellKnownRouter } from "./routes/well-known.ts";
import { mcpRouter } from "./routes/mcp.ts";
import { pairingRouter } from "./routes/pairing.ts";
import { agentConnectionsRouter } from "./routes/agent-connections.ts";
import { sharesRouter } from "./routes/shares.ts";
import { publicSharesRouter } from "./routes/public-shares.ts";
import { connectRouter } from "./routes/connect.ts";
import { workspaceRouter } from "./routes/workspace.ts";
import { operatorRouter } from "./routes/operator.ts";
import { systemRouter } from "./routes/system.ts";
import { integrationsRouter } from "./routes/integrations.ts";
import { authSessionRouter } from "./routes/auth-session.ts";
import { profileRouter } from "./routes/profile.ts";
import {
  authRequired,
  implicitLoopbackRequestAllowed,
  sameOriginRequestAllowed,
  ownerIdentity,
  publicOriginConfigured,
  publicSurfaceAuthRequired,
  trustedLocalIdentity,
  verifyRealtimeCredential,
  wsAuthRequired,
} from "./auth.ts";
import { gatewayAdmits, isHosted } from "./hosted.ts";
import { warmAuthServerCaches } from "./oauth-jwt.ts";
import { verifyRawCookieHeader, hasOwnerPasswordSync } from "./session-store.ts";
import { hasScope, listTokens, tokenIdFromToken, type TokenIdentity } from "./token-store.ts";
import {
  REACHABLE_NETWORK_NOTICE,
  tlsTerminatedUpstream,
} from "./exposure-notice.ts";
import { WorkspaceWatcher } from "./watcher.ts";
import { DocumentFilesystemCoordinator } from "./document-filesystem-coordinator.ts";
import { invalidateSearchIndex, noteRecordMutated } from "./search-index.ts";
import { invalidateLinkGraph } from "./link-graph.ts";
import { docAliasesRouter } from "./routes/doc-aliases.ts";
import { docAliasReservationError } from "./doc-aliases.ts";
import { evictFreshness } from "./freshness.ts";
import { lintScheduler, startLintScheduler } from "./wiki-lint.ts";
import { recordIndex, recordIndexEnabled } from "./record-index.ts";
import { THREADS_SCOPE, wsManager } from "./ws.ts";
import { yjsManager } from "./yjs-manager.ts";
import {
  getDocCollaborationCacheEpoch,
  listSpaces,
  readDoc } from "./store.ts";
import { syncExternalDocChange } from "./external-doc-sync.ts"
import { listRecordCollections } from "./record-store.ts";
import { recordExternalWidgetChange } from "./widget-version-store.ts";
import { getWidgetPath, withWidgetWriteLock } from "./widget-store.ts";
import { withVersionKeyLock } from "./version-store.ts";
import {
  htmlDocumentSourceExistsV2,
  usesHtmlDocumentStorageV2,
} from "./html-document-storage-v2.ts";
import { seedStarterWorkspace } from "./seed.ts";
import { ensureInstallIdentity } from "./local-identity.ts";
import { reconcileUpdateStatus } from "./update-runner.ts";
import {
  startBackgroundUpdateCheckScheduler,
  updateCheckDisabled,
  updateCheckSupported,
} from "./update-check.ts";
import { VERSION } from "./release-info.ts";
import { createStaticFileResponse, getStaticAssetsInfo } from "./static-assets.ts";
import { ensureWorkspaceManifest, getWorkspaceRoot, WorkspaceAdoptionError } from "./workspace.ts";
import { runRetentionSweep } from "./version-retention.ts";
import {
  changeEventAffectsContentDerivedState,
  drainWorkspaceChanges,
  notifyWorkspaceChangeAndWait,
  notifyWorkspaceChangeAndWaitOrThrow,
  onWorkspaceChange,
  type ChangeEvent,
} from "./workspace-events.ts";
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts";
import { runServerMaintenance } from "./server-maintenance.ts";
import { beginPreparedWorkspaceReplacement } from "./workspace-replacement.ts";
import {
  calculateLocalWorkspaceContentCheckpoints,
  calculateWorkspaceContentCheckpoint,
} from "./workspace-transfer-v2.ts";
import {
  setWorkspaceReplacementExecutor,
  waitForActiveWorkspaceExports,
} from "./workspace-replacement-coordinator.ts";
import {
  setWorkspaceExportFlush,
  setWorkspaceExportSnapshot,
} from "./workspace-export-coordinator.ts";
import { recoverInterruptedWorkspaceReplacements } from "./workspace-replacement-recovery.ts";
import {
  reconcileRecoveredDocumentLifecycles,
  recoverInterruptedDocumentLifecycles,
} from "./document-lifecycle-journal.ts"
import {
  discoverDocumentDataV2LifecycleRecovery,
  reconcileDocumentDataV2LifecycleRecovery,
} from "./document-data-lifecycle-v2.ts"
import {
  discoverDocumentCreateRecoveryV2,
  reconcileDocumentCreateRecoveryV2,
} from "./document-create-recovery-v2.ts"
import {
  admitWorkspaceRequest,
  isWorkspaceRequestAdmissionOpen,
  isWorkspaceRequest,
  resumeWorkspaceRequestAdmission,
  runWorkspaceRequestAdmissionHookForTests,
  stopWorkspaceRequestAdmissionAndDrain,
} from "./workspace-request-lifecycle.ts";
import {
  clearWorkspaceRecoveryRequirement,
  onWorkspaceRecoveryRequired,
  requireWorkspaceRecovery,
  WorkspaceUnavailableError,
  workspaceRecoveryRequired,
} from "./workspace-safety.ts"
import { startWorkspaceTransferMaintenance } from "./workspace-transfer-jobs.ts";
import {
  disableAuthorizedOperatorRequestTimeout,
  initializeLocalOperatorToken,
  isAuthorizedLocalOperatorRequest,
} from "./operator-export.ts";

// ============================================================
// App setup
// ============================================================

const app = new Hono();

// CORS split.
//
// Default: a wildcard, no-credentials CORS for everything — byte-for-byte
// today's behavior. The /mcp router mounts its own origin:"*" no-creds CORS
// (untouched here; browsers never speak MCP).
//
// When exposed (non-loopback bind or configured public origin), the browser's
// REST/auth calls must send the session cookie, which requires
// `credentials:true` and a REFLECTED origin (the wildcard "*" is illegal with
// credentials). The reflector is a strict SAME-ORIGIN allowlist, NOT an open
// identity reflector: the request Origin is reflected only when its host equals
// the public request host, else denied. Because the real client is same-origin,
// denying cross-origin is correct.
const sameOriginCredentialedCors = cors({
  origin: (origin, c) => {
    return origin && sameOriginRequestAllowed(c.req.raw) ? origin : undefined;
  },
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Worktable-Content-Epoch"],
});

const wildcardCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Authorization",
    "mcp-session-id",
    "Last-Event-ID",
    "mcp-protocol-version",
  ],
  exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
});

// One CORS per request, never two (a second would overwrite the first's
// Access-Control-Allow-Origin). For the cookie surfaces (/api/*, /auth/*) use
// same-origin CORS for ambient local / cookie access; explicit bearer clients
// retain cross-origin access, subject to credential and scope verification. The /mcp router's own CORS
// is mounted on the router and is unaffected.
function isCookieSurface(pathname: string): boolean {
  // /api/mcp is the hosted MCP mount — a bearer surface with no cookie
  // path. It must keep the wildcard MCP CORS (exact /mcp parity): the
  // credentialed same-origin policy would deny cross-origin MCP clients
  // and drop the mcp-* headers.
  if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) {
    return false;
  }
  return pathname.startsWith("/api/") || pathname.startsWith("/auth/");
}

app.use("*", async (c, next) => {
  const bearerPreflight = c.req.method === "OPTIONS" &&
    c.req.header("Access-Control-Request-Headers")?.toLowerCase().split(",").some((header) => header.trim() === "authorization");
  if (isCookieSurface(new URL(c.req.url).pathname) &&
      (publicSurfaceAuthRequired() || (!c.req.header("Authorization") && !bearerPreflight))) {
    return sameOriginCredentialedCors(c, next);
  }
  return wildcardCors(c, next);
});
const requestLogger = logger();
app.use("*", (c, next) =>
  c.req.path === "/api/linked/account/callback" ? next() : requestLogger(c, next)
);
app.use("/api/*", compressApiResponse);

// A replacement closes this gate before stopping the listener. Every admitted
// workspace mutation is held until its complete route lifecycle settles, so a
// handler that already passed authorization cannot write into the new root.
app.use("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (!isWorkspaceRequest(c.req.method, pathname)) return next();
  const release = admitWorkspaceRequest();
  if (!release) {
    return c.json(
      {
        error: "Workspace replacement is in progress",
        code: "WORKSPACE_REPLACING",
      },
      503
    );
  }
  try {
    await runWorkspaceRequestAdmissionHookForTests({
      method: c.req.method,
      pathname,
    });
    return await next();
  } finally {
    release();
  }
});

// Gateway admission (hosted only). A tenant's sprite URL is public, so without
// this a valid bearer could reach the instance DIRECTLY and skip the cloud
// gateway — which is also how a past-due tenant would evade billing
// enforcement. Runs BEFORE any route: admission first, identity second (both
// must hold). No-op for local/self-hosted installs. See hosted.ts.
app.use("*", async (c, next) => {
  if (isAuthorizedLocalOperatorRequest(c.req.raw)) return next();
  if (!gatewayAdmits(c.req.raw)) {
    return c.json({ error: "Forbidden", code: "GATEWAY_REQUIRED" }, 403);
  }
  return next();
});

// Error handler
app.onError((err, c) => {
  if (err instanceof WorkspaceUnavailableError) {
    return c.json({ error: err.message, code: err.code }, 503)
  }
  console.error("[server] unhandled error:", err);
  return c.json(
    { error: err.message ?? "Internal server error", code: "INTERNAL_ERROR" },
    500
  );
});

// Every REST request resolves to an identity (implicit owner for bare
// local requests; presented bearers must verify). Handlers can read it
// via c.get("identity"); browser sessions tighten this later.
//
// /api/mcp is mounted BEFORE this middleware so it keeps exact parity
// with /mcp (bearer-only via requireIdentity, no cookie path). It exists
// because the hosted proxy (Fly Sprites) reserves the literal /mcp path
// for its own MCP feature and swallows every non-POST method on it —
// hosted deployments point WORKTABLE_RESOURCE_URL here instead.
app.route("/api/mcp", mcpRouter);
// Pairing also mounts BEFORE the /api/* identity middleware: its redeem and
// progress routes are authenticated by the pairing code alone (the remote
// agent machine has no cookie or bearer yet), while its owner routes mount
// their own tokens-style gate stack internally.
// Pairing and the connector script are the LOCAL / self-hosted agent-connect
// path: a code is redeemed for an endpoint and a locally minted wt_ token.
// Hosted deliberately has one credential model — AS-issued OAuth bearers (M1,
// proven against real Claude and ChatGPT connectors) — because a wt_ token is
// tenant-local: the control plane does not know it and structurally cannot
// resolve it to a tenant, so the gateway could never route it. Rather than
// leave these as silent dead ends behind app.worktable.cloud, they are closed
// in hosted mode with the same HOSTED_DISABLED shape the owner-password
// surface uses.
app.use("/api/pairing/*", async (c, next) => {
  if (isHosted()) {
    return c.json(
      {
        error: "Pairing is not available on Worktable Cloud; connect your agent with OAuth.",
        code: "HOSTED_DISABLED",
      },
      403
    );
  }
  return next();
});
app.route("/api/pairing", pairingRouter);
// Token management owns its complete gate stack, including the hosted-mode
// prohibition. Mount it before the general REST identity middleware so a bare
// hosted request receives the same truthful HOSTED_DISABLED response as an
// already-authenticated one. Local/self-hosted requests still resolve through
// the router's trustedLocalIdentity → mint-auth → scope chain.
app.route("/api/tokens", tokensRouter);
app.route("/api/agent-connections", agentConnectionsRouter);
app.route("/api/linked", cloudCallbackRouter);
app.use("/api/*", trustedLocalIdentity());
app.use("/api/*", requireWorkspaceContentEpoch);

// Auth/session routes are mounted OUTSIDE the /api/* identity middleware so
// login and status work unauthenticated (the login page must be reachable with
// no cookie). The SPA fallback already serves /login.
app.route("/auth", authSessionRouter);

// Routes
app.route("/health", healthRouter);
app.route("/internal/operator", operatorRouter);
app.route("/public/share", publicSharesRouter);
app.route("/api/workspace", workspaceRouter);
app.route("/api/profile", profileRouter);
app.route("/api/system", systemRouter);
app.route("/api/shares", sharesRouter);
app.route("/api/linked", linkedRouter);
app.route("/api/spaces", spacesRouter);
app.route("/api/spaces/:spaceId/documents", documentsRouter);
app.route("/api/spaces/:spaceId/docs", docsRouter);
app.route("/api/spaces/:spaceId/doc-aliases", docAliasesRouter);
app.route("/api/spaces/:spaceId/widgets", widgetsRouter);
app.route("/api/spaces/:spaceId/records", recordsRouter);
app.route("/api/spaces/:spaceId/annotations", annotationsRouter);
app.route("/api/spaces/:spaceId/threads", threadsRouter);
app.route("/api/threads", threadsRouter);
app.route("/api/search", searchRouter);
app.route("/.well-known", wellKnownRouter);
app.route("/mcp", mcpRouter);
// Version-matched, secret-free provider integration packages. Mounted before
// the SPA fallback and intentionally outside owner authentication so a client
// can download its connection runtime before it has a credential.
app.route("/", integrationsRouter);
// Remote-agent connector assets. Root-mounted (not /api) so the Settings
// one-liner stays short; registered before the static/SPA fallback so the
// paths always resolve to the connector, never the web shell.
// The connector script (/connect.sh, /connect.mjs) belongs to the same
// local/self-hosted pairing flow closed above — a hosted user connects an
// agent with OAuth, not by piping a script that redeems a pairing code.
app.use("/connect.*", async (c, next) => {
  if (isHosted()) {
    return c.json(
      {
        error: "The connector script is not available on Worktable Cloud; connect your agent with OAuth.",
        code: "HOSTED_DISABLED",
      },
      403
    );
  }
  return next();
});
app.route("/", connectRouter);

// Keep removed or unknown API endpoints from falling through to the SPA shell.
app.all("/api/*", (c) => c.json({ error: "Not found", code: "NOT_FOUND" }, 404));

// ============================================================
// Static file serving (production)
// ============================================================

const STATIC_ASSETS = getStaticAssetsInfo();
const HAS_STATIC = Boolean(STATIC_ASSETS.staticDir && STATIC_ASSETS.shellPath);

const SERVICE_WORKER_CLEANUP = `self.addEventListener("install",(event)=>{self.skipWaiting();});
self.addEventListener("activate",(event)=>{event.waitUntil((async()=>{try{const keys=await caches.keys();await Promise.all(keys.map((key)=>caches.delete(key)));}catch{}try{await self.registration.unregister();}catch{}try{const clients=await self.clients.matchAll({type:"window",includeUncontrolled:true});for(const client of clients){client.navigate(client.url);}}catch{}})());});`;

const REGISTER_SW_CLEANUP = `if("serviceWorker" in navigator){window.addEventListener("load",()=>{navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(()=>{});navigator.serviceWorker.getRegistrations().then((registrations)=>registrations.forEach((registration)=>registration.unregister())).catch(()=>{});if(window.caches){caches.keys().then((keys)=>Promise.all(keys.map((key)=>caches.delete(key)))).catch(()=>{});}});}`;

if (HAS_STATIC) {
  const staticDir = STATIC_ASSETS.staticDir!;
  const staticFile = (requestPath: string, request: Request, headers?: HeadersInit) =>
    createStaticFileResponse(staticDir, requestPath, headers, request) ??
    new Response("Not found", { status: 404 });

  // Serve static assets (js, css, images, fonts)
  app.get("/assets/*", (c) => staticFile(c.req.path, c.req.raw));

  // PWA files: service worker, manifest, registerSW, icons, favicons, robots
  if (existsSync(join(staticDir, "sw.js"))) {
    app.get("/sw.js", (c) => staticFile(c.req.path, c.req.raw));
    app.get("/workbox-*.js", (c) => staticFile(c.req.path, c.req.raw));
    app.get("/registerSW.js", (c) => staticFile(c.req.path, c.req.raw));
  } else {
    // The PWA plugin can emit registerSW.js without sw.js for this TanStack Start build.
    // Never let /sw.js fall through to the HTML shell: browsers reject it as a service
    // worker, and stale clients can keep serving broken cached bundles.
    app.get("/sw.js", (c) => c.text(SERVICE_WORKER_CLEANUP, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" }));
    app.get("/workbox-*.js", (c) => c.text("", 404));
    app.get("/registerSW.js", (c) => c.text(REGISTER_SW_CLEANUP, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" }));
  }
  app.get("/manifest.webmanifest", (c) =>
    staticFile(c.req.path, c.req.raw, { "Content-Type": "application/manifest+json" })
  );
  app.get("/favicon.ico", (c) => staticFile(c.req.path, c.req.raw));
  app.get("/favicon.svg", (c) => staticFile(c.req.path, c.req.raw));
  app.get("/apple-touch-icon-180x180.png", (c) => staticFile(c.req.path, c.req.raw));
  app.get("/pwa-64x64.png", (c) => staticFile(c.req.path, c.req.raw));
  app.get("/pwa-192x192.png", (c) => staticFile(c.req.path, c.req.raw));
  app.get("/pwa-512x512.png", (c) => staticFile(c.req.path, c.req.raw));
  app.get("/maskable-icon-512x512.png", (c) => staticFile(c.req.path, c.req.raw));
  app.get("/robots.txt", (c) => staticFile(c.req.path, c.req.raw));

  // SPA fallback: any non-API, non-WS route serves the shell HTML
  // TanStack Start uses _shell.html; older builds use index.html
  const shellPath = STATIC_ASSETS.shellPath!;
  const shellTemplate = readFileSync(shellPath, "utf8");
  const documentPreloads = readDocumentPreloads(staticDir);

  app.get("*", async (c) => {
    const opening = await injectDocumentOpening(c.req.raw, shellTemplate, documentPreloads);
    if (opening) {
      const compressed = acceptsGzip(c.req.header("Accept-Encoding") ?? "");
      return new Response(compressed ? gzipSync(opening) : opening, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          "Vary": "Cookie, Authorization, Accept-Encoding",
          ...(compressed ? { "Content-Encoding": "gzip" } : {}),
        },
      });
    }
    return (
      createStaticFileResponse(staticDir, `/${shellPath.slice(staticDir.length + 1)}`, {
        "Content-Type": "text/html; charset=utf-8",
      }, c.req.raw) ??
      c.text("Static shell not found", 500)
    );
  });

}

// ============================================================
// WS data type
// ============================================================

interface WsData {
  localTokenId?: string;
  credentialRevoked?: boolean;
  sessionStillValid?: () => Promise<boolean>;
  type: "space" | "yjs";
  spaceId: string;
  threadScope?: boolean;
  canReadDocs: boolean;
  canReadWidgets: boolean;
  canReadRecords: boolean;
  canReadAnnotations: boolean;
  canReadThreads: boolean;
  canReadAny: boolean;
  docPath?: string; // Only for yjs
  baseVersionId?: string;
  baseContentHash?: string;
}

// ============================================================
// Server start
// ============================================================

function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * WebSocket upgrade gate for /ws and /yjs. Local implicit access requires a trusted
 * local app or non-browser request. Presented tokens never gain implicit owner
 * authority. When exposed (non-loopback bind or configured public origin):
 *
 *   - Cookie path (browsers): the Origin header MUST be present AND its host must
 *     equal the public request host. An absent/"null"/unparseable Origin is REJECTED —
 *     this closes the absent-Origin bypass and means widgets (opaque "null"
 *     origin sandbox) cannot open a socket. Then the raw Cookie header must carry
 *     a valid owner session.
 *   - Token path (non-browser Yjs tooling): `?token=<bearer>` may omit Origin and
 *     is accepted when the bearer verifies — a workspace-bound wt_ token or,
 *     on hosted instances, an AS-issued JWT (same credential set as the HTTP
 *     surfaces; see verifyRealtimeCredential).
 */
async function wsGateIdentity(
  req: Request,
  url: URL
): Promise<TokenIdentity | null> {
  // Gateway admission first. A WS upgrade never passes through the Hono
  // middleware stack (Bun handles it before app.fetch), so the guard applied
  // to the HTTP surface would not cover /ws and /yjs — which carry the same
  // document traffic. The gateway injects the header on its upstream WS
  // connect, which browsers cannot do themselves. No-op unless hosted with a
  // secret configured.
  if (!gatewayAdmits(req)) return null;

  // A bearer in the Authorization header. A browser cannot set this on a WS
  // handshake, but the gateway can on its upstream connect — and that is the
  // only credential a proxied browser socket carries, because the gateway
  // strips the cookie (it is the gateway's session, meaningless here) and does
  // not put the token in the query string, where it would leak into logs.
  // Checked before the Origin gate: like ?token below, this path may
  // legitimately omit Origin.
  const header = req.headers.get("Authorization");
  if (header !== null) {
    if (!header.startsWith("Bearer ")) return null;
    const bearer = header.slice("Bearer ".length).trim();
    if (!bearer) return null;
    try {
      return await verifyRealtimeCredential(req, bearer);
    } catch {
      return null;
    }
  }

  // Non-browser tooling: a bearer in the query string. This path may
  // legitimately omit Origin, so it is checked before the Origin gate.
  const token = url.searchParams.get("token");
  if (token !== null) {
    if (!token) return null;
    try {
      return await verifyRealtimeCredential(req, token);
    } catch {
      return null;
    }
  }

  // Presented credentials are always checked before ambient local trust.
  if (!wsAuthRequired()) {
    return implicitLoopbackRequestAllowed(req) ? ownerIdentity() : null;
  }

  // Browser cookie path: Origin must be present and same-host.
  const origin = req.headers.get("Origin");
  if (!origin || !sameOriginRequestAllowed(req)) return null;

  return (await verifyRawCookieHeader(req.headers.get("Cookie")))
    ? ownerIdentity()
    : null;
}

// Retain only the public token handle, never the bearer, for session revocation.
function localRealtimeTokenId(req: Request, url: URL, identity: TokenIdentity): string | undefined {
  if (identity.credentialClass !== "local") return undefined;
  const raw = req.headers.get("Authorization")?.slice("Bearer ".length).trim() ?? url.searchParams.get("token");
  if (!raw || raw === process.env["WORKTABLE_MCP_TOKEN"]) return undefined;
  return tokenIdFromToken(raw) ?? undefined;
}

function realtimeCookieCheck(req: Request, url: URL): (() => Promise<boolean>) | undefined {
  if (isHosted() || !wsAuthRequired() || req.headers.has("Authorization") || url.searchParams.has("token")) return undefined;
  const cookie = req.headers.get("Cookie");
  // Keep the cookie in a private verifier closure, never in a serializable field.
  return cookie ? () => verifyRawCookieHeader(cookie) : undefined;
}

async function realtimeAccess(identity: TokenIdentity): Promise<{
  canReadDocs: boolean;
  canReadWidgets: boolean;
  canReadRecords: boolean;
  canReadAnnotations: boolean;
  canReadThreads: boolean;
  canReadAny: boolean;
}> {
  const canReadDocs = hasScope(identity.scopes, "docs:read");
  const canReadWidgets = hasScope(identity.scopes, "widgets:read");
  const canReadRecords = hasScope(identity.scopes, "records:read");
  const canReadAnnotations = hasScope(identity.scopes, "annotations:read");
  const canReadThreads = hasScope(identity.scopes, "threads:read");
  return {
    canReadDocs,
    canReadWidgets,
    canReadRecords,
    canReadAnnotations,
    canReadThreads,
    canReadAny:
      canReadDocs ||
      canReadWidgets ||
      canReadRecords ||
      canReadAnnotations ||
      canReadThreads,
  };
}

/** Teardown for the lint scheduler registered by the most recent startServer. */
let stopLintScheduler: (() => Promise<void>) | null = null;

// Teardown for the completion-anchored update scheduler registered by the most
// recent startServer. Module scope prevents repeated boots in tests from
// stacking parallel check loops.
let stopUpdateCheckScheduler: (() => Promise<void>) | null = null;
let stopWorkspaceTransferMaintenance: (() => Promise<void>) | null = null;

// Version-retention timers for the most recent startServer. Module-scoped and
// replaced (not stacked) on each boot, same rationale as the update scheduler: one
// deferred boot sweep + one 24h steady-state sweep per running server.
let retentionBootTimer: ReturnType<typeof setTimeout> | null = null;
let retentionSweepTimer: ReturnType<typeof setInterval> | null = null;
const RETENTION_BOOT_DELAY_MS = 30_000;
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Watchers are the responsive path, but filesystem event delivery is not a
// durable queue. A low-frequency file-truth sweep heals wholly dropped events.
let recordReconcileSweepTimer: ReturnType<typeof setInterval> | null = null;
const RECORD_RECONCILE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let activeServer: ReturnType<typeof Bun.serve<WsData>> | null = null;
let replacementRestartInProgress = false;
let starterSeedScheduleHookForTests: (() => void | Promise<void>) | null = null;
let workspaceWatcherTestOptions:
  | { debounceMs: number; onPendingChange: (event: ChangeEvent | null) => void }
  | null = null;
let starterSeedRequestWaitHookForTests:
  | ((method: string, path: string) => void)
  | null = null;
let workspaceReplacementRecoveryHookForTests: (() => void) | null = null;
let workspaceReplacementRestartHookForTests:
  | ((phase: "replacement" | "rollback") => void)
  | null = null;
let workspaceReplacementAfterCheckpointHookForTests:
  | (() => void | Promise<void>)
  | null = null;
let terminateAfterWorkspaceReplacementRecoveryFailure = (
  error: unknown
): void => {
  console.error(
    "[Worktable] workspace replacement recovery could not restart the server; terminating for supervisor recovery:",
    error
  );
  process.exit(1);
};

export function setStarterSeedScheduleHookForTests(
  hook: (() => void | Promise<void>) | null
): void {
  starterSeedScheduleHookForTests = hook;
}

export function setWorkspaceWatcherTestOptions(
  options:
    | { debounceMs: number; onPendingChange: (event: ChangeEvent | null) => void }
    | null
): void {
  workspaceWatcherTestOptions = options;
}

export function setStarterSeedRequestWaitHookForTests(
  hook: ((method: string, path: string) => void) | null
): void {
  starterSeedRequestWaitHookForTests = hook;
}

export function setWorkspaceReplacementRecoveryHookForTests(
  hook: (() => void) | null
): void {
  workspaceReplacementRecoveryHookForTests = hook;
}

export function setWorkspaceReplacementRestartHookForTests(
  hook: ((phase: "replacement" | "rollback") => void) | null
): void {
  workspaceReplacementRestartHookForTests = hook;
}

export function setWorkspaceReplacementAfterCheckpointHookForTests(
  hook: (() => void | Promise<void>) | null
): void {
  workspaceReplacementAfterCheckpointHookForTests = hook;
}

export function setWorkspaceReplacementFatalExitHookForTests(
  hook: ((error: unknown) => void) | null
): void {
  terminateAfterWorkspaceReplacementRecoveryFailure =
    hook ??
    ((error: unknown): void => {
      console.error(
        "[Worktable] workspace replacement recovery could not restart the server; terminating for supervisor recovery:",
        error
      );
      process.exit(1);
    });
}

function workspaceRootIsRealDirectory(): boolean {
  try {
    const info = lstatSync(getWorkspaceRoot());
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * A failed second swap rename can throw before a transaction object exists.
 * Retry the durable journal recovery before any suppressed restart gets a
 * chance to adopt the temporarily absent root as a new empty workspace.
 */
function recoverWorkspaceRootBeforeReplacementRestart(): void {
  if (workspaceRootIsRealDirectory()) return;
  recoverInterruptedWorkspaceReplacements();
  if (!workspaceRootIsRealDirectory()) {
    throw new Error(
      "workspace replacement recovery did not restore a real workspace root"
    );
  }
}

function enableWorkspaceTransferMaintenance(): void {
  if (!activeServer || stopWorkspaceTransferMaintenance) return;
  stopWorkspaceTransferMaintenance = startWorkspaceTransferMaintenance();
}

/** Stop the active server, if any, and wait for all shutdown work to finish. */
export async function stopActiveServer(): Promise<void> {
  await activeServer?.stop();
}

export async function runRecordReconcileSweep(): Promise<void> {
  const projectedBefore = recordIndex.projectedCollections();
  await recordIndex.rebuild();
  // A sweep can repair drift without a corresponding watcher event.
  // Invalidate the union of before/after collection identities so a
  // collection removed by the rebuild cannot remain cached in browsers.
  const changed = new Map(projectedBefore.map((entry) => [`${entry.spaceId}/${entry.collectionId}`, entry]));
  for (const space of await listSpaces()) {
    for (const collection of await listRecordCollections(space.id)) {
      changed.set(`${space.id}/${collection.id}`, { spaceId: space.id, collectionId: collection.id });
    }
  }
  for (const { spaceId, collectionId } of changed.values()) {
    wsManager.broadcast(spaceId, { type: "record_collection_update", spaceId, collectionId });
  }
}

export function startServer(
  port = 7480,
  hostname = process.env["HOST"],
  options: {
    resumeWorkspaceRequests?: boolean;
    replacementRestart?: boolean;
  } = {}
): ReturnType<typeof Bun.serve<WsData>> {
  if (activeServer) {
    throw new Error(
      "A Worktable server is already running or stopping in this process. Await server.stop() before starting its replacement.",
    );
  }
  initializeLocalOperatorToken();
  // Importing the server also powers deployment-neutral maintenance commands.
  // Keep startup diagnostics inside the actual startup path so command stdout
  // remains a strict machine-readable channel.
  if (HAS_STATIC) {
    console.log("[server] static serving enabled from", STATIC_ASSETS.staticDir);
  } else {
    console.warn(
      "[server] static serving disabled; checked",
      STATIC_ASSETS.checked.join(", ")
    );
  }
  // SERVER REFUSES TO SERVE exposed-without-password. A non-loopback bind, or a
  // configured public origin that exposes a loopback bind through a tunnel/proxy,
  // MUST have an owner password before any listener exists.
  //
  // Hosted tenant instances (WORKTABLE_HOSTED=1) are the one exception: they
  // never have an owner password — identity arrives as AS-issued bearers via
  // the cloud gateway — and the hosted posture already 401s every bare surface
  // (publicSurfaceAuthRequired/mcpBearerRequired are forced on), so booting
  // without a password exposes nothing.
  const bindIsLoopback =
    hostname === undefined || isLoopbackBindHost(hostname);
  const exposedBind = authRequired() || !bindIsLoopback;
  const publicOrigin = publicOriginConfigured();
  if (!isHosted() && ((exposedBind && !bindIsLoopback) || publicOrigin)) {
    if (!hasOwnerPasswordSync()) {
      const message = publicOrigin
        ? "[Worktable] refusing to serve with a configured public URL and no owner password set. " +
          "Set an owner password before configuring WORKTABLE_PUBLIC_URL or Settings > General > Public URL."
        : "[Worktable] refusing to serve on a non-loopback bind with no owner password set. " +
          "Run `worktable setup --reachable` to set an owner password, or bind to loopback.";
      console.error(message);
      throw new Error(message);
    }
  }

  let workspaceRejected = false;
  let recoveredWorkspaceReset: Promise<void> | null = null;
  let recoveredDocuments: ReturnType<
    typeof recoverInterruptedDocumentLifecycles
  > = [];
  let recoveredDocumentData: ReturnType<
    typeof discoverDocumentDataV2LifecycleRecovery
  > = [];
  let recoveredDocumentCreates: ReturnType<
    typeof discoverDocumentCreateRecoveryV2
  > = [];
  // Warm the AS discovery/JWKS caches in the background when an
  // authorization server is configured. Fire-and-forget: the first bearer
  // after a process start must not pay (or hang on) the AS round-trips —
  // observed live as parallel 13s 401s that MCP clients read as the whole
  // server being down.
  void warmAuthServerCaches();
  // Machine-local install identity is independent of workspace adoption, so it
  // runs in its own try/catch and is never skipped by a workspace rejection.
  try {
    ensureInstallIdentity();
  } catch (err) {
    console.error("[Worktable] install identity setup error:", err);
  }
  // Finalize any in-flight self-update: if this boot is the post-update restart,
  // the running version is the verdict. Machine-local, so it runs regardless of
  // workspace adoption and never blocks startup.
  try {
    const update = reconcileUpdateStatus();
    // A `noop` success installed nothing (already current) — announcing
    // "update complete" for it would be false.
    if (update.state === "succeeded" && update.to && !update.noop)
      console.log(`[Worktable] update complete — now running ${VERSION}`);
    else if (update.state === "failed")
      console.warn(`[Worktable] update did not complete: ${update.error ?? "unknown error"}`);
  } catch (err) {
    console.error("[Worktable] update reconcile error:", err);
  }
  try {
    if (!replacementRestartInProgress) {
      workspaceReplacementRecoveryHookForTests?.();
      const recovered = recoverInterruptedWorkspaceReplacements({ details: true })
        .filter((job) => !job.retained);
      if (recovered.length > 0) {
        retireWorkspaceDerivedFiles();
        recoveredWorkspaceReset = notifyWorkspaceChangeAndWaitOrThrow({
          type: "workspaceReset",
        }).then(async () => {
          // A committed clear must revoke old downloads before boot serves requests.
          for (const job of recovered) {
            if (job.kind === "clear" && job.state === "complete")
              await finalizeWorkspaceClearJob(job.id);
          }
        }).catch((error) => {
          workspaceRejected = true;
          console.error("[workspace] recovered state could not be initialized", error);
        });
        console.warn(
          `[Worktable] recovered ${recovered.length} interrupted workspace replacement${recovered.length === 1 ? "" : "s"}`
        );
      }
    }
    recoveredDocuments = recoverInterruptedDocumentLifecycles()
    if (recoveredDocuments.length > 0) {
      console.warn(
        `[Worktable] recovered ${recoveredDocuments.length} interrupted document lifecycle operation${recoveredDocuments.length === 1 ? "" : "s"}`
      )
    }
    recoveredDocumentData = discoverDocumentDataV2LifecycleRecovery()
    recoveredDocumentCreates = discoverDocumentCreateRecoveryV2()
    if (
      recoveredDocumentData.length > 0 ||
      recoveredDocumentCreates.length > 0
    ) {
      requireWorkspaceRecovery(
        "document V2 data is waiting for recovery"
      )
    } else {
      clearWorkspaceRecoveryRequirement()
    }
    ensureWorkspaceManifest();
  } catch (err) {
    workspaceRejected = true;
    if (err instanceof WorkspaceAdoptionError) {
      console.error(`[Worktable] refusing to start workspace: ${err.message}`);
    } else {
      console.error(
        "[Worktable] refusing to start workspace after setup failed:",
        err
      );
    }
  }

  // Mechanical wiki lint: reacts to internal write notifications and sweeps
  // periodically. WORKTABLE_SKIP_LINT_SWEEP=1 exists for the test runner
  // (same rationale as the starter-seed guard above). Never set in production.
  // Replace, never stack: startServer can run repeatedly in one process, and
  // an ungraceful caller may have skipped the previous server's stop boundary.
  if (!workspaceRejected && process.env["WORKTABLE_SKIP_LINT_SWEEP"] !== "1") {
    // activeServer prevents overlapping server lifecycles; a prior callback
    // can only be a fully stopped lifecycle and is safe to replace here.
    stopLintScheduler = startLintScheduler();
  }

  // Doc version-history retention: one deferred sweep ~30s after boot (so it
  // never delays startup) plus a 24h steady-state sweep. Both no-op instantly
  // when the policy is "all" (the default). Replace-not-stack across reboots,
  // and both timers are unref'd so they never keep a test process (or a briefly
  // idle server) alive. WORKTABLE_SKIP_RETENTION_SWEEP=1 disables them for the
  // test runner, mirroring the lint/seed guards.
  if (retentionBootTimer) clearTimeout(retentionBootTimer);
  if (retentionSweepTimer) clearInterval(retentionSweepTimer);
  retentionBootTimer = null;
  retentionSweepTimer = null;
  if (!workspaceRejected && process.env["WORKTABLE_SKIP_RETENTION_SWEEP"] !== "1") {
    const sweep = () =>
      void runRetentionSweep().catch((err) =>
        console.error("[version-retention] sweep error:", err),
      );
    retentionBootTimer = setTimeout(sweep, RETENTION_BOOT_DELAY_MS);
    retentionBootTimer.unref?.();
    retentionSweepTimer = setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS);
    retentionSweepTimer.unref?.();
  }

  // Record index: derived SQLite projection of record YAML, fed by internal
  // record events plus the watcher (below). WORKTABLE_RECORDS_INDEX=0 is the
  // kill switch. Replace, never stack, same as the lint scheduler. The stop is
  // unconditional: a boot with the kill switch on (or a rejected workspace)
  // must also tear down an index left by a caller that skipped graceful stop.
  recordIndex.stop();
  if (!workspaceRejected && recordIndexEnabled()) {
    recordIndex.start();
  }
  if (recordReconcileSweepTimer) clearInterval(recordReconcileSweepTimer);
  recordReconcileSweepTimer = null;
  if (!workspaceRejected && recordIndexEnabled() && process.env["WORKTABLE_SKIP_RECORD_RECONCILE_SWEEP"] !== "1") {
    recordReconcileSweepTimer = setInterval(() => {
      void runRecordReconcileSweep().catch((err) => console.error("[record-index] periodic reconciliation failed:", err));
    }, RECORD_RECONCILE_SWEEP_INTERVAL_MS);
    recordReconcileSweepTimer.unref?.();
  }

  // When the workspace folder was rejected, do not start the watcher (which
  // would create spaces/ inside a foreign folder) or the periodic space scan.
  // The server still serves /health so the operator can see it is alive and
  // read the refusal reason in the logs.
  const documentFilesystemCoordinator = new DocumentFilesystemCoordinator({
    emit: notifyWorkspaceChangeAndWait,
    onError: (error) => {
      console.error("[document-filesystem] coordination error:", error);
    },
  });
  const watcher = new WorkspaceWatcher({
    onDocumentChange: (event) => documentFilesystemCoordinator.note(event),
    ...(workspaceWatcherTestOptions ?? {}),
  });
  const pendingServerTasks = new Set<Promise<unknown>>();
  let starterSeedTask: Promise<void> | null = null;
  let recoveredDocumentTask: Promise<void> | null = null;
  let startupDiscarded = false;
  let stopWorkspaceChangeHandler: (() => void) | null = null;
  let spaceScanTimer: ReturnType<typeof setInterval> | null = null;

  const trackServerTask = (task: Promise<unknown>): void => {
    pendingServerTasks.add(task);
    void task.finally(() => pendingServerTasks.delete(task)).catch(() => {});
  };

  const drainServerTasks = async (): Promise<void> => {
    while (pendingServerTasks.size > 0) {
      await Promise.allSettled([...pendingServerTasks]);
    }
  };

  // First run on an empty workspace: seed the welcome space so the first
  // open isn't an empty void. No-op on any workspace with content. Skipped
  // when the workspace folder was rejected so we never write into a foreign
  // or unreadable folder. Track it as server-owned work so replacement waits
  // for the last write before swapping workspace roots.
  //
  // WORKTABLE_SKIP_STARTER_SEED=1 disables the seed for the test runner. The
  // seed itself is covered directly by seed.test.ts. Never set in production.
  if (
    !workspaceRejected &&
    !options.replacementRestart &&
    process.env["WORKTABLE_SKIP_STARTER_SEED"] !== "1"
  ) {
    const task = (async () => {
      // Make cancellation after any synchronous startup failure an explicit
      // production boundary rather than an incidental await of a test hook.
      await Promise.resolve();
      if (startupDiscarded) return;
      await starterSeedScheduleHookForTests?.();
      if (startupDiscarded) return;
      const seeded = await seedStarterWorkspace();
      if (seeded) {
        console.log("[Worktable] seeded starter workspace (welcome space)");
      }
    })().catch((err) =>
      console.error("[Worktable] starter seed error:", err)
    );
    starterSeedTask = task;
    trackServerTask(task);
    void task.finally(() => {
      if (starterSeedTask === task) starterSeedTask = null;
    });
  }
  // A widget save touches two files (widget.yaml + index.html) and so fires
  // two watcher events; coalesce per widget before versioning external edits.
  const widgetChangeCoalescer = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; flush: () => void }
  >();
  const flushWidgetChangeCoalescer = (): void => {
    const pending = [...widgetChangeCoalescer.values()];
    for (const { timer } of pending) clearTimeout(timer);
    for (const { flush } of pending) flush();
  };
  const discardFailedStart = (): void => {
    startupDiscarded = true;
    watcher.stop();
    stopWorkspaceChangeHandler?.();
    stopWorkspaceChangeHandler = null;
    void documentFilesystemCoordinator
      .stop({ flushPending: false })
      .catch((stopErr) =>
        console.error(
          "[document-filesystem] failed-start cleanup error:",
          stopErr
        )
      );
    if (spaceScanTimer) clearInterval(spaceScanTimer);
    spaceScanTimer = null;
    for (const { timer } of widgetChangeCoalescer.values()) clearTimeout(timer);
    widgetChangeCoalescer.clear();
    if (retentionBootTimer) clearTimeout(retentionBootTimer);
    retentionBootTimer = null;
    if (retentionSweepTimer) clearInterval(retentionSweepTimer);
    retentionSweepTimer = null;
    if (recordReconcileSweepTimer) clearInterval(recordReconcileSweepTimer);
    recordReconcileSweepTimer = null;
    const stopLint = stopLintScheduler;
    stopLintScheduler = null;
    void stopLint?.().catch((stopErr) =>
      console.error("[wiki-lint] failed-start cleanup error:", stopErr)
    );
    recordIndex.stop();
  };
  const WIDGET_CHANGE_COALESCE_MS = 250;
  if (!workspaceRejected) {
    stopWorkspaceChangeHandler = onWorkspaceChange(async (event) => {
      if (event.type === "doc") {
        const aliasError = await docAliasReservationError(
          event.spaceId,
          event.docPath
        );
        if (aliasError) return;
      }
      // Invalidate derived state on any content change. External edits do not
      // flow through store.writeDoc, so this is their only notification path.
      // Record events route through noteRecordMutated: while the record index
      // serves record search, a record change must not rebuild MiniSearch.
      if (changeEventAffectsContentDerivedState(event)) {
        if (event.type === "record" || event.type === "recordCollection" || event.type === "recordCollectionReconcile") noteRecordMutated();
        else invalidateSearchIndex();
        invalidateLinkGraph();
      }

      // Keep the record index fresh on external edits (internal writes reach
      // it synchronously via record-events; these ingests are idempotent, so
      // the watcher echo of an internal write is harmless). Projection
      // maintenance is derived-cache work: a failure is logged, but must not
      // prevent the canonical-file change from reaching websocket clients.
      try {
        if (event.type === "record" && recordIndex.isStarted()) {
          await recordIndex.ingestFile(event.spaceId, event.collectionId, event.recordId);
        }
        if (event.type === "recordCollection" && recordIndex.isStarted()) {
          await recordIndex.refreshCollection(event.spaceId, event.collectionId);
        }
        if (event.type === "recordCollectionReconcile" && recordIndex.isStarted()) {
          const result = await recordIndex.reconcileCollection(event.spaceId, event.collectionId);
          console.info(`[record-index] ${JSON.stringify({
            event: "collection_reconciled",
            workspace: getWorkspaceRoot(),
            spaceId: event.spaceId,
            collectionId: event.collectionId,
            eventKind: event.type,
            ...result,
          })}`);
        }
      } catch (err) {
        console.error(`[record-index] watcher ${event.type} projection update failed:`, err);
      }

      // Version external HTML-doc (widget) edits. One logical save touches
      // widget.yaml AND index.html — two watcher events — so coalesce per
      // widget id before recording, or the first event would snapshot a
      // half-written mix of new yaml + old html. Watcher echo of our own
      // REST/MCP writes dedups away inside recordExternalWidgetChange (the
      // content hash matches the provenance those writes already recorded).
      if (event.type === "widget") {
        const key = `${event.spaceId}:${event.widgetId}`;
        const pending = widgetChangeCoalescer.get(key);
        if (pending) clearTimeout(pending.timer);
        let flushed = false;
        const flush = () => {
          if (flushed) return;
          flushed = true;
          widgetChangeCoalescer.delete(key);
          const recordChange = async () => {
            try {
              await recordExternalWidgetChange(event.spaceId, event.widgetId, {
                updatedBy: "external",
                source: "filesystem",
              });
            } catch (err) {
              console.error("[server] widget version record error:", err);
            }
            // Broadcast AFTER recording: clients refetch on widget_update, and a
            // broadcast before the provenance write would hand them a stale
            // contentHash/version list for the 250ms coalesce window. When the
            // widget was removed on disk, recordExternalWidgetChange has already
            // retired its history/provenance/annotations, but handleChange re-reads
            // the widget for a widget_update and silently returns when the files are
            // gone — so clients would never learn of the deletion. Emit
            // widget_deleted explicitly so widget AND annotation queries refetch.
            const exists = (await usesHtmlDocumentStorageV2())
              ? await htmlDocumentSourceExistsV2(
                  event.spaceId,
                  event.widgetId
                )
              : existsSync(dirname(getWidgetPath(event.spaceId, event.widgetId)));
            if (!exists) {
              wsManager.broadcast(event.spaceId, { type: "widget_deleted", spaceId: event.spaceId, widgetId: event.widgetId });
            } else {
              await wsManager.handleChange(event).catch((err) =>
                console.error("[server] ws broadcast error:", err)
              );
            }
          };
          trackServerTask(usesHtmlDocumentStorageV2().then((storageV2) =>
            storageV2
              ? recordChange()
              : withVersionKeyLock(event.spaceId, "widgets", event.widgetId, () =>
                  withWidgetWriteLock(event.spaceId, event.widgetId, recordChange)
                )
          ));
        };
        const timer = setTimeout(flush, WIDGET_CHANGE_COALESCE_MS);
        widgetChangeCoalescer.set(key, { timer, flush });
        // The deferred callback owns this event's broadcast.
        return;
      }

      // Sync external doc changes into Yjs in-memory state
      if (event.type === "doc") {
        console.log(`[Worktable] watcher doc change event: spaceId=${event.spaceId}, docPath=${event.docPath}`);
        evictFreshness(event.spaceId, event.docPath);
        // External edits bypass store.writeDoc, so notify lint here.
        lintScheduler.noteDocChanged(event.spaceId, event.docPath);
        try {
          await syncExternalDocChange(event.spaceId, event.docPath);
        } catch (err) {
          console.error("[server] external doc sync error:", err);
        }
      }

      trackServerTask(wsManager.handleChange(event).catch((err) =>
        console.error("[server] ws broadcast error:", err)
      ));
    });
    try {
      watcher.start();
    } catch (err) {
      discardFailedStart();
      throw err;
    }

    if (
      recoveredDocuments.length > 0 ||
      recoveredDocumentData.length > 0 ||
      recoveredDocumentCreates.length > 0
    ) {
      const task = (async () => {
        if (recoveredDocumentData.length > 0) {
          await reconcileDocumentDataV2LifecycleRecovery(recoveredDocumentData)
        }
        if (recoveredDocuments.length > 0) {
          await reconcileRecoveredDocumentLifecycles(recoveredDocuments);
        }
        if (recoveredDocumentCreates.length > 0) {
          await reconcileDocumentCreateRecoveryV2(recoveredDocumentCreates)
        }
        clearWorkspaceRecoveryRequirement()
      })().catch((error) => {
        requireWorkspaceRecovery(
          "recovered document content could not be reconciled"
        );
        console.error(
          "[document-lifecycle] recovered content reconciliation failed:",
          error
        );
      });
      recoveredDocumentTask = task;
      trackServerTask(task);
      void task.finally(() => {
        if (recoveredDocumentTask === task) recoveredDocumentTask = null;
      });
    }

    // Periodic space scan: detect new spaces created on disk
    let knownSpaceIds = new Set<string>();
    // Initialize known spaces
    trackServerTask(listSpaces().then((spaces) => {
      knownSpaceIds = new Set(spaces.map((s) => s.id));
    }).catch((err) => console.error("[Worktable] initial space scan error:", err)));

    spaceScanTimer = setInterval(() => {
      trackServerTask((async () => {
        try {
          const spaces = await listSpaces();
          const currentIds = new Set(spaces.map((s) => s.id));
          let hasNew = false;
          for (const id of currentIds) {
            if (!knownSpaceIds.has(id)) {
              hasNew = true;
              console.log(`[Worktable] new space detected on disk: ${id}`);
            }
          }
          knownSpaceIds = currentIds;
          if (hasNew) {
            wsManager.broadcastAll({ type: "spaces_changed" });
          }
        } catch (err) {
          console.error("[Worktable] periodic space scan error:", err);
        }
      })());
    }, 5000);
    spaceScanTimer.unref?.();
  }

  const stopWorkspaceSafetyHandler = onWorkspaceRecoveryRequired(() => {
    wsManager.closeAll()
    yjsManager.quarantineForWorkspaceRecovery()
  })

  const credentialSockets = new Set<import("bun").ServerWebSocket<WsData>>();
  let credentialCheck: Promise<void> | null = null;
  const checkRealtimeCredentials = (): Promise<void> => {
    if (credentialCheck) return credentialCheck;
    if (credentialSockets.size === 0) return Promise.resolve();
    credentialCheck = (async () => {
      // Read canonical app-private state so CLI / other-process revocations also
      // take effect. No token secrets are copied into WebSocket state.
      let activeIds = new Set<string>();
      try {
        activeIds = new Set((await listTokens())
          .filter(token => !token.revokedAt && token.workspace === getWorkspaceRoot())
          .map(token => token.id));
      } catch {
        // Losing the credential store cannot preserve authenticated sessions.
      }
      for (const socket of credentialSockets) {
        let revoked = Boolean(socket.data.localTokenId && !activeIds.has(socket.data.localTokenId));
        if (!revoked && socket.data.sessionStillValid) {
          try { revoked = !(await socket.data.sessionStillValid()); } catch { revoked = true; }
        }
        if (revoked) {
          socket.data.credentialRevoked = true;
          credentialSockets.delete(socket);
          if (socket.data.type === "yjs") {
            yjsManager.handleDisconnect(socket, socket.data.spaceId, socket.data.docPath!);
          } else {
            wsManager.unsubscribe(socket);
          }
          // Bun 1.3.14 can retain its pending-WebSocket count after a server-
          // initiated close, hanging stop(). Detach authorization immediately;
          // let the peer / native idle timeout / shutdown finish the transport.
          // A revoked Yjs peer must not receive a JSON frame on its binary protocol.
          if (socket.data.type === "space") {
            try {
              socket.send(JSON.stringify({ type: "error", error: "Credential revoked" }));
            } catch {
              // The peer may already have gone away; authorization is detached.
            }
          }
        }
      }
    })().finally(() => { credentialCheck = null; });
    return credentialCheck;
  };

  const startListener = () => Bun.serve<WsData>({
    port,
    ...(hostname ? { hostname } : {}),
    idleTimeout: 120, // seconds — sync MCP calls can poll up to 60s
    async fetch(req, server) {
      const url = new URL(req.url);
      // A full-workspace capture may be quiet for hours. This capability is
      // process-local and owner-only, so disable Bun's idle timer only for the
      // authenticated maintenance hop rather than for public requests.
      disableAuthorizedOperatorRequestTimeout(req, server);

      // A rejected workspace must be left byte-for-byte untouched. Short-circuit
      // every workspace-touching surface (REST, MCP, Yjs/space WebSockets) with
      // 503 so no request can create spaces/ or other files under the foreign or
      // unreadable folder. /health stays up so the operator can see the server is
      // alive and read the refusal reason in the logs.
      if (
        (workspaceRejected || workspaceRecoveryRequired()) &&
        url.pathname !== "/health"
      ) {
        return new Response(
          JSON.stringify({
            error: workspaceRejected
              ? "Workspace unavailable: the configured folder was not adopted. See server logs."
              : "Workspace unavailable: restart Worktable to finish recovering a document move.",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }

      if (recoveredWorkspaceReset && url.pathname !== "/health") {
        await recoveredWorkspaceReset;
        if (workspaceRejected) {
          return new Response("Workspace recovery failed; restart Worktable.", {
            status: 503,
          });
        }
      }
      const pendingRecoveredDocument = recoveredDocumentTask;
      if (pendingRecoveredDocument && url.pathname !== "/health") {
        await pendingRecoveredDocument;
        if (workspaceRecoveryRequired()) {
          return new Response(
            JSON.stringify({
              error:
                "Workspace unavailable: restart Worktable to finish recovering a document move.",
            }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      // Health remains responsive while the first-run seed lands, but no
      // workspace-facing request may observe or mutate the empty workspace.
      // Transfer maintenance stays exempt so a requested replacement can
      // supersede a pending seed without deadlocking server shutdown.
      const pendingStarterSeed = starterSeedTask;
      const readOnlyWorkspaceIdentityProbe =
        req.method === "GET" && url.pathname === "/api/workspace";
      if (
        pendingStarterSeed &&
        url.pathname !== "/health" &&
        !readOnlyWorkspaceIdentityProbe &&
        !url.pathname.startsWith("/api/workspace/transfers/")
      ) {
        starterSeedRequestWaitHookForTests?.(req.method, url.pathname);
        await pendingStarterSeed;
      }

      // Handle Yjs WebSocket upgrade at /yjs/{spaceId}/{docPath...}
      if (url.pathname.startsWith("/yjs/")) {
        if (!isWorkspaceRequestAdmissionOpen()) {
          return new Response(
            "Workspace writes are temporarily paused for a consistent snapshot",
            { status: 503, headers: { "Retry-After": "1" } }
          );
        }
        // Decode each segment so the collab room path matches the REST path
        // (extractDocPath in routes/docs.ts also decodes). Without this, a doc
        // titled "Planning Onsite" opens a room for "Planning%20Onsite" and the
        // editor persists a duplicate "Planning%20Onsite.json" alongside it.
        let parts: string[];
        try {
          parts = url.pathname.slice(5).split("/").map(decodeURIComponent); // Remove '/yjs/'
        } catch {
          return new Response("Invalid Yjs room path", { status: 400 });
        }
        const spaceId = parts[0] ?? "";
        const docPath = parts.slice(1).join("/");

        if (!spaceId || !docPath) {
          return new Response("Missing spaceId or docPath", { status: 400 });
        }

        const identity = await wsGateIdentity(req, url);
        if (!identity) {
          return new Response("Forbidden", { status: 403 });
        }
        // Browser edit-intent frames become human provenance. Agent writes use
        // the REST/MCP paths, which attribute them to the verified principal.
        if (identity.principal.type !== "human" || !hasScope(identity.scopes, "docs:write")) {
          return new Response("Forbidden", { status: 403 });
        }
        const access = await realtimeAccess(identity);

        const roomDoc = await readDoc(spaceId, docPath);
        if (roomDoc.error || roomDoc.data === null) {
          return new Response("Document not found", { status: 404 });
        }
        if (roomDoc.storedAs === "md") {
          return new Response("Markdown documents are read-only", {
            status: 409,
          });
        }
        const collaborationEpoch = url.searchParams.get(
          "collaborationEpoch"
        );
        const collaborationCacheEpoch = url.searchParams.get(
          "collaborationCacheEpoch"
        );
        const expectedCacheEpoch = await getDocCollaborationCacheEpoch(
          spaceId,
          docPath
        );
        if (
          !collaborationEpoch ||
          collaborationEpoch !== (await getWorkspaceCollaborationEpoch()) ||
          (collaborationCacheEpoch
            ? collaborationCacheEpoch !== expectedCacheEpoch
            : expectedCacheEpoch !== "legacy")
        ) {
          return new Response(
            "Collaboration session expired; reload the document",
            { status: 409 }
          );
        }

        const success = server.upgrade(req, {
          data: {
            type: "yjs" as const,
            localTokenId: localRealtimeTokenId(req, url, identity),
            sessionStillValid: realtimeCookieCheck(req, url),
            spaceId,
            ...access,
            docPath,
            baseVersionId: url.searchParams.get("baseVersionId") ?? undefined,
            baseContentHash: url.searchParams.get("baseContentHash") ?? undefined,
          },
        });
        if (success) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Handle existing space WebSocket upgrade at /ws?spaceId=xxx
      if (url.pathname === "/ws") {
        const identity = await wsGateIdentity(req, url);
        if (!identity) {
          return new Response("Forbidden", { status: 403 });
        }
        const access = await realtimeAccess(identity);
        if (!access.canReadAny) {
          return new Response("Forbidden", { status: 403 });
        }
        const threadScope = url.searchParams.get("scope") === "threads";
        const spaceId = threadScope
          ? THREADS_SCOPE
          : (url.searchParams.get("spaceId") ?? "");
        if (threadScope && !access.canReadThreads) {
          return new Response("Forbidden", { status: 403 });
        }
        const success = server.upgrade(req, {
          data: {
            type: "space" as const,
            localTokenId: localRealtimeTokenId(req, url, identity),
            sessionStillValid: realtimeCookieCheck(req, url),
            spaceId,
            threadScope,
            ...access,
          },
        });
        if (success) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return app.fetch(req);
    },
    websocket: {
      async open(ws) {
        if (ws.data.localTokenId || ws.data.sessionStillValid) credentialSockets.add(ws);
        if (workspaceRejected || workspaceRecoveryRequired()) {
          ws.close()
          return
        }
        if (ws.data.type === "yjs") {
          try {
            // Bun may deliver message events before this async handler settles.
            // YjsDocManager registers the socket synchronously and buffers those
            // early protocol frames until the room is ready.
            await yjsManager.handleConnection(
              ws,
              ws.data.spaceId,
              ws.data.docPath!,
              {
                baseVersionId: ws.data.baseVersionId,
                baseContentHash: ws.data.baseContentHash,
              }
            );
          } catch (err) {
            console.warn(
              `[YjsManager] refusing room ${ws.data.spaceId}/${ws.data.docPath}: ${(err as Error).message}`
            );
            ws.close();
          }
        } else {
          const { spaceId } = ws.data;
          if (spaceId) {
            wsManager.subscribe(ws, spaceId);
            ws.send(
              JSON.stringify(
                ws.data.threadScope
                  ? { type: "subscribed", scope: "threads" }
                  : { type: "subscribed", spaceId }
              )
            );
          } else {
            ws.send(
              JSON.stringify({
                type: "error",
                error: "Missing spaceId query param",
              })
            );
            ws.close();
          }
        }
      },
      message(ws, message) {
        if (ws.data.credentialRevoked) return;
        if (ws.data.type === "yjs") {
          if (workspaceRecoveryRequired()) {
            ws.close()
            return
          }
          yjsManager.handleMessage(
            ws,
            ws.data.spaceId,
            ws.data.docPath!,
            message as ArrayBuffer | Uint8Array
          );
        }
        // Old space WS clients don't send messages; ignore
      },
      close(ws) {
        credentialSockets.delete(ws);
        if (ws.data.type === "yjs") {
          yjsManager.handleDisconnect(
            ws,
            ws.data.spaceId,
            ws.data.docPath!
          );
        } else {
          wsManager.unsubscribe(ws);
        }
      },
    },
  });

  let server: ReturnType<typeof Bun.serve<WsData>>;
  try {
    server = startListener();
  } catch (err) {
    stopWorkspaceSafetyHandler()
    // Bun can reject the bind after workspace services were initialized. Undo
    // every long-lived source synchronously before allowing a retry.
    discardFailedStart();
    throw err;
  }
  // Bounded revocation latency for local bearer and owner-cookie sessions. Empty
  // installs do no token-store I/O, and overlapping checks are coalesced.
  const credentialTimer = setInterval(() => { void checkRealtimeCredentials(); }, 1000);
  credentialTimer.unref?.();
  activeServer = server;
  const stopLinked = startLinkedRuntime();
  const stopBackupNotifier = startWorkspaceBackupNotifier();
  if (options.resumeWorkspaceRequests !== false) {
    resumeWorkspaceRequestAdmission();
  }
  void stopWorkspaceTransferMaintenance?.();
  stopWorkspaceTransferMaintenance =
    workspaceRejected || options.resumeWorkspaceRequests === false
      ? null
      : startWorkspaceTransferMaintenance();

  // Keep the update-check cache warm while the service runs, so surfaces that
  // must never block on the network (the CLI's passive nudge, the Settings
  // drawer) read a recent answer. Start only after the listener binds: a failed
  // boot must not leave an update request racing a replacement server.
  //
  // Two opt-outs of DIFFERENT strengths, not duplicates:
  //   WORKTABLE_NO_UPDATE_CHECK (env) kills ALL checks, including the manual
  //     Settings/CLI paths — enforced inside checkForUpdate itself.
  //   settings.updates.autoCheck === false disables only these BACKGROUND
  //     checks; the manual path (GET /version, explicit CLI check) still runs.
  // autoCheck is re-read each tick so toggling it in Settings takes effect
  // without a restart.
  if (updateCheckSupported() && !updateCheckDisabled()) {
    stopUpdateCheckScheduler = startBackgroundUpdateCheckScheduler();
  }

  const displayHost = hostname && hostname !== "0.0.0.0" ? hostname : "localhost";
  // Print the actual bound port (server.port), not the requested `port` arg:
  // when called with port 0 the OS assigns an ephemeral port, and the old
  // banner cosmetically printed 0.
  console.log(`[Worktable server] running on http://${displayHost}:${server.port}`);

  // Exposure notice: when bound non-loopback (or the exposure flag is set), the
  // server is reachable from other machines. Covers the background-service path
  // too. Shared constant with the CLI banners (see exposure-notice.ts), and
  // suppressed when the operator has declared HTTPS is terminated upstream.
  const exposed =
    (hostname !== undefined && !isLoopbackBindHost(hostname)) ||
    process.env["WORKTABLE_REQUIRE_AUTH"] === "1";
  if (exposed && !tlsTerminatedUpstream()) {
    console.warn(`[Worktable server] ${REACHABLE_NETWORK_NOTICE}`);
  }

  // Bun owns the listening socket, but Worktable also starts filesystem and
  // derived-state services. Make stop() the lifecycle boundary for both so a
  // supervised restart or test cannot leave work running against a later
  // workspace/app-storage provider.
  const stopSocket = server.stop.bind(server);
  let stopPromise: Promise<void> | null = null;
  server.stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;

    // Cancel sources synchronously, even when a caller intentionally does not
    // await stop(). The returned promise drains work that was already running.
    stopWorkspaceSafetyHandler()
    clearInterval(credentialTimer);
    watcher.stop({ flushPending: true });
    const documentFilesystemStopping = documentFilesystemCoordinator
      .stop()
      .finally(() => {
        stopWorkspaceChangeHandler?.();
        stopWorkspaceChangeHandler = null;
      });
    if (spaceScanTimer) clearInterval(spaceScanTimer);
    spaceScanTimer = null;
    flushWidgetChangeCoalescer();
    const stopUpdateChecks = stopUpdateCheckScheduler;
    const updateChecksStopping = stopUpdateChecks?.() ?? Promise.resolve();
    stopUpdateCheckScheduler = null;
    const stopTransfers = stopWorkspaceTransferMaintenance;
    stopWorkspaceTransferMaintenance = null;
    const transfersStopping = stopTransfers?.() ?? Promise.resolve();
    if (retentionBootTimer) clearTimeout(retentionBootTimer);
    retentionBootTimer = null;
    if (retentionSweepTimer) clearInterval(retentionSweepTimer);
    retentionSweepTimer = null;
    if (recordReconcileSweepTimer) clearInterval(recordReconcileSweepTimer);
    recordReconcileSweepTimer = null;
    const stopLint = stopLintScheduler;
    stopLintScheduler = null;
    const lintStopping = stopLint?.() ?? Promise.resolve();

    stopPromise = (async () => {
      const shutdownErrors: unknown[] = [];
      const settle = async (work: () => Promise<unknown>): Promise<void> => {
        try {
          await work();
        } catch (err) {
          shutdownErrors.push(err);
        }
      };
      try {
        // A server lifecycle cannot remain half-alive behind an indefinitely
        // open upgraded connection. Worktable drains its own durable work
        // below, so the listener boundary itself is always force-closed.
        await settle(() => stopSocket(true));
        await settle(stopLinked);
        await settle(stopBackupNotifier);
        await settle(() => credentialCheck ?? Promise.resolve());
        credentialSockets.clear();
        await settle(async () => {
          await documentFilesystemStopping;
          // The coordinator can deliver a widget after the synchronous pass
          // above while it drains an earlier async document handler.
          flushWidgetChangeCoalescer();
          await drainWorkspaceChanges();
          await drainServerTasks();
        });
        await settle(() => yjsManager.shutdown());
        await settle(async () => {
          await drainWorkspaceChanges();
          await drainServerTasks();
        });
        await settle(() => lintStopping);
        await settle(() => transfersStopping);
        await settle(() => updateChecksStopping);
        await settle(() => recordIndex.whenIdle());
        try {
          recordIndex.stop();
        } catch (err) {
          shutdownErrors.push(err);
        }
      } finally {
        if (activeServer === server) {
          activeServer = null;
          setWorkspaceReplacementExecutor(null);
          setWorkspaceExportFlush(null);
          setWorkspaceExportSnapshot(null);
        }
      }
      if (shutdownErrors.length === 1) throw shutdownErrors[0];
      if (shutdownErrors.length > 1) {
        throw new AggregateError(shutdownErrors, "Worktable server shutdown failed");
      }
    })();
    return stopPromise;
  };

  const replacementPort = server.port;
  setWorkspaceReplacementExecutor((replacement) => {
    setTimeout(() => {
      void (async () => {
        let transaction:
          | Awaited<ReturnType<typeof beginPreparedWorkspaceReplacement>>
          | null = null;
        try {
          await stopWorkspaceRequestAdmissionAndDrain();
          await waitForActiveWorkspaceExports();
          // Stop and flush every accepted writer before checking the reviewed tree.
          await server.stop();
          const destinationContentCheckpoint =
            replacement.expectedDestinationContentCheckpoint ??
            ((replacement.options?.destinationCheckpointPaths ?? replacement.options?.checkpointPaths) === "local"
              ? (await calculateLocalWorkspaceContentCheckpoints(
                  getWorkspaceRoot()
                )).workspaceContentCheckpoint
              : await calculateWorkspaceContentCheckpoint(getWorkspaceRoot()));
          await workspaceReplacementAfterCheckpointHookForTests?.();
          transaction = await beginPreparedWorkspaceReplacement(
            replacement.stagingPath,
            replacement.backupPath,
            replacement.contentCheckpoint,
            destinationContentCheckpoint,
            replacement.options
          );
          retireWorkspaceDerivedFiles();
          await notifyWorkspaceChangeAndWaitOrThrow({
            type: "workspaceReset",
          });
          replacementRestartInProgress = true;
          try {
            workspaceReplacementRestartHookForTests?.("replacement");
            startServer(replacementPort, hostname, {
              resumeWorkspaceRequests: false,
              replacementRestart: true,
            });
          } finally {
            replacementRestartInProgress = false;
          }
          await transaction.commit();
        } catch (error) {
          let failure = error;
          let recoveryIncomplete = false;
          try {
            if (transaction && activeServer) await activeServer.stop();
            await transaction?.rollback();
            if (transaction) {
              retireWorkspaceDerivedFiles();
              await notifyWorkspaceChangeAndWaitOrThrow({
                type: "workspaceReset",
              });
            }
            if (!activeServer) {
              recoverWorkspaceRootBeforeReplacementRestart();
              replacementRestartInProgress = true;
              try {
                workspaceReplacementRestartHookForTests?.("rollback");
                startServer(replacementPort, hostname, {
                  resumeWorkspaceRequests: false,
                  replacementRestart: true,
                });
              } finally {
                replacementRestartInProgress = false;
              }
            }
          } catch (recoveryError) {
            recoveryIncomplete = true;
            failure = new AggregateError(
              [error, recoveryError],
              "workspace replacement and rollback restart failed"
            );
          }
          try {
            await replacement.onFailed(failure, { recoveryIncomplete });
          } catch (statusError) {
            console.error(
              "[Worktable] workspace replacement rolled back, but failure status finalization failed:",
              statusError
            );
          } finally {
            if (recoveryIncomplete) {
              // The listener is already closed and no in-process retry can
              // safely reconstruct every server-owned subsystem. Exit
              // nonzero only after the durable import job records failure so
              // Desktop/systemd/container supervisors can restart into boot
              // recovery instead of observing a live but permanently inert
              // Worktable process.
              terminateAfterWorkspaceReplacementRecoveryFailure(failure);
            }
            if (!recoveryIncomplete && activeServer) {
              resumeWorkspaceRequestAdmission();
              enableWorkspaceTransferMaintenance();
            }
          }
          return;
        }
        // This work belongs after the irreversible commit, outside rollback handling.
        // Keep admission closed on failure so boot recovery can finish it durably.
        try {
          await replacement.onCommitted?.();
        } catch (error) {
          try {
            await activeServer?.stop();
          } finally {
            terminateAfterWorkspaceReplacementRecoveryFailure(error);
          }
          return;
        }
        resumeWorkspaceRequestAdmission();
        try {
          await replacement.onSucceeded();
        } catch (error) {
          // The swap is already committed and must never be presented as a
          // rollback. Boot recovery can reconcile the durable "replacing" job
          // if this final app-data status write fails.
          console.error(
            "[Worktable] workspace replacement committed, but status finalization failed:",
            error
          );
        } finally {
          enableWorkspaceTransferMaintenance();
        }
      })();
    }, 250);
  });
  setWorkspaceExportFlush(async () => {
    // Reconcile already-observed filesystem edits before persisting loaded
    // Rich Docs. Otherwise a stale in-memory room can overwrite a newer disk
    // edit that is still waiting in the watcher's debounce queue.
    watcher.flushPending();
    await documentFilesystemCoordinator.drain();
    await drainWorkspaceChanges();
    // A coordinator-delivered HTML event settles after scheduling this
    // coalescer. Materialize that delayed version work before the snapshot.
    flushWidgetChangeCoalescer();
    await drainServerTasks();
    await yjsManager.flushAllPersists();
    await drainWorkspaceChanges();
    await drainServerTasks();
  });
  setWorkspaceExportSnapshot(async (capture) => {
    await stopWorkspaceRequestAdmissionAndDrain();
    let resumeYjs: (() => void) | null = null;
    try {
      resumeYjs = yjsManager.pauseWorkspaceMutations();
      return await capture();
    } finally {
      try {
        resumeYjs?.();
      } finally {
        resumeWorkspaceRequestAdmission();
      }
    }
  });

  return server;
}

// Auto-start when run directly
if (import.meta.main) {
  try {
    const handled = await runServerMaintenance(process.argv);
    if (!handled) {
      const port = parseInt(process.env["PORT"] ?? "7480", 10);
      startServer(port, process.env["HOST"]);
    }
  } catch (err) {
    console.error(`[Worktable server] ${(err as Error).message}`);
    process.exit(1);
  }
}
