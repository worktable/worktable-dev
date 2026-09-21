import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { authSessionRouter } from "./routes/auth-session.ts";
import {
  SESSION_COOKIE_NAME,
  setOwnerPassword,
} from "./session-store.ts";

// HTTP-level coverage of the owner-password session API. These routes are the
// cookie surface that drives the web login page; they must work unauthenticated
// (login/status) and never authenticate /mcp.

function buildApp() {
  const app = new Hono();
  app.onError((err, c) => c.json({ error: err.message }, 500));
  app.route("/auth", authSessionRouter);
  return app;
}

function cookieFrom(res: Response): string | null {
  const setCookie = res.headers.get("Set-Cookie");
  if (!setCookie) return null;
  const m = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return m ? `${SESSION_COOKIE_NAME}=${m[1]}` : null;
}

async function post(
  app: Hono,
  path: string,
  body: unknown,
  opts: { cookie?: string; scheme?: "http" | "https" } = {}
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const scheme = opts.scheme ?? "http";
  return app.fetch(
    new Request(`${scheme}://localhost/${path.replace(/^\//, "")}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    })
  );
}

let appDir: string;
let workspaceDir: string;
let savedRequireAuth: string | undefined;
let savedHost: string | undefined;
let app: Hono;

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-app-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-ws-"));
  setAppDirOverride(appDir);
  setWorkspaceRootOverride(workspaceDir);
  savedRequireAuth = process.env["WORKTABLE_REQUIRE_AUTH"];
  savedHost = process.env["HOST"];
  delete process.env["WORKTABLE_REQUIRE_AUTH"];
  delete process.env["HOST"];
  app = buildApp();
});

afterEach(() => {
  if (savedRequireAuth === undefined) delete process.env["WORKTABLE_REQUIRE_AUTH"];
  else process.env["WORKTABLE_REQUIRE_AUTH"] = savedRequireAuth;
  if (savedHost === undefined) delete process.env["HOST"];
  else process.env["HOST"] = savedHost;
  setAppDirOverride(null);
  setWorkspaceRootOverride(null);
  for (const dir of [appDir, workspaceDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /auth/login", () => {
  it("409 needsSetup when no owner password is set", async () => {
    const res = await post(app, "/auth/login", { password: "anything" });
    expect(res.status).toBe(409);
    expect((await res.json()).needsSetup).toBe(true);
  });

  it("401 on the wrong password (no cookie issued)", async () => {
    await setOwnerPassword("correct-password");
    const res = await post(app, "/auth/login", { password: "wrong" });
    expect(res.status).toBe(401);
    expect(cookieFrom(res)).toBeNull();
  });

  it("200 + an httpOnly session cookie on the correct password", async () => {
    await setOwnerPassword("correct-password");
    const res = await post(app, "/auth/login", { password: "correct-password" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("sets Secure on https but NOT on http", async () => {
    await setOwnerPassword("correct-password");
    const httpsRes = await post(
      app,
      "/auth/login",
      { password: "correct-password" },
      { scheme: "https" }
    );
    expect(httpsRes.headers.get("Set-Cookie")).toContain("Secure");

    const httpRes = await post(
      app,
      "/auth/login",
      { password: "correct-password" },
      { scheme: "http" }
    );
    const httpCookie = httpRes.headers.get("Set-Cookie") ?? "";
    expect(httpCookie).not.toContain("Secure");
  });
});

describe("GET /auth/status", () => {
  it("is callable unauthenticated and reports the surface shape", async () => {
    const res = await app.fetch(new Request("http://localhost/auth/status"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      exposed: false,
      hasOwnerPassword: false,
      authenticated: false,
    });
  });

  it("reflects exposure and password state", async () => {
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    await setOwnerPassword("correct-password");
    const res = await app.fetch(new Request("http://localhost/auth/status"));
    const json = await res.json();
    expect(json.exposed).toBe(true);
    expect(json.hasOwnerPassword).toBe(true);
    expect(json.authenticated).toBe(false);
  });

  it("authenticated=true with a valid session cookie", async () => {
    await setOwnerPassword("correct-password");
    const login = await post(app, "/auth/login", { password: "correct-password" });
    const cookie = cookieFrom(login)!;
    const res = await app.fetch(
      new Request("http://localhost/auth/status", { headers: { Cookie: cookie } })
    );
    expect((await res.json()).authenticated).toBe(true);
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie", async () => {
    const res = await post(app, "/auth/logout", {});
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("Max-Age=0");
  });
});

describe("POST /auth/password", () => {
  it("first-set is allowed on a loopback request and issues a cookie", async () => {
    const res = await post(app, "/auth/password", { password: "new-password-123" });
    expect(res.status).toBe(200);
    expect(cookieFrom(res)).not.toBeNull();
    // Now login works.
    const login = await post(app, "/auth/login", { password: "new-password-123" });
    expect(login.status).toBe(200);
  });

  it("rejects a short password", async () => {
    const res = await post(app, "/auth/password", { password: "short" });
    expect(res.status).toBe(400);
  });

  it("rotate requires a valid session AND the current password", async () => {
    await setOwnerPassword("current-password");

    // No session cookie -> 401.
    const noSession = await post(app, "/auth/password", {
      password: "another-password",
      currentPassword: "current-password",
    });
    expect(noSession.status).toBe(401);

    const login = await post(app, "/auth/login", { password: "current-password" });
    const cookie = cookieFrom(login)!;

    // Wrong current password -> 401.
    const wrongCurrent = await post(
      app,
      "/auth/password",
      { password: "another-password", currentPassword: "nope" },
      { cookie }
    );
    expect(wrongCurrent.status).toBe(401);

    // Valid session + correct current -> 200.
    const ok = await post(
      app,
      "/auth/password",
      { password: "another-password", currentPassword: "current-password" },
      { cookie }
    );
    expect(ok.status).toBe(200);
    const after = await post(app, "/auth/login", { password: "another-password" });
    expect(after.status).toBe(200);
  });

  it("a remote (non-loopback) first-set is refused (no remote bootstrap)", async () => {
    const res = await app.fetch(
      new Request("http://192.168.1.50/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "new-password-123" }),
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /auth/logout-everywhere", () => {
  it("requires a valid session and rotates the secret (prior cookie invalidated)", async () => {
    await setOwnerPassword("current-password");
    const login = await post(app, "/auth/login", { password: "current-password" });
    const cookie = cookieFrom(login)!;

    const noSession = await post(app, "/auth/logout-everywhere", {});
    expect(noSession.status).toBe(401);

    const ok = await post(app, "/auth/logout-everywhere", {}, { cookie });
    expect(ok.status).toBe(200);

    // The previously valid cookie no longer authenticates.
    const status = await app.fetch(
      new Request("http://localhost/auth/status", { headers: { Cookie: cookie } })
    );
    expect((await status.json()).authenticated).toBe(false);
  });
});
