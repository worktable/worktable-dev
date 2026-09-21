import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import fc from "fast-check";
import { setAppDirOverride } from "./app-storage.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { createToken } from "./token-store.ts";
import { systemRouter } from "./routes/system.ts";
import { resolveWorkspaceOriginForRequest } from "./workspace-origin.ts";
import {
  invalidateServerSettingsCache,
  updateServerSettings,
} from "./settings-store.ts";

// GET /api/system/connection reports how a local MCP client reaches this install
// (endpoint + reachability) and the workspace origin (for agent-facing doc URLs).
// The route computes from env + request + the token store (mcpTokenRequired),
// so each test gets a fresh temp app dir/workspace and env is saved/restored so
// stray endpoint/origin env can't leak across cases (or into the real process).

interface ConnectionBody {
  mcpAuthMode: "oauth" | "local-token";
  endpoint: string;
  reachable: boolean;
  authRequired: boolean;
  origin: string;
  remoteMcpUrl: string;
  originSource: "env" | "config" | "resource" | "request" | "fallback";
  originConfigured: boolean;
  mcpTokenRequired: boolean;
}

function app() {
  const a = new Hono();
  a.route("/api/system", systemRouter);
  return a;
}

async function getConnection(
  headers: Record<string, string> = {},
  url = "http://localhost/api/system/connection"
): Promise<{ status: number; body: ConnectionBody }> {
  const res = await app().fetch(new Request(url, { headers }));
  return { status: res.status, body: (await res.json()) as ConnectionBody };
}

const ENV_KEYS = [
  "HOST",
  "PORT",
  "WORKTABLE_REQUIRE_AUTH",
  "WORKTABLE_PUBLIC_URL",
  "WORKTABLE_RESOURCE_URL",
  "WORKTABLE_HOSTED",
];
let saved: Record<string, string | undefined>;
let tempDir: string;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  tempDir = mkdtempSync(join(tmpdir(), "wt-connection-test-"));
  setAppDirOverride(join(tempDir, "app"));
  setWorkspaceRootOverride(join(tempDir, "workspace"));
  invalidateServerSettingsCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setAppDirOverride(null);
  setWorkspaceRootOverride(null);
  invalidateServerSettingsCache();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /api/system/connection", () => {
  it("loopback default: loopback endpoint, not reachable, request origin", async () => {
    const { status, body } = await getConnection();
    expect(status).toBe(200);
    expect(body.mcpAuthMode).toBe("local-token");
    expect(body.mcpTokenRequired).toBe(false);
    expect(body.endpoint).toBe("http://127.0.0.1:7480/mcp");
    expect(body.reachable).toBe(false);
    expect(body.authRequired).toBe(false);
    expect(body.origin).toBe("http://localhost");
    expect(body.remoteMcpUrl).toBe("http://localhost/mcp");
    expect(body.originSource).toBe("request");
    expect(body.originConfigured).toBe(false);
  });

  it("respects a custom PORT in the endpoint", async () => {
    process.env["PORT"] = "9123";
    const { body } = await getConnection();
    expect(body.endpoint).toBe("http://127.0.0.1:9123/mcp");
  });

  it("respects a specific configured HOST and PORT in the local endpoint", async () => {
    process.env["HOST"] = "192.0.2.44";
    process.env["PORT"] = "9123";
    const { body } = await getConnection();
    expect(body.endpoint).toBe("http://192.0.2.44:9123/mcp");
  });

  it("formats an explicit IPv6 HOST as a valid URL", async () => {
    process.env["HOST"] = "::1";
    process.env["PORT"] = "9123";
    const { body } = await getConnection();
    expect(body.endpoint).toBe("http://[::1]:9123/mcp");
  });

  it("falls back from an invalid PORT instead of emitting an invalid URL", async () => {
    process.env["PORT"] = "99999";
    const { body } = await getConnection();
    expect(body.endpoint).toBe("http://127.0.0.1:7480/mcp");
  });

  it("falls back from an invalid HOST instead of emitting an invalid URL", async () => {
    process.env["HOST"] = "not a valid host";
    const { body } = await getConnection();
    expect(body.endpoint).toBe("http://127.0.0.1:7480/mcp");
  });

  it("HOST=0.0.0.0 → endpoint host maps to loopback, authRequired/reachable true", async () => {
    process.env["HOST"] = "0.0.0.0";
    const { body } = await getConnection();
    // A reachable install binds the wildcard but a LOCAL client must target a
    // connectable address — the endpoint host is loopback, not 0.0.0.0.
    expect(body.endpoint).toBe("http://127.0.0.1:7480/mcp");
    expect(body.reachable).toBe(true);
    expect(body.authRequired).toBe(true);
  });

  it("WORKTABLE_REQUIRE_AUTH=1 alone flips authRequired/reachable", async () => {
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const { body } = await getConnection();
    expect(body.endpoint).toBe("http://127.0.0.1:7480/mcp");
    expect(body.authRequired).toBe(true);
    expect(body.reachable).toBe(true);
  });

  it("WORKTABLE_PUBLIC_URL wins as the origin (env source, origin-only)", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://work.example.com/some/path";
    const { body } = await getConnection();
    // Trimmed to origin only, and reported as the configured (env) source.
    expect(body.origin).toBe("https://work.example.com");
    expect(body.originSource).toBe("env");
    expect(body.originConfigured).toBe(true);
  });

  it("honors X-Forwarded-Proto/Host from a fronting proxy", async () => {
    const { body } = await getConnection({
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "worktable.example.dev",
    });
    expect(body.origin).toBe("https://worktable.example.dev");
    expect(body.originSource).toBe("request");
    expect(body.originConfigured).toBe(false);
  });

  it("env origin outranks a forwarded host", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://canonical.example.com";
    const { body } = await getConnection({
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "spoofed.example.dev",
    });
    expect(body.origin).toBe("https://canonical.example.com");
    expect(body.originSource).toBe("env");
  });

  it("ignores a non-HTTP forwarded protocol and falls back to the request URL", async () => {
    const { body } = await getConnection({
      "X-Forwarded-Proto": "javascript",
      "X-Forwarded-Host": "worktable.example.dev",
    });
    expect(body.origin).toBe("http://localhost");
    expect(body.originSource).toBe("request");
    expect(body.origin).not.toBe("null");
  });
});

