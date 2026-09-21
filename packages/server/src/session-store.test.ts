import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import {
  clearSessionCookie,
  getSessionSecret,
  hasOwnerPassword,
  hasOwnerPasswordSync,
  issueSessionCookie,
  rotateSessionSecret,
  SESSION_COOKIE_NAME,
  setOwnerPassword,
  verifyOwnerPassword,
  verifyOwnerSessionCookie,
  verifyRawCookieHeader,
} from "./session-store.ts";

let appDir: string;
let workspaceDir: string;

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-app-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-ws-"));
  setAppDirOverride(appDir);
  setWorkspaceRootOverride(workspaceDir);
});

afterEach(() => {
  setAppDirOverride(null);
  setWorkspaceRootOverride(null);
  for (const dir of [appDir, workspaceDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

// Helper: extract the raw Set-Cookie value the issuer produced via a Context.
async function issueCookieValue(): Promise<string> {
  const app = new Hono();
  app.get("/", async (c) => {
    await issueSessionCookie(c);
    return c.json({ ok: true });
  });
  const res = await app.fetch(new Request("https://localhost/"));
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match) throw new Error("no session cookie issued");
  return match[1]!;
}

describe("session store persistence", () => {
  it("stores the password hash and HMAC secret in app-storage at 0o600, not the workspace", async () => {
    await setOwnerPassword("hunter2pass");
    const file = join(appDir, "session.json");
    expect(existsSync(file)).toBe(true);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = JSON.parse(await readFile(file, "utf8")) as {
      passwordHash: string;
      secret: string;
    };
    expect(typeof raw.passwordHash).toBe("string");
    expect(typeof raw.secret).toBe("string");
    // The plaintext password is never stored.
    expect(JSON.stringify(raw)).not.toContain("hunter2pass");

    // Nothing leaked into the workspace folder.
    expect(readdirSync(workspaceDir)).not.toContain("session.json");
  });

  it("roundtrips the owner password through Bun.password (argon2id)", async () => {
    expect(await hasOwnerPassword()).toBe(false);
    expect(hasOwnerPasswordSync()).toBe(false);
    await setOwnerPassword("correct horse battery");
    expect(await hasOwnerPassword()).toBe(true);
    expect(hasOwnerPasswordSync()).toBe(true);
    expect(await verifyOwnerPassword("correct horse battery")).toBe(true);
    expect(await verifyOwnerPassword("wrong")).toBe(false);
  });
});

describe("session cookie signing (single scheme, one verifier)", () => {
  it("REQUIRED: a cookie issued via issueSessionCookie verifies through verifyRawCookieHeader", async () => {
    const value = await issueCookieValue();
    expect(await verifyRawCookieHeader(`${SESSION_COOKIE_NAME}=${value}`)).toBe(true);
    // And through the Context verifier too.
    const app = new Hono();
    app.get("/", async (c) => c.json({ ok: await verifyOwnerSessionCookie(c) }));
    const res = await app.fetch(
      new Request("https://localhost/", {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${value}` },
      })
    );
    expect((await res.json()).ok).toBe(true);
  });

  it("rejects a tampered cookie payload/signature (fast-check)", async () => {
    const value = await issueCookieValue();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: value.length - 1 }),
        fc.constantFrom(..."ABCXYZ0189-_".split("")),
        async (idx, ch) => {
          if (value[idx] === ch) return; // skip a no-op edit
          const tampered = value.slice(0, idx) + ch + value.slice(idx + 1);
          expect(
            await verifyRawCookieHeader(`${SESSION_COOKIE_NAME}=${tampered}`)
          ).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("rotating the secret invalidates a previously issued cookie", async () => {
    const value = await issueCookieValue();
    expect(await verifyRawCookieHeader(`${SESSION_COOKIE_NAME}=${value}`)).toBe(true);
    await rotateSessionSecret();
    expect(await verifyRawCookieHeader(`${SESSION_COOKIE_NAME}=${value}`)).toBe(false);
  });

  it("garbage and absent cookies fail", async () => {
    expect(await verifyRawCookieHeader(null)).toBe(false);
    expect(await verifyRawCookieHeader("")).toBe(false);
    expect(await verifyRawCookieHeader("other=1")).toBe(false);
    expect(
      await verifyRawCookieHeader(`${SESSION_COOKIE_NAME}=not.a.cookie`)
    ).toBe(false);
  });

  it("clearSessionCookie emits an expiring cookie", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      clearSessionCookie(c);
      return c.json({ ok: true });
    });
    const res = await app.fetch(new Request("https://localhost/"));
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("getSessionSecret is stable across calls and survives a password set", async () => {
    const a = await getSessionSecret();
    await setOwnerPassword("a-long-enough-password");
    const b = await getSessionSecret();
    expect(b).toBe(a);
  });
});
