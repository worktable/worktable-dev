import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  captureClientConfigMutation,
  codexPath,
  installClient,
  preflightClient,
  readCodexAuth,
  readCodexConfigError,
  readCodexUrl,
  removeCodex,
  restoreClientConfig,
  validateClientConfigSnapshot,
} from "./client-config.ts";
import { parseConnectorArgs } from "./connector.ts";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];

function useTempRuntime(): string {
  const root = mkdtempSync(join(tmpdir(), "worktable-mcp-connect-"));
  tempRoots.push(root);
  process.env["HOME"] = root;
  process.env["PATH"] = join(root, "bin"); // no claude/codex/etc on PATH
  process.env["CLAUDE_CONFIG_DIR"] = root;
  process.env["WORKTABLE_CURSOR_MCP_CONFIG"] = join(root, ".cursor", "mcp.json");
  process.env["WORKTABLE_OPENCODE_CONFIG"] = join(root, ".config", "opencode", "opencode.json");
  process.env["WORKTABLE_CODEX_CONFIG"] = join(root, ".codex", "config.toml");
  process.env["WORKTABLE_VSCODE_MCP_CONFIG"] = join(root, "vscode", "mcp.json");
  return root;
}

function installFakeClaude(root: string, scope: "Local" | "Project" | "User" | null): void {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(Bun.which("sh")!, join(bin, "sh"));
  const executable = join(bin, "claude");
  const response = scope
    ? `printf '%s\\n' 'worktable:' '  Scope: ${scope} config'\nexit 0`
    : `printf '%s\\n' 'No MCP server named "worktable".' >&2\nexit 1`;
  writeFileSync(
    executable,
    `#!/bin/sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ] && [ "$3" = "worktable" ]; then\n  ${response.replace(/\n/g, "\n  ")}\nfi\nexit 2\n`
  );
  chmodSync(executable, 0o755);
  process.env["WORKTABLE_CLAUDE_COMMAND"] = executable;
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TARGET = { endpoint: "https://wt.example.com/mcp", token: "wt_x_y" };

describe("codexPath", () => {
  it("prefers the Worktable-specific override over CODEX_HOME", () => {
    const root = useTempRuntime();
    const override = process.env["WORKTABLE_CODEX_CONFIG"]!;
    process.env["CODEX_HOME"] = join(root, "isolated-codex-home");

    expect(codexPath()).toBe(override);
  });

  it("uses CODEX_HOME when no Worktable-specific override is set", () => {
    const root = useTempRuntime();
    delete process.env["WORKTABLE_CODEX_CONFIG"];
    process.env["CODEX_HOME"] = join(root, "isolated-codex-home");

    expect(codexPath()).toBe(join(root, "isolated-codex-home", "config.toml"));
  });

  it("falls back to the default config under the user home", () => {
    useTempRuntime();
    delete process.env["WORKTABLE_CODEX_CONFIG"];
    delete process.env["CODEX_HOME"];

    expect(codexPath()).toBe(join(homedir(), ".codex", "config.toml"));
  });
});

describe("installClient", () => {
  it("writes cursor config with bearer, preserving unrelated servers, mode 0600", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CURSOR_MCP_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { url: "http://other" } } }));

    const outcome = installClient("cursor", TARGET);
    expect(outcome.ok).toBe(true);
    expect(outcome.configPath).toBe(path);

    const config = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
    };
    expect(config.mcpServers["other"]!.url).toBe("http://other");
    expect(config.mcpServers["worktable"]!.url).toBe(TARGET.endpoint);
    expect(config.mcpServers["worktable"]!.headers!["Authorization"]).toBe("Bearer wt_x_y");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("writes the codex TOML block and preserves other sections", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `[profile]\nmodel = "o4"\n`);

    const outcome = installClient("codex", TARGET);
    expect(outcome.ok).toBe(true);

    const text = readFileSync(path, "utf8");
    expect(text).toContain(`[profile]\nmodel = "o4"`);
    expect(text).toContain(`[mcp_servers.worktable]\nurl = "${TARGET.endpoint}"`);
    expect(text).toContain(`http_headers = { Authorization = "Bearer wt_x_y" }`);
  });

  it("writes Codex config under CODEX_HOME when no Worktable override is set", () => {
    const root = useTempRuntime();
    delete process.env["WORKTABLE_CODEX_CONFIG"];
    process.env["CODEX_HOME"] = join(root, "isolated-codex-home");
    const path = join(process.env["CODEX_HOME"]!, "config.toml");

    const outcome = installClient("codex", TARGET);

    expect(outcome.ok).toBe(true);
    expect(outcome.configPath).toBe(path);
    expect(readFileSync(path, "utf8")).toContain(`[mcp_servers.worktable]\nurl = "${TARGET.endpoint}"`);
  });

  it("fails claude-code cleanly when the CLI is absent", () => {
    useTempRuntime();
    const outcome = installClient("claude-code", TARGET);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("Claude Code CLI not found");
  });

  it("returns a failed outcome instead of throwing when the config path is unwritable", () => {
    const root = useTempRuntime();
    // Parent "directory" is a FILE, so mkdir/write must fail.
    writeFileSync(join(root, "blocker"), "");
    process.env["WORKTABLE_CODEX_CONFIG"] = join(root, "blocker", "config.toml");

    const outcome = installClient("codex", TARGET);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBeDefined();
  });

  it("connector preflight leaves malformed JSON byte-for-byte unchanged", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CURSOR_MCP_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    const corrupt = Buffer.from("{ definitely not json\n");
    writeFileSync(path, corrupt);

    const outcome = preflightClient("cursor", { replace: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("not valid JSON");
    expect(readFileSync(path)).toEqual(corrupt);
  });
});