describe("GET /api/system/connection — hosted resource source", () => {
  it("derives the app origin and exact remote MCP URL from WORKTABLE_RESOURCE_URL", async () => {
    process.env["WORKTABLE_HOSTED"] = "1";
    process.env["WORKTABLE_RESOURCE_URL"] =
      "https://tenant.example.com/api/mcp";
    const { body } = await getConnection({}, "http://internal:8080/api/system/connection");
    expect(body.mcpAuthMode).toBe("oauth");
    expect(body.origin).toBe("https://tenant.example.com");
    expect(body.remoteMcpUrl).toBe("https://tenant.example.com/api/mcp");
    expect(body.originSource).toBe("resource");
    expect(body.originConfigured).toBe(true);
  });

  it("keeps the explicit Workspace URL ahead of the resource fallback", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://custom.example.com";
    process.env["WORKTABLE_RESOURCE_URL"] =
      "https://tenant.example.com/api/mcp";
    const { body } = await getConnection();
    expect(body.origin).toBe("https://custom.example.com");
    expect(body.originSource).toBe("env");
    // The OAuth audience remains the canonical remote MCP endpoint even when
    // the browser/document front door has an explicit override.
    expect(body.remoteMcpUrl).toBe("https://tenant.example.com/api/mcp");
  });

  it("ignores a malformed or non-HTTP resource URL", async () => {
    process.env["WORKTABLE_RESOURCE_URL"] = "file:///tenant/mcp";
    const { body } = await getConnection();
    expect(body.origin).toBe("http://localhost");
    expect(body.originSource).toBe("request");
    expect(body.originConfigured).toBe(false);
    expect(body.remoteMcpUrl).toBe("http://localhost/mcp");
  });
});

