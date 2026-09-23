import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { requireIdentity, trustedLocalIdentity } from "./auth.ts";
import { createToken } from "./token-store.ts";
import {
  invalidateServerSettingsCache,
  updateServerSettings,
} from "./settings-store.ts";
import { tokensRouter } from "./routes/tokens.ts";
import { wellKnownRouter } from "./routes/well-known.ts";
import {
  issueSessionCookie,
  setOwnerPassword,
  SESSION_COOKIE_NAME,
} from "./session-store.ts";

// HTTP-level coverage of the auth policy: the strict identity middleware
// (as mounted on /mcp) and the token management API, exercised through
// real requests against real temp-dir storage.

function buildTestApp() {
  const app = new Hono();
  app.onError((err, c) =>
    c.json({ error: err.message, code: "INTERNAL_ERROR" }, 500)
  );
  app.route("/api/tokens", tokensRouter);

  // Stand-in for the MCP surface: same middleware, introspectable result.
  const protectedRouter = new Hono();
  protectedRouter.use("*", requireIdentity());
  protectedRouter.get("/", (c) => c.json({ identity: c.get("identity") }));
  app.route("/protected", protectedRouter);

  // Stand-in for the REST surface: local-trust bridge.
  const restRouter = new Hono();
  restRouter.use("*", trustedLocalIdentity());
  restRouter.get("/", (c) => c.json({ identity: c.get("identity") }));
  app.route("/rest", restRouter);

  for (const path of ["/api/workspace", "/api/spaces"]) {
    const supervisedReadRouter = new Hono();
    supervisedReadRouter.use("*", trustedLocalIdentity());
    supervisedReadRouter.get("/", (c) =>
      c.json({ identity: c.get("identity") })
    );
    supervisedReadRouter.get("/extra", (c) =>
      c.json({ identity: c.get("identity") })
    );
    supervisedReadRouter.post("/", (c) =>
      c.json({ identity: c.get("identity") })
    );
    app.route(path, supervisedReadRouter);
  }

  app.route("/.well-known", wellKnownRouter);

  // Test-only helper to mint a real session cookie through the production issuer.
  app.get("/issue-cookie", async (c) => {
    await issueSessionCookie(c);
    return c.json({ ok: true });
  });
  return app;
}

async function issuedCookie(app: Hono): Promise<string> {
  const res = await app.fetch(new Request("https://localhost/issue-cookie"));
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const m = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!m) throw new Error("no cookie issued");
  return `${SESSION_COOKIE_NAME}=${m[1]}`;
}

async function reqWithCookie(
  app: Hono,
  method: string,
  path: string,
  cookie: string
) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { Cookie: cookie },
    })
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function req(
  app: Hono,
  method: string,
  path: string,
  options: {
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  } = {}
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  );
  const text = await res.text();
  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    headers: res.headers,
  };
}

let appDir: string;
let workspaceDir: string;
let app: Hono;
let savedEnvToken: string | undefined;
let savedAuthServerUrl: string | undefined;
let savedRequireAuth: string | undefined;
let savedHost: string | undefined;
let savedPublicUrl: string | undefined;
let savedHostVerificationToken: string | undefined;
let savedHosted: string | undefined;
// The route contract is fail-soft when its third-party authorization server
// cannot be reached. Use the same closed loopback endpoint as the OAuth tests
// so this integration test never depends on public DNS or network latency.
const UNREACHABLE_AUTH_SERVER_URL = "http://127.0.0.1:9";

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-app-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-ws-"));
  setAppDirOverride(appDir);
  setWorkspaceRootOverride(workspaceDir);
  invalidateServerSettingsCache();
  savedEnvToken = process.env["WORKTABLE_MCP_TOKEN"];
  savedAuthServerUrl = process.env["WORKTABLE_AUTH_SERVER_URL"];
  savedRequireAuth = process.env["WORKTABLE_REQUIRE_AUTH"];
  savedHost = process.env["HOST"];
  savedPublicUrl = process.env["WORKTABLE_PUBLIC_URL"];
  savedHostVerificationToken = process.env["WORKTABLE_HOST_VERIFICATION_TOKEN"];
  savedHosted = process.env["WORKTABLE_HOSTED"];
  delete process.env["WORKTABLE_MCP_TOKEN"];
  delete process.env["WORKTABLE_AUTH_SERVER_URL"];
  delete process.env["WORKTABLE_REQUIRE_AUTH"];
  // Isolate from an ambient HOST so authRequired()'s bind-host check is deterministic.
  delete process.env["HOST"];
  // A configured public origin is part of the MCP bearer gate — isolate it.
  delete process.env["WORKTABLE_PUBLIC_URL"];
  delete process.env["WORKTABLE_HOST_VERIFICATION_TOKEN"];
  delete process.env["WORKTABLE_HOSTED"];
  app = buildTestApp();
});

