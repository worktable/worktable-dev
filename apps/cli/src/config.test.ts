import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyRuntimeConfig,
  bindHostFor,
  clientHostFor,
  clientOriginFor,
  ConfigCorruptError,
  createDefaultConfig,
  endpointFor,
  getConfigBackupPath,
  getConfigCorruptPath,
  getConfigPath,
  isLoopbackHost,
  loadConfigForRecreate,
  readConfig,
  writeConfig,
} from "./config.ts";
import { existsSync, readFileSync } from "node:fs";

const originalEnv = { ...process.env };
const tempRoots: string[] = [];

function useTempRuntime(): { appDir: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "worktable-cli-config-"));
  tempRoots.push(root);
  const appDir = join(root, "app");
  const workspace = join(root, "workspace");
  process.env["WORKTABLE_APP_DIR"] = appDir;
  process.env["WORKTABLE_WORKSPACE"] = workspace;
  return { appDir, workspace };
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical config", () => {
  it("creates the default local config shape (v2, loopback, not reachable)", () => {
    const { appDir, workspace } = useTempRuntime();

    const config = writeConfig(createDefaultConfig());

    expect(getConfigPath()).toBe(join(appDir, "config.json"));
    expect(config).toMatchObject({
      version: 2,
      workspace,
      service: {
        host: "127.0.0.1",
        port: 7480,
        startAtLogin: true,
        reachable: false,
      },
      mcp: { endpoint: "http://127.0.0.1:7480/mcp" },
    });
    expect(readConfig()).toEqual(config);
  });

  it("normalizes older or partial config files", () => {
    const { workspace } = useTempRuntime();

    writeConfig({
      version: 2,
      workspace,
      service: {
        host: "127.0.0.1",
        port: 7444,
        startAtLogin: false,
        reachable: false,
        exposureAcknowledged: false,
        httpsUpstream: false,
      },
      mcp: { endpoint: endpointFor("127.0.0.1", 7444), clients: {} },
    });

    const config = readConfig();
    expect(config.service.port).toBe(7444);
    expect(config.service.startAtLogin).toBe(false);
    expect(config.mcp.endpoint).toBe("http://127.0.0.1:7444/mcp");
  });

  it("derives MCP endpoint from the service host and port", () => {
    const { appDir, workspace } = useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        workspace,
        service: { host: "127.0.0.1", port: 7555, startAtLogin: true, reachable: false },
        mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
      })
    );

    const config = readConfig();

    expect(path).toBe(join(appDir, "config.json"));
    expect(config.mcp.endpoint).toBe("http://127.0.0.1:7555/mcp");
  });

  it("throws (never silently defaults to loopback) when config is corrupt with no backup", () => {
    useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{nope");

    // The old behavior — silently returning loopback defaults — WAS the silent
    // reachable-downgrade bug. A corrupt config with no recovery source must fail
    // loud so nothing persists loopback in place of a reachable install.
    expect(() => readConfig()).toThrow(ConfigCorruptError);
    // The unparseable bytes are preserved for inspection, not discarded.
    expect(existsSync(getConfigCorruptPath())).toBe(true);
    expect(readFileSync(getConfigCorruptPath(), "utf8")).toBe("{nope");
  });

  it("recovers a reachable config from the .bak backup when the primary is corrupt", () => {
    const { workspace } = useTempRuntime();
    // A durable reachable install: writeConfig lays down config.json...
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    // ...and a second write refreshes the .bak sidecar from that good file.
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    expect(existsSync(getConfigBackupPath())).toBe(true);

    // Simulate a truncated config.json after an unclean stop.
    writeFileSync(getConfigPath(), "");

    const recovered = readConfig();
    expect(recovered.service.host).toBe("0.0.0.0");
    expect(recovered.service.reachable).toBe(true);
    // Recovery re-persists, so the next read is clean with no throw.
    expect(readConfig().service.reachable).toBe(true);
  });

  it("recovers from .bak when the primary config.json is deleted (not a first run)", () => {
    const { workspace } = useTempRuntime();
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    // Delete the primary; the backup proves this was a real install, not first run.
    rmSync(getConfigPath());

    const recovered = readConfig();
    expect(recovered.service.reachable).toBe(true);
  });

  it("keeps a genuine first run (no config, no backup) on loopback defaults", () => {
    const { workspace } = useTempRuntime();
    const config = readConfig();
    expect(config.workspace).toBe(workspace);
    expect(config.service.reachable).toBe(false);
    expect(existsSync(getConfigBackupPath())).toBe(false);
  });

  it("does NOT resurrect a reachable bind after a deliberate downgrade to loopback", () => {
    const { workspace } = useTempRuntime();
    // Was reachable...
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    // ...then the user deliberately downgrades to loopback. The backup must now
    // mirror the loopback config, not the prior reachable one.
    writeConfig(createDefaultConfig({ workspace, service: { host: "127.0.0.1", reachable: false } }));

    // Primary lost after the downgrade.
    writeFileSync(getConfigPath(), "");
    const recovered = readConfig();
    // Recovery restores the LAST intent (loopback), never the stale reachable bind.
    expect(recovered.service.reachable).toBe(false);
    expect(recovered.service.host).toBe("127.0.0.1");
  });

  it("throws when the primary is missing and the backup is unparseable (not a first run)", () => {
    const { workspace } = useTempRuntime();
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    expect(existsSync(getConfigBackupPath())).toBe(true);
    // A configured install whose primary was deleted AND whose backup is damaged
    // must fail loud, not silently fall back to loopback defaults.
    writeFileSync(getConfigBackupPath(), "{ broken backup");
    rmSync(getConfigPath());
    expect(() => readConfig()).toThrow(ConfigCorruptError);
  });

  it("seeds the backup when a valid config is read and none exists yet (upgrade path)", () => {
    const { workspace } = useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    // A pre-fix reachable install: a valid config.json with no .bak sidecar.
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        workspace,
        service: {
          host: "0.0.0.0",
          port: 7480,
          startAtLogin: true,
          reachable: true,
          exposureAcknowledged: true,
          httpsUpstream: false,
        },
        mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
      })
    );
    expect(existsSync(getConfigBackupPath())).toBe(false);

    const config = readConfig();
    expect(config.service.reachable).toBe(true);
    // The read seeded the backup, so durability is active immediately — a
    // truncating reboot before any mutating write can still recover reachable.
    expect(existsSync(getConfigBackupPath())).toBe(true);
    writeFileSync(path, "");
    expect(readConfig().service.reachable).toBe(true);
  });

  it("recovers reachable from backup when the primary is valid JSON but empty ({})", () => {
    const { workspace } = useTempRuntime();
    // A durable reachable install — writeConfig lays down both primary and .bak.
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    expect(existsSync(getConfigBackupPath())).toBe(true);

    // A truncated/partial write that stays valid JSON but drops the real config.
    writeFileSync(getConfigPath(), "{}");
    const recovered = readConfig();
    // Must recover the reachable install, not accept the {}'s loopback defaults.
    expect(recovered.service.reachable).toBe(true);
    expect(recovered.service.host).toBe("0.0.0.0");
  });

  it("returns defaults (no throw) for an empty {} config when there is no backup", () => {
    const { workspace } = useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}");
    // Valid JSON, nothing to recover — normalize to defaults rather than hard-fail.
    const config = readConfig();
    expect(config.service.reachable).toBe(false);
    expect(config.workspace).toBe(workspace);
  });

  it("recovers from backup when the primary has only invalid service fields", () => {
    const { workspace } = useTempRuntime();
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    // A service object present but with an empty host and no port — normalizeConfig
    // would silently substitute loopback defaults, so it must be treated as unusable
    // and the reachable backup preferred instead.
    writeFileSync(getConfigPath(), JSON.stringify({ service: { host: "" } }));
    expect(readConfig().service.reachable).toBe(true);
  });

  it("recovers from backup for a port-only primary (host is the reachability determinant)", () => {
    const { workspace } = useTempRuntime();
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    // `{"service":{"port":7480}}` has a valid port but NO host — normalizeConfig
    // would fill DEFAULT_HOST/reachable=false, so it must be treated as unusable and
    // the reachable backup preferred rather than trusting a host-less primary.
    writeFileSync(getConfigPath(), JSON.stringify({ service: { port: 7480 } }));
    expect(readConfig().service.reachable).toBe(true);
  });

  it("recovers from backup for a service-only primary that is missing the workspace", () => {
    const { workspace } = useTempRuntime();
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    // Host + port present but NO workspace — normalizeConfig would silently move the
    // install to the DEFAULT workspace, so it must be treated as unusable and the
    // full last-good backup preferred.
    writeFileSync(getConfigPath(), JSON.stringify({ service: { host: "0.0.0.0", port: 7480 } }));
    const recovered = readConfig();
    expect(recovered.service.reachable).toBe(true);
    expect(recovered.workspace).toBe(workspace);
  });

  it("fails loud for an empty primary when a backup exists but is unusable", () => {
    const { workspace } = useTempRuntime();
    writeConfig(
      createDefaultConfig({
        workspace,
        service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
      })
    );
    // Configured install (backup present) whose backup is damaged AND primary is a
    // truncated-but-valid `{}` — recovery is impossible, so fail rather than default.
    writeFileSync(getConfigBackupPath(), "{ broken");
    writeFileSync(getConfigPath(), "{}");
    expect(() => readConfig()).toThrow(ConfigCorruptError);
  });

  it("refreshes a stale backup when the primary is valid (recovery uses current state)", () => {
    const { workspace } = useTempRuntime();
    // Current durable state: loopback.
    writeConfig(createDefaultConfig({ workspace, service: { host: "127.0.0.1", reachable: false } }));
    // Simulate a crash that left a STALE reachable backup (interrupted write).
    writeFileSync(
      getConfigBackupPath(),
      JSON.stringify(
        createDefaultConfig({
          workspace,
          service: { host: "0.0.0.0", reachable: true, exposureAcknowledged: true },
        }),
        null,
        2
      ) + "\n"
    );
    // Reading the valid loopback primary must resync the stale backup to loopback.
    expect(readConfig().service.reachable).toBe(false);
    // A later truncation then recovers loopback, NOT the stale reachable backup.
    writeFileSync(getConfigPath(), "");
    expect(readConfig().service.reachable).toBe(false);
  });

  it("loadConfigForRecreate returns defaults for a corrupt config WITHOUT persisting", () => {
    useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ corrupt");

    // setup uses this to recreate: it must recover in-memory defaults but NOT
    // write, so an abort during setup's later validation can't overwrite a
    // corrupt-but-present install with loopback defaults. `recreated` flags that the
    // defaults are not a trustworthy baseline of the running install.
    const { config, recreated } = loadConfigForRecreate();
    expect(config.service.reachable).toBe(false);
    expect(recreated).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("{ corrupt");
  });
});