describe("connector config transaction", () => {
  it("blocks an existing Worktable entry unless replacement is explicit", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CURSOR_MCP_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { worktable: { url: "https://old.test/mcp" } },
      })
    );

    const blocked = preflightClient("cursor", { replace: false });
    expect(blocked.ok).toBe(false);
    expect(blocked.existing).toBe(true);
    expect(blocked.message).toContain("--replace");

    const allowed = preflightClient("cursor", { replace: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.existing).toBe(true);
    expect(allowed.snapshot?.contents).toEqual(readFileSync(path));
  });

  it("blocks a higher-priority Claude scope even when replacing the user entry", () => {
    const root = useTempRuntime();
    installFakeClaude(root, "Local");
    const path = join(root, ".claude.json");
    const original = Buffer.from(
      JSON.stringify({
        mcpServers: {
          worktable: { type: "http", url: "https://old.test/mcp" },
        },
      }) + "\n"
    );
    writeFileSync(path, original);

    const checked = preflightClient("claude-code", { replace: true });
    expect(checked.ok).toBe(false);
    expect(checked.existing).toBe(true);
    expect(checked.message).toContain("higher-priority local or project");
    expect(readFileSync(path)).toEqual(original);
  });

  it("allows Claude preflight when its CLI reports no scoped Worktable server", () => {
    const root = useTempRuntime();
    installFakeClaude(root, null);

    const checked = preflightClient("claude-code", { replace: false });
    expect(checked.ok).toBe(true);
    expect(checked.existing).toBe(false);
  });

  it("detects and replaces one Codex entry in a CRLF config", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '[profile]\r\nmodel = "o4"\r\n\r\n[mcp_servers.worktable]\r\nurl = "https://old.test/mcp"\r\n');

    const blocked = preflightClient("codex", { replace: false });
    expect(blocked.ok).toBe(false);
    expect(blocked.existing).toBe(true);

    const allowed = preflightClient("codex", { replace: true });
    expect(allowed.ok).toBe(true);
    expect(installClient("codex", TARGET, { replace: true, existing: true }).ok).toBe(true);
    const written = readFileSync(path, "utf8");
    expect(written.match(/\[mcp_servers\.worktable\]/g)).toHaveLength(1);
    expect(written).toContain(`url = "${TARGET.endpoint}"`);
  });

  it("detects, replaces, reads, and removes a quoted Codex Worktable table", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '[mcp_servers."worktable"]\nurl = "https://old.test/mcp"\nhttp_headers = { Authorization = "Bearer old" }\n\n[profile]\nmodel = "o4"\n'
    );

    expect(readCodexUrl(path)).toBe("https://old.test/mcp");
    expect(readCodexAuth(path)).toBe(true);
    const blocked = preflightClient("codex", { replace: false });
    expect(blocked.ok).toBe(false);
    expect(blocked.existing).toBe(true);

    const allowed = preflightClient("codex", { replace: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.existing).toBe(true);
    expect(installClient("codex", TARGET, { replace: true, existing: true }).ok).toBe(true);
    const written = readFileSync(path, "utf8");
    expect(written).not.toContain('[mcp_servers."worktable"]');
    expect(written.match(/\[mcp_servers\.worktable\]/g)).toHaveLength(1);
    expect(written).toContain('[profile]\nmodel = "o4"');
    expect(readCodexUrl(path)).toBe(TARGET.endpoint);
    expect(readCodexAuth(path)).toBe(true);

    removeCodex(path);
    expect(readCodexUrl(path)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toContain('[profile]\nmodel = "o4"');
  });

  it("repairs the duplicate inline and nested Codex headers from the live incident", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '[profile]\nmodel = "o4"\n\n' +
        "[mcp_servers.worktable]\n" +
        'url = "https://old.test/mcp"\n' +
        'http_headers = { Authorization = "Bearer wt_new_secret" }\n' +
        "[mcp_servers.worktable.http_headers]\n" +
        'Authorization = "Bearer wt_old_secret"\n\n' +
        '[mcp_servers.other]\nurl = "https://other.test/mcp"\n'
    );

    const error = readCodexConfigError(path);
    expect(error).toBeDefined();
    expect(error).not.toContain("wt_new_secret");
    expect(error).not.toContain("wt_old_secret");
    expect(error).not.toContain("new_secret");
    expect(error).not.toContain("old_secret");

    const installed = installClient("codex", TARGET, {
      replace: true,
      existing: true,
    });
    expect(installed.ok).toBe(true);
    expect(readCodexConfigError(path)).toBeUndefined();
    expect(readCodexUrl(path)).toBe(TARGET.endpoint);
    expect(readCodexAuth(path)).toBe(true);

    const written = readFileSync(path, "utf8");
    expect(written.match(/\[mcp_servers\.worktable\]/g)).toHaveLength(1);
    expect(written).not.toContain("[mcp_servers.worktable.http_headers]");
    expect(written).not.toContain("wt_old_secret");
    expect(written).toContain('[mcp_servers.other]\nurl = "https://other.test/mcp"');
    expect(written).toContain('[profile]\nmodel = "o4"');
  });

  it("detects parsed inline Codex entries and refuses an unsafe rewrite or removal", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    const original =
      '[mcp_servers]\nworktable = { url = "https://old.test/mcp", http_headers = { Authorization = "Bearer old" } }\n';
    writeFileSync(path, original);

    expect(readCodexUrl(path)).toBe("https://old.test/mcp");
    expect(readCodexAuth(path)).toBe(true);
    const blocked = preflightClient("codex", { replace: false });
    expect(blocked.ok).toBe(false);
    expect(blocked.existing).toBe(true);

    const allowed = preflightClient("codex", { replace: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.existing).toBe(true);
    expect(installClient("codex", TARGET, { replace: true, existing: true }).ok).toBe(false);
    expect(() => removeCodex(path)).toThrow(/outside a removable TOML table/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("redacts a complete underscored bearer from Codex parser errors", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '[mcp_servers.worktable]\nhttp_headers = { Authorization = "Bearer wt_abc123_secret_value" BAD }\n'
    );

    const error = readCodexConfigError(path);
    expect(error).toContain("Bearer <redacted>");
    expect(error).not.toContain("abc123");
    expect(error).not.toContain("secret_value");
  });

  it("redacts bearer values from Codex preflight parse errors", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '[mcp_servers]\nworktable = { url = "https://old.test/mcp", http_headers = { Authorization = "Bearer wt_preflight_secret_value" BAD } }\n'
    );

    const outcome = preflightClient("codex", { replace: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("Bearer <redacted>");
    expect(outcome.message).not.toContain("preflight");
    expect(outcome.message).not.toContain("secret_value");
  });

  it("replaces a valid nested Codex header table without leaving descendants", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '[mcp_servers.worktable]\nurl = "https://old.test/mcp"\n\n' +
        "[mcp_servers.worktable.http_headers]\n" +
        'Authorization = "Bearer wt_old_secret"\n\n' +
        '[mcp_servers.other]\nurl = "https://other.test/mcp"\n'
    );

    expect(readCodexConfigError(path)).toBeUndefined();
    expect(readCodexAuth(path)).toBe(true);
    expect(installClient("codex", TARGET, { replace: true, existing: true }).ok).toBe(true);

    const written = readFileSync(path, "utf8");
    expect(readCodexConfigError(path)).toBeUndefined();
    expect(written).not.toContain("[mcp_servers.worktable.http_headers]");
    expect(written).not.toContain("wt_old_secret");
    expect(written).toContain(`Authorization = "Bearer ${TARGET.token}"`);
    expect(written).toContain('[mcp_servers.other]\nurl = "https://other.test/mcp"');
  });

  it("restores exact bytes and mode after replacing an existing config", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    const original = Buffer.from('[mcp_servers.other]\nurl = "https://other.test"\n');
    writeFileSync(path, original);
    chmodSync(path, 0o640);

    const checked = preflightClient("codex", { replace: true });
    expect(checked.ok).toBe(true);
    expect(installClient("codex", TARGET).ok).toBe(true);
    expect(captureClientConfigMutation(checked.snapshot!).ok).toBe(true);
    expect(readFileSync(path)).not.toEqual(original);

    expect(restoreClientConfig(checked.snapshot!).ok).toBe(true);
    expect(readFileSync(path)).toEqual(original);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it("removes a config that the transaction created", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    const checked = preflightClient("codex", { replace: false });
    expect(checked.ok).toBe(true);
    expect(checked.snapshot?.existed).toBe(false);

    expect(installClient("codex", TARGET).ok).toBe(true);
    expect(captureClientConfigMutation(checked.snapshot!).ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(restoreClientConfig(checked.snapshot!).ok).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects a malformed MCP parent without rewriting it", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CURSOR_MCP_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    const original = Buffer.from('{"mcpServers":"not-an-object"}\n');
    writeFileSync(path, original);

    const checked = preflightClient("cursor", { replace: true });
    expect(checked.ok).toBe(false);
    expect(checked.message).toContain("non-object mcpServers");
    expect(readFileSync(path)).toEqual(original);
  });

  it("rejects a dangling config symlink without removing it", () => {
    const root = useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(join(root, "missing-config.toml"), path);

    const checked = preflightClient("codex", { replace: true });
    expect(checked.ok).toBe(false);
    expect(checked.message).toContain("no such file or directory");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it("rejects a regular config whose parent cannot support atomic replacement", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });
    const original = Buffer.from('[profile]\nmodel = "o4"\n');
    writeFileSync(path, original);
    chmodSync(path, 0o600);
    chmodSync(parent, 0o500);

    try {
      const checked = preflightClient("codex", { replace: true });
      expect(checked.ok).toBe(false);
      expect(readFileSync(path)).toEqual(original);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it("refuses to overwrite a config edited after the connector write", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    const checked = preflightClient("codex", { replace: false });
    expect(installClient("codex", TARGET).ok).toBe(true);
    expect(captureClientConfigMutation(checked.snapshot!).ok).toBe(true);

    writeFileSync(path, `${readFileSync(path, "utf8")}# concurrent edit\n`);
    const restored = restoreClientConfig(checked.snapshot!);
    expect(restored.ok).toBe(false);
    expect(restored.message).toContain("refusing to overwrite the newer edit");
    expect(readFileSync(path, "utf8")).toContain("# concurrent edit");
  });

  it("detects a config change between preflight and mutation", () => {
    useTempRuntime();
    const path = process.env["WORKTABLE_CODEX_CONFIG"]!;
    const checked = preflightClient("codex", { replace: false });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '[mcp_servers.other]\nurl = "https://new.test"\n');

    const current = validateClientConfigSnapshot(checked.snapshot!);
    expect(current.ok).toBe(false);
    expect(current.message).toContain("changed after preflight");
  });
});