afterEach(() => {
  if (savedEnvToken === undefined) delete process.env["WORKTABLE_MCP_TOKEN"];
  else process.env["WORKTABLE_MCP_TOKEN"] = savedEnvToken;
  if (savedAuthServerUrl === undefined)
    delete process.env["WORKTABLE_AUTH_SERVER_URL"];
  else process.env["WORKTABLE_AUTH_SERVER_URL"] = savedAuthServerUrl;
  if (savedRequireAuth === undefined)
    delete process.env["WORKTABLE_REQUIRE_AUTH"];
  else process.env["WORKTABLE_REQUIRE_AUTH"] = savedRequireAuth;
  if (savedHost === undefined) delete process.env["HOST"];
  else process.env["HOST"] = savedHost;
  if (savedPublicUrl === undefined) delete process.env["WORKTABLE_PUBLIC_URL"];
  else process.env["WORKTABLE_PUBLIC_URL"] = savedPublicUrl;
  if (savedHostVerificationToken === undefined)
    delete process.env["WORKTABLE_HOST_VERIFICATION_TOKEN"];
  else
    process.env["WORKTABLE_HOST_VERIFICATION_TOKEN"] =
      savedHostVerificationToken;
  if (savedHosted === undefined) delete process.env["WORKTABLE_HOSTED"];
  else process.env["WORKTABLE_HOSTED"] = savedHosted;
  invalidateServerSettingsCache();
  setAppDirOverride(null);
  setWorkspaceRootOverride(null);
  for (const dir of [appDir, workspaceDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("strict identity policy (MCP surface)", () => {
  it("is open with implicit owner identity while no auth is configured", async () => {
    const res = await req(app, "GET", "/protected");
    expect(res.status).toBe(200);
    expect(res.json.identity).toMatchObject({
      user: "owner",
      workspace: workspaceDir,
      scopes: ["*"],
      agent: null,
    });
  });

  it("keeps bare loopback access after mint while honoring token identity", async () => {
    const { token } = await createToken({ scopes: ["docs:read"], agent: "ci" });

    const bare = await req(app, "GET", "/protected");
    expect(bare.status).toBe(200);
    expect(bare.json.identity).toMatchObject({ scopes: ["*"], agent: null });

    const authed = await req(app, "GET", "/protected", { token });
    expect(authed.status).toBe(200);
    expect(authed.json.identity).toMatchObject({
      scopes: ["docs:read"],
      agent: "ci",
    });

    const forged = await req(app, "GET", "/protected", {
      token: token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"),
    });
    expect(forged.status).toBe(401);
  });

  it("honors the legacy WORKTABLE_MCP_TOKEN env value as owner", async () => {
    process.env["WORKTABLE_MCP_TOKEN"] = "legacy-secret";

    const bare = await req(app, "GET", "/protected");
    expect(bare.status).toBe(401);

    const wrong = await req(app, "GET", "/protected", { token: "nope" });
    expect(wrong.status).toBe(401);

    const legacy = await req(app, "GET", "/protected", {
      token: "legacy-secret",
    });
    expect(legacy.status).toBe(200);
    expect(legacy.json.identity).toMatchObject({ user: "owner", scopes: ["*"] });
  });

  it("minted tokens keep working alongside the legacy env token", async () => {
    process.env["WORKTABLE_MCP_TOKEN"] = "legacy-secret";
    const { token } = await createToken({ scopes: ["*"] });
    const res = await req(app, "GET", "/protected", { token });
    expect(res.status).toBe(200);
  });

  it("requires a bearer once a public origin is configured in settings (loopback, no tokens)", async () => {
    // A saved public URL fronts this loopback bind with a tunnel — an exposed
    // front door, so bearer-less MCP access must be refused even with no tokens.
    await updateServerSettings({
      network: { publicUrl: "https://tunnel.example.com" },
    });
    const bare = await req(app, "GET", "/protected");
    expect(bare.status).toBe(401);
    // An owner bearer (legacy env value) still clears the gate.
    process.env["WORKTABLE_MCP_TOKEN"] = "legacy-secret";
    const authed = await req(app, "GET", "/protected", { token: "legacy-secret" });
    expect(authed.status).toBe(200);
  });

  it("requires a bearer once a public origin is configured via WORKTABLE_PUBLIC_URL", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://env-tunnel.example.com";
    const bare = await req(app, "GET", "/protected");
    expect(bare.status).toBe(401);
  });

  it("stays implicit owner when no public origin (or token) is configured", async () => {
    // Regression guard for the gate: a plain loopback install with nothing
    // configured is still zero-ceremony owner.
    const res = await req(app, "GET", "/protected");
    expect(res.status).toBe(200);
    expect(res.json.identity).toMatchObject({ user: "owner", scopes: ["*"] });
  });

  it("rejects bare MCP when the request host is not a literal loopback", async () => {
    const res = await app.fetch(new Request("http://worktable.test/protected"));
    expect(res.status).toBe(401);
  });

  it("rejects cross-origin browser access to the loopback MCP endpoint", async () => {
    const crossOrigin = await req(app, "GET", "/protected", {
      headers: { Origin: "https://malicious.example" },
    });
    expect(crossOrigin.status).toBe(401);

    const fetchMetadata = await req(app, "GET", "/protected", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(fetchMetadata.status).toBe(401);
  });

  it("accepts a same-origin browser request to the loopback MCP endpoint", async () => {
    const res = await req(app, "GET", "/protected", {
      headers: { Origin: "http://localhost" },
    });
    expect(res.status).toBe(200);
  });
});

describe("exposure mint gate (WORKTABLE_REQUIRE_AUTH)", () => {

  it("401s a bare POST /api/tokens when HOST is non-loopback even without WORKTABLE_REQUIRE_AUTH", async () => {
    // Defense-in-depth: a raw bind to 0.0.0.0 without the CLI flag must still gate
    // the mint route, or token minting is open over the network.
    delete process.env["WORKTABLE_REQUIRE_AUTH"];
    process.env["HOST"] = "0.0.0.0";
    const res = await req(app, "POST", "/api/tokens", {
      body: { scopes: ["*"] },
    });
    expect(res.status).toBe(401);
  });

  it("after a minted token, bare loopback and scoped bearer identities coexist", async () => {
    const { token } = await createToken({ scopes: ["*"] });
    const bare = await req(app, "GET", "/protected");
    expect(bare.status).toBe(200);
    const authed = await req(app, "GET", "/protected", { token });
    expect(authed.status).toBe(200);
    expect(authed.json.identity).toMatchObject({ scopes: ["*"] });
  });
});

describe("REST identity bridge", () => {
  it("bare local requests act as owner even when tokens exist", async () => {
    await createToken({ scopes: ["docs:read"] });
    const res = await req(app, "GET", "/rest");
    expect(res.status).toBe(200);
    expect(res.json.identity).toMatchObject({ user: "owner", scopes: ["*"] });
  });

  it("presented bearers must verify and carry their own identity", async () => {
    const { token } = await createToken({ scopes: ["docs:read"], agent: "ci" });

    const valid = await req(app, "GET", "/rest", { token });
    expect(valid.status).toBe(200);
    expect(valid.json.identity).toMatchObject({
      scopes: ["docs:read"],
      agent: "ci",
    });

    const invalid = await req(app, "GET", "/rest", { token: "garbage" });
    expect(invalid.status).toBe(401);
  });
});

describe("OAuth discovery seam (RFC 9728)", () => {
  it("protected-resource metadata 404s when no authorization server is configured", async () => {
    const res = await req(app, "GET", "/.well-known/oauth-protected-resource");
    expect(res.status).toBe(404);
  });

  it("serves metadata pointing at the configured authorization server", async () => {
    process.env["WORKTABLE_AUTH_SERVER_URL"] = UNREACHABLE_AUTH_SERVER_URL;
    const res = await req(app, "GET", "/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(res.json.authorization_servers).toEqual([
      UNREACHABLE_AUTH_SERVER_URL,
    ]);
    expect(res.json.resource).toBe("http://localhost/mcp");
    // The AS here is unreachable, so no scope vocabulary can be mirrored —
    // the field must be OMITTED (never Worktable's internal token scopes,
    // which the AS would reject with invalid_scope when clients echo them).
    expect(res.json.scopes_supported).toBeUndefined();
    expect(res.json.bearer_methods_supported).toEqual(["header"]);
  });

  it("serves the RFC 9728 path-insertion variant for any resource path", async () => {
    process.env["WORKTABLE_AUTH_SERVER_URL"] = UNREACHABLE_AUTH_SERVER_URL;
    // Spec-following MCP clients construct these URLs themselves (well-known
    // path + resource path) and try them BEFORE the root variant; they must
    // not fall through to the SPA catch-all. /api/mcp is the hosted mount.
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource/api/mcp",
    ]) {
      const res = await req(app, "GET", path);
      expect(res.status).toBe(200);
      expect(res.json.authorization_servers).toEqual([
        UNREACHABLE_AUTH_SERVER_URL,
      ]);
      expect(res.json.resource).toBe("http://localhost/mcp");
    }
  });

  it("404s unknown well-known paths as JSON, never the SPA shell", async () => {
    process.env["WORKTABLE_AUTH_SERVER_URL"] = UNREACHABLE_AUTH_SERVER_URL;
    const res = await req(app, "GET", "/.well-known/apple-app-site-association");
    expect(res.status).toBe(404);
    expect(res.json.code).toBe("NOT_FOUND");
  });

  it("404s the AS metadata passthrough when the AS is unreachable", async () => {
    process.env["WORKTABLE_AUTH_SERVER_URL"] = UNREACHABLE_AUTH_SERVER_URL;
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/openid-configuration",
    ]) {
      const res = await req(app, "GET", path);
      expect(res.status).toBe(404);
      expect(res.json.code).toBe("NOT_FOUND");
    }
  });

  it("401s carry the WWW-Authenticate discovery hint when configured", async () => {
    process.env["WORKTABLE_AUTH_SERVER_URL"] = UNREACHABLE_AUTH_SERVER_URL;
    await createToken({ scopes: ["*"] });

    const res = await req(app, "GET", "/protected");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"'
    );
  });

  it("401s omit the hint when no authorization server is configured", async () => {
    await createToken({ scopes: ["*"] });
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await req(app, "GET", "/protected");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });
});