describe("GET /api/system/connection — config source (settings network.publicUrl)", () => {
  it("reports the settings origin as the config source", async () => {
    await updateServerSettings({
      network: { publicUrl: "https://config.example.com" },
    });
    const { body } = await getConnection();
    expect(body.origin).toBe("https://config.example.com");
    expect(body.originSource).toBe("config");
    expect(body.originConfigured).toBe(true);
  });

  it("a non-http stored publicUrl is ignored, not surfaced as a null origin", async () => {
    // Settings normalize on write, so seed the file directly with a hand-edited
    // bad value and re-read tolerantly (coerced to null on read → request source).
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(tempDir, "app"), { recursive: true });
    writeFileSync(
      join(tempDir, "app", "settings.json"),
      JSON.stringify({ version: 1, network: { publicUrl: "not a url" } }),
    );
    invalidateServerSettingsCache();
    const { body } = await getConnection();
    expect(body.originSource).toBe("request");
    expect(body.origin).not.toBe("null");
    expect(body.originConfigured).toBe(false);
  });
});

describe("GET /api/system/connection — mcpTokenRequired", () => {
  it("stays false when scoped tokens coexist with a loopback bind", async () => {
    await createToken({ scopes: ["docs:read"], agent: "test" });
    const { body } = await getConnection();
    expect(body.reachable).toBe(false);
    expect(body.mcpTokenRequired).toBe(false);
  });

  it("true on an exposed bind even with no tokens", async () => {
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const { body } = await getConnection();
    expect(body.mcpTokenRequired).toBe(true);
  });

  it("true on a loopback bind with only a configured public URL (no tokens)", async () => {
    // A saved public origin is an exposed front door even on loopback, so the
    // connect card must require a token — matching requireIdentity()'s gate.
    await updateServerSettings({
      network: { publicUrl: "https://tunnel.example.com" },
    });
    const { body } = await getConnection();
    expect(body.reachable).toBe(false); // still a loopback bind
    expect(body.authRequired).toBe(true);
    expect(body.mcpTokenRequired).toBe(true);
    expect(body.originConfigured).toBe(true);
  });

  it("true via the WORKTABLE_PUBLIC_URL env public origin (no tokens, loopback)", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://env-tunnel.example.com";
    const { body } = await getConnection();
    expect(body.reachable).toBe(false);
    expect(body.authRequired).toBe(true);
    expect(body.mcpTokenRequired).toBe(true);
  });
});

describe("GET /api/system/connection — origin scheme validation", () => {
  it("a non-http WORKTABLE_PUBLIC_URL is ignored, not surfaced as a null origin", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "file:///etc";
    const { body } = await getConnection();
    expect(body.originSource).toBe("request");
    expect(body.origin).not.toBe("null");
    expect(body.originConfigured).toBe(false);
  });

  it("never accepts a non-HTTP forwarded protocol", () => {
    const unsupportedScheme = fc
      .stringMatching(/^[a-z][a-z0-9+.-]{0,15}$/)
      .filter((scheme) => scheme !== "http" && scheme !== "https");
    fc.assert(
      fc.property(unsupportedScheme, (scheme) => {
        const resolved = resolveWorkspaceOriginForRequest(
          new Request("http://internal.example/api/system/connection", {
            headers: {
              "X-Forwarded-Proto": scheme,
              "X-Forwarded-Host": "forwarded.example",
            },
          }),
        );
        expect(resolved).toEqual({
          origin: "http://internal.example",
          originSource: "request",
        });
      }),
    );
  });

  it("falls back to local HOST/PORT when the request URL is not HTTP", () => {
    process.env["HOST"] = "192.0.2.44";
    process.env["PORT"] = "9123";
    expect(
      resolveWorkspaceOriginForRequest(
        new Request("file:///api/system/connection"),
      ),
    ).toEqual({
      origin: "http://192.0.2.44:9123",
      originSource: "fallback",
    });
  });
});
