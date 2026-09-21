import { afterAll, describe, expect, it } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createLocalRuntimeRecord,
  LOCAL_PROOF_HEADER,
  writeLocalRuntime,
} from "@worktable/server/runtime"
import {
  SETUP_INTERACTIVE_TERMINAL_REQUIRED_MESSAGE,
  assertExclusiveRunMode,
  clientsToDeselect,
  describeWorkspaceClassification,
  normalizeWorkspaceAnswer,
  preprocessArgv,
  sameVersion,
  shouldShowUpdateNudge,
  updateTargetForInstall,
  waitForExactLocalRuntime,
} from "./index.ts"
import { cliTestEnvironment, createCliTestWorker } from "./cli-test-harness.ts"
import { colorEnabled, UsageError } from "./style.ts"

// A throwaway HOME for every CLI subprocess so a command that installs a service
// can NEVER write the real user's ~/.config/systemd/user/worktable.service. Bun's
// os.homedir() reads the subprocess's initial environment, so passing HOME here does
// isolate it (unlike an in-process runtime change). Individual tests can still
// override HOME via the env arg.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "wt-cli-home-"))
const CLI_TEST_WORKER = createCliTestWorker(ISOLATED_HOME)

afterAll(async () => {
  await CLI_TEST_WORKER.close()
  rmSync(ISOLATED_HOME, { recursive: true, force: true })
})

type CliResult = { stdout: string; stderr: string; exitCode: number }

interface ServiceRuntimeProof {
  owner?: unknown
  workspacePath?: unknown
  host?: unknown
  port?: unknown
  proofToken?: unknown
}

function cliSubprocessEnv(
  overrides: Record<string, string>
): Record<string, string> {
  return cliTestEnvironment(ISOLATED_HOME, overrides)
}

function expectCliSuccess(result: CliResult, context: string): void {
  if (result.exitCode === 0) return
  throw new Error(
    `${context} exited ${result.exitCode}\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`
  )
}

// Fresh setup/launch subprocesses must not probe the product's real default
// port. A developer commonly has Worktable running on 7480 while testing; that
// host is unrelated to the isolated HOME/workspace/app directories and must not
// make the test process reject setup as a foreign local authority.
function isolateFreshCliPort(
  args: string[],
  env: Record<string, string>
): string[] {
  if (
    (args[0] !== "setup" && args[0] !== "launch") ||
    args.includes("--port") ||
    !env.WORKTABLE_APP_DIR ||
    existsSync(join(env.WORKTABLE_APP_DIR, "config.json"))
  ) {
    return args
  }

  const reservation = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("temporary CLI test port reservation"),
  })
  const port = reservation.port
  reservation.stop(true)
  if (port === undefined) throw new Error("Could not allocate a CLI test port")
  return [...args, "--port", String(port)]
}

// Run the real CLI as a subprocess against an isolated workspace/app dir.
function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  if (requiresFreshCliRuntime(args, env)) return runCliSubprocess(args, env)
  return CLI_TEST_WORKER.run(isolateFreshCliPort(args, env), env)
}

function requiresFreshCliRuntime(
  args: string[],
  env: Record<string, string>
): boolean {
  return (
    env.WORKTABLE_VERSION !== undefined ||
    (env.WORKTABLE_SERVICE_BACKEND === "process" &&
      ["launch", "service", "update", "local-host"].includes(
        args[0] ?? "launch"
      )) ||
    (env.HOME !== undefined &&
      env.HOME !== ISOLATED_HOME &&
      env.WORKTABLE_WORKSPACE === undefined)
  )
}

function runCliSubprocess(
  args: string[],
  env: Record<string, string> = {}
): CliResult {
  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      join(import.meta.dir, "index.ts"),
      ...isolateFreshCliPort(args, env),
    ],
    {
      env: cliSubprocessEnv(env),
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }
}

async function waitForServiceAuthority(
  appDir: string,
  workspace: string
): Promise<ServiceRuntimeProof> {
  const runtimePath = join(appDir, "local-runtime.json")
  const deadline = Date.now() + 8_000
  let diagnostic = "runtime record has not been published"
  while (Date.now() < deadline) {
    if (existsSync(runtimePath)) {
      try {
        const runtime = JSON.parse(
          readFileSync(runtimePath, "utf8")
        ) as ServiceRuntimeProof
        diagnostic = JSON.stringify(runtime)
        if (
          runtime.owner === "service" &&
          runtime.workspacePath === workspace &&
          typeof runtime.host === "string" &&
          typeof runtime.port === "number" &&
          typeof runtime.proofToken === "string"
        ) {
          const response = await fetch(
            `http://${runtime.host}:${runtime.port}/health`,
            {
              headers: {
                "X-Worktable-Local-Proof": runtime.proofToken,
              },
              signal: AbortSignal.timeout(500),
            }
          ).catch(() => null)
          if (
            response?.ok &&
            response.headers.get("X-Worktable-Local-Proof") === "verified"
          ) {
            return runtime
          }
          diagnostic = `${diagnostic}; health proof was not ready`
        }
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : String(error)
      }
    }
    // test-policy: external-readiness-backoff
    await Bun.sleep(50)
  }
  throw new Error(
    `Timed out waiting for the managed service authority: ${diagnostic}`
  )
}

// Async variant for tests that also run an in-process HTTP server (the local
// release host): spawnSync would block the event loop and the server could
// never answer the subprocess, so those tests must await instead.
async function runCliAsync(
  args: string[],
  env: Record<string, string> = {}
): Promise<CliResult> {
  if (requiresFreshCliRuntime(args, env))
    return runCliSubprocessAsync(args, env)
  return CLI_TEST_WORKER.runAsync(isolateFreshCliPort(args, env), env)
}

async function runCliSubprocessAsync(
  args: string[],
  env: Record<string, string> = {}
): Promise<CliResult> {
  const child = Bun.spawn(
    [
      "bun",
      "run",
      join(import.meta.dir, "index.ts"),
      ...isolateFreshCliPort(args, env),
    ],
    {
      env: cliSubprocessEnv(env),
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

function withTempEnv(): { env: Record<string, string>; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), "wt-ws-"))
  const appDir = mkdtempSync(join(tmpdir(), "wt-app-"))
  return {
    env: { WORKTABLE_WORKSPACE: workspace, WORKTABLE_APP_DIR: appDir },
    cleanup: () => {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(appDir, { recursive: true, force: true })
    },
  }
}

function isolatedServiceTestPath(appDir: string): string {
  const directory = join(appDir, "isolated-service-bin")
  mkdirSync(directory, { recursive: true })
  const bun = join(directory, "bun")
  if (!existsSync(bun)) symlinkSync(process.execPath, bun)
  return directory
}

function isolatedServiceTestHome(appDir: string): string {
  const directory = join(appDir, "isolated-service-home")
  mkdirSync(directory, { recursive: true })
  return directory
}

function occupyEphemeralPort(hostname = "127.0.0.1"): {
  port: number
  stop: () => Promise<void>
} {
  const server = Bun.serve({
    port: 0,
    hostname,
    fetch: () => new Response("reserved for CLI integration test"),
  })
  const port = server.port
  if (port === undefined) {
    void server.stop(true)
    throw new Error("Could not reserve an ephemeral CLI integration-test port")
  }
  let stopped = false
  return {
    port,
    stop: async () => {
      if (stopped) return
      stopped = true
      await server.stop(true)
    },
  }
}

describe("argv preprocessing", () => {
  it("routes the bare MCP stdio spawn contract to `mcp stdio`", () => {
    expect(preprocessArgv(["--mcp"])).toEqual(["mcp", "stdio"])
  })

  it("defaults a bare invocation to launch", () => {
    expect(preprocessArgv([])).toEqual(["launch"])
  })

  it("defaults an option-first invocation to launch", () => {
    expect(preprocessArgv(["--port", "7000"])).toEqual([
      "launch",
      "--port",
      "7000",
    ])
  })

  it("passes global --help/--version through untouched", () => {
    expect(preprocessArgv(["--help"])).toEqual(["--help"])
    expect(preprocessArgv(["--version"])).toEqual(["--version"])
    expect(preprocessArgv(["-h"])).toEqual(["-h"])
    expect(preprocessArgv(["-V"])).toEqual(["-V"])
  })

  it("leaves explicit commands untouched so unknown commands still error", () => {
    expect(preprocessArgv(["mcp", "status"])).toEqual(["mcp", "status"])
    expect(preprocessArgv(["bogus"])).toEqual(["bogus"])
    expect(preprocessArgv(["setup", "--mcp", "codex"])).toEqual([
      "setup",
      "--mcp",
      "codex",
    ])
  })
})

describe("setup helpers", () => {
  it("rejects conflicting run mode flags with a UsageError", () => {
    expect(() =>
      assertExclusiveRunMode({ background: true, foreground: true })
    ).toThrow(UsageError)
    expect(() =>
      assertExclusiveRunMode({ background: true, foreground: true })
    ).toThrow("Choose either --background or --foreground")
  })

  it("trims the interactive workspace answer before persisting it", () => {
    expect(normalizeWorkspaceAnswer("  /Users/alex/Worktable  ")).toBe(
      "/Users/alex/Worktable"
    )
  })

  it("removes previously connected agents left out of the selection", () => {
    const config = {
      mcp: {
        clients: {
          "claude-code": { desired: true, state: "configured" },
          codex: { desired: true, state: "configured" },
          cursor: { desired: false, state: "removed" },
        },
      },
    } as const

    expect(clientsToDeselect(config, ["claude-code"])).toEqual(["codex"])
    expect(clientsToDeselect(config, ["claude-code", "codex"])).toEqual([])
    expect(clientsToDeselect(config, [])).toEqual(["claude-code", "codex"])
  })

  it("tells non-interactive users that --yes is required", () => {
    expect(SETUP_INTERACTIVE_TERMINAL_REQUIRED_MESSAGE).toContain("--yes")
  })
})

