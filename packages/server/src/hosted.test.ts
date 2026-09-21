import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { invalidateServerSettingsCache } from "./settings-store.ts";
import {
  authRequired,
  publicSurfaceAuthRequired,
  verifyBearer,
} from "./auth.ts";
import { isHosted } from "./hosted.ts";
import { createToken } from "./token-store.ts";

// WORKTABLE_HOSTED marks a Worktable Cloud tenant instance. It must only ever
// tighten posture: hosted forces the exposed-surface rules on even when the
// bind looks loopback-local and no other exposure signal is set. Env is
// saved/restored so cases can't leak into each other or the real process.

const ENV_KEYS = [
  "HOST",
  "WORKTABLE_REQUIRE_AUTH",
  "WORKTABLE_HOSTED",
  "WORKTABLE_MCP_TOKEN",
  "WORKTABLE_PUBLIC_URL",
];
let saved: Record<string, string | undefined>;
let tempDir: string;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  tempDir = mkdtempSync(join(tmpdir(), "wt-hosted-"));
  setAppDirOverride(tempDir);
  invalidateServerSettingsCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setAppDirOverride(null);
  invalidateServerSettingsCache();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("hosted posture flag", () => {
  it("is off by default and for any value other than '1'", () => {
    expect(isHosted()).toBe(false);
    process.env["WORKTABLE_HOSTED"] = "true";
    expect(isHosted()).toBe(false);
    process.env["WORKTABLE_HOSTED"] = "1";
    expect(isHosted()).toBe(true);
  });

  it("forces authRequired on even with a loopback bind and no other flags", () => {
    process.env["HOST"] = "127.0.0.1";
    expect(authRequired()).toBe(false);
    process.env["WORKTABLE_HOSTED"] = "1";
    expect(authRequired()).toBe(true);
  });

  it("engages the exposed REST surface (no bare implicit-owner bridge)", () => {
    expect(publicSurfaceAuthRequired()).toBe(false);
    process.env["WORKTABLE_HOSTED"] = "1";
    expect(publicSurfaceAuthRequired()).toBe(true);
  });

  it("rejects residual local bearers instead of creating an unmanageable Cloud credential", async () => {
    const { token } = await createToken({
      scopes: ["docs:read"],
      agent: "pre-hosted-agent",
    });
    process.env["WORKTABLE_MCP_TOKEN"] = "legacy-local-owner-token";

    expect(await verifyBearer(token)).not.toBeNull();
    expect(await verifyBearer("legacy-local-owner-token")).not.toBeNull();

    process.env["WORKTABLE_HOSTED"] = "1";
    expect(await verifyBearer(token)).toBeNull();
    expect(await verifyBearer("legacy-local-owner-token")).toBeNull();
  });

  it("closes the owner-password bootstrap: POST /auth/password 403s even with a spoofed loopback Host and no password set", async () => {
    process.env["WORKTABLE_HOSTED"] = "1";
    const { authSessionRouter } = await import("./routes/auth-session.ts");
    const app = new Hono().route("/auth", authSessionRouter);
    const res = await app.fetch(
      new Request("http://localhost/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json", Host: "localhost" },
        body: JSON.stringify({ password: "attacker-password" }),
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("HOSTED_DISABLED");
    // Login is closed too; status stays readable.
    const login = await app.fetch(
      new Request("http://localhost/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "x" }),
      })
    );
    expect(login.status).toBe(403);
    const status = await app.fetch(new Request("http://localhost/auth/status"));
    expect(status.status).toBe(200);
  });

  it("rejects pre-existing owner session cookies once hosted mode is on", async () => {
    const { setOwnerPassword, verifyRawCookieHeader } = await import(
      "./session-store.ts"
    );
    const { authSessionRouter } = await import("./routes/auth-session.ts");
    // Non-hosted: establish a password and a real session cookie via login.
    await setOwnerPassword("correct-horse-battery");
    const app = new Hono().route("/auth", authSessionRouter);
    const login = await app.fetch(
      new Request("http://localhost/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct-horse-battery" }),
      })
    );
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0]!;
    expect(await verifyRawCookieHeader(cookie)).toBe(true);
    // Hosted: the same, still-valid cookie must fail closed everywhere.
    process.env["WORKTABLE_HOSTED"] = "1";
    expect(await verifyRawCookieHeader(cookie)).toBe(false);
  });
});