describe("v1 → v2 migration", () => {
  it("treats an absent reachable field as false and preserves the loopback host", () => {
    const { workspace } = useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    // A genuine v1 config: no version stamp could even be v1, no reachable field.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        workspace,
        service: { host: "127.0.0.1", port: 7480, startAtLogin: true },
        mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
      })
    );

    const config = readConfig();
    expect(config.version).toBe(2);
    expect(config.service.reachable).toBe(false);
    expect(config.service.host).toBe("127.0.0.1");
  });

  it("preserves an explicitly reachable:true v2 config on read", () => {
    const { workspace } = useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        workspace,
        service: { host: "0.0.0.0", port: 7480, startAtLogin: true, reachable: true },
        mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
      })
    );

    const config = readConfig();
    expect(config.service.reachable).toBe(true);
    expect(config.service.host).toBe("0.0.0.0");
  });

  it("reconciles a drifted host=0.0.0.0 / reachable=false config to reachable on read", () => {
    const { workspace } = useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        workspace,
        service: { host: "0.0.0.0", port: 7480, startAtLogin: true, reachable: false },
        mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
      })
    );
    const config = readConfig();
    // A non-loopback bind IS reachable; the inconsistent reachable:false is healed
    // so exposure detection (token mint, auth gate) can't treat it as loopback-only.
    expect(config.service.reachable).toBe(true);
    // The local MCP endpoint targets a connectable address, not the wildcard.
    expect(config.mcp.endpoint).toBe("http://127.0.0.1:7480/mcp");
  });

  it("never infers exposureAcknowledged from a non-loopback host — it must be explicit", () => {
    const { workspace } = useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        workspace,
        service: { host: "0.0.0.0", port: 7480, startAtLogin: true, reachable: true },
        mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
      })
    );
    const config = readConfig();
    // reachable is reconciled from the host (for exposure DETECTION), but the
    // acknowledgement is NOT — a hand-edited host can't fake having acknowledged.
    expect(config.service.reachable).toBe(true);
    expect(config.service.exposureAcknowledged).toBe(false);
  });
});