describe("color gating", () => {
  function withEnv(
    vars: Record<string, string | undefined>,
    run: () => void
  ): void {
    const saved: Record<string, string | undefined> = {}
    for (const key of Object.keys(vars)) saved[key] = process.env[key]
    try {
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      run()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it("disables color when NO_COLOR is present, even if empty", () => {
    withEnv({ NO_COLOR: "", FORCE_COLOR: undefined }, () => {
      expect(colorEnabled()).toBe(false)
    })
  })

  it("treats FORCE_COLOR=0 as disabled, not forced-on", () => {
    withEnv({ FORCE_COLOR: "0", NO_COLOR: undefined }, () => {
      expect(colorEnabled()).toBe(false)
    })
  })

  it("forces color on for FORCE_COLOR=1 regardless of TTY", () => {
    withEnv({ FORCE_COLOR: "1", NO_COLOR: undefined }, () => {
      expect(colorEnabled()).toBe(true)
    })
  })
})

describe("CLI command surface (shared command runtime)", () => {
  it("prints the version for --version", () => {
    const { stdout, exitCode } = runCli(["--version"])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("documents the top-level commands in --help", () => {
    const { stdout, exitCode } = runCli(["--help"])
    expect(exitCode).toBe(0)
    // Locked by verify-local-e2e.sh: these substrings must appear in help.
    expect(stdout).toContain("worktable launch")
    expect(stdout).toContain("worktable setup")
    expect(stdout).toContain("worktable mcp")
    expect(stdout).toContain("  skills")
  })

  it("shows scoped per-subcommand help (the P0 fix)", () => {
    const launch = runCli(["launch", "--help"])
    expect(launch.exitCode).toBe(0)
    expect(launch.stdout).toContain("--background")
    expect(launch.stdout).toContain("--no-browser")

    const mcp = runCli(["mcp", "--help"])
    expect(mcp.exitCode).toBe(0)
    expect(mcp.stdout).toContain("remove")
    expect(mcp.stdout).toContain("setup")

    const skills = runCli(["skills", "--help"])
    expect(skills.exitCode).toBe(0)
    expect(skills.stdout).toContain("install")
    expect(skills.stdout).not.toContain("rollback")
    expect(skills.stdout).toContain("status")
  })

  it("runs both target-based skill installations through the real CLI", async () => {
    const home = mkdtempSync(join(tmpdir(), "wt-skills-home-"))
    const appDir = mkdtempSync(join(tmpdir(), "wt-skills-app-"))
    const missingRelease = mkdtempSync(join(tmpdir(), "wt-skills-release-"))
    const env = { HOME: home, WORKTABLE_APP_DIR: appDir }
    // One fresh process owns this HOME for the entire install/status/remove journey.
    // Reuse its production command runtime instead of cold-starting every command.
    const skillsWorker = createCliTestWorker(home)
    try {
      const preview = skillsWorker.run(
        ["skills", "install", "agents", "--preview", "--json"],
        env
      )
      expectCliSuccess(preview, "skill install preview")
      expect(JSON.parse(preview.stdout).preview).toMatchObject({
        action: "write",
        allowed: true,
        status: { state: "not-installed" },
      })

      const jsonNeedsApproval = skillsWorker.run(
        ["skills", "install", "agents", "--json"],
        env
      )
      expect(jsonNeedsApproval.exitCode).not.toBe(0)
      expect(jsonNeedsApproval.stdout).toBe("")
      expect(jsonNeedsApproval.stderr).toContain(
        "JSON output cannot use an interactive confirmation"
      )

      expectCliSuccess(
        skillsWorker.run(["skills", "install", "agents", "--yes", "--json"], env),
        "standard Agent Skills install"
      )
      const claude = skillsWorker.run(
        ["skills", "install", "claude", "--yes", "--json"],
        env
      )
      expectCliSuccess(claude, "Claude skill install")
      expect(JSON.parse(claude.stdout).result.action).toBe("write")

      const status = skillsWorker.run(["skills", "status", "all", "--json"], env)
      expectCliSuccess(status, "target-based skill status")
      expect(
        JSON.parse(status.stdout).statuses.map(
          (item: { targetId: string; state: string }) => [
            item.targetId,
            item.state,
          ]
        )
      ).toEqual([
        ["claude", "current"],
        ["agents", "current"],
      ])
      const mixedUnknown = skillsWorker.run(
        ["skills", "status", "all,not-a-target", "--json"],
        env
      )
      expect(mixedUnknown.exitCode).toBe(1)
      expect(mixedUnknown.stderr).toContain("Unknown skill target")
      const multiTargetMutation = skillsWorker.run(
        ["skills", "install", "all", "--yes", "--json"],
        env
      )
      expect(multiTargetMutation.exitCode).toBe(1)
      expect(multiTargetMutation.stderr).toContain(
        "Choose exactly one skill target"
      )

      const sourceIndependentEnv = {
        ...env,
        WORKTABLE_RELEASE_DIR: missingRelease,
      }
      const sourceIndependentStatus = skillsWorker.run(
        ["skills", "status", "agents", "--json"],
        sourceIndependentEnv
      )
      expectCliSuccess(sourceIndependentStatus, "source-independent status")
      expect(
        JSON.parse(sourceIndependentStatus.stdout).statuses[0]
      ).toMatchObject({ state: "current", sourcePackageDigest: null })

      expectCliSuccess(
        skillsWorker.run(
          ["skills", "remove", "agents", "--yes", "--json"],
          sourceIndependentEnv
        ),
        "standard Agent Skills removal"
      )
      expect(
        existsSync(
          join(home, ".agents", "skills", "worktable-create-or-update-docs")
        )
      ).toBe(false)
      expectCliSuccess(
        skillsWorker.run(
          ["skills", "remove", "claude", "--yes", "--json"],
          sourceIndependentEnv
        ),
        "Claude skill removal"
      )
      expect(
        existsSync(
          join(home, ".claude", "skills", "worktable-create-or-update-docs")
        )
      ).toBe(false)
    } finally {
      await skillsWorker.close()
      rmSync(home, { recursive: true, force: true })
      rmSync(appDir, { recursive: true, force: true })
      rmSync(missingRelease, { recursive: true, force: true })
    }
  }, 20_000)

  it("rejects unknown commands with a clean error and exit 1", () => {
    const { stderr, exitCode } = runCli(["bogus"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("unknown command")
    expect(stderr).not.toContain("Fatal:")
  })

  it("rejects an unsupported mcp client without a stack trace", () => {
    const { stderr, exitCode } = runCli(["mcp", "remove", "not-a-client"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unsupported MCP client")
    expect(stderr).not.toContain("Fatal:")
  })

  it("rejects an unsupported `mcp setup` id as a usage error, not Fatal", () => {
    const { env, cleanup } = withTempEnv()
    try {
      const { stderr, exitCode } = runCli(["mcp", "setup", "not-a-client"], env)
      expect(exitCode).toBe(1)
      expect(stderr).toContain("Unsupported MCP client")
      expect(stderr).not.toContain("Fatal:")
    } finally {
      cleanup()
    }
  })

  it("accepts --no-open as a back-compat alias for --no-browser", () => {
    // The alias is hidden from help but must still parse (not error as unknown).
    const { stderr } = runCli(["launch", "--no-open", "--help"])
    expect(stderr).not.toContain("unknown option")
  })

  it("runs the update command with a positional version (not the global --version)", () => {
    const { env, cleanup } = withTempEnv()
    try {
      // A bare version must reach commandUpdate, not print the CLI version and
      // exit. This build has no embedded installer, so it reports that.
      const { stdout, exitCode } = runCli(["update", "v9.9.9"], env)
      expect(exitCode).toBe(0)
      expect(stdout).toContain("embedded installer")
      expect(stdout.trim()).not.toBe("0.0.1")
    } finally {
      cleanup()
    }
  })

  it("emits update state in the machine-readable status", async () => {
    const { env, cleanup } = withTempEnv()
    const releaseHost = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ version: "9.9.9" }),
    })
    try {
      const { stdout, exitCode } = await CLI_TEST_WORKER.runAsync(
        ["status", "--json"],
        {
          ...env,
          WORKTABLE_VERSION: "0.0.1",
          WORKTABLE_RELEASE_BASE_URL: `http://127.0.0.1:${releaseHost.port}`,
        }
      )
      expect(exitCode).toBe(0)
      const parsed = JSON.parse(stdout)
      expect(parsed).toMatchObject({
        version: "0.0.1",
        latestVersion: "9.9.9",
        updateAvailable: true,
      })
      expect(parsed).toHaveProperty("mcp")
      expect(parsed.server).toHaveProperty("running")
    } finally {
      await releaseHost.stop(true)
      cleanup()
    }
  })

  it("retries an exact authenticated runtime after a transient proof timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-readiness-loop-"))
    const appDir = join(root, "app")
    const workspacePath = join(root, "workspace")
    mkdirSync(appDir, { recursive: true })
    mkdirSync(workspacePath, { recursive: true })
    const previousAppDir = process.env["WORKTABLE_APP_DIR"]
    process.env["WORKTABLE_APP_DIR"] = appDir
    const proofToken = "loop-proof-token-that-is-long-enough-for-runtime"
    let requests = 0
    let releaseFirstRequest = (): void => {}
    const runtimeHost = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1
        if (requests === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstRequest = () =>
              resolve(Response.json({ ok: true, service: "worktable" }))
          })
        }
        return Response.json(
          { ok: true, service: "worktable" },
          { headers: { [LOCAL_PROOF_HEADER]: "verified" } }
        )
      },
    })
    try {
      writeLocalRuntime(
        createLocalRuntimeRecord({
          owner: "service",
          installId: "ins_readiness_loop",
          workspaceId: "ws_readiness_loop",
          workspacePath,
          host: "127.0.0.1",
          port: runtimeHost.port!,
          proofToken,
        })
      )

      const readiness = await waitForExactLocalRuntime(
        {
          workspaceId: "ws_readiness_loop",
          workspacePath,
          host: "127.0.0.1",
          port: runtimeHost.port!,
        },
        {
          readinessTimeoutMs: 1_000,
          probeTimeoutMs: 50,
          backoffMs: 1,
        }
      )

      expect(readiness.ok).toBe(true)
      expect(requests).toBeGreaterThanOrEqual(2)
    } finally {
      releaseFirstRequest()
      await runtimeHost.stop(true)
      if (previousAppDir === undefined) delete process.env["WORKTABLE_APP_DIR"]
      else process.env["WORKTABLE_APP_DIR"] = previousAppDir
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("read-only commands never rewrite config", () => {
  // A durable reachable install as it would exist on the live box.
  const reachableConfig = JSON.stringify(
    {
      version: 2,
      workspace: "/tmp/does-not-matter",
      service: {
        host: "0.0.0.0",
        port: 7480,
        startAtLogin: true,
        reachable: true,
        exposureAcknowledged: true,
        httpsUpstream: true,
      },
      mcp: { endpoint: "http://127.0.0.1:7480/mcp", clients: {} },
    },
    null,
    2
  )

  function writeConfigInto(appDir: string, contents: string): string {
    const path = join(appDir, "config.json")
    writeFileSync(path, contents)
    return path
  }

  // Each read-only command, run against a reachable config, must leave
  // config.json byte-for-byte unchanged — the old ensureConfig() write-back could
  // persist loopback defaults from a corrupt read (the silent downgrade).
  for (const args of [
    ["status", "--json"],
    ["doctor"],
    ["paths", "--json"],
    ["mcp", "status", "--json"],
  ]) {
    it(`\`${args.join(" ")}\` leaves a reachable config untouched`, () => {
      const { env, cleanup } = withTempEnv()
      try {
        const path = writeConfigInto(env.WORKTABLE_APP_DIR, reachableConfig)
        const before = readFileSync(path, "utf8")
        const { exitCode } = runCli(args, env)
        expect(exitCode).toBe(0)
        const after = readFileSync(path, "utf8")
        expect(after).toBe(before)
        // The bind intent specifically survives — no loopback downgrade.
        expect(JSON.parse(after).service.reachable).toBe(true)
      } finally {
        cleanup()
      }
    })
  }

  it("fails `status` cleanly on a corrupt config instead of silently downgrading", () => {
    const { env, cleanup } = withTempEnv()
    try {
      const path = writeConfigInto(env.WORKTABLE_APP_DIR, "{ this is not json")
      const { stderr, exitCode } = runCli(["status", "--json"], env)
      expect(exitCode).toBe(1)
      expect(stderr).toContain("could not be loaded")
      // The corrupt bytes were NOT replaced with a valid loopback config.
      expect(readFileSync(path, "utf8")).toContain("this is not json")
      expect(existsSync(`${path}.corrupt`)).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe("update target helpers", () => {
  it("maps a resolved semver to the v-prefixed release tag for install.sh", () => {
    expect(updateTargetForInstall("0.0.18")).toBe("v0.0.18")
    expect(updateTargetForInstall("v0.0.18")).toBe("v0.0.18")
    // Non-semver input passes through for install.sh to reject or handle.
    expect(updateTargetForInstall("latest")).toBe("latest")
  })

  it("compares versions across tag and plain forms", () => {
    expect(sameVersion("v0.0.18", "0.0.18")).toBe(true)
    expect(sameVersion("0.0.18", "0.0.19")).toBe(false)
    expect(sameVersion("latest", "latest")).toBe(false)
  })
})

describe("update nudge gating", () => {
  const base = {
    commandPath: "doctor",
    json: false,
    isTTY: true,
    failed: false,
    current: "0.0.10",
    latest: "0.0.11",
  }

  it("shows for a human-facing command with a newer cached release", () => {
    expect(shouldShowUpdateNudge(base)).toBe(true)
  })

  it("suppresses without a TTY, with --json, and after a failed command", () => {
    expect(shouldShowUpdateNudge({ ...base, isTTY: false })).toBe(false)
    expect(shouldShowUpdateNudge({ ...base, json: true })).toBe(false)
    expect(shouldShowUpdateNudge({ ...base, failed: true })).toBe(false)
  })

  it("suppresses on protocol/config/log surfaces and self-managing commands", () => {
    for (const commandPath of [
      "status",
      "update",
      "uninstall",
      "mcp stdio",
      "mcp bridge",
      "mcp print-config",
      "service logs",
      "local-host inspect",
      "local-host activate",
      "completion",
      "completion bash",
      "__completion_internal",
    ]) {
      expect(shouldShowUpdateNudge({ ...base, commandPath })).toBe(false)
    }
    // Sibling leaf names that collide with excluded ones stay eligible.
    expect(shouldShowUpdateNudge({ ...base, commandPath: "mcp status" })).toBe(
      true
    )
    expect(
      shouldShowUpdateNudge({ ...base, commandPath: "service status" })
    ).toBe(true)
  })

  it("keeps the machine-facing bridge command hidden and rejects raw token flags", () => {
    const help = runCli(["mcp", "--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).not.toContain("bridge")

    const raw = runCli([
      "mcp",
      "bridge",
      "--url",
      "http://127.0.0.1:7480/mcp",
      "--token",
      "must-not-be-accepted",
    ])
    expect(raw.exitCode).not.toBe(0)
    expect(raw.stderr).toContain("unknown option '--token'")
    expect(raw.stdout).toBe("")
  })

  it("suppresses when no newer release is known", () => {
    expect(shouldShowUpdateNudge({ ...base, latest: null })).toBe(false)
    expect(shouldShowUpdateNudge({ ...base, latest: "0.0.10" })).toBe(false)
    expect(shouldShowUpdateNudge({ ...base, latest: "0.0.9" })).toBe(false)
  })
})

describe("reachability and owner-auth command integration", () => {
  function tempWsApp(): { ws: string; app: string; cleanup: () => void } {
    const ws = mkdtempSync(join(tmpdir(), "wt-reach-ws-"))
    const app = mkdtempSync(join(tmpdir(), "wt-reach-app-"))
    return {
      ws,
      app,
      cleanup: () => {
        rmSync(ws, { recursive: true, force: true })
        rmSync(app, { recursive: true, force: true })
      },
    }
  }

  it("refuses --reachable --yes without an owner password: non-zero, hint, no token, not reachable", () => {
    const { ws, app, cleanup } = tempWsApp()
    try {
      // An owner password is required for a non-loopback bind. With neither
      // password flag/env, refuse.
      const { stderr, exitCode } = runCli(
        ["setup", "--reachable", "--yes", "--skip-mcp", "--no-launch"],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
        }
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("--owner-password")
      // No token minted, and no reachable config persisted. setup defers its
      // config write to the final commit, so a refused reachable run leaves no
      // config at all on a fresh install (rather than early-writing loopback
      // defaults); if one exists it must be loopback, never reachable.
      expect(existsSync(join(app, "tokens.json"))).toBe(false)
      const configPath = join(app, "config.json")
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, "utf8"))
        expect(config.service.reachable).toBe(false)
        expect(config.service.host).toBe("127.0.0.1")
      }
    } finally {
      cleanup()
    }
  })

  it("setup with WORKTABLE_PUBLIC_URL treats a loopback background service as exposed", async () => {
    const { ws, app, cleanup } = tempWsApp()
    const launcher = join(app, "worktable-test-launcher.sh")
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec bun run ${JSON.stringify(join(import.meta.dir, "index.ts"))} "$@"\n`,
      { mode: 0o755 }
    )
    const env = {
      WORKTABLE_WORKSPACE: ws,
      WORKTABLE_APP_DIR: app,
      WORKTABLE_PUBLIC_URL: "https://worktable.example.com",
      WORKTABLE_SERVICE_BACKEND: "process",
      WORKTABLE_LAUNCHER: launcher,
      WORKTABLE_NO_UPDATE_CHECK: "1",
      FORCE_COLOR: "0",
      HOME: isolatedServiceTestHome(app),
      PATH: isolatedServiceTestPath(app),
    }
    try {
      const refused = runCli(
        ["setup", "--yes", "--skip-mcp", "--background", "--no-launch"],
        env
      )
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain("--owner-password")
      expect(existsSync(join(app, "tokens.json"))).toBe(false)

      const accepted = runCli(
        ["setup", "--yes", "--skip-mcp", "--background"],
        {
          ...env,
          WORKTABLE_OWNER_PASSWORD: TEST_OWNER_PASSWORD,
        }
      )
      expectCliSuccess(accepted, "public URL background setup")
      await waitForServiceAuthority(app, ws)
      // Exposed posture engages the remote-connect flow (never a raw token).
      expect(accepted.stdout).toContain("worktable agent invite")
      expect(accepted.stdout).not.toMatch(/Bearer wt_[0-9a-f]{12}_/)

      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.host).toBe("127.0.0.1")
      expect(config.service.reachable).toBe(false)
      expect(config.service.startAtLogin).toBe(true)
      expect(config.service.exposureAcknowledged).toBe(true)

      expect(existsSync(join(app, "session.json"))).toBe(true)
      const tokensPath = join(app, "tokens.json")
      expect(existsSync(tokensPath)).toBe(true)
      const tokens = JSON.parse(readFileSync(tokensPath, "utf8"))
      const active = (
        Array.isArray(tokens) ? tokens : (tokens.tokens ?? [])
      ).filter((t: { revokedAt?: unknown }) => !t.revokedAt)
      expect(active.length).toBeGreaterThan(0)

      expect(
        JSON.parse(readFileSync(join(app, "managed-service.json"), "utf8"))
      ).toMatchObject({ publicUrl: "https://worktable.example.com" })
      const runtime = JSON.parse(
        readFileSync(join(app, "local-runtime.json"), "utf8")
      ) as { port: number }
      const bare = await fetch(
        `http://127.0.0.1:${runtime.port}/api/system/connection`
      )
      expect(bare.status).toBe(401)
      const login = await fetch(`http://127.0.0.1:${runtime.port}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: TEST_OWNER_PASSWORD }),
      })
      expect(login.status).toBe(200)
      const connection = await fetch(
        `http://127.0.0.1:${runtime.port}/api/system/connection`,
        {
          headers: { Cookie: login.headers.get("set-cookie") ?? "" },
        }
      )
      expect(connection.status).toBe(200)
      expect(await connection.json()).toMatchObject({
        authRequired: true,
        origin: "https://worktable.example.com",
        originSource: "env",
      })
    } finally {
      runCli(["service", "stop"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        WORKTABLE_SERVICE_BACKEND: "process",
        PATH: env.PATH,
      })
      cleanup()
    }
  }, 20_000)

  it("setup preserves scoped identities when tunnel-only exposure is removed", () => {
    const { ws, app, cleanup } = tempWsApp()
    const publicEnv = {
      WORKTABLE_WORKSPACE: ws,
      WORKTABLE_APP_DIR: app,
      WORKTABLE_PUBLIC_URL: "https://worktable.example.com",
      WORKTABLE_OWNER_PASSWORD: TEST_OWNER_PASSWORD,
    }
    try {
      const exposed = runCli(
        ["setup", "--yes", "--skip-mcp", "--no-launch"],
        publicEnv
      )
      expect(exposed.exitCode).toBe(0)
      const tokensPath = join(app, "tokens.json")
      const activeAfterExpose = (
        JSON.parse(readFileSync(tokensPath, "utf8")) as Array<{
          revokedAt?: unknown
        }>
      ).filter((t) => !t.revokedAt)
      expect(activeAfterExpose.length).toBeGreaterThan(0)

      const local = runCli(["setup", "--yes", "--skip-mcp", "--no-launch"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(local.exitCode).toBe(0)
      const activeAfterRemoval = (
        JSON.parse(readFileSync(tokensPath, "utf8")) as Array<{
          revokedAt?: unknown
        }>
      ).filter((t) => !t.revokedAt)
      expect(activeAfterRemoval).toHaveLength(activeAfterExpose.length)
      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.exposureAcknowledged).toBe(false)
    } finally {
      cleanup()
    }
  })

  it("setup --reachable --owner-password --yes prints the remote-connect hint (never a raw token) and the reachability notice; token + session files are 0o600", () => {
    const { ws, app, cleanup } = tempWsApp()
    try {
      const { stdout, exitCode } = runCli(
        [
          "setup",
          "--reachable",
          "--owner-password",
          "a-strong-owner-password",
          "--yes",
          "--skip-mcp",
          "--no-launch",
        ],
        { WORKTABLE_WORKSPACE: ws, WORKTABLE_APP_DIR: app }
      )
      expect(exitCode).toBe(0)
      // The pairing flow replaced the paste-ready snippet: setup points at
      // `worktable agent invite` and never prints a raw bearer.
      expect(stdout).toContain("worktable agent invite")
      expect(stdout).not.toMatch(/Bearer wt_[0-9a-f]{12}_/)
      expect(stdout).toContain("reachable over the network")
      expect(stdout).toContain("HTTPS tunnel")

      const tokensPath = join(app, "tokens.json")
      expect(existsSync(tokensPath)).toBe(true)
      expect(statSync(tokensPath).mode & 0o777).toBe(0o600)

      // The owner password is persisted machine-local at 0o600, never the workspace.
      const sessionPath = join(app, "session.json")
      expect(existsSync(sessionPath)).toBe(true)
      expect(statSync(sessionPath).mode & 0o777).toBe(0o600)
      expect(existsSync(join(ws, "session.json"))).toBe(false)

      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.reachable).toBe(true)
      expect(config.service.host).toBe("0.0.0.0")
      // No HTTPS-upstream ack, so it is not suppressed and not persisted.
      expect(config.service.httpsUpstream).toBe(false)
    } finally {
      cleanup()
    }
  })

  it("setup --reachable --behind-tls suppresses the reachability notice, persists httpsUpstream, but still prints the remote-connect hint", () => {
    const { ws, app, cleanup } = tempWsApp()
    try {
      const { stdout, exitCode } = runCli(
        [
          "setup",
          "--reachable",
          "--behind-tls",
          "--owner-password",
          "a-strong-owner-password",
          "--yes",
          "--skip-mcp",
          "--no-launch",
        ],
        { WORKTABLE_WORKSPACE: ws, WORKTABLE_APP_DIR: app }
      )
      expect(exitCode).toBe(0)
      // The reminder is suppressed...
      expect(stdout).not.toContain("reachable over the network")
      expect(stdout).not.toContain("HTTPS tunnel")
      // ...but the remote-connect hint is unaffected.
      expect(stdout).toContain("worktable agent invite")

      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.reachable).toBe(true)
      expect(config.service.httpsUpstream).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("accepts the owner password from WORKTABLE_OWNER_PASSWORD env", () => {
    const { ws, app, cleanup } = tempWsApp()
    try {
      const { exitCode } = runCli(
        ["setup", "--reachable", "--yes", "--skip-mcp", "--no-launch"],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
          WORKTABLE_OWNER_PASSWORD: "env-owner-password",
        }
      )
      expect(exitCode).toBe(0)
      expect(existsSync(join(app, "session.json"))).toBe(true)
      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.reachable).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("re-running setup --yes on an already-passworded reachable config is not blocked by the gate", () => {
    const app = mkdtempSync(join(tmpdir(), "wt-app-"))
    const ws = mkdtempSync(join(tmpdir(), "wt-ws-"))
    try {
      const first = runCli(
        [
          "setup",
          "--reachable",
          "--owner-password",
          "a-strong-owner-password",
          "--yes",
          "--skip-mcp",
          "--no-launch",
        ],
        { WORKTABLE_WORKSPACE: ws, WORKTABLE_APP_DIR: app }
      )
      expect(first.exitCode).toBe(0)
      // Re-run plain setup (no --reachable, no password): the persisted reachable
      // intent + existing owner password mean it must NOT re-demand a password.
      const again = runCli(["setup", "--yes", "--skip-mcp", "--no-launch"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(again.exitCode).toBe(0)
      expect(again.stderr).not.toContain("Refusing to bind to all interfaces")
      expect(again.stderr).not.toContain("--owner-password")
      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.reachable).toBe(true)
    } finally {
      rmSync(app, { recursive: true, force: true })
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

// Seed a reachable, already-acknowledged config (and a managed token) the same
// way a real `setup --reachable --owner-password` would, so launch/mcp tests
// start from a realistic persisted state instead of a hand-written config.
const TEST_OWNER_PASSWORD = "test-owner-password"

function seedReachableConfig(ws: string, app: string): { exitCode: number } {
  // An owner password gates reachability. Provide it so the exposed setup is
  // allowed and the server can serve the non-loopback bind.
  const { exitCode } = runCli(
    [
      "setup",
      "--reachable",
      "--owner-password",
      TEST_OWNER_PASSWORD,
      "--yes",
      "--skip-mcp",
      "--no-launch",
    ],
    { WORKTABLE_WORKSPACE: ws, WORKTABLE_APP_DIR: app }
  )
  return { exitCode }
}

function tempWsAppPair(): { ws: string; app: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "wt-launch-ws-"))
  const app = mkdtempSync(join(tmpdir(), "wt-launch-app-"))
  return {
    ws,
    app,
    cleanup: () => {
      rmSync(ws, { recursive: true, force: true })
      rmSync(app, { recursive: true, force: true })
    },
  }
}

describe("agent invite and configuration command integration", () => {
  it("creates a pairing and prints the one-line connect command, warning when no Workspace URL is set", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      const { stdout, exitCode } = runCli(
        ["agent", "invite", "--client", "codex"],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
        }
      )
      expect(exitCode).toBe(0)
      expect(stdout).toMatch(
        /curl -fsSL http:\/\/[^/]+\/connect\.sh \| sh -s -- [0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}/
      )
      expect(stdout).toContain("--client codex")
      expect(stdout).toContain("expires in 15 minutes")
      // No Workspace URL configured: the origin is a guess, say so.
      expect(stdout).toContain("No Workspace URL is configured")
      // The pairing session is persisted machine-local, never in the workspace.
      expect(existsSync(join(app, "pairing.json"))).toBe(true)
      expect(existsSync(join(ws, "pairing.json"))).toBe(false)
      // The code is the credential: only its hash may be stored.
      const code = stdout.match(/sh -s -- ([0-9A-HJKMNP-TV-Z-]+)/)![1]!
      expect(readFileSync(join(app, "pairing.json"), "utf8")).not.toContain(
        code.replace("-", "")
      )
    } finally {
      cleanup()
    }
  })

  it("uses the configured Workspace URL as the command origin (no warning)", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      const { stdout, exitCode } = runCli(["agent", "invite"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        WORKTABLE_PUBLIC_URL: "https://wt.example.com",
      })
      expect(exitCode).toBe(0)
      expect(stdout).toContain("curl -fsSL https://wt.example.com/connect.sh")
      expect(stdout).not.toContain("No Workspace URL is configured")
    } finally {
      cleanup()
    }
  })

  it("print-config --with-token mints and embeds a scoped bearer (manual fallback)", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      const { stdout, exitCode } = runCli(
        ["mcp", "print-config", "goose", "--with-token"],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
        }
      )
      expect(exitCode).toBe(0)
      expect(stdout).toMatch(/Bearer wt_[0-9a-f]{12}_/)
      expect(stdout).toContain("shown once")
      // A manual config is destined for another machine: with a Workspace
      // URL configured, the embedded endpoint must be the public one.
      const remote = runCli(["mcp", "print-config", "goose", "--with-token"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        WORKTABLE_PUBLIC_URL: "https://wt.example.com",
      })
      expect(remote.exitCode).toBe(0)
      expect(remote.stdout).toContain("https://wt.example.com/mcp")

      // Extension-only clients have no fake CLI snippet; Settings owns their
      // download and credential handoff.
      const refused = runCli(
        ["mcp", "print-config", "claude-desktop", "--with-token"],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
        }
      )
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain("Claude Desktop uses the extension")

      // Re-running rotates the manual bearer instead of accumulating tokens.
      const again = runCli(["mcp", "print-config", "goose", "--with-token"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(again.exitCode).toBe(0)
      const tokens = JSON.parse(
        readFileSync(join(app, "tokens.json"), "utf8")
      ) as {
        agent: string | null
        revokedAt: string | null
      }[]
      const manual = tokens.filter((t) => t.agent === "manual-goose")
      // Three --with-token runs in this test; rotation keeps exactly one live.
      expect(manual.length).toBe(3)
      expect(manual.filter((t) => t.revokedAt === null).length).toBe(1)
    } finally {
      cleanup()
    }
  })

  it("rejects goose and unknown clients with usage guidance", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      for (const bad of ["goose", "emacs"]) {
        const { stderr, exitCode } = runCli(
          ["agent", "invite", "--client", bad],
          {
            WORKTABLE_WORKSPACE: ws,
            WORKTABLE_APP_DIR: app,
          }
        )
        expect(exitCode).not.toBe(0)
        expect(stderr).toContain("Unsupported client")
      }
    } finally {
      cleanup()
    }
  })
})

describe("workspace and service handoff command integration", () => {
  it("exports the standard package by default and auto-imports it as a fresh workspace", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    const restored = join(app, "restored-workspace")
    try {
      const setup = runCli(["setup", "--yes", "--skip-mcp", "--no-launch"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(setup.exitCode).toBe(0)
      mkdirSync(join(ws, "spaces", "notes", "docs"), { recursive: true })
      writeFileSync(
        join(ws, "spaces", "notes", "docs", "portable.md"),
        "# Portable\n"
      )
      const original = JSON.parse(
        readFileSync(join(ws, "worktable.workspace.json"), "utf8")
      ) as { id: string }
      const destination = join(app, "daily-backup")
      const exported = runCli(
        ["workspace", "export", destination, "--history", "none"],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
        }
      )
      expect(exported.exitCode).toBe(0)
      expect(exported.stdout).toContain("History: 0 included")
      const packagePath = `${destination}.wtb`
      expect(readFileSync(packagePath).subarray(0, 2)).toEqual(
        Buffer.from("PK")
      )

      const imported = runCli(["workspace", "import", packagePath, restored], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(imported.exitCode).toBe(0)
      expect(
        readFileSync(
          join(restored, "spaces", "notes", "docs", "portable.md"),
          "utf8"
        )
      ).toBe("# Portable\n")
      expect(
        JSON.parse(
          readFileSync(join(restored, "worktable.workspace.json"), "utf8")
        ).id
      ).not.toBe(original.id)
    } finally {
      cleanup()
    }
  })

  it("a background launch of a persisted-reachable config is NOT blocked by the ack gate (Finding 1)", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      // Background-intent launch. The service backend is forced to `unsupported`
      // so no real OS service is installed/started. The launch must get PAST the
      // ack gate (it is already persisted-acknowledged, with an owner password on
      // disk) — it may then report that background mode is unavailable, but it
      // must NOT fail with the reachability refusal.
      const { stderr } = runCli(["launch", "--background", "--no-browser"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        WORKTABLE_SERVICE_BACKEND: "unsupported",
      })
      expect(stderr).not.toContain("Refusing to bind to all interfaces")
      // Config stays reachable (the launch did not silently downgrade it).
      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.reachable).toBe(true)
      expect(config.service.host).toBe("0.0.0.0")
    } finally {
      cleanup()
    }
  })

  it("a non-loopback launch with no prior token mints a managed token (Finding 2)", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      // Start from a loopback config with NO token (plain default setup).
      const setup = runCli(["setup", "--yes", "--skip-mcp", "--no-launch"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(setup.exitCode).toBe(0)
      expect(existsSync(join(app, "tokens.json"))).toBe(false)

      // Now launch reachable for the first time. An owner password gates the
      // exposed bind, supplied here via the env. Backend forced unsupported so no
      // real service is started; the mint runs before the background branch. A
      // managed token must exist afterwards, so a subsequent bare /mcp would 401.
      runCli(["launch", "--reachable", "--background", "--no-browser"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        WORKTABLE_SERVICE_BACKEND: "unsupported",
        WORKTABLE_OWNER_PASSWORD: TEST_OWNER_PASSWORD,
      })
      const tokensPath = join(app, "tokens.json")
      expect(existsSync(tokensPath)).toBe(true)
      const tokens = JSON.parse(readFileSync(tokensPath, "utf8"))
      const active = (
        Array.isArray(tokens) ? tokens : (tokens.tokens ?? [])
      ).filter((t: { revokedAt?: unknown }) => !t.revokedAt)
      expect(active.length).toBeGreaterThan(0)
      expect(statSync(tokensPath).mode & 0o777).toBe(0o600)
    } finally {
      cleanup()
    }
  })

  it("a loopback launch with WORKTABLE_PUBLIC_URL accepts the owner password preflight and de-escalates when removed", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      const setup = runCli(["setup", "--yes", "--skip-mcp", "--no-launch"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(setup.exitCode).toBe(0)

      runCli(["launch", "--background", "--no-browser"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        WORKTABLE_SERVICE_BACKEND: "unsupported",
        WORKTABLE_PUBLIC_URL: "https://worktable.example.com",
        WORKTABLE_OWNER_PASSWORD: TEST_OWNER_PASSWORD,
      })

      const sessionPath = join(app, "session.json")
      expect(existsSync(sessionPath)).toBe(true)
      const session = JSON.parse(readFileSync(sessionPath, "utf8")) as {
        passwordHash?: unknown
      }
      expect(typeof session.passwordHash).toBe("string")

      const tokensPath = join(app, "tokens.json")
      const activeAfterPublicLaunch = (
        JSON.parse(readFileSync(tokensPath, "utf8")) as Array<{
          revokedAt?: unknown
        }>
      ).filter((t) => !t.revokedAt)
      expect(activeAfterPublicLaunch.length).toBeGreaterThan(0)
      let config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.exposureAcknowledged).toBe(true)

      runCli(["launch", "--background", "--no-browser"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        WORKTABLE_SERVICE_BACKEND: "unsupported",
      })
      const activeAfterRemoval = (
        JSON.parse(readFileSync(tokensPath, "utf8")) as Array<{
          revokedAt?: unknown
        }>
      ).filter((t) => !t.revokedAt)
      expect(activeAfterRemoval).toHaveLength(activeAfterPublicLaunch.length)
      config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.exposureAcknowledged).toBe(false)
    } finally {
      cleanup()
    }
  })

  it("launch --background restarts a running service after changing its workspace", async () => {
    const { ws, app, cleanup } = tempWsAppPair()
    const second = mkdtempSync(join(tmpdir(), "wt-background-second-"))
    const blocker = occupyEphemeralPort()
    let port = blocker.port
    const launcher = join(app, "worktable-test-launcher.sh")
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec bun run ${JSON.stringify(join(import.meta.dir, "index.ts"))} "$@"\n`,
      { mode: 0o755 }
    )
    const baseEnv = {
      WORKTABLE_WORKSPACE: ws,
      WORKTABLE_APP_DIR: app,
      WORKTABLE_SERVICE_BACKEND: "process",
      WORKTABLE_LAUNCHER: launcher,
      FORCE_COLOR: "0",
      HOME: isolatedServiceTestHome(app),
      PATH: isolatedServiceTestPath(app),
    }
    try {
      const setup = runCli(
        [
          "setup",
          "--yes",
          "--skip-mcp",
          "--background",
          "--no-launch",
          "--port",
          String(blocker.port),
        ],
        baseEnv
      )
      expectCliSuccess(setup, "workspace-switch test setup")
      port = (
        JSON.parse(readFileSync(join(app, "config.json"), "utf8")) as {
          service: { port: number }
        }
      ).service.port
      await blocker.stop()
      expectCliSuccess(
        runCli(["launch", "--background", "--no-browser"], baseEnv),
        "workspace-switch initial launch"
      )
      const firstWorkspace = (await (
        await fetch(`http://127.0.0.1:${port}/api/workspace`)
      ).json()) as { id: string }

      expectCliSuccess(
        runCli(
          ["workspace", "prepare", second, "--intent", "create", "--json"],
          baseEnv
        ),
        "workspace-switch workspace preparation"
      )
      const switched = runCli(
        ["launch", "--background", "--no-browser", "--workspace", second],
        baseEnv
      )
      expectCliSuccess(switched, "workspace-switch launch")
      const switchedConfig = JSON.parse(
        readFileSync(join(app, "config.json"), "utf8")
      ) as { workspace: string; service: { port: number } }
      let secondWorkspace: { id: string } | null = null
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${switchedConfig.service.port}/api/workspace`
          )
          if (response.ok) {
            secondWorkspace = (await response.json()) as { id: string }
            break
          }
        } catch {
          // The process backend closes and rebinds the socket during restart.
        }
        // test-policy: external-readiness-backoff
        await Bun.sleep(100)
      }
      if (!secondWorkspace) {
        throw new Error(
          `service did not recover after switch\nstdout: ${switched.stdout}\nstderr: ${switched.stderr}`
        )
      }
      expect(secondWorkspace).not.toBeNull()
      expect(secondWorkspace?.id).not.toBe(firstWorkspace.id)
      expect(switchedConfig.workspace).toBe(second)
    } finally {
      await blocker.stop()
      runCli(["service", "stop"], baseEnv)
      cleanup()
      rmSync(second, { recursive: true, force: true })
    }
  }, 30_000)

  it("a follow-up launch ensures (does not rotate) the existing managed token", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      const tokensPath = join(app, "tokens.json")
      const before = JSON.parse(readFileSync(tokensPath, "utf8"))
      const activeBefore = (before as Array<{ revokedAt?: unknown }>).filter(
        (t) => !t.revokedAt
      )
      expect(activeBefore.length).toBe(1)
      const idBefore = (activeBefore[0] as { id: string }).id

      // A reachable launch with an already-acknowledged config must NOT revoke the
      // token setup minted+injected — it ensures, not rotates.
      runCli(["launch", "--reachable", "--background", "--no-browser"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        WORKTABLE_SERVICE_BACKEND: "unsupported",
      })
      const after = JSON.parse(readFileSync(tokensPath, "utf8")) as Array<{
        id: string
        revokedAt?: unknown
      }>
      const activeAfter = after.filter((t) => !t.revokedAt)
      expect(activeAfter.length).toBe(1)
      expect(activeAfter[0]?.id).toBe(idBefore)
    } finally {
      cleanup()
    }
  })

  it("a launch that changes reachability vs the running service does not report the stale loopback URL (Finding 4)", async () => {
    // The process backend's start waits a few seconds for the (deliberately
    // failing) managed child to report a PID, so allow extra time.
    const { ws, app, cleanup } = tempWsAppPair()
    const servicePath = isolatedServiceTestPath(app)
    const serviceHome = isolatedServiceTestHome(app)
    // Occupy the target port so the managed child server cannot bind and exits
    // immediately — this keeps the test from leaving a real server running while
    // still exercising the apply-new-config path.
    const blocker = occupyEphemeralPort("0.0.0.0")
    const port = blocker.port
    try {
      // Plain loopback setup on a fixed port.
      const setup = runCli(
        ["setup", "--yes", "--skip-mcp", "--no-launch", "--port", String(port)],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
          WORKTABLE_SERVICE_BACKEND: "process",
          HOME: serviceHome,
          PATH: servicePath,
        }
      )
      expectCliSuccess(setup, "stale-loopback test setup")
      // Mark the process-backend service as installed (marker file present) so the
      // "service already installed" branch is taken.
      writeFileSync(join(app, "managed-service.json"), "{}")

      const { stdout } = runCli(
        ["launch", "--reachable", "--no-browser", "--port", String(port)],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
          WORKTABLE_SERVICE_BACKEND: "process",
          WORKTABLE_OWNER_PASSWORD: TEST_OWNER_PASSWORD,
          HOME: serviceHome,
          PATH: servicePath,
        }
      )
      // It must NOT silently report the old loopback URL as already running.
      expect(stdout).not.toContain(
        `Worktable running at http://127.0.0.1:${port}`
      )
      // Instead it applied the newly resolved reachable config (persisted 0.0.0.0).
      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.reachable).toBe(true)
      expect(config.service.host).toBe("0.0.0.0")
    } finally {
      await blocker.stop()
      cleanup()
    }
  }, 20000)

  it("a failed foreground bind restores the previous config and workspace reservation", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    // Block the port so the foreground startServer throws EADDRINUSE immediately.
    // The launch reserves its resolved endpoint before binding, but a failed bind
    // must roll that provisional ownership back so durable state still describes
    // the server that can actually be started.
    const port = 39521
    const blocker = Bun.serve({
      port,
      hostname: "0.0.0.0",
      fetch: () => new Response("busy"),
    })
    try {
      const setup = runCli(
        ["setup", "--yes", "--skip-mcp", "--no-launch", "--port", String(port)],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
        }
      )
      expect(setup.exitCode).toBe(0)
      const configPath = join(app, "config.json")
      const registryPath = join(app, "local-workspaces.json")
      const beforeConfig = readFileSync(configPath, "utf8")
      const beforeRegistry = readFileSync(registryPath, "utf8")

      const failed = runCli(
        [
          "launch",
          "--foreground",
          "--reachable",
          "--no-browser",
          "--port",
          String(port),
        ],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
          WORKTABLE_OWNER_PASSWORD: TEST_OWNER_PASSWORD,
        }
      )
      expect(failed.exitCode).not.toBe(0)
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    } finally {
      blocker.stop(true)
      cleanup()
    }
  })

  it("a hand-edited non-loopback host without an owner password is refused at launch", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      // Hand-edited config: reachable host, but the risk was NEVER acknowledged
      // (no exposureAcknowledged). The gate must NOT be bypassed.
      writeFileSync(
        join(app, "config.json"),
        JSON.stringify({
          version: 2,
          workspace: ws,
          service: {
            host: "0.0.0.0",
            port: 7466,
            startAtLogin: false,
            reachable: true,
          },
          mcp: { endpoint: "http://127.0.0.1:7466/mcp", clients: {} },
        })
      )
      const { stderr, exitCode } = runCli(["launch", "--no-browser"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        WORKTABLE_SERVICE_BACKEND: "unsupported",
      })
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("Refusing to bind to all interfaces")
    } finally {
      cleanup()
    }
  })

  it("a reachable launch does not reuse a healthy server after the bind changes", async () => {
    const { ws, app, cleanup } = tempWsAppPair()
    const reservation = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("reserved"),
    })
    const port = reservation.port
    reservation.stop(true)
    // A server that answers /health like Worktable would satisfy the old reuse
    // shortcut. With the configured bind changing to reachable, launch must NOT
    // accept it as "already running" — it falls through to bind 0.0.0.0:port,
    // which deterministically fails because that exact address is occupied.
    let blocker: ReturnType<typeof Bun.serve> | null = null
    try {
      const setup = await runCliAsync(
        ["setup", "--yes", "--skip-mcp", "--no-launch", "--port", String(port)],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
        }
      )
      expect(setup.exitCode).toBe(0)
      blocker = Bun.serve({
        port,
        hostname: "0.0.0.0",
        fetch: () =>
          new Response(JSON.stringify({ ok: true, service: "worktable" }), {
            headers: { "Content-Type": "application/json" },
          }),
      })
      const configPath = join(app, "config.json")
      const registryPath = join(app, "local-workspaces.json")
      const beforeConfig = readFileSync(configPath, "utf8")
      const beforeRegistry = readFileSync(registryPath, "utf8")
      const { stdout, exitCode } = await runCliAsync(
        ["launch", "--reachable", "--no-browser", "--port", String(port)],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
          WORKTABLE_SERVICE_BACKEND: "unsupported",
          WORKTABLE_OWNER_PASSWORD: TEST_OWNER_PASSWORD,
        }
      )
      expect(stdout).not.toContain("already running")
      expect(exitCode).not.toBe(0)
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    } finally {
      blocker?.stop(true)
      cleanup()
    }
  })

  it("setup --yes auto-picks a free port when the chosen one is held by a foreign process", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    const port = 39540
    // A foreign HTTP server (does NOT answer /health with service:"worktable")
    // occupies the port. classifyPort sees it as
    // "occupied" (not a Worktable reuse), so --yes must auto-pick another port and
    // never write MCP configs pointing at the foreign server.
    const blocker = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () => new Response("not worktable"),
    })
    try {
      const { stdout, exitCode } = runCli(
        ["setup", "--yes", "--skip-mcp", "--no-launch", "--port", String(port)],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
        }
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain(`Port ${port} is already in use`)
      const config = JSON.parse(readFileSync(join(app, "config.json"), "utf8"))
      expect(config.service.port).not.toBe(port)
      expect(config.service.port).toBeGreaterThan(port)
      expect(config.mcp.endpoint).toContain(`:${config.service.port}/mcp`)
    } finally {
      blocker.stop(true)
      cleanup()
    }
  })

  it("setup leaves config and credentials unchanged when another workspace owns the endpoint", () => {
    const first = mkdtempSync(join(tmpdir(), "wt-setup-first-"))
    const second = mkdtempSync(join(tmpdir(), "wt-setup-second-"))
    const app = mkdtempSync(join(tmpdir(), "wt-setup-app-"))
    const port = 39542
    const environment = {
      WORKTABLE_WORKSPACE: first,
      WORKTABLE_APP_DIR: app,
      WORKTABLE_SERVICE_BACKEND: "unsupported",
    }
    try {
      const initial = runCli(
        [
          "setup",
          "--yes",
          "--skip-mcp",
          "--no-launch",
          "--workspace",
          first,
          "--port",
          String(port),
        ],
        environment
      )
      expect(initial.exitCode).toBe(0)
      const configPath = join(app, "config.json")
      const registryPath = join(app, "local-workspaces.json")
      const beforeConfig = readFileSync(configPath, "utf8")
      const beforeRegistry = readFileSync(registryPath, "utf8")

      const refused = runCli(
        [
          "setup",
          "--yes",
          "--skip-mcp",
          "--no-launch",
          "--workspace",
          second,
          "--port",
          String(port),
          "--reachable",
          "--owner-password",
          TEST_OWNER_PASSWORD,
        ],
        environment
      )
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain("belongs to")
      expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
      expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
      expect(existsSync(join(app, "session.json"))).toBe(false)
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
      rmSync(app, { recursive: true, force: true })
    }
  })

  it("warns to re-point agents when setup --skip-mcp also moves the workspace on a reachable install", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    const ws2 = mkdtempSync(join(tmpdir(), "wt-ws2-"))
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      // Re-run reachable setup --skip-mcp pointing at a DIFFERENT (empty) workspace:
      // the managed token rebinds to ws2 but agents are not re-injected, so the user
      // must be told to re-point them.
      const { stdout, exitCode } = runCli(
        [
          "setup",
          "--reachable",
          "--yes",
          "--skip-mcp",
          "--no-launch",
          "--workspace",
          ws2,
        ],
        { WORKTABLE_WORKSPACE: ws, WORKTABLE_APP_DIR: app }
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain("Workspace changed on a reachable install")
    } finally {
      rmSync(ws2, { recursive: true, force: true })
      cleanup()
    }
  })

  it("switching back to loopback preserves managed identities while bare localhost remains valid", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      const tokensPath = join(app, "tokens.json")
      const before = (
        JSON.parse(readFileSync(tokensPath, "utf8")) as Array<{
          revokedAt?: unknown
        }>
      ).filter((t) => !t.revokedAt)
      expect(before.length).toBeGreaterThan(0)

      // Re-bind to loopback. Scoped identities remain available, while their
      // existence no longer disables implicit-owner use on literal loopback.
      const { exitCode } = runCli(
        ["setup", "--host", "127.0.0.1", "--yes", "--skip-mcp", "--no-launch"],
        {
          WORKTABLE_WORKSPACE: ws,
          WORKTABLE_APP_DIR: app,
        }
      )
      expect(exitCode).toBe(0)
      const after = (
        JSON.parse(readFileSync(tokensPath, "utf8")) as Array<{
          revokedAt?: unknown
        }>
      ).filter((t) => !t.revokedAt)
      expect(after.length).toBe(before.length)
    } finally {
      cleanup()
    }
  })

  it("re-running setup --skip-mcp on a reachable config preserves the managed token", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      const tokensPath = join(app, "tokens.json")
      const before = (
        JSON.parse(readFileSync(tokensPath, "utf8")) as Array<{
          id: string
          revokedAt?: unknown
        }>
      ).filter((t) => !t.revokedAt)
      expect(before).toHaveLength(1)
      const idBefore = before[0]?.id

      // No client changes + already acknowledged → must NOT rotate/revoke the
      // existing bearer, or remote agents on the printed snippet break.
      const again = runCli(["setup", "--yes", "--skip-mcp", "--no-launch"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(again.exitCode).toBe(0)
      const after = (
        JSON.parse(readFileSync(tokensPath, "utf8")) as Array<{
          id: string
          revokedAt?: unknown
        }>
      ).filter((t) => !t.revokedAt)
      expect(after).toHaveLength(1)
      expect(after[0]?.id).toBe(idBefore)
    } finally {
      cleanup()
    }
  })
})

