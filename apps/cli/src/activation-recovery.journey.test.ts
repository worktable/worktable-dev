import { expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cliTestEnvironment } from "./cli-test-harness.ts"

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

const cliEntry = join(import.meta.dir, "index.ts")

async function runCli(
  args: string[],
  environment: Record<string, string>
): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, cliEntry, ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function expectSuccess(
  pending: Promise<CliResult>,
  context: string
): Promise<CliResult> {
  const result = await pending
  if (result.exitCode === 0) return result
  throw new Error(
    `${context} exited ${result.exitCode}\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`
  )
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("reserved") })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error("Could not allocate a test port")
  return port
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`)
    }
    // test-policy: external-readiness-backoff
    await Bun.sleep(50)
  }
}

it("retains a recoverable activation journal when the previous managed service cannot be restored", async () => {
  const root = mkdtempSync(join(tmpdir(), "wt-activation-recovery-journey-"))
  const appDir = join(root, "app")
  const home = join(root, "home")
  const first = join(root, "first")
  const second = join(root, "second")
  const isolatedBin = join(root, "bin")
  mkdirSync(appDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(isolatedBin, { recursive: true })
  const environment = cliTestEnvironment(home, {
    PATH: isolatedBin,
    WORKTABLE_APP_DIR: appDir,
    WORKTABLE_SERVICE_BACKEND: "process",
    WORKTABLE_NO_UPDATE_CHECK: "1",
  })
  const launcher = join(appDir, "worktable-test-launcher.sh")
  const workingLauncher = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntry)} "$@"\n`
  writeFileSync(launcher, workingLauncher, { mode: 0o755 })
  environment["WORKTABLE_LAUNCHER"] = launcher

  try {
    await expectSuccess(
      runCli(
        ["workspace", "prepare", first, "--intent", "create", "--json"],
        environment
      ),
      "first workspace preparation"
    )
    await expectSuccess(
      runCli(
        ["workspace", "prepare", second, "--intent", "create", "--json"],
        environment
      ),
      "second workspace preparation"
    )
    const port = await freePort()
    await expectSuccess(
      runCli(
        [
          "setup",
          "--yes",
          "--skip-mcp",
          "--background",
          "--no-launch",
          "--workspace",
          first,
          "--port",
          String(port),
        ],
        environment
      ),
      "managed activation setup"
    )
    await expectSuccess(
      runCli(["launch", "--background", "--no-browser"], environment),
      "managed activation launch"
    )
    await waitForFile(join(appDir, "local-runtime.json"))

    const configPath = join(appDir, "config.json")
    const registryPath = join(appDir, "local-workspaces.json")
    const beforeConfig = readFileSync(configPath, "utf8")
    const beforeRegistry = readFileSync(registryPath, "utf8")

    // Make both the target start and rollback restart fail at process creation.
    // A launcher that starts and then exits makes the process backend wait for
    // its production PID deadline twice, which adds no evidence about journal
    // recovery and makes this test depend on runner load.
    rmSync(launcher)
    const failed = await runCli(
      ["local-host", "activate", second, "--json"],
      environment
    )
    expect(failed.exitCode).toBe(1)
    expect(JSON.parse(failed.stdout)).toMatchObject({
      ok: false,
      error: { code: "ACTIVATION_ROLLBACK_FAILED" },
    })
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig)
    expect(readFileSync(registryPath, "utf8")).toBe(beforeRegistry)
    expect(existsSync(join(appDir, "local-activation.json"))).toBe(true)
  } finally {
    writeFileSync(launcher, workingLauncher, { mode: 0o755 })
    await runCli(["service", "stop"], environment)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
