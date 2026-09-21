import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultConfig, readConfig, setClientState, writeConfig } from "./config.ts";
import {
  ensureManagedToken,
  getMcpStatuses,
  printClientConfig,
  repairClients,
  rotateManagedToken,
  setupClients,
  setupManagedClients,
} from "./mcp.ts";
import { getWorkspaceRoot, listTokens } from "@worktable/server/runtime";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];

function useTempRuntime(): string {
  const root = mkdtempSync(join(tmpdir(), "worktable-cli-mcp-"));
  tempRoots.push(root);
  process.env["HOME"] = root;
  process.env["PATH"] = join(root, "bin");
  process.env["WORKTABLE_APP_DIR"] = join(root, "app");
  process.env["WORKTABLE_WORKSPACE"] = join(root, "workspace");
  process.env["WORKTABLE_CURSOR_MCP_CONFIG"] = join(root, ".cursor", "mcp.json");
  process.env["WORKTABLE_OPENCODE_CONFIG"] = join(root, ".config", "opencode", "opencode.json");
  process.env["WORKTABLE_CODEX_CONFIG"] = join(root, ".codex", "config.toml");
  return root;
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP adapters", () => {
  it("writes Cursor config without removing unrelated servers", () => {
    const root = useTempRuntime();
    writeConfig(createDefaultConfig());
    const cursorConfig = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      cursorConfig,
      JSON.stringify({ mcpServers: { existing: { url: "http://example.test/mcp" } } }, null, 2),
      { mode: 0o600 }
    );

    setupClients(["cursor"], true);

    const parsed = JSON.parse(readFileSync(cursorConfig, "utf8")) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(parsed.mcpServers.existing?.url).toBe("http://example.test/mcp");
    expect(parsed.mcpServers.worktable?.url).toBe("http://127.0.0.1:7480/mcp");
  });

  it("repairs malformed Cursor config JSON instead of throwing", () => {
    const root = useTempRuntime();
    writeConfig(createDefaultConfig());
    const cursorConfig = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(cursorConfig, "{nope", { mode: 0o600 });

    setupClients(["cursor"], true);

    const parsed = JSON.parse(readFileSync(cursorConfig, "utf8")) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(parsed.mcpServers.worktable?.url).toBe("http://127.0.0.1:7480/mcp");
  });

  it("reports Claude Code configured after a successful stored setup", () => {
    useTempRuntime();
    const config = createDefaultConfig();
    setClientState(config, "claude-code", true, "configured");
    writeConfig(config);

    const status = getMcpStatuses(config).find((item) => item.id === "claude-code");

    expect(status?.state).toBe("configured");
    expect(status?.configuredUrl).toBe("http://127.0.0.1:7480/mcp");
  });

  it("does not let stored pending Claude Code state appear configured", () => {
    useTempRuntime();
    const config = createDefaultConfig();
    setClientState(config, "claude-code", true, "pending");
    writeConfig(config);

    const status = getMcpStatuses(config).find((item) => item.id === "claude-code");

    expect(status?.state).toBe("pending");
    expect(status?.configuredUrl).toBeUndefined();
  });

  it("reports malformed Codex TOML instead of claiming the client is configured", () => {
    const root = useTempRuntime();
    const config = reachableConfig();
    setClientState(config, "codex", true, "configured");
    writeConfig(config);
    const path = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      path,
      "[mcp_servers.worktable]\n" +
        'url = "http://127.0.0.1:7480/mcp"\n' +
        'http_headers = { Authorization = "Bearer wt_new_secret" }\n' +
        "[mcp_servers.worktable.http_headers]\n" +
        'Authorization = "Bearer wt_old_secret"\n'
    );

    const status = getMcpStatuses(config).find((item) => item.id === "codex");
    expect(status?.state).not.toBe("configured");
    expect(status?.message).toContain("Invalid Codex config");
    expect(status?.message).not.toContain("wt_new_secret");
    expect(status?.message).not.toContain("wt_old_secret");
  });

  it("emits the claude `mcp add` command with the URL before --header", () => {
    // claude's `-H, --header <header...>` is variadic and greedily eats a trailing
    // URL ("missing required argument 'commandOrUrl'"). The URL must come right
    // after the name and --header must be last. (setup() shells out to `claude`,
    // so printConfig is the testable surface for the command shape.)
    useTempRuntime();
    const config = createDefaultConfig();
    const token = "wt_test_token";
    const original = console.log;
    let printed = "";
    console.log = (msg?: unknown) => {
      printed += `${String(msg ?? "")}\n`;
    };
    try {
      printClientConfig("claude-code", config, token);
    } finally {
      console.log = original;
    }
    const line = printed.trim();
    expect(line).toContain(`worktable ${config.mcp.endpoint} `);
    expect(line.indexOf(config.mcp.endpoint)).toBeLessThan(line.indexOf("--header"));
    expect(line.endsWith(`--header "Authorization: Bearer ${token}"`)).toBe(true);
  });

  it("writes opencode config in the expected shape", () => {
    const root = useTempRuntime();
    writeConfig(createDefaultConfig());

    setupClients(["opencode"], true);

    const path = join(root, ".config", "opencode", "opencode.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      mcp: Record<string, { type: string; url: string; enabled: boolean }>;
    };
    expect(parsed.mcp.worktable).toEqual({
      type: "remote",
      url: "http://127.0.0.1:7480/mcp",
      enabled: true,
    });
  });

  it("reports drift against the canonical endpoint", () => {
    const root = useTempRuntime();
    const config = createDefaultConfig({
      service: { host: "127.0.0.1", port: 7434, startAtLogin: true },
      mcp: { endpoint: "http://127.0.0.1:7434/mcp", clients: {} },
    });
    setClientState(config, "cursor", true, "pending");
    writeConfig(config);
    const cursorConfig = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      cursorConfig,
      JSON.stringify({ mcpServers: { worktable: { url: "http://127.0.0.1:7480/mcp" } } }, null, 2),
      { mode: 0o600 }
    );

    const status = getMcpStatuses(config).find((item) => item.id === "cursor");

    expect(status?.state).toBe("drift");
    expect(status?.configuredUrl).toBe("http://127.0.0.1:7480/mcp");
    expect(status?.expectedUrl).toBe("http://127.0.0.1:7434/mcp");
  });
});

