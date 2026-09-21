import { describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cliTestEnvironment } from "./cli-test-harness.ts"

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number
}

const cliEntry = join(import.meta.dir, "index.ts")

function subprocessEnvironment(
  home: string,
  overrides: Record<string, string>
): Record<string, string> {
  return cliTestEnvironment(home, overrides)
}

function runCli(
  args: string[],
  home: string,
  env: Record<string, string>
): CliResult {
  const result = Bun.spawnSync([process.execPath, cliEntry, ...args], {
    env: subprocessEnvironment(home, env),
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }
}

async function runCliAsync(
  args: string[],
  home: string,
  env: Record<string, string>
): Promise<CliResult> {
  const child = Bun.spawn([process.execPath, cliEntry, ...args], {
    env: subprocessEnvironment(home, env),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

function isolatedServicePath(appDir: string): string {
  const directory = join(appDir, "isolated-service-bin")
  mkdirSync(directory, { recursive: true })
  const bun = join(directory, "bun")
  if (!existsSync(bun)) symlinkSync(process.execPath, bun)
  const shell = join(directory, "sh")
  if (!existsSync(shell)) symlinkSync("/bin/sh", shell)
  return directory
}

function expectSuccess(result: CliResult, context: string): void {
  if (result.exitCode === 0) return
  throw new Error(
    `${context} exited ${result.exitCode}\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`
  )
}

describe("installed update subprocess journey", () => {
  it("preserves update status and serializes installed service restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-update-journey-"))
    const home = join(root, "home")
    const workspace = join(root, "workspace")
    const appDir = join(root, "app")
    const releaseDir = join(root, "release")
    mkdirSync(home, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    mkdirSync(appDir, { recursive: true })
    mkdirSync(releaseDir, { recursive: true })

    const releaseHost = Bun.serve({
      port: 0,
      fetch: () => Response.json({ version: "0.0.10" }),
    })
    const installerRecord = join(releaseDir, "install-args.txt")
    writeFileSync(
      join(releaseDir, "install.sh"),
      `#!/bin/sh\necho "$@" > "${installerRecord}"\n`
    )
    const launcher = join(appDir, "worktable-test-launcher.sh")
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntry)} "$@"\n`,
      { mode: 0o755 }
    )
    const baseEnvironment = {
      WORKTABLE_WORKSPACE: workspace,
      WORKTABLE_APP_DIR: appDir,
      WORKTABLE_VERSION: "0.0.10",
      WORKTABLE_RELEASE_BASE_URL: `http://127.0.0.1:${releaseHost.port}`,
      WORKTABLE_RELEASE_DIR: releaseDir,
      WORKTABLE_SERVICE_BACKEND: "process",
      WORKTABLE_LAUNCHER: launcher,
      FORCE_COLOR: "0",
    }

    try {
      const statusFile = join(appDir, "update-status.json")
      const noOp = await runCliAsync(
        ["update", "--background", "--status-file", statusFile],
        home,
        baseEnvironment
      )
      expectSuccess(noOp, "background no-op update")
      expect(JSON.parse(readFileSync(statusFile, "utf8"))).toMatchObject({
        state: "succeeded",
        noop: true,
        from: "0.0.10",
        to: "0.0.10",
      })
      expect(existsSync(installerRecord)).toBe(false)

      const reservation = Bun.serve({
        port: 0,
        fetch: () => new Response(),
      })
      const port = reservation.port
      reservation.stop(true)
      const serviceEnvironment = {
        ...baseEnvironment,
        WORKTABLE_NO_UPDATE_CHECK: "1",
        PATH: isolatedServicePath(appDir),
      }
      expectSuccess(
        runCli(
          [
            "launch",
            "--background",
            "--no-browser",
            "--workspace",
            workspace,
            "--port",
            String(port),
          ],
          home,
          serviceEnvironment
        ),
        "managed service launch"
      )

      const runtimePath = join(appDir, "local-runtime.json")
      const interactive = runCli(["update", "9.9.9"], home, serviceEnvironment)
      expectSuccess(interactive, "interactive managed update")
      expect(readFileSync(installerRecord, "utf8").trim()).toBe(
        "--version v9.9.9 --no-setup"
      )
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true)

      const markManagedRuntimeAsStaleCli = (): void => {
        const runtime = JSON.parse(readFileSync(runtimePath, "utf8"))
        expect(runtime.owner).toBe("service")
        writeFileSync(
          runtimePath,
          JSON.stringify({ ...runtime, owner: "cli" }, null, 2) + "\n"
        )
      }

      markManagedRuntimeAsStaleCli()
      const desktopRestart = runCli(
        ["local-host", "restart"],
        home,
        serviceEnvironment
      )
      expectSuccess(desktopRestart, "Desktop restart with stale runtime owner")
      expect(JSON.parse(desktopRestart.stdout)).toMatchObject({
        ok: true,
        action: "attach",
        owner: "service",
      })

      markManagedRuntimeAsStaleCli()
      rmSync(installerRecord, { force: true })

      // This is the one real installed-update boundary. The cheaper update and
      // authority tests own status permutations; this journey proves that the
      // actual worker, installer, authority retry, manager restart, and new
      // service boot cooperate even when an older release left a stale owner label.
      const lockPath = join(appDir, "local-authority.lock")
      writeFileSync(
        lockPath,
        JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          nonce: "live-background-update-lock",
        })
      )
      let backgroundSettled = false
      const backgroundPending = runCliAsync(
        ["update", "0.0.10", "--background"],
        home,
        serviceEnvironment
      )
      void backgroundPending.then(
        () => {
          backgroundSettled = true
        },
        () => {
          backgroundSettled = true
        }
      )
      const installerDeadline = Date.now() + 5_000
      while (!existsSync(installerRecord) && Date.now() < installerDeadline) {
        // test-policy: external-readiness-backoff
        await Bun.sleep(10)
      }
      expect(existsSync(installerRecord)).toBe(true)
      expect(backgroundSettled).toBe(false)
      expect(existsSync(lockPath)).toBe(true)
      rmSync(lockPath, { force: true })

      const background = await backgroundPending
      expectSuccess(background, "background managed update")
      expect(readFileSync(installerRecord, "utf8").trim()).toBe(
        "--version v0.0.10 --no-setup"
      )
      expect(JSON.parse(readFileSync(runtimePath, "utf8"))).toMatchObject({
        owner: "service",
      })
      expect(
        JSON.parse(readFileSync(join(appDir, "update-status.json"), "utf8"))
      ).toMatchObject({ state: "succeeded" })
      expect(existsSync(lockPath)).toBe(false)
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true)
    } finally {
      rmSync(join(appDir, "local-authority.lock"), { force: true })
      runCli(["service", "stop"], home, {
        ...baseEnvironment,
        WORKTABLE_NO_UPDATE_CHECK: "1",
        PATH: isolatedServicePath(appDir),
      })
      releaseHost.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
