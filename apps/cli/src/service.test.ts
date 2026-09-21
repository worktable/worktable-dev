import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createLocalRuntimeRecord,
  writeLocalRuntime,
} from "@worktable/server/runtime";
import { createDefaultConfig } from "./config.ts";
import {
  classifyManagedPidReadFailure,
  getServicePaths,
  getServiceStatus,
  getInstalledServicePublicUrl,
  installService,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveBackend,
  ServiceLifecycleError,
  setServiceHomeOverride,
  startService,
  stopService,
  uninstallService,
} from "./service.ts";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

function tempAppDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-svc-"));
  tempDirs.push(dir);
  process.env["WORKTABLE_APP_DIR"] = dir;
  return dir;
}

// Redirect the service home (used for the systemd unit / launchd plist paths) into
// a temp dir so an install in tests can NEVER touch the real ~/.config. This uses
// an explicit override, NOT $HOME: Bun's os.homedir() reads the initial environment
// and ignores a runtime process.env.HOME change, so setting HOME here would not
// isolate anything (and once let tests clobber a live install's unit).
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-home-"));
  tempDirs.push(dir);
  setServiceHomeOverride(dir);
  return dir;
}

// An empty PATH so systemctl/launchctl/loginctl/crontab can't be found — keeps
// tests off the real service managers and exercises graceful degradation.
function emptyPath(): void {
  const dir = mkdtempSync(join(tmpdir(), "wt-emptypath-"));
  tempDirs.push(dir);
  process.env["PATH"] = dir;
}

