import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { tokensRouter } from "./routes/tokens.ts";
import { authSessionRouter } from "./routes/auth-session.ts";
import { SESSION_COOKIE_NAME, setOwnerPassword } from "./session-store.ts";
import { createToken } from "./token-store.ts";

// requireMintAuth postures on the /api/tokens surface. The router mounts
// trustedLocalIdentity → requireMintAuth → requireScope("tokens:manage"), so
// these drive the real middleware stack. The NEW behavior under test: on an
// exposed install a valid owner-session cookie (the browser Settings owner) is
// accepted, where before only a bearer cleared requireMintAuth.

function buildApp() {
  const app = new Hono();
  app.route("/auth", authSessionRouter);
  app.route("/api/tokens", tokensRouter);
  return app;
}

function cookieFrom(res: Response): string | null {
  const setCookie = res.headers.get("Set-Cookie");
  if (!setCookie) return null;
  const m = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return m ? `${SESSION_COOKIE_NAME}=${m[1]}` : null;
}

async function loginCookie(app: Hono, password: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
  );
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error(`login failed (${res.status})`);
  return cookie;
}

function tokensReq(
  method: string,
  path = "/api/tokens",
  opts: { cookie?: string; bearer?: string; body?: unknown } = {}
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

let appDir: string;
let workspaceDir: string;
let savedRequireAuth: string | undefined;
let savedHost: string | undefined;
let savedPublicUrl: string | undefined;
let savedHosted: string | undefined;
let app: Hono;

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-tokens-app-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-tokens-ws-"));
  setAppDirOverride(appDir);
  setWorkspaceRootOverride(workspaceDir);
  savedRequireAuth = process.env["WORKTABLE_REQUIRE_AUTH"];
  savedHost = process.env["HOST"];
  savedPublicUrl = process.env["WORKTABLE_PUBLIC_URL"];
  savedHosted = process.env["WORKTABLE_HOSTED"];
  delete process.env["WORKTABLE_REQUIRE_AUTH"];
  delete process.env["HOST"];
  delete process.env["WORKTABLE_PUBLIC_URL"];
  delete process.env["WORKTABLE_HOSTED"];
  app = buildApp();
});

afterEach(() => {
  if (savedRequireAuth === undefined) delete process.env["WORKTABLE_REQUIRE_AUTH"];
  else process.env["WORKTABLE_REQUIRE_AUTH"] = savedRequireAuth;
  if (savedHost === undefined) delete process.env["HOST"];
  else process.env["HOST"] = savedHost;
  if (savedPublicUrl === undefined) delete process.env["WORKTABLE_PUBLIC_URL"];
  else process.env["WORKTABLE_PUBLIC_URL"] = savedPublicUrl;
  if (savedHosted === undefined) delete process.env["WORKTABLE_HOSTED"];
  else process.env["WORKTABLE_HOSTED"] = savedHosted;
  setAppDirOverride(null);
  setWorkspaceRootOverride(null);
  for (const dir of [appDir, workspaceDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("hosted mode", () => {
  it("disables every local-token management route before authentication", async () => {
    process.env["WORKTABLE_HOSTED"] = "1";
    const requests = [
      tokensReq("GET"),
      tokensReq("POST", "/api/tokens", {
        body: { scopes: ["docs:read"] },
      }),
      tokensReq("DELETE", "/api/tokens/does-not-exist"),
    ];

    for (const request of requests) {
      const response = await app.fetch(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error:
          "Local access tokens are not available on Worktable Cloud; connect agents with OAuth.",
        code: "HOSTED_DISABLED",
      });
    }
  });
});

describe("loopback (unexposed): bare requests act as owner", () => {
  it("GET, POST, and DELETE all pass the mint gate", async () => {
    const list = await app.fetch(tokensReq("GET"));
    expect(list.status).toBe(200);

    const created = await app.fetch(
      tokensReq("POST", "/api/tokens", { body: { scopes: ["docs:read"] } })
    );
    expect(created.status).toBe(201);
    const { metadata } = (await created.json()) as { metadata: { id: string } };

    const deleted = await app.fetch(
      tokensReq("DELETE", `/api/tokens/${metadata.id}`)
    );
    expect(deleted.status).toBe(200);
  });
});

describe("exposed (WORKTABLE_REQUIRE_AUTH=1)", () => {
  it("accepts a valid owner-session cookie (the new requireMintAuth behavior)", async () => {
    await setOwnerPassword("correct-horse-battery");
    const cookie = await loginCookie(app, "correct-horse-battery");
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";

    const list = await app.fetch(tokensReq("GET", "/api/tokens", { cookie }));
    expect(list.status).toBe(200);

    const created = await app.fetch(
      tokensReq("POST", "/api/tokens", {
        cookie,
        body: { scopes: ["docs:read"] },
      })
    );
    expect(created.status).toBe(201);
    const { metadata } = (await created.json()) as { metadata: { id: string } };

    const deleted = await app.fetch(
      tokensReq("DELETE", `/api/tokens/${metadata.id}`, { cookie })
    );
    expect(deleted.status).toBe(200);
  });

  it("rejects (401) a request with no credentials", async () => {
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await app.fetch(
      tokensReq("POST", "/api/tokens", { body: { scopes: ["docs:read"] } })
    );
    expect(res.status).toBe(401);
  });

  it("403s a narrow-scoped bearer that lacks tokens:manage", async () => {
    // A verifying bearer clears requireMintAuth (not 401) but requireScope
    // enforces tokens:manage afterwards — so escalation is blocked at 403.
    const { token } = await createToken({ scopes: ["docs:read"], agent: null });
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";

    const res = await app.fetch(
      tokensReq("POST", "/api/tokens", {
        bearer: token,
        body: { scopes: ["docs:*"] },
      })
    );
    expect(res.status).toBe(403);
  });

  it("accepts a bearer that carries tokens:manage", async () => {
    const { token } = await createToken({
      scopes: ["tokens:manage"],
      agent: null,
    });
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";

    const res = await app.fetch(tokensReq("GET", "/api/tokens", { bearer: token }));
    expect(res.status).toBe(200);
  });
});

describe("configured public origin on loopback", () => {
  it("rejects (401) a bare token mint request", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com";
    const res = await app.fetch(
      tokensReq("POST", "/api/tokens", { body: { scopes: ["docs:read"] } })
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid owner-session cookie", async () => {
    await setOwnerPassword("correct-horse-battery");
    const cookie = await loginCookie(app, "correct-horse-battery");
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com";

    const created = await app.fetch(
      tokensReq("POST", "/api/tokens", {
        cookie,
        body: { scopes: ["docs:read"] },
      })
    );
    expect(created.status).toBe(201);
  });
});