describe("bind host helpers", () => {
  it("clientHostFor maps the bind wildcard to loopback, leaving routable hosts alone", () => {
    expect(clientHostFor("0.0.0.0")).toBe("127.0.0.1");
    expect(clientHostFor("::")).toBe("127.0.0.1");
    expect(clientHostFor("[::]")).toBe("127.0.0.1");
    expect(clientHostFor("127.0.0.1")).toBe("127.0.0.1");
    expect(clientHostFor("192.168.1.5")).toBe("192.168.1.5");
    expect(clientHostFor("  0.0.0.0 ")).toBe("127.0.0.1");
  });

  it("clientOriginFor brackets IPv6 destinations and maps wildcards to loopback", () => {
    expect(clientOriginFor("::1", 7480)).toBe("http://[::1]:7480");
    expect(clientOriginFor("[::1]", 7480)).toBe("http://[::1]:7480");
    expect(clientOriginFor("::", 7480)).toBe("http://127.0.0.1:7480");
  });

  it("endpointFor builds a connectable MCP url even for a 0.0.0.0 bind", () => {
    expect(endpointFor("0.0.0.0", 7480)).toBe("http://127.0.0.1:7480/mcp");
    expect(endpointFor("127.0.0.1", 7480)).toBe("http://127.0.0.1:7480/mcp");
    expect(endpointFor("192.168.1.5", 7480)).toBe("http://192.168.1.5:7480/mcp");
  });

  it("isLoopbackHost covers 127.0.0.1 / localhost / ::1 and rejects others", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LocalHost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("  127.0.0.1 ")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.5")).toBe(false);
  });

  it("bindHostFor honors an explicit override, else derives from reachable", () => {
    expect(bindHostFor(false)).toBe("127.0.0.1");
    expect(bindHostFor(true)).toBe("0.0.0.0");
    expect(bindHostFor(false, "192.168.1.5")).toBe("192.168.1.5");
    expect(bindHostFor(true, "10.0.0.1")).toBe("10.0.0.1");
    // An empty/whitespace override falls through to the reachable-derived host.
    expect(bindHostFor(true, "   ")).toBe("0.0.0.0");
  });
});