// A PATH containing ONLY a stub `systemctl` that exits 0 — simulates a reachable
// user manager (so installs may proceed) without ever touching the real systemd.
// loginctl/crontab stay absent, so linger/boot-persistence still degrade.
function stubSystemctlPath(): void {
  const dir = mkdtempSync(join(tmpdir(), "wt-stubbin-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env["PATH"] = dir;
}

afterEach(() => {
  process.env = { ...originalEnv };
  setServiceHomeOverride(null);
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("service file generation", () => {
  it("protects a live unreadable PID but clears one that disappeared", () => {
    expect(classifyManagedPidReadFailure(true)).toBe("unknown");
    expect(classifyManagedPidReadFailure(false)).toBe("foreign");
  });

  it("renders a user systemd unit with canonical runtime settings", () => {
    process.env["WORKTABLE_APP_DIR"] = "/tmp/worktable-app";
    process.env["WORKTABLE_RELEASE_DIR"] = "/tmp/worktable-release";
    process.env["WORKTABLE_STATIC_DIR"] = "/tmp/worktable-release/web";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: { host: "127.0.0.1", port: 7480, startAtLogin: true },
      mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
    });

    const unit = renderSystemdUnit(config, "/usr/local/bin/worktable");

    expect(unit).toContain(
      "ExecStart='/usr/local/bin/worktable' launch --foreground --no-browser"
    );
    expect(unit).toContain(
      "Environment=WORKTABLE_WORKSPACE='/tmp/worktable-workspace'"
    );
    expect(unit).toContain(
      "Environment=WORKTABLE_APP_DIR='/tmp/worktable-app'"
    );
    expect(unit).toContain("Environment=HOST='127.0.0.1'");
    expect(unit).toContain("Environment=PORT='7480'");
    expect(unit).toContain("Environment=WORKTABLE_LOCAL_OWNER='service'");
    expect(unit).toContain(
      "Environment=WORKTABLE_RELEASE_DIR='/tmp/worktable-release'"
    );
    expect(unit).toContain(
      "Environment=WORKTABLE_STATIC_DIR='/tmp/worktable-release/web'"
    );
    expect(unit).toContain(
      "StandardOutput=append:/tmp/worktable-app/logs/service.out.log"
    );
    expect(unit).toContain(
      "StandardError=append:/tmp/worktable-app/logs/service.err.log"
    );
    expect(unit).toContain("WantedBy=default.target");
  });

  it("carries HOST=0.0.0.0 and WORKTABLE_REQUIRE_AUTH=1 into a reachable systemd unit", () => {
    process.env["WORKTABLE_APP_DIR"] = "/tmp/worktable-app";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: {
        host: "0.0.0.0",
        port: 7480,
        startAtLogin: true,
        reachable: true,
      },
      mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
    });

    const unit = renderSystemdUnit(config, "/usr/local/bin/worktable");

    expect(unit).toContain("Environment=HOST='0.0.0.0'");
    expect(unit).toContain("Environment=WORKTABLE_REQUIRE_AUTH='1'");
  });

  it("carries HOST=0.0.0.0 and WORKTABLE_REQUIRE_AUTH=1 into a reachable launchd plist", () => {
    process.env["WORKTABLE_APP_DIR"] = "/tmp/worktable-app";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: {
        host: "0.0.0.0",
        port: 7480,
        startAtLogin: true,
        reachable: true,
      },
      mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
    });

    const plist = renderLaunchdPlist(config, "/usr/local/bin/worktable");

    expect(plist).toContain("<key>HOST</key>");
    expect(plist).toContain("<string>0.0.0.0</string>");
    expect(plist).toContain("<key>WORKTABLE_REQUIRE_AUTH</key>");
    expect(plist).toContain("<string>1</string>");
  });

  it("carries WORKTABLE_PUBLIC_URL into managed service environments", () => {
    process.env["WORKTABLE_APP_DIR"] = "/tmp/worktable-app";
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: {
        host: "127.0.0.1",
        port: 7480,
        startAtLogin: true,
        reachable: false,
      },
      mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
    });

    const unit = renderSystemdUnit(config, "/usr/local/bin/worktable");
    const plist = renderLaunchdPlist(config, "/usr/local/bin/worktable");

    expect(unit).toContain(
      "Environment=WORKTABLE_PUBLIC_URL='https://worktable.example.com'"
    );
    expect(plist).toContain("<key>WORKTABLE_PUBLIC_URL</key>");
    expect(plist).toContain("<string>https://worktable.example.com</string>");
  });

  it("renders an explicit authority handoff without requiring ambient env", () => {
    process.env["WORKTABLE_APP_DIR"] = "/tmp/worktable-app";
    delete process.env["WORKTABLE_PUBLIC_URL"];
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
    });
    const options = {
      publicUrl: "https://preserved.example.com",
      authorityHandoff: '{"pid":42,"nonce":"handoff-nonce-for-test"}',
    };
    const unit = renderSystemdUnit(config, "/usr/local/bin/worktable", options);
    const plist = renderLaunchdPlist(
      config,
      "/usr/local/bin/worktable",
      options
    );
    expect(unit).toContain(
      "Environment=WORKTABLE_PUBLIC_URL='https://preserved.example.com'"
    );
    expect(unit).toContain("Environment=WORKTABLE_LOCAL_AUTHORITY_HANDOFF=");
    expect(plist).toContain("<key>WORKTABLE_LOCAL_AUTHORITY_HANDOFF</key>");
  });

  it("carries WORKTABLE_TLS_UPSTREAM=1 into a reachable unit only when httpsUpstream is set", () => {
    process.env["WORKTABLE_APP_DIR"] = "/tmp/worktable-app";
    const without = renderSystemdUnit(
      createDefaultConfig({
        workspace: "/tmp/worktable-workspace",
        service: {
          host: "0.0.0.0",
          port: 7480,
          startAtLogin: true,
          reachable: true,
        },
        mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
      }),
      "/usr/local/bin/worktable"
    );
    expect(without).not.toContain("WORKTABLE_TLS_UPSTREAM");

    const withAck = renderSystemdUnit(
      createDefaultConfig({
        workspace: "/tmp/worktable-workspace",
        service: {
          host: "0.0.0.0",
          port: 7480,
          startAtLogin: true,
          reachable: true,
          httpsUpstream: true,
        },
        mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
      }),
      "/usr/local/bin/worktable"
    );
    expect(withAck).toContain("Environment=WORKTABLE_TLS_UPSTREAM='1'");
  });

  it("omits WORKTABLE_REQUIRE_AUTH from a loopback systemd unit (byte-for-byte today)", () => {
    process.env["WORKTABLE_APP_DIR"] = "/tmp/worktable-app";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: {
        host: "127.0.0.1",
        port: 7480,
        startAtLogin: true,
        reachable: false,
      },
      mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
    });

    const unit = renderSystemdUnit(config, "/usr/local/bin/worktable");
    expect(unit).not.toContain("WORKTABLE_REQUIRE_AUTH");
  });

  it("renders a launchd user agent without exposing a LAN host", () => {
    process.env["WORKTABLE_APP_DIR"] = "/tmp/worktable-app";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: { host: "127.0.0.1", port: 7480, startAtLogin: true },
      mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
    });

    const plist = renderLaunchdPlist(config, "/usr/local/bin/worktable");

    expect(plist).toContain("<string>/usr/local/bin/worktable</string>");
    expect(plist).toContain("<string>launch</string>");
    expect(plist).toContain("<key>HOST</key>");
    expect(plist).toContain("<string>127.0.0.1</string>");
    expect(plist).toContain("<key>WORKTABLE_APP_DIR</key>");
    expect(plist).toContain("<string>/tmp/worktable-app</string>");
    expect(plist).toContain(
      "<string>/tmp/worktable-app/logs/service.out.log</string>"
    );
    expect(plist).toContain(
      "<string>/tmp/worktable-app/logs/service.err.log</string>"
    );
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
  });
});