describe("parseConnectorArgs", () => {
  it("accepts a bare code with --server, and normalizes the origin", () => {
    const args = parseConnectorArgs(["ABCDE-FGHJK", "--server", "https://wt.example.com/some/path"]);
    expect(args).toEqual({
      code: "ABCDE-FGHJK",
      origin: "https://wt.example.com",
      client: null,
      all: false,
      replace: false,
      oauth: false,
    });
  });

  it("accepts tokenless OAuth mode without a pairing code", () => {
    expect(
      parseConnectorArgs([
        "--oauth",
        "--server",
        "https://app.worktable.cloud/path",
        "--client",
        "codex",
      ])
    ).toEqual({
      code: null,
      origin: "https://app.worktable.cloud",
      client: "codex",
      all: false,
      replace: false,
      oauth: true,
    });
  });

  it("extracts origin and code from a full pairing URL", () => {
    const args = parseConnectorArgs(["https://wt.example.com/connect/ABCDE-FGHJK", "--client", "codex"]);
    expect(args.origin).toBe("https://wt.example.com");
    expect(args.code).toBe("ABCDE-FGHJK");
    expect(args.client).toBe("codex");
  });

  it("accepts explicit replacement", () => {
    const args = parseConnectorArgs(["ABCDE-FGHJK", "--server", "https://wt.example.com", "--replace"]);
    expect(args.replace).toBe(true);
  });

  it("rejects unknown clients, unknown flags, and a missing origin", () => {
    expect(() => parseConnectorArgs(["CODE", "--client", "emacs"])).toThrow(/Unknown client/);
    expect(() => parseConnectorArgs(["CODE", "--client", "claude-desktop"])).toThrow(/Unknown client/);
    expect(() => parseConnectorArgs(["CODE", "--frobnicate"])).toThrow(/Unknown flag/);
    expect(() => parseConnectorArgs(["CODE"])).toThrow(/No server origin/);
    expect(() => parseConnectorArgs(["CODE", "--client", "codex", "--all", "--server", "http://x"])).toThrow(
      /mutually exclusive/
    );
  });
});