describe("applyRuntimeConfig exposure flag (keyed on host)", () => {
  it("overrides ambient runtime values from a non-loopback config", () => {
    const { appDir } = useTempRuntime();
    const configuredWorkspace = join(appDir, "configured-workspace");
    writeConfig(
      createDefaultConfig({
        workspace: configuredWorkspace,
        service: { host: "0.0.0.0", port: 9123, startAtLogin: true, reachable: true },
      })
    );
    process.env["WORKTABLE_WORKSPACE"] = join(appDir, "ambient-workspace");
    process.env["HOST"] = "192.0.2.44";
    process.env["PORT"] = "9122";
    delete process.env["WORKTABLE_REQUIRE_AUTH"];
    applyRuntimeConfig(readConfig());
    expect(process.env["WORKTABLE_REQUIRE_AUTH"]).toBe("1");
    expect(process.env["WORKTABLE_WORKSPACE"]).toBe(configuredWorkspace);
    expect(process.env["HOST"]).toBe("0.0.0.0");
    expect(process.env["PORT"]).toBe("9123");
  });

  it("deletes a stale WORKTABLE_REQUIRE_AUTH on a loopback bind", () => {
    useTempRuntime();
    // A stale value from a prior reachable run must not leak in-process.
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    applyRuntimeConfig(
      createDefaultConfig({
        service: { host: "127.0.0.1", port: 7480, startAtLogin: true, reachable: false },
      })
    );
    expect(process.env["WORKTABLE_REQUIRE_AUTH"]).toBeUndefined();
    expect(process.env["HOST"]).toBe("127.0.0.1");
  });
});

describe("httpsUpstream (reachability-notice suppression)", () => {
  it("defaults to false and round-trips through normalization", () => {
    useTempRuntime();
    expect(createDefaultConfig().service.httpsUpstream).toBe(false);
    // An older config file with no httpsUpstream field normalizes to false.
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        workspace: process.env["WORKTABLE_WORKSPACE"],
        service: { host: "0.0.0.0", port: 7480, startAtLogin: true, reachable: true },
        mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
      })
    );
    expect(readConfig().service.httpsUpstream).toBe(false);
  });

  it("is never inferred from the host — only an explicit value persists", () => {
    useTempRuntime();
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        workspace: process.env["WORKTABLE_WORKSPACE"],
        service: {
          host: "0.0.0.0",
          port: 7480,
          startAtLogin: true,
          reachable: true,
          httpsUpstream: true,
        },
        mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
      })
    );
    expect(readConfig().service.httpsUpstream).toBe(true);
  });

  it("applyRuntimeConfig sets WORKTABLE_TLS_UPSTREAM only when httpsUpstream is set", () => {
    useTempRuntime();
    process.env["WORKTABLE_TLS_UPSTREAM"] = "1"; // stale value must not leak
    applyRuntimeConfig(
      createDefaultConfig({
        service: { host: "0.0.0.0", port: 7480, startAtLogin: true, reachable: true },
      })
    );
    expect(process.env["WORKTABLE_TLS_UPSTREAM"]).toBeUndefined();

    applyRuntimeConfig(
      createDefaultConfig({
        service: {
          host: "0.0.0.0",
          port: 7480,
          startAtLogin: true,
          reachable: true,
          httpsUpstream: true,
        },
      })
    );
    expect(process.env["WORKTABLE_TLS_UPSTREAM"]).toBe("1");
  });
});
