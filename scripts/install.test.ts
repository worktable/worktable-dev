import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

function mapTarget(os: string, arch: string): { exitCode: number; stdout: string; stderr: string } {
  const result = runInstall(["sh", "scripts/install.sh"], os, arch, {
    WORKTABLE_TEST_MAP_ONLY: "1",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function runInstall(
  cmd: string[],
  os = "Linux",
  arch = "x86_64",
  env: Record<string, string> = {}
): { exitCode: number; stdout: Buffer; stderr: Buffer } {
  const result = Bun.spawnSync(cmd, {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      WORKTABLE_TEST_OS: os,
      WORKTABLE_TEST_ARCH: arch,
      ...env,
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("install.sh target mapping", () => {
  it("maps Apple Silicon Macs", () => {
    expect(mapTarget("Darwin", "arm64")).toMatchObject({
      exitCode: 0,
      stdout: "worktable-darwin-arm64.tar.gz",
    });
  });

  it("maps Intel Macs", () => {
    expect(mapTarget("Darwin", "x86_64")).toMatchObject({
      exitCode: 0,
      stdout: "worktable-darwin-x64.tar.gz",
    });
  });

  it("maps Linux x64", () => {
    expect(mapTarget("Linux", "x86_64")).toMatchObject({
      exitCode: 0,
      stdout: "worktable-linux-x64.tar.gz",
    });
  });

  it("maps Linux arm64", () => {
    expect(mapTarget("Linux", "aarch64")).toMatchObject({
      exitCode: 0,
      stdout: "worktable-linux-arm64.tar.gz",
    });
    expect(mapTarget("Linux", "arm64")).toMatchObject({
      exitCode: 0,
      stdout: "worktable-linux-arm64.tar.gz",
    });
  });

  it("rejects unsupported operating systems", () => {
    const result = mapTarget("FreeBSD", "x86_64");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not yet provide");
  });

  it("rejects unsupported architectures", () => {
    const result = mapTarget("Linux", "riscv64");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not yet provide");
  });
});

describe("install.sh flags", () => {
  it("passes POSIX shell syntax validation", () => {
    const result = runInstall(["sh", "-n", "scripts/install.sh"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  it("reattaches only stdin to /dev/tty for piped setup, leaving stdout/stderr inherited", () => {
    // Reattaching stdout/stderr to a reopened /dev/tty makes the Bun-compiled
    // binary build a TTY WriteStream that crashes on macOS (EINVAL kqueue), so
    // piped setup restores stdin only and leaves stdout/stderr inherited.
    const script = readFileSync("scripts/install.sh", "utf8");
    expect(script).toContain('"$launcher" "$@" < /dev/tty');
    expect(script).not.toContain("> /dev/tty");
  });

  it("prints help", () => {
    const result = runInstall(["sh", "scripts/install.sh", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("--install-dir");
    expect(result.stdout.toString()).toContain("--app-dir");
  });

  it("resolves CLI flags in dry-run mode", () => {
    const result = runInstall([
      "sh",
      "scripts/install.sh",
      "--dry-run",
      "--yes",
      "--no-setup",
      "--background",
      "--workspace",
      "/tmp/worktable workspace",
      "--port",
      "7444",
      "--host",
      "127.0.0.1",
      "--mcp",
      "codex,cursor",
      "--install-dir",
      "/tmp/worktable-bin",
      "--app-dir",
      "/tmp/worktable-app",
      "--version",
      "v1.2.3",
      "--release-base-url",
      "https://example.com/releases",
    ]);

    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Artifact: worktable-linux-x64.tar.gz");
    expect(stdout).toContain("Version: v1.2.3");
    expect(stdout).toContain("Release base URL: https://example.com/releases");
    expect(stdout).toContain("Download URL: https://example.com/releases/v1.2.3/worktable-linux-x64.tar.gz");
    expect(stdout).toContain("App-private dir: /tmp/worktable-app");
    expect(stdout).toContain("Install dir: /tmp/worktable-bin");
    expect(stdout).toContain("Run setup: no");
    expect(stdout).toContain("Setup mode: background");
    expect(stdout).toContain("Workspace: /tmp/worktable workspace");
    expect(stdout).toContain("Host: 127.0.0.1");
    expect(stdout).toContain("Port: 7444");
    expect(stdout).toContain("MCP clients: codex,cursor");
  });

  it("lets flags override environment variables", () => {
    const result = runInstall(
      [
        "sh",
        "scripts/install.sh",
        "--dry-run",
        "--install-dir",
        "/tmp/flag-bin",
        "--app-dir",
        "/tmp/flag-app",
      ],
      "Linux",
      "x86_64",
      {
        WORKTABLE_INSTALL_DIR: "/tmp/env-bin",
        WORKTABLE_APP_DIR: "/tmp/env-app",
      }
    );

    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Install dir: /tmp/flag-bin");
    expect(stdout).toContain("App-private dir: /tmp/flag-app");
    expect(stdout).not.toContain("/tmp/env-bin");
    expect(stdout).not.toContain("/tmp/env-app");
  });

  it("defaults Linux app-private data to XDG config home", () => {
    const result = runInstall(
      ["sh", "scripts/install.sh", "--dry-run"],
      "Linux",
      "x86_64",
      {
        HOME: "/tmp/worktable-home",
        XDG_CONFIG_HOME: "/tmp/worktable-xdg-config",
        WORKTABLE_APP_DIR: "",
      }
    );

    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("App-private dir: /tmp/worktable-xdg-config/worktable");
  });

  it("rejects unknown options", () => {
    const result = runInstall(["sh", "scripts/install.sh", "--wat"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Unknown option: --wat");
  });

  it("rejects missing option values", () => {
    const result = runInstall(["sh", "scripts/install.sh", "--install-dir"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--install-dir requires");
  });
});