describe("backend detection", () => {
  it("reads a preserved public URL from an installed launchd artifact", () => {
    tempAppDir();
    tempHome();
    emptyPath();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "launchd";
    delete process.env["WORKTABLE_PUBLIC_URL"];
    installService(createDefaultConfig(), {
      publicUrl: "https://preserved.example.com",
    });
    expect(getInstalledServicePublicUrl()).toBe(
      "https://preserved.example.com"
    );
  });

  it("refuses to start a service beside a Desktop-owned local host", () => {
    const appDir = tempAppDir();
    tempHome();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    writeLocalRuntime(
      createLocalRuntimeRecord({
        owner: "desktop",
        installId: "ins_test",
        workspaceId: "ws_desktop",
        workspacePath: join(appDir, "workspace"),
        host: "127.0.0.1",
        port: 17480,
      })
    );
    expect(() => startService()).toThrow(
      "Worktable Desktop already owns the local endpoint"
    );
  });

  it("does not let a recycled runtime PID block service startup", () => {
    const appDir = tempAppDir();
    tempHome();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    writeLocalRuntime(
      createLocalRuntimeRecord({
        owner: "desktop",
        installId: "ins_stale",
        workspaceId: "ws_stale",
        workspacePath: join(appDir, "workspace"),
        host: "127.0.0.1",
        port: 17480,
        ownerIdentity: "not-the-current-process-start",
      })
    );

    expect(startService().state).toBe("not-installed");
  });

  it("honors the WORKTABLE_SERVICE_BACKEND override", () => {
    const appDir = tempAppDir();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    const paths = getServicePaths();
    expect(paths.platform).toBe("process");
    expect(paths.file).toBe(join(appDir, "managed-service.json"));
  });

  it("falls back to the managed-process backend when systemd is unavailable", () => {
    if (process.platform !== "linux") return;
    tempAppDir();
    // Isolate HOME so a real/leftover systemd unit on the dev box isn't adopted —
    // this test is about detection with NO existing artifacts.
    tempHome();
    // An empty PATH means systemctl can't be found, so a real Linux box with no
    // reachable user manager degrades instead of pretending to be systemd.
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "wt-emptypath-"));
    tempDirs.push(process.env["PATH"]);
    expect(getServicePaths().platform).toBe("process");
  });
});

