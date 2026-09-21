import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import { connectRouter } from "./routes/connect.ts";
import { resetConnectorBundleCacheForTests } from "./connector-assets.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { invalidateServerSettingsCache } from "./settings-store.ts";

// /connect.sh and /connect.mjs are the unauthenticated delivery surface for
// the remote-agent connector. Under test: origin templating (server-derived,
// never request/user content beyond forwarded-host resolution), script
// validity, and bundle resolution via the env override and the dev source
// fallback.

let tempDir: string;
let savedEnv: Record<string, string | undefined>;
let app: Hono;

const ENV_KEYS = ["WORKTABLE_CONNECTOR_BUNDLE", "WORKTABLE_PUBLIC_URL"] as const;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "worktable-connect-routes-"));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // resolveOrigin falls back to the machine-local settings store after the env
  // override. Keep this test off the developer's real Worktable installation.
  setAppDirOverride(join(tempDir, "app"));
  invalidateServerSettingsCache();
  resetConnectorBundleCacheForTests();
  app = new Hono();
  app.route("/", connectRouter);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setAppDirOverride(null);
  invalidateServerSettingsCache();
  resetConnectorBundleCacheForTests();
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /connect.sh", () => {
  it("embeds the configured public origin and passes sh syntax check", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://wt.example.com";
    const res = await app.fetch(new Request("http://localhost/connect.sh"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("shellscript");

    const body = await res.text();
    expect(body).toContain('ORIGIN="https://wt.example.com"');
    expect(body).toContain("/connect.mjs");
    expect(body).not.toContain("__");

    const script = join(tempDir, "connect.sh");
    writeFileSync(script, body);
    expect(spawnSync("sh", ["-n", script]).status).toBe(0);
  });

  it("falls back to the request origin when nothing is configured", async () => {
    const res = await app.fetch(new Request("http://127.0.0.1:7480/connect.sh"));
    const body = await res.text();
    expect(body).toContain('ORIGIN="http://127.0.0.1:7480"');
  });
});

describe("GET /connect.mjs", () => {
  it("serves the bundle from the env override", async () => {
    const bundle = join(tempDir, "bundle.mjs");
    writeFileSync(bundle, "console.log('connector')\n");
    process.env["WORKTABLE_CONNECTOR_BUNDLE"] = bundle;

    const res = await app.fetch(new Request("http://localhost/connect.mjs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("javascript");
    expect(await res.text()).toBe("console.log('connector')\n");
  });

  it("resolves from the dev source tree when no override is set", async () => {
    const res = await app.fetch(new Request("http://localhost/connect.mjs"));
    expect(res.status).toBe(200);
    const body = await res.text();
    // The built connector carries the redeem call.
    expect(body).toContain("/api/pairing/redeem");
  });
});