describe("owner-password session gate on REST (WORKTABLE_REQUIRE_AUTH)", () => {
  it("flag OFF: a bare REST request is owner (byte-for-byte today)", async () => {
    delete process.env["WORKTABLE_REQUIRE_AUTH"];
    const res = await req(app, "GET", "/rest");
    expect(res.status).toBe(200);
    expect(res.json.identity).toMatchObject({ user: "owner", scopes: ["*"] });
  });

  it("flag ON: a bare REST request is 401 (no cookie)", async () => {
    await setOwnerPassword("owner-password");
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await req(app, "GET", "/rest");
    expect(res.status).toBe(401);
  });

  it("flag ON: a valid session cookie authenticates REST as owner", async () => {
    await setOwnerPassword("owner-password");
    const cookie = await issuedCookie(app);
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await reqWithCookie(app, "GET", "/rest", cookie);
    expect(res.status).toBe(200);
    expect(res.json.identity).toMatchObject({ user: "owner", scopes: ["*"] });
    for (const headers of [
      { Origin: "null" },
      { Origin: "https://other.example.test" },
      { Origin: "http://localhost:1234", "Sec-Fetch-Site": "same-site" },
    ] as Record<string, string>[]) {
      const denied = await req(app, "GET", "/rest", { headers: { ...headers, Cookie: cookie } });
      expect(denied.status).toBe(401);
    }
  });

  it("flag ON: a garbage cookie is 401", async () => {
    await setOwnerPassword("owner-password");
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await reqWithCookie(
      app,
      "GET",
      "/rest",
      `${SESSION_COOKIE_NAME}=not.a.valid.cookie`
    );
    expect(res.status).toBe(401);
  });

  it("flag ON: a verifying bearer still authenticates REST (no cookie needed)", async () => {
    const { token } = await createToken({ scopes: ["docs:read"], agent: "ci" });
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await req(app, "GET", "/rest", { token });
    expect(res.status).toBe(200);
    expect(res.json.identity).toMatchObject({ scopes: ["docs:read"], agent: "ci" });
  });

  it("configured public URL: a bare REST request is 401 on loopback", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com";
    const res = await req(app, "GET", "/rest");
    expect(res.status).toBe(401);
  });

  it("lets a supervised host verify only its two local read paths", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com";
    process.env["WORKTABLE_HOST_VERIFICATION_TOKEN"] = "desktop-secret";
    const verification = {
      "X-Worktable-Host-Verification": "desktop-secret",
    };

    for (const path of ["/api/workspace", "/api/spaces"]) {
      const verified = await req(app, "GET", path, {
        headers: verification,
      });
      expect(verified.status).toBe(200);
      expect(verified.json.identity).toMatchObject({
        user: "owner",
        scopes: ["*"],
      });
    }

    expect(
      (
        await req(app, "GET", "/api/workspace", {
          headers: { "X-Worktable-Host-Verification": "wrong-secret" },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await req(app, "POST", "/api/workspace", {
          headers: verification,
        })
      ).status
    ).toBe(401);
    expect(
      (await req(app, "GET", "/rest", { headers: verification })).status
    ).toBe(401);
    expect(
      (await req(app, "GET", "/api/spaces/extra", { headers: verification }))
        .status
    ).toBe(401);

    process.env["WORKTABLE_HOSTED"] = "1";
    expect(
      (await req(app, "GET", "/api/workspace", { headers: verification }))
        .status
    ).toBe(401);
  });

  it("configured public URL: a valid session cookie authenticates REST as owner", async () => {
    const cookie = await issuedCookie(app);
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com";
    const res = await reqWithCookie(app, "GET", "/rest", cookie);
    expect(res.status).toBe(200);
    expect(res.json.identity).toMatchObject({ user: "owner", scopes: ["*"] });
  });

  it("configured public URL: a verifying bearer still authenticates REST", async () => {
    const { token } = await createToken({ scopes: ["docs:read"], agent: "ci" });
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com";
    const res = await req(app, "GET", "/rest", { token });
    expect(res.status).toBe(200);
    expect(res.json.identity).toMatchObject({ scopes: ["docs:read"], agent: "ci" });
  });

  it("flag ON: the legacy WORKTABLE_MCP_TOKEN bearer authenticates REST as owner", async () => {
    process.env["WORKTABLE_MCP_TOKEN"] = "legacy-secret";
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await req(app, "GET", "/rest", { token: "legacy-secret" });
    expect(res.status).toBe(200);
    expect(res.json.identity).toMatchObject({ user: "owner", scopes: ["*"] });
  });

  it("a session cookie does NOT authenticate the /mcp (requireIdentity) surface", async () => {
    // Configure MCP auth (a minted token) so requireIdentity requires a bearer.
    await createToken({ scopes: ["*"] });
    await setOwnerPassword("owner-password");
    const cookie = await issuedCookie(app);
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await reqWithCookie(app, "GET", "/protected", cookie);
    expect(res.status).toBe(401);
  });
});