describe("managed-process service backend", () => {
  it("persists the effective ambient public URL in the managed marker", () => {
    tempAppDir();
    tempHome();
    emptyPath();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    process.env["WORKTABLE_PUBLIC_URL"] = "https://ambient.example.com";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: { startAtLogin: false },
    });
    installService(config);
    delete process.env["WORKTABLE_PUBLIC_URL"];
    expect(getInstalledServicePublicUrl()).toBe("https://ambient.example.com");
  });

  it("preserves a public URL in the installed service artifact", () => {
    tempAppDir();
    tempHome();
    emptyPath();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    delete process.env["WORKTABLE_PUBLIC_URL"];
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: { startAtLogin: false },
    });
    installService(config, { publicUrl: "https://preserved.example.com" });
    expect(getInstalledServicePublicUrl()).toBe(
      "https://preserved.example.com"
    );
  });

  it("installs and uninstalls without a service manager and never crashes on missing binaries", () => {
    const appDir = tempAppDir();
    tempHome(); // isolate from any real systemd unit on this box (competing-backend cleanup)
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    // No systemctl/launchctl on PATH — the original bug threw a fatal error here.
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "wt-emptypath-"));
    tempDirs.push(process.env["PATH"]);
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      // startAtLogin: false so the test never touches the real crontab.
      service: { host: "127.0.0.1", port: 7480, startAtLogin: false },
      mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
    });

    const installed = installService(config);
    expect(installed.platform).toBe("process");
    expect(installed.installed).toBe(true);
    expect(installed.state).toBe("stopped");
    expect(installed.startsAtLogin).toBe(false);
    expect(existsSync(join(appDir, "managed-service.json"))).toBe(true);

    expect(getServiceStatus().state).toBe("stopped");

    const removed = uninstallService();
    expect(removed.installed).toBe(false);
    expect(removed.state).toBe("not-installed");
    expect(existsSync(join(appDir, "managed-service.json"))).toBe(false);
  });

  it("persists the chosen backend so a later systemctl-less session can't switch it", () => {
    if (process.platform !== "linux") return;
    const appDir = tempAppDir();
    tempHome();
    // Install with a REACHABLE (stubbed) manager — a degraded-session install is
    // now refused by the preflight, so persistence must be established here.
    stubSystemctlPath();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "systemd";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: {
        host: "0.0.0.0",
        port: 7480,
        startAtLogin: true,
        reachable: true,
      },
      mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
    });
    const installed = installService(config);
    expect(installed.platform).toBe("systemd");
    const state = JSON.parse(
      readFileSync(join(appDir, "service-state.json"), "utf8")
    );
    expect(state.backend).toBe("systemd");

    // Now a DEGRADED session with NO override and no systemctl on PATH: detection
    // alone would pick "process", but the persisted choice must win so the install
    // doesn't silently switch backends (and lose reachability).
    delete process.env["WORKTABLE_SERVICE_BACKEND"];
    emptyPath();
    expect(resolveBackend()).toBe("systemd");
    expect(getServicePaths().platform).toBe("systemd");
  });

  it("cleans up a competing backend's artifacts on install (no split-brain)", () => {
    if (process.platform !== "linux") return;
    const appDir = tempAppDir();
    tempHome();
    stubSystemctlPath(); // reachable manager; the degraded case is refused by preflight
    // Seed a stray managed-process marker (the incident's leftover backend).
    const marker = join(appDir, "managed-service.json");
    writeFileSync(marker, "{}\n");

    process.env["WORKTABLE_SERVICE_BACKEND"] = "systemd";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: {
        host: "0.0.0.0",
        port: 7480,
        startAtLogin: true,
        reachable: true,
      },
      mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
    });
    installService(config);

    // The competing process-backend marker is gone; only systemd remains.
    expect(existsSync(marker)).toBe(false);
    expect(getServicePaths().platform).toBe("systemd");
  });

  it("warns about split-brain when more than one backend's artifacts coexist", () => {
    if (process.platform !== "linux") return;
    const appDir = tempAppDir();
    const home = tempHome();
    emptyPath();
    // Two backends present at once, created out-of-band: a systemd unit AND a
    // managed-process marker.
    const unit = join(home, ".config", "systemd", "user", "worktable.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Unit]\n");
    writeFileSync(join(appDir, "managed-service.json"), "{}\n");

    const status = getServiceStatus();
    expect(status.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Multiple service backends are installed"),
      ])
    );
  });

  it("prefers systemd over process in a degraded split-brain install (never deletes the unit)", () => {
    if (process.platform !== "linux") return;
    const appDir = tempAppDir();
    const home = tempHome();
    emptyPath(); // no systemctl → detection alone would pick process
    // Upgrade with split-brain: a real systemd unit AND a stale process marker,
    // no persisted choice.
    const unit = join(home, ".config", "systemd", "user", "worktable.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Unit]\nDescription=Worktable\n");
    writeFileSync(join(appDir, "managed-service.json"), "{}\n");

    // Manager backend wins over the portable fallback (asserted while degraded).
    expect(resolveBackend()).toBe("systemd");

    // Consolidating install (manager now reachable via stub) must remove the stale
    // process marker but PRESERVE the boot-durable systemd unit.
    stubSystemctlPath();
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: {
        host: "0.0.0.0",
        port: 7480,
        startAtLogin: true,
        reachable: true,
      },
      mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
    });
    installService(config);
    expect(existsSync(unit)).toBe(true);
    expect(existsSync(join(appDir, "managed-service.json"))).toBe(false);
  });

  it("ignores a platform-invalid artifact when adopting (stale launchd plist on Linux)", () => {
    if (process.platform !== "linux") return;
    const home = tempHome();
    tempAppDir();
    emptyPath();
    // A stale macOS launchd plist AND a real systemd unit on a Linux box.
    const plist = join(
      home,
      "Library",
      "LaunchAgents",
      "dev.worktable.local.plist"
    );
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist/>");
    const unit = join(home, ".config", "systemd", "user", "worktable.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Unit]\n");
    // launchd can't run here, so it must be ignored; systemd is adopted.
    expect(resolveBackend()).toBe("systemd");
  });

  it("does not delete a systemd unit when it can't be stopped (degraded session)", () => {
    if (process.platform !== "linux") return;
    const home = tempHome();
    tempAppDir();
    emptyPath(); // no systemctl → stop can't confirm the service is down
    process.env["WORKTABLE_SERVICE_BACKEND"] = "systemd";
    const unit = join(home, ".config", "systemd", "user", "worktable.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Unit]\n");

    // Throws (incomplete teardown) AND preserves the unit: a live service could
    // still hold the port, so it must stay visible/stoppable from a proper session.
    expect(() => uninstallService()).toThrow(ServiceLifecycleError);
    expect(existsSync(unit)).toBe(true);
  });

  it("reports the linger gap when systemd auto-start can't be made boot-durable", () => {
    if (process.platform !== "linux") return;
    tempAppDir();
    tempHome();
    stubSystemctlPath(); // manager reachable, but loginctl absent → lingering can't be enabled
    process.env["WORKTABLE_SERVICE_BACKEND"] = "systemd";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: {
        host: "0.0.0.0",
        port: 7480,
        startAtLogin: true,
        reachable: true,
      },
      mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
    });
    const status = installService(config);
    expect(status.message ?? "").toContain("lingering could not be enabled");
  });

  it("reports unknown (not stopped) when systemctl can't answer for a persisted systemd backend", () => {
    if (process.platform !== "linux") return;
    tempAppDir();
    const home = tempHome();
    emptyPath(); // no systemctl on PATH → the query can't be answered
    process.env["WORKTABLE_SERVICE_BACKEND"] = "systemd";
    // An existing systemd install (unit on disk), queried from a degraded session.
    // (Written by hand: a degraded-session install is now refused by preflight.)
    const unit = join(home, ".config", "systemd", "user", "worktable.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Unit]\nDescription=Worktable\n");

    const status = getServiceStatus();
    expect(status.installed).toBe(true);
    // A running-but-unqueryable enabled service must not be reported as stopped.
    expect(status.state).toBe("unknown");
    expect(status.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining("state is unknown")])
    );
  });

  it("adopts an existing systemd unit instead of misdetecting process in a degraded session (upgrade path)", () => {
    if (process.platform !== "linux") return;
    const appDir = tempAppDir();
    const home = tempHome();
    emptyPath(); // no systemctl → detection alone would resolve to "process"
    // An install predating this change: a systemd unit on disk, no service-state.json.
    const unit = join(home, ".config", "systemd", "user", "worktable.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Unit]\nDescription=Worktable\n");

    // Adopt the on-disk backend rather than re-detecting a different one.
    expect(resolveBackend()).toBe("systemd");

    // A DEGRADED-session install now REFUSES (the manager can't reload/enable), and
    // must not tear the real systemd unit down or create a process backend.
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: {
        host: "0.0.0.0",
        port: 7480,
        startAtLogin: true,
        reachable: true,
      },
      mcp: { endpoint: "http://0.0.0.0:7480/mcp", clients: {} },
    });
    expect(() => installService(config)).toThrow(ServiceLifecycleError);
    expect(existsSync(unit)).toBe(true); // preserved, not destroyed
    expect(existsSync(join(appDir, "managed-service.json"))).toBe(false); // no process backend

    // From a full session (stubbed manager), the same install succeeds and persists
    // the adopted backend.
    stubSystemctlPath();
    installService(config);
    expect(existsSync(unit)).toBe(true);
    const state = JSON.parse(
      readFileSync(join(appDir, "service-state.json"), "utf8")
    );
    expect(state.backend).toBe("systemd");
  });

  it("ignores a persisted backend whose artifact is missing (interrupted install)", () => {
    if (process.platform !== "linux") return;
    const appDir = tempAppDir();
    tempHome();
    // service-state.json says systemd, but no unit exists (crash before unit write);
    // a leftover process marker is the only real artifact.
    writeFileSync(
      join(appDir, "service-state.json"),
      JSON.stringify({ backend: "systemd" })
    );
    writeFileSync(join(appDir, "managed-service.json"), "{}\n");
    // The persisted-but-artifactless systemd choice is ignored; the real one wins.
    expect(resolveBackend()).toBe("process");
  });

  it("refuses to install a backend when a competing one can't be torn down", () => {
    if (process.platform !== "linux") return;
    const home = tempHome();
    const appDir = tempAppDir();
    emptyPath(); // no systemctl → the competing systemd unit can't be stopped
    // A competing systemd unit exists; we try to install the process backend.
    const unit = join(home, ".config", "systemd", "user", "worktable.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Unit]\n");
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: { host: "127.0.0.1", port: 7480, startAtLogin: false },
      mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
    });

    // THROWS (not a status note): no caller can proceed past a failed install. No
    // process marker written, the competing unit preserved — no split-brain created.
    expect(() => installService(config)).toThrow(ServiceLifecycleError);
    expect(existsSync(join(appDir, "managed-service.json"))).toBe(false);
    expect(existsSync(unit)).toBe(true);
  });

  it("uninstallService reports incompletion when a unit can't be removed", () => {
    if (process.platform !== "linux") return;
    const home = tempHome();
    tempAppDir();
    emptyPath(); // no systemctl → stop can't confirm the service is down
    process.env["WORKTABLE_SERVICE_BACKEND"] = "systemd";
    const unit = join(home, ".config", "systemd", "user", "worktable.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Unit]\n");

    // THROWS: commandUninstall aborts before deleting launchers/app dir; the unit
    // is preserved (not orphaned) for a full-session retry.
    expect(() => uninstallService()).toThrow(ServiceLifecycleError);
    expect(existsSync(unit)).toBe(true);
  });

  it("reports stopped (not running) when the pid file points at an unrelated live process", () => {
    if (process.platform !== "linux") return; // /proc-based identity check is Linux-only
    const appDir = tempAppDir();
    tempHome();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    writeFileSync(join(appDir, "managed-service.json"), "{}\n");
    // A live process that is NOT our managed child, on a recycled PID.
    const victim = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      writeFileSync(join(appDir, "service.pid"), String(victim.pid));
      // Status must not claim a running Worktable that was never spawned.
      expect(getServiceStatus().state).toBe("stopped");
    } finally {
      victim.kill();
    }
  });

  it("does not kill an unrelated process when the pid file is stale/recycled", () => {
    if (process.platform !== "linux") return; // /proc-based identity check is Linux-only
    const appDir = tempAppDir();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    writeFileSync(join(appDir, "managed-service.json"), "{}\n");
    // A live process that is NOT our managed child (no WORKTABLE_MANAGED_PID_FILE).
    const victim = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      writeFileSync(join(appDir, "service.pid"), String(victim.pid));
      stopService(); // process backend → stopManagedProcess
      let alive = true;
      try {
        process.kill(victim.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(true); // the recycled/unrelated PID must be left alone
    } finally {
      victim.kill();
    }
  });

  it("does not start a managed process when it was never installed", () => {
    const appDir = tempAppDir();
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "wt-emptypath-"));
    tempDirs.push(process.env["PATH"]);

    const status = startService();
    expect(status.state).toBe("not-installed");
    expect(existsSync(join(appDir, "service.pid"))).toBe(false);
  });

  it("keeps the marker, status, and message consistent when boot persistence is unavailable", () => {
    const appDir = tempAppDir();
    tempHome(); // isolate from any real systemd unit on this box (competing-backend cleanup)
    process.env["WORKTABLE_SERVICE_BACKEND"] = "process";
    // No crontab on PATH, so boot persistence can't be configured.
    process.env["PATH"] = mkdtempSync(join(tmpdir(), "wt-emptypath-"));
    tempDirs.push(process.env["PATH"]);
    const config = createDefaultConfig({
      workspace: "/tmp/worktable-workspace",
      service: { host: "127.0.0.1", port: 7480, startAtLogin: true },
      mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
    });

    const status = installService(config);
    // Status reflects reality: boot persistence was not achieved.
    expect(status.startsAtLogin).toBe(false);
    // Message must not claim the service is already running.
    expect(status.message).toContain("auto-start at boot is unavailable");
    expect(status.message).not.toContain("runs now");
    // The marker stores the achieved state, not the requested flag.
    const marker = JSON.parse(
      readFileSync(join(appDir, "managed-service.json"), "utf8")
    );
    expect(marker.startAtLogin).toBe(false);
  });
});