describe("MCP exposure and rotation command integration", () => {
  it("writes the client config WITH the managed bearer at 0o600 (Finding 3)", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    const home = mkdtempSync(join(tmpdir(), "wt-home-"))
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      // Configure a client whose config is a JSON file under HOME (cursor) so we
      // can read the injected bearer back. HOME is redirected to a temp dir.
      const { exitCode } = runCli(["mcp", "setup", "cursor"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        HOME: home,
      })
      expect(exitCode).toBe(0)
      const cursorPath = join(home, ".cursor", "mcp.json")
      expect(existsSync(cursorPath)).toBe(true)
      const raw = readFileSync(cursorPath, "utf8")
      // The injected entry must carry the bearer header — same-machine agents
      // would 401 without it on a reachable config.
      expect(raw).toContain("Authorization")
      expect(raw).toMatch(/Bearer wt_[0-9a-f]{12}_/)
      expect(statSync(cursorPath).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(home, { recursive: true, force: true })
      cleanup()
    }
  })

  it("prints the rotation note pointing remote reconnects at the pairing flow", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    const home = mkdtempSync(join(tmpdir(), "wt-home-"))
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      const { stdout, exitCode } = runCli(["mcp", "setup", "cursor"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        HOME: home,
      })
      expect(exitCode).toBe(0)
      // Rotation commits only after every local config succeeds. Pairing-connected
      // remote agents keep their own tokens; the note points any old shared-token
      // remote at the pairing flow instead of dumping a fresh raw bearer.
      expect(stdout).toContain("Committed the managed MCP credential rotation")
      expect(stdout).toContain("worktable agent invite")
      expect(stdout).not.toMatch(/Bearer wt_[0-9a-f]{12}_/)
    } finally {
      rmSync(home, { recursive: true, force: true })
      cleanup()
    }
  })

  it("mcp print-config goose on a reachable config emits the token guidance, not a tokenless snippet", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      // Reachability comes from config.service.reachable; the stored MCP endpoint is
      // a connectable 127.0.0.1 URL, so a hostname-based heuristic would wrongly emit
      // a tokenless remote snippet that 401s.
      const { stdout, exitCode } = runCli(["mcp", "print-config", "goose"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(exitCode).toBe(0)
      expect(stdout).toContain("requires a bearer token")
      expect(stdout).not.toContain('"type": "remote"')
    } finally {
      cleanup()
    }
  })

  it("mcp print-config cursor on a reachable config warns the snippet needs a bearer token", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    try {
      expect(seedReachableConfig(ws, app).exitCode).toBe(0)
      // Non-goose adapters print a tokenless snippet; the command must still warn
      // that a reachable server requires the bearer (which can't be reprinted).
      const { stdout, exitCode } = runCli(["mcp", "print-config", "cursor"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(exitCode).toBe(0)
      expect(stdout).toContain("requires a bearer token")
    } finally {
      cleanup()
    }
  })

  it("loopback config: mcp setup writes NO bearer header (byte-for-byte today)", () => {
    const { ws, app, cleanup } = tempWsAppPair()
    const home = mkdtempSync(join(tmpdir(), "wt-home-"))
    try {
      const setup = runCli(["setup", "--yes", "--skip-mcp", "--no-launch"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      })
      expect(setup.exitCode).toBe(0)
      const { exitCode } = runCli(["mcp", "setup", "cursor"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
        HOME: home,
      })
      expect(exitCode).toBe(0)
      const cursorPath = join(home, ".cursor", "mcp.json")
      expect(existsSync(cursorPath)).toBe(true)
      const raw = readFileSync(cursorPath, "utf8")
      expect(raw).not.toContain("Authorization")
      // No token minted on a loopback bind.
      expect(existsSync(join(app, "tokens.json"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
      cleanup()
    }
  })
})

describe("shell completion command integration", () => {
  it("generates a completion script free of Bun's /$bunfs/ path", () => {
    const { stdout, exitCode } = runCli(["completion", "zsh"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("#compdef worktable")
    expect(stdout).not.toContain("bunfs")
  })

  it("resolves static subcommands at runtime", () => {
    const { stdout, exitCode } = runCli(["complete", "--", "service", ""])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("install")
    expect(stdout).toContain("logs")
  })

  it("does not leak the internal script-gen command into suggestions", () => {
    const { stdout, exitCode } = runCli(["complete", "--", ""])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("launch") // real commands are present
    expect(stdout).not.toContain("__completion_internal")
  })

  it("resolves live agent ids for `mcp remove`", () => {
    const { env, cleanup } = withTempEnv()
    try {
      writeFileSync(
        join(env.WORKTABLE_APP_DIR, "config.json"),
        JSON.stringify({
          version: 1,
          workspace: env.WORKTABLE_WORKSPACE,
          service: { host: "127.0.0.1", port: 7480, startAtLogin: true },
          mcp: {
            endpoint: "http://127.0.0.1:7480/mcp",
            clients: { codex: { desired: true, state: "configured" } },
          },
        })
      )
      const { stdout, exitCode } = runCli(
        ["complete", "--", "mcp", "remove", ""],
        env
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain("codex")
    } finally {
      cleanup()
    }
  })
})

describe("describeWorkspaceClassification", () => {
  it("lets missing and empty proceed silently", () => {
    expect(describeWorkspaceClassification({ outcome: "missing" })).toEqual({
      ok: true,
      message: "",
    })
    expect(describeWorkspaceClassification({ outcome: "empty" })).toEqual({
      ok: true,
      message: "",
    })
  })

  it("adopts a valid workspace and asks to confirm, echoing the name", () => {
    const result = describeWorkspaceClassification({
      outcome: "valid",
      name: "Acme",
      manifest: {
        type: "worktable.workspace",
        version: 1,
        id: "ws_x",
        name: "Acme",
        createdAt: "2024-01-01T00:00:00.000Z",
        cloud: { status: "unlinked" },
      },
    })
    expect(result.ok).toBe(true)
    expect(result.confirm).toBe(true)
    expect(result.message).toContain("Acme")
    expect(result.message).toContain("Adopting")
  })

  it("blocks each reject reason with the classifier message", () => {
    for (const reason of [
      "not-a-directory",
      "non-empty-non-workspace",
      "corrupt-manifest",
      "unsupported-version",
      "symlink",
    ] as const) {
      const result = describeWorkspaceClassification({
        outcome: "reject",
        reason,
        message: `rejected: ${reason}`,
      })
      expect(result.ok).toBe(false)
      expect(result.message).toBe(`rejected: ${reason}`)
    }
  })
})

describe("workspace adoption and ephemeral launch command integration", () => {
  function tempAppDir(): { appDir: string; cleanup: () => void } {
    const appDir = mkdtempSync(join(tmpdir(), "wt-app-"))
    return {
      appDir,
      cleanup: () => rmSync(appDir, { recursive: true, force: true }),
    }
  }

  it("refuses to take over a foreign folder and leaves it unmutated", () => {
    const { appDir, cleanup } = tempAppDir()
    const workspace = mkdtempSync(join(tmpdir(), "wt-foreign-"))
    writeFileSync(join(workspace, "notes.txt"), "important data")
    try {
      const { stderr, exitCode } = runCli(
        [
          "setup",
          "--yes",
          "--workspace",
          workspace,
          "--skip-mcp",
          "--no-launch",
        ],
        {
          WORKTABLE_APP_DIR: appDir,
        }
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("already contains other files")
      // No manifest written; the foreign file is preserved.
      const entries = readdirSync(workspace).sort()
      expect(entries).toEqual(["notes.txt"])
      expect(existsSync(join(workspace, "worktable.workspace.json"))).toBe(
        false
      )
    } finally {
      cleanup()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("refuses a foreign --workspace on launch --background before persisting or installing a service", () => {
    // The launch override must go through the same adoption gate as setup, and
    // must reject before updateConfig/installService so a foreign folder is
    // never saved to config or installed as a 503-ing background service.
    const { appDir, cleanup } = tempAppDir()
    const workspace = mkdtempSync(join(tmpdir(), "wt-foreign-"))
    writeFileSync(join(workspace, "data.txt"), "keep")
    try {
      const { stderr, exitCode } = runCli(
        ["launch", "--background", "--workspace", workspace],
        {
          WORKTABLE_APP_DIR: appDir,
        }
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("already contains other files")
      expect(readdirSync(workspace).sort()).toEqual(["data.txt"])
    } finally {
      cleanup()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("uses an ephemeral foreground workspace without persisting it", () => {
    const { appDir, cleanup } = tempAppDir()
    const configuredWorkspace = mkdtempSync(join(tmpdir(), "wt-configured-"))
    const ephemeralWorkspace = mkdtempSync(join(tmpdir(), "wt-ephemeral-"))
    const portReservation = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = portReservation.port
    portReservation.stop(true)
    try {
      expect(
        runCli(
          [
            "setup",
            "--yes",
            "--skip-mcp",
            "--no-launch",
            "--workspace",
            configuredWorkspace,
            "--port",
            String(port),
          ],
          { WORKTABLE_APP_DIR: appDir }
        ).exitCode
      ).toBe(0)
      const configPath = join(appDir, "config.json")
      const configBefore = readFileSync(configPath, "utf8")
      const backupBefore = readFileSync(`${configPath}.bak`, "utf8")

      const blocker = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response("occupied"),
      })
      try {
        const result = runCli(
          [
            "launch",
            "--foreground",
            "--no-browser",
            "--port",
            String(blocker.port),
            "--ephemeral-workspace",
            ephemeralWorkspace,
          ],
          { WORKTABLE_APP_DIR: appDir }
        )
        expect(result.exitCode).not.toBe(0)
        const config = JSON.parse(readFileSync(configPath, "utf8")) as {
          workspace: string
        }
        expect(config.workspace).toBe(configuredWorkspace)
        expect(readFileSync(configPath, "utf8")).toBe(configBefore)
        expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(backupBefore)
      } finally {
        blocker.stop(true)
      }
    } finally {
      cleanup()
      rmSync(configuredWorkspace, { recursive: true, force: true })
      rmSync(ephemeralWorkspace, { recursive: true, force: true })
    }
  })

  it("uses ephemeral bind settings without creating CLI config", () => {
    const { appDir, cleanup } = tempAppDir()
    const ephemeralWorkspace = mkdtempSync(join(tmpdir(), "wt-ephemeral-"))
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("occupied"),
    })
    try {
      const result = runCli(
        [
          "launch",
          "--foreground",
          "--no-browser",
          "--host",
          "127.0.0.1",
          "--port",
          String(blocker.port),
          "--ephemeral-workspace",
          ephemeralWorkspace,
        ],
        {
          WORKTABLE_APP_DIR: appDir,
          WORKTABLE_SERVICE_BACKEND: "process",
          PATH: isolatedServiceTestPath(appDir),
        }
      )
      expect(result.exitCode).not.toBe(0)
      expect(existsSync(join(appDir, "config.json"))).toBe(false)
      expect(existsSync(join(appDir, "config.json.bak"))).toBe(false)
    } finally {
      blocker.stop(true)
      cleanup()
      rmSync(ephemeralWorkspace, { recursive: true, force: true })
    }
  })

  it("does not read or repair corrupt CLI config in ephemeral mode", () => {
    const { appDir, cleanup } = tempAppDir()
    const ephemeralWorkspace = mkdtempSync(join(tmpdir(), "wt-ephemeral-"))
    const configPath = join(appDir, "config.json")
    const corruptBytes = "{ definitely not valid config\n"
    writeFileSync(configPath, corruptBytes)
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("occupied"),
    })
    try {
      const result = runCli(
        [
          "launch",
          "--foreground",
          "--no-browser",
          "--port",
          String(blocker.port),
          "--ephemeral-workspace",
          ephemeralWorkspace,
        ],
        { WORKTABLE_APP_DIR: appDir }
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("port may already be in use")
      expect(readFileSync(configPath, "utf8")).toBe(corruptBytes)
      expect(existsSync(`${configPath}.corrupt`)).toBe(false)
      expect(existsSync(`${configPath}.bak`)).toBe(false)
    } finally {
      blocker.stop(true)
      cleanup()
      rmSync(ephemeralWorkspace, { recursive: true, force: true })
    }
  })

  it("trims whitespace before the gate so a padded --workspace can't slip past it", () => {
    // Regression: the gate must classify the same normalized path writeConfig
    // persists. A trailing-space absolute path resolves to a different,
    // nonexistent folder; without trimming the gate would see "missing" and
    // happily initialize the wrong directory while config stored the trimmed one.
    const { appDir, cleanup } = tempAppDir()
    const workspace = mkdtempSync(join(tmpdir(), "wt-foreign-"))
    writeFileSync(join(workspace, "notes.txt"), "important data")
    try {
      const { stderr, exitCode } = runCli(
        [
          "setup",
          "--yes",
          "--workspace",
          `${workspace}  `,
          "--skip-mcp",
          "--no-launch",
        ],
        { WORKTABLE_APP_DIR: appDir }
      )
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("already contains other files")
      const entries = readdirSync(workspace).sort()
      expect(entries).toEqual(["notes.txt"])
      // The padded path must not have spawned a sibling workspace folder either.
      expect(existsSync(`${workspace}  `)).toBe(false)
    } finally {
      cleanup()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("adopts a valid existing workspace and prints its name", () => {
    const { appDir, cleanup } = tempAppDir()
    const workspace = mkdtempSync(join(tmpdir(), "wt-valid-"))
    writeFileSync(
      join(workspace, "worktable.workspace.json"),
      JSON.stringify({
        type: "worktable.workspace",
        version: 1,
        id: "ws_keep-me",
        name: "Existing WS",
        createdAt: "2024-01-01T00:00:00.000Z",
        cloud: { status: "unlinked" },
      })
    )
    try {
      const { stdout, exitCode } = runCli(
        [
          "setup",
          "--yes",
          "--workspace",
          workspace,
          "--skip-mcp",
          "--no-launch",
        ],
        {
          WORKTABLE_APP_DIR: appDir,
        }
      )
      expect(exitCode).toBe(0)
      expect(stdout).toContain("Adopting")
      expect(stdout).toContain("Existing WS")
      // End-to-end: adoption must preserve the existing identity (no rewrite,
      // no new id) and must not seed the folder with new content.
      const persisted = JSON.parse(
        readFileSync(join(workspace, "worktable.workspace.json"), "utf8")
      )
      expect(persisted.id).toBe("ws_keep-me")
      expect(persisted.name).toBe("Existing WS")
      expect(existsSync(join(workspace, "spaces"))).toBe(false)
    } finally {
      cleanup()
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe("Desktop workspace JSON command contract", () => {
  it("inspects the provider default without creating config or workspace content", () => {
    const home = mkdtempSync(join(tmpdir(), "wt-desktop-inspect-home-"))
    const appDir = mkdtempSync(join(tmpdir(), "wt-desktop-inspect-app-"))
    try {
      const result = runCli(["workspace", "inspect", "--json"], {
        HOME: home,
        WORKTABLE_APP_DIR: appDir,
        WORKTABLE_NO_UPDATE_CHECK: "1",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout.trim().split("\n")).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: true,
        inspection: {
          outcome: "missing",
          path: join(home, "Worktable"),
        },
      })
      expect(existsSync(join(home, "Worktable"))).toBe(false)
      expect(existsSync(join(appDir, "config.json"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  it("prepares a new workspace without mutating durable CLI config", () => {
    const base = mkdtempSync(join(tmpdir(), "wt-desktop-prepare-"))
    const target = join(base, "workspace")
    const appDir = mkdtempSync(join(tmpdir(), "wt-desktop-prepare-app-"))
    try {
      const result = runCli(
        ["workspace", "prepare", target, "--intent", "create", "--json"],
        {
          WORKTABLE_APP_DIR: appDir,
          WORKTABLE_NO_UPDATE_CHECK: "1",
        }
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout.trim().split("\n")).toHaveLength(1)
      const body = JSON.parse(result.stdout) as {
        schemaVersion: number
        ok: boolean
        prepared: {
          path: string
          created: boolean
          workspace: { id: string }
        }
      }
      expect(body.schemaVersion).toBe(1)
      expect(body.ok).toBe(true)
      expect(body.prepared.path).toBe(target)
      expect(body.prepared.created).toBe(true)
      expect(body.prepared.workspace.id).toMatch(/^ws_/)
      expect(
        JSON.parse(
          readFileSync(join(target, "worktable.workspace.json"), "utf8")
        ).id
      ).toBe(body.prepared.workspace.id)
      expect(existsSync(join(appDir, "config.json"))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  it("opens an existing workspace without rewriting its manifest", () => {
    const target = mkdtempSync(join(tmpdir(), "wt-desktop-open-"))
    const appDir = mkdtempSync(join(tmpdir(), "wt-desktop-open-app-"))
    const manifestPath = join(target, "worktable.workspace.json")
    const manifest = `${JSON.stringify(
      {
        type: "worktable.workspace",
        version: 1,
        id: "ws_desktop-existing",
        name: "Desktop Existing",
        createdAt: "2024-01-01T00:00:00.000Z",
        cloud: { status: "unlinked" },
      },
      null,
      4
    )}\n`
    writeFileSync(manifestPath, manifest)
    try {
      const result = runCli(
        ["workspace", "prepare", target, "--intent", "open", "--json"],
        {
          WORKTABLE_APP_DIR: appDir,
          WORKTABLE_NO_UPDATE_CHECK: "1",
        }
      )
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        prepared: {
          path: target,
          created: false,
          workspace: { id: "ws_desktop-existing", name: "Desktop Existing" },
        },
      })
      expect(readFileSync(manifestPath, "utf8")).toBe(manifest)
    } finally {
      rmSync(target, { recursive: true, force: true })
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  it("returns a stable machine error when intent does not match", () => {
    const target = mkdtempSync(join(tmpdir(), "wt-desktop-open-empty-"))
    const appDir = mkdtempSync(join(tmpdir(), "wt-desktop-open-empty-app-"))
    try {
      const result = runCli(
        ["workspace", "prepare", target, "--intent", "open", "--json"],
        {
          WORKTABLE_APP_DIR: appDir,
          WORKTABLE_NO_UPDATE_CHECK: "1",
        }
      )
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("")
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        error: {
          code: "EXPECTED_EXISTING_WORKSPACE",
          path: target,
        },
      })
      expect(existsSync(join(target, "worktable.workspace.json"))).toBe(false)
    } finally {
      rmSync(target, { recursive: true, force: true })
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  it("returns versioned JSON for an invalid preparation intent", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-desktop-invalid-intent-"))
    try {
      const result = runCli([
        "workspace",
        "prepare",
        root,
        "--intent",
        "replace",
        "--json",
      ])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("")
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        error: { code: "INVALID_INTENT" },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns versioned JSON for unexpected filesystem preparation failures", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-desktop-fs-failure-"))
    const regularFile = join(root, "regular-file")
    writeFileSync(regularFile, "not a directory")
    const target = join(regularFile, "workspace")
    try {
      const result = runCli([
        "workspace",
        "prepare",
        target,
        "--intent",
        "create",
        "--json",
      ])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout.trim().split("\n")).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        error: {
          code: "WORKSPACE_PREPARATION_FAILED",
          path: target,
        },
      })
      expect(JSON.parse(result.stdout).error.message.toLowerCase()).toContain(
        "not a directory"
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("uninstall and purge command integration", () => {
  // Shared fixture: a configured install plus the on-disk artifacts an uninstall
  // is meant to clean up (launchers, completions). XDG vars route completions
  // into the temp tree so the test never touches the real ~/.local paths.
  // WORKTABLE_RELEASE_DIR is always pinned to a temp dir — a derived release dir
  // in a source checkout would resolve to the repo tree.
  function setupInstall(): {
    ws: string
    app: string
    home: string
    installDir: string
    releaseParent: string
    bashCompletion: string
    env: Record<string, string>
    cleanup: () => void
  } {
    const ws = mkdtempSync(join(tmpdir(), "wt-uninstall-ws-"))
    const app = mkdtempSync(join(tmpdir(), "wt-uninstall-app-"))
    const home = mkdtempSync(join(tmpdir(), "wt-uninstall-home-"))
    const installDir = mkdtempSync(join(tmpdir(), "wt-uninstall-bin-"))
    // dirname(releaseDir) is what uninstall removes; the parent must exist but
    // the leaf need not. Keep it separate from installDir.
    const releaseParent = mkdtempSync(join(tmpdir(), "wt-uninstall-rel-"))
    const releaseDir = join(releaseParent, "0.0.1")
    const skillSource = join(releaseDir, "integrations", "worktable-skills")
    for (const name of [
      "worktable-create-or-update-docs",
      "worktable-create-or-manage-records",
      "worktable-review-with-annotations",
    ]) {
      mkdirSync(join(skillSource, name), { recursive: true })
      writeFileSync(join(skillSource, name, "SKILL.md"), `# ${name}\n`)
    }
    const xdgData = mkdtempSync(join(tmpdir(), "wt-uninstall-data-"))
    const xdgConfig = mkdtempSync(join(tmpdir(), "wt-uninstall-cfg-"))
    // A config must exist for `uninstall` to name the workspace it preserves.
    expect(
      runCli(["setup", "--yes", "--skip-mcp", "--no-launch"], {
        WORKTABLE_WORKSPACE: ws,
        WORKTABLE_APP_DIR: app,
      }).exitCode
    ).toBe(0)
    // Simulate the two launchers install.sh writes onto PATH.
    writeFileSync(join(installDir, "worktable"), "#!/bin/sh\n")
    writeFileSync(join(installDir, "wtb"), "#!/bin/sh\n")
    // Simulate a bash completion install.sh would have written.
    const bashCompletionDir = join(xdgData, "bash-completion", "completions")
    mkdirSync(bashCompletionDir, { recursive: true })
    const bashCompletion = join(bashCompletionDir, "worktable")
    writeFileSync(bashCompletion, "# worktable completion\n")
    const env = {
      WORKTABLE_WORKSPACE: ws,
      WORKTABLE_APP_DIR: app,
      HOME: home,
      WORKTABLE_INSTALL_DIR: installDir,
      WORKTABLE_LAUNCHER: join(installDir, "worktable"),
      WORKTABLE_RELEASE_DIR: releaseDir,
      WORKTABLE_SERVICE_BACKEND: "unsupported",
      XDG_DATA_HOME: xdgData,
      XDG_CONFIG_HOME: xdgConfig,
    }
    return {
      ws,
      app,
      home,
      installDir,
      releaseParent,
      bashCompletion,
      env,
      cleanup: () => {
        for (const dir of [
          ws,
          app,
          home,
          installDir,
          releaseParent,
          xdgData,
          xdgConfig,
        ])
          rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  it("removes launchers, app data, and completions while preserving the workspace", () => {
    const fx = setupInstall()
    try {
      const { exitCode, stdout } = runCli(["uninstall", "--yes"], fx.env)
      expect(exitCode).toBe(0)
      // Both launchers gone — `wtb` must not linger pointing at a removed tree.
      expect(existsSync(join(fx.installDir, "worktable"))).toBe(false)
      expect(existsSync(join(fx.installDir, "wtb"))).toBe(false)
      // App data (config, tokens, logs) wiped — no machine-local state lingers.
      expect(existsSync(fx.app)).toBe(false)
      // Shell completion for the removed binary is cleaned up.
      expect(existsSync(fx.bashCompletion)).toBe(false)
      // Workspace and its contents are preserved by default.
      expect(existsSync(fx.ws)).toBe(true)
      expect(stdout).toContain("Workspace preserved")
    } finally {
      fx.cleanup()
    }
  })

  it("removes exact siblings and reports modified and missing paths from one manifest before deleting ownership", () => {
    const fx = setupInstall()
    try {
      const agentsInstall = runCli(
        ["skills", "install", "agents", "--yes", "--json"],
        fx.env
      )
      expectCliSuccess(agentsInstall, "Agent Skills install before uninstall")
      const target = JSON.parse(agentsInstall.stdout).result.statusAfter
        .targetRoot as string
      const modifiedSkill = join(target, "worktable-create-or-update-docs")
      const exactSkill = join(target, "worktable-review-with-annotations")
      const missingSkill = join(target, "worktable-create-or-manage-records")
      writeFileSync(
        join(modifiedSkill, "SKILL.md"),
        "# My locally modified Worktable skill\n"
      )
      rmSync(missingSkill, { recursive: true })

      const { exitCode, stdout } = runCli(["uninstall", "--yes"], fx.env)
      expect(exitCode).toBe(0)
      expect(existsSync(exactSkill)).toBe(false)
      expect(existsSync(modifiedSkill)).toBe(true)
      expect(existsSync(missingSkill)).toBe(false)
      expect(readFileSync(join(modifiedSkill, "SKILL.md"), "utf8")).toBe(
        "# My locally modified Worktable skill\n"
      )
      expect(existsSync(fx.app)).toBe(false)
      expect(stdout).toContain(`Changed skills preserved at ${target}`)
      expect(stdout).toContain(`Locally modified: ${modifiedSkill}`)
      expect(stdout).toContain(`Already missing: ${missingSkill}`)
      expect(stdout).toContain(
        "Move or remove locally changed Worktable skill folders before reinstalling"
      )
    } finally {
      fx.cleanup()
    }
  })

  it("keeps MCP and service state intact when skill uninstall preflight fails", () => {
    const fx = setupInstall()
    const codexConfig = join(fx.home, ".codex", "config.toml")
    const serviceMarker = join(fx.app, "managed-service.json")
    const env = {
      ...fx.env,
      WORKTABLE_SERVICE_BACKEND: "process",
      WORKTABLE_CODEX_CONFIG: codexConfig,
    }
    const commandEnv: Record<string, string> = { ...env }
    delete commandEnv.WORKTABLE_WORKSPACE
    try {
      const configPath = join(fx.app, "config.json")
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      config.mcp.clients.codex = { desired: true }
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
      const originalCodexConfig =
        '[mcp_servers.worktable]\nurl = "https://app.worktable.cloud/api/mcp"\n'
      mkdirSync(join(fx.home, ".codex"), { recursive: true })
      writeFileSync(codexConfig, originalCodexConfig)
      const originalServiceMarker = "{}\n"
      writeFileSync(serviceMarker, originalServiceMarker)

      const installed = runCli(
        ["skills", "install", "agents", "--yes", "--json"],
        commandEnv
      )
      expectCliSuccess(
        installed,
        "Agent Skills install before rejected uninstall"
      )
      const manifestDir = join(fx.app, "agent-skills", "projections", "v2")
      writeFileSync(join(manifestDir, readdirSync(manifestDir)[0]!), "{")

      const rejected = runCli(["uninstall", "--yes"], commandEnv)
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.stderr).toMatch(/skill installation state.*invalid/i)
      expect(readFileSync(codexConfig, "utf8")).toBe(originalCodexConfig)
      expect(readFileSync(serviceMarker, "utf8")).toBe(originalServiceMarker)
      expect(existsSync(join(fx.installDir, "worktable"))).toBe(true)
      expect(existsSync(join(fx.installDir, "wtb"))).toBe(true)
      expect(existsSync(fx.app)).toBe(true)
    } finally {
      fx.cleanup()
    }
  })

  it("proves skill target writes before disconnecting MCP or stopping the service", () => {
    const fx = setupInstall()
    const codexConfig = join(fx.home, ".codex", "config.toml")
    const serviceMarker = join(fx.app, "managed-service.json")
    const target = join(fx.home, ".agents", "skills")
    const env = {
      ...fx.env,
      WORKTABLE_SERVICE_BACKEND: "process",
      WORKTABLE_CODEX_CONFIG: codexConfig,
    }
    const commandEnv: Record<string, string> = { ...env }
    delete commandEnv.WORKTABLE_WORKSPACE
    try {
      const configPath = join(fx.app, "config.json")
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      config.mcp.clients.codex = { desired: true }
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
      const originalCodexConfig =
        '[mcp_servers.worktable]\nurl = "https://app.worktable.cloud/api/mcp"\n'
      mkdirSync(join(fx.home, ".codex"), { recursive: true })
      writeFileSync(codexConfig, originalCodexConfig)
      const originalServiceMarker = "{}\n"
      writeFileSync(serviceMarker, originalServiceMarker)

      const installed = runCli(
        ["skills", "install", "agents", "--yes", "--json"],
        commandEnv
      )
      expectCliSuccess(installed, "Agent Skills install before write preflight")
      chmodSync(target, 0o500)

      const rejected = runCli(["uninstall", "--yes"], commandEnv)
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.stderr).toMatch(/cannot safely write.*during uninstall/i)
      expect(readFileSync(codexConfig, "utf8")).toBe(originalCodexConfig)
      expect(readFileSync(serviceMarker, "utf8")).toBe(originalServiceMarker)
      expect(existsSync(join(fx.installDir, "worktable"))).toBe(true)
      expect(existsSync(join(fx.installDir, "wtb"))).toBe(true)
      expect(existsSync(join(target, "worktable-create-or-update-docs"))).toBe(
        true
      )
      expect(existsSync(fx.app)).toBe(true)
    } finally {
      if (existsSync(target)) chmodSync(target, 0o700)
      fx.cleanup()
    }
  })

  it("still cleans up machine-local state when the config is corrupt", () => {
    const fx = setupInstall()
    try {
      // A broken install: config.json is unreadable AND its backup is gone, so
      // readConfig can't self-heal. uninstall must still remove machine-local state
      // instead of throwing on the config read.
      writeFileSync(join(fx.app, "config.json"), "{ not valid json")
      rmSync(join(fx.app, "config.json.bak"), { force: true })
      const { exitCode, stdout } = runCli(["uninstall", "--yes"], fx.env)
      expect(exitCode).toBe(0)
      expect(existsSync(join(fx.installDir, "worktable"))).toBe(false)
      expect(existsSync(fx.app)).toBe(false)
      // The workspace path couldn't be trusted from a corrupt config, so it's left.
      expect(existsSync(fx.ws)).toBe(true)
      expect(stdout).toContain("config was unreadable")
    } finally {
      fx.cleanup()
    }
  })

  it("refuses without --yes when there is no interactive terminal and removes nothing", () => {
    const fx = setupInstall()
    try {
      // The subprocess has no TTY; without --yes there is no way to confirm.
      const { exitCode, stderr } = runCli(["uninstall"], fx.env)
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("--yes")
      // Nothing was touched.
      expect(existsSync(join(fx.installDir, "worktable"))).toBe(true)
      expect(existsSync(fx.app)).toBe(true)
      expect(existsSync(fx.bashCompletion)).toBe(true)
      expect(existsSync(fx.ws)).toBe(true)
    } finally {
      fx.cleanup()
    }
  })

  it("keeps the authority lock until a purged workspace is fully deleted", async () => {
    const fx = setupInstall()
    // Enough real files make the destructive interval observable from a competing
    // process. Once uninstall publishes its lock, there must never be a moment when
    // app data (and therefore the lock) is gone while workspace contents remain.
    for (let index = 0; index < 3_000; index += 1) {
      writeFileSync(join(fx.ws, `purge-${index}.txt`), "delete me\n")
    }
    try {
      let settled = false
      const pending = runCliAsync(["uninstall", "--yes", "--purge"], fx.env)
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      const lockPath = join(fx.app, "local-authority.lock")
      let sawLock = false
      let sawUnlockedLiveWorkspace = false
      while (!settled) {
        if (existsSync(lockPath)) sawLock = true
        else if (sawLock && existsSync(fx.ws)) {
          sawUnlockedLiveWorkspace = true
        }
        // test-policy: external-readiness-backoff
        await Bun.sleep(1)
      }
      const { exitCode, stdout } = await pending
      expect(exitCode).toBe(0)
      expect(sawLock).toBe(true)
      expect(sawUnlockedLiveWorkspace).toBe(false)
      expect(existsSync(fx.ws)).toBe(false)
      expect(stdout).toContain("Workspace deleted")
    } finally {
      fx.cleanup()
    }
  }, 30_000)
})