const REACHABLE_ENDPOINT = "http://0.0.0.0:7480/mcp";

function reachableConfig() {
  return createDefaultConfig({
    service: {
      host: "0.0.0.0",
      port: 7480,
      startAtLogin: true,
      reachable: true,
    },
    mcp: { endpoint: REACHABLE_ENDPOINT, clients: {} },
  });
}

describe("token injection into agent configs", () => {
  it("injects the bearer into cursor/opencode/vscode and preserves unrelated servers", () => {
    const root = useTempRuntime();
    process.env["WORKTABLE_VSCODE_MCP_CONFIG"] = join(root, "vscode", "mcp.json");
    writeConfig(reachableConfig());
    // A pre-existing unrelated cursor server must survive injection.
    const cursorConfig = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      cursorConfig,
      JSON.stringify({ mcpServers: { existing: { url: "http://example.test/mcp" } } }, null, 2),
      { mode: 0o600 }
    );

    setupClients(["cursor", "opencode", "vscode"], true, "wt_test_token");

    const cursor = JSON.parse(readFileSync(cursorConfig, "utf8")) as {
      mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
    };
    expect(cursor.mcpServers.existing?.url).toBe("http://example.test/mcp");
    expect(cursor.mcpServers.worktable?.headers?.Authorization).toBe("Bearer wt_test_token");

    const opencode = JSON.parse(
      readFileSync(join(root, ".config", "opencode", "opencode.json"), "utf8")
    ) as {
      mcp: Record<string, { headers?: Record<string, string> }>;
    };
    expect(opencode.mcp.worktable?.headers?.Authorization).toBe("Bearer wt_test_token");

    const vscode = JSON.parse(readFileSync(join(root, "vscode", "mcp.json"), "utf8")) as {
      servers: Record<string, { headers?: Record<string, string> }>;
    };
    expect(vscode.servers.worktable?.headers?.Authorization).toBe("Bearer wt_test_token");

    // The injected config file is 0o600 (a bearer must never be world-readable).
    expect(statSync(cursorConfig).mode & 0o777).toBe(0o600);
  });

  it("writes http_headers into the codex TOML block when a token is present", () => {
    const root = useTempRuntime();
    writeConfig(reachableConfig());

    setupClients(["codex"], true, "wt_codex_token");

    const codexPath = join(root, ".codex", "config.toml");
    const toml = readFileSync(codexPath, "utf8");
    expect(toml).toContain("[mcp_servers.worktable]");
    // A reachable install binds 0.0.0.0 but the LOCAL client endpoint must target a
    // connectable address (loopback), not the listen wildcard.
    expect(toml).toContain('url = "http://127.0.0.1:7480/mcp"');
    expect(toml).toContain('http_headers = { Authorization = "Bearer wt_codex_token" }');
    expect(statSync(codexPath).mode & 0o777).toBe(0o600);
  });

  it("emits no headers when no token is in hand (loopback path unchanged)", () => {
    const root = useTempRuntime();
    writeConfig(createDefaultConfig());

    setupClients(["cursor"], true);

    const cursor = JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { url: string; headers?: unknown }>;
    };
    expect(cursor.mcpServers.worktable?.url).toBe("http://127.0.0.1:7480/mcp");
    expect(cursor.mcpServers.worktable?.headers).toBeUndefined();
  });

  it("repair on a reachable config preserves a WORKING bearer (re-mint, prior managed revoked)", async () => {
    const root = useTempRuntime();
    const config = reachableConfig();
    setClientState(config, "cursor", true, "configured");
    setClientState(config, "claude-code", true, "pending");
    writeConfig(config);
    const cursorConfig = join(root, ".cursor", "mcp.json");

    // repair() drives the real rotate-and-inject path on a reachable config:
    // it mints a managed token and writes the bearer into the cursor config.
    await repairClients();
    const firstHeaders = (
      JSON.parse(readFileSync(cursorConfig, "utf8")) as {
        mcpServers: Record<string, { headers?: Record<string, string> }>;
      }
    ).mcpServers.worktable?.headers?.Authorization;
    expect(firstHeaders).toMatch(/^Bearer wt_/);

    const afterFirst = (await listTokens()).filter(
      (t) => t.agent === "managed:cursor" && !t.revokedAt
    );
    expect(afterFirst).toHaveLength(1);

    // A second repair must re-mint (preserving a working bearer) and revoke the
    // prior managed token — no accumulation of live managed tokens.
    await repairClients();
    const secondHeaders = (
      JSON.parse(readFileSync(cursorConfig, "utf8")) as {
        mcpServers: Record<string, { headers?: Record<string, string> }>;
      }
    ).mcpServers.worktable?.headers?.Authorization;
    expect(secondHeaders).toMatch(/^Bearer wt_/);
    expect(secondHeaders).not.toBe(firstHeaders);

    const live = (await listTokens()).filter(
      (t) => t.agent === "managed:cursor" && !t.revokedAt
    );
    expect(live).toHaveLength(1);
    expect(readConfig().mcp.clients["claude-code"]?.state).toBe("pending");

    // The injected file stays 0o600.
    expect(statSync(cursorConfig).mode & 0o777).toBe(0o600);
  });

  it("repair binds the minted token to the CONFIG workspace, not the ambient env", async () => {
    const root = useTempRuntime();
    // Simulate `mcp repair` run in a shell whose WORKTABLE_WORKSPACE points at a
    // DIFFERENT folder than the config's workspace (the action does not run
    // applyRuntimeConfig first). Without repairClients setting the env from
    // config, createToken would bind the token to this ambient path and
    // verifyToken would then reject the injected bearer.
    const configWorkspace = join(root, "config-workspace");
    process.env["WORKTABLE_WORKSPACE"] = join(root, "ambient-workspace");
    const config = createDefaultConfig({
      workspace: configWorkspace,
      service: {
        host: "0.0.0.0",
        port: 7480,
        startAtLogin: true,
        reachable: true,
      },
      mcp: { endpoint: REACHABLE_ENDPOINT, clients: {} },
    });
    setClientState(config, "cursor", true, "configured");
    writeConfig(config);

    await repairClients();

    const live = (await listTokens()).filter(
      (t) => t.agent === "managed:cursor" && !t.revokedAt
    );
    expect(live).toHaveLength(1);
    // The token must be bound to the config workspace so verifyToken (which keys
    // on getWorkspaceRoot()) accepts the bearer injected into the agent config.
    expect(live[0]?.workspace).toBe(configWorkspace);
  });

  it("updates every desired client before committing per-client credentials", async () => {
    const root = useTempRuntime();
    const config = reachableConfig();
    setClientState(config, "cursor", true, "configured");
    setClientState(config, "codex", true, "configured");
    writeConfig(config);
    const oldToken = await rotateManagedToken();
    setupClients(["cursor", "codex"], true, oldToken);

    const results = await setupManagedClients(["codex"], true);
    expect(results.map((result) => result.id).sort()).toEqual(["codex", "cursor"]);

    const cursor = JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { headers: { Authorization: string } }>;
    };
    const cursorAuth = cursor.mcpServers.worktable!.headers.Authorization;
    const codexAuth = readFileSync(join(root, ".codex", "config.toml"), "utf8").match(
      /Authorization = "([^"]+)"/
    )?.[1];
    expect(codexAuth).toBeDefined();
    expect(cursorAuth).not.toBe(codexAuth!);
    expect(cursorAuth).not.toBe(`Bearer ${oldToken}`);
    expect(codexAuth).not.toBe(`Bearer ${oldToken}`);

    const managed = (await listTokens()).filter(
      (token) =>
        token.agent === "managed" || token.agent?.startsWith("managed:")
    );
    expect(
      managed
        .filter((token) => !token.revokedAt)
        .map((token) => token.agent)
        .sort()
    ).toEqual(["managed:codex", "managed:cursor"]);
    expect(
      managed.filter((token) => token.agent === "managed" && token.revokedAt)
    ).toHaveLength(1);
  });

  it("does not mint or revoke when any affected client fails preflight", async () => {
    const root = useTempRuntime();
    const config = reachableConfig();
    setClientState(config, "cursor", true, "configured");
    setClientState(config, "codex", true, "configured");
    writeConfig(config);
    const oldToken = await rotateManagedToken();
    setupClients(["cursor"], true, oldToken);
    const cursorPath = join(root, ".cursor", "mcp.json");
    const cursorBefore = readFileSync(cursorPath);

    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "blocked");
    process.env["WORKTABLE_CODEX_CONFIG"] = join(blocker, "config.toml");

    await expect(setupManagedClients(["cursor"], true)).rejects.toThrow(/rotation was not started/);
    expect(readFileSync(cursorPath)).toEqual(cursorBefore);
    const managed = (await listTokens()).filter((token) => token.agent === "managed");
    expect(managed).toHaveLength(1);
    expect(managed[0]?.revokedAt).toBeNull();
  });

  it("does not let a pending unavailable client block a requested rotation", async () => {
    const root = useTempRuntime();
    const config = reachableConfig();
    setClientState(config, "cursor", true, "configured");
    setClientState(config, "claude-code", true, "pending");
    writeConfig(config);
    const oldToken = await rotateManagedToken();
    setupClients(["cursor"], true, oldToken);

    const results = await setupManagedClients(["cursor"], true);
    expect(results.map((result) => result.id)).toEqual(["cursor"]);
    expect(
      JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8")).mcpServers.worktable
        .headers.Authorization
    ).not.toBe(`Bearer ${oldToken}`);

    const managed = (await listTokens()).filter(
      (token) =>
        token.agent === "managed" || token.agent?.startsWith("managed:")
    );
    expect(
      managed
        .filter((token) => !token.revokedAt)
        .map((token) => token.agent)
    ).toEqual(["managed:cursor"]);
  });

  it("repairs the duplicate Codex header incident through managed setup", async () => {
    const root = useTempRuntime();
    const config = reachableConfig();
    setClientState(config, "codex", true, "configured");
    writeConfig(config);
    const oldToken = await rotateManagedToken();
    const path = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      path,
      '[profile]\nmodel = "o4"\n\n' +
        '[mcp_servers.worktable]\nurl = "http://127.0.0.1:7480/mcp"\n' +
        `http_headers = { Authorization = "Bearer ${oldToken}" }\n` +
        '[mcp_servers.worktable.http_headers]\nAuthorization = "Bearer revoked_old_value"\n'
    );

    const results = await setupManagedClients(["codex"], true);
    expect(results).toHaveLength(1);
    expect(results[0]?.state).toBe("configured");
    const written = readFileSync(path, "utf8");
    expect(written).not.toContain("[mcp_servers.worktable.http_headers]");
    expect(written).not.toContain(`Bearer ${oldToken}`);

    const managed = (await listTokens()).filter(
      (token) =>
        token.agent === "managed" || token.agent?.startsWith("managed:")
    );
    expect(
      managed
        .filter((token) => !token.revokedAt)
        .map((token) => token.agent)
    ).toEqual(["managed:codex"]);
    expect(
      managed.filter((token) => token.agent === "managed" && token.revokedAt)
    ).toHaveLength(1);
  });

  it("restores client bytes and preserves the old token after a malformed unrelated setting", async () => {
    const root = useTempRuntime();
    const config = reachableConfig();
    setClientState(config, "cursor", true, "configured");
    setClientState(config, "codex", true, "configured");
    writeConfig(config);
    const oldToken = await rotateManagedToken();

    const cursorPath = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      cursorPath,
      JSON.stringify(
        {
          mcpServers: {
            worktable: {
              url: "http://127.0.0.1:7480/mcp",
              headers: { Authorization: `Bearer ${oldToken}` },
            },
          },
        },
        null,
        2
      ) + "\n",
      { mode: 0o600 }
    );
    const codexPath = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      codexPath,
      "broken = [\n\n[mcp_servers.worktable]\n" +
        'url = "http://127.0.0.1:7480/mcp"\n' +
        `http_headers = { Authorization = "Bearer ${oldToken}" }\n`,
      { mode: 0o600 }
    );
    const cursorBefore = readFileSync(cursorPath);
    const codexBefore = readFileSync(codexPath);

    await expect(setupManagedClients(["cursor", "codex"], true)).rejects.toThrow(
      /Previous client configurations and credentials remain active/
    );
    expect(readFileSync(cursorPath)).toEqual(cursorBefore);
    expect(readFileSync(codexPath)).toEqual(codexBefore);

    const managed = (await listTokens()).filter(
      (token) =>
        token.agent === "managed" || token.agent?.startsWith("managed:")
    );
    expect(
      managed
        .filter((token) => !token.revokedAt)
        .map((token) => token.agent)
    ).toEqual(["managed"]);
    expect(
      managed.filter(
        (token) => token.agent?.startsWith("managed:") && token.revokedAt
      )
    ).toHaveLength(2);
  });

  it("reports a reachable client as drift when its config lacks the bearer header", () => {
    const root = useTempRuntime();
    writeConfig(reachableConfig());
    // Configure cursor WITH the bearer → configured.
    setupClients(["cursor"], true, "wt_status_token");
    let cursor = getMcpStatuses(readConfig()).find((s) => s.id === "cursor");
    expect(cursor?.state).toBe("configured");

    // Strip the Authorization header (stale/headerless config): the URL still
    // matches, but a reachable server would 401 — so it must report drift.
    const cursorConfig = join(root, ".cursor", "mcp.json");
    const json = JSON.parse(readFileSync(cursorConfig, "utf8")) as {
      mcpServers: Record<string, { url: string; headers?: unknown }>;
    };
    delete json.mcpServers.worktable.headers;
    writeFileSync(cursorConfig, JSON.stringify(json, null, 2));
    cursor = getMcpStatuses(readConfig()).find((s) => s.id === "cursor");
    expect(cursor?.state).toBe("drift");
  });

  it("ensureManagedToken mints a fresh token when the only managed token is bound to a different workspace", async () => {
    const root = useTempRuntime();
    // Mint a managed token bound to workspace A (the default useTempRuntime ws).
    await rotateManagedToken();
    const wsA = getWorkspaceRoot();
    const activeA = (await listTokens()).filter((t) => t.agent === "managed" && !t.revokedAt);
    expect(activeA).toHaveLength(1);
    expect(activeA[0]?.workspace).toBe(wsA);

    // Point at a different workspace: the A-bound token is invalid here (verifyToken
    // keys on getWorkspaceRoot), so ensureManagedToken must mint a token for B
    // rather than treat the stale A token as "present" and leave MCP clients 401ing.
    process.env["WORKTABLE_WORKSPACE"] = join(root, "workspace-b");
    const wsB = getWorkspaceRoot();
    expect(wsB).not.toBe(wsA);
    await ensureManagedToken();
    const activeForB = (await listTokens()).filter(
      (t) => t.agent === "managed" && !t.revokedAt && t.workspace === wsB
    );
    expect(activeForB).toHaveLength(1);
  });

  it("drift detection still matches on .url with a headers key present", () => {
    const root = useTempRuntime();
    const config = reachableConfig();
    setClientState(config, "cursor", true, "configured");
    writeConfig(config);
    const cursorConfig = join(root, ".cursor", "mcp.json");
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      cursorConfig,
      JSON.stringify(
        {
          mcpServers: {
            worktable: {
              url: REACHABLE_ENDPOINT,
              headers: { Authorization: "Bearer wt_anything" },
            },
          },
        },
        null,
        2
      ),
      { mode: 0o600 }
    );

    const status = getMcpStatuses(config).find((item) => item.id === "cursor");
    // The endpoint matches, so a headers key must not flip it to drift.
    expect(status?.state).toBe("configured");
  });
});
