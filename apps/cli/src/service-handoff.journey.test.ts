import { expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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

function runCli(
  args: string[],
  home: string,
  env: Record<string, string>
): CliResult {
  const result = Bun.spawnSync(["bun", "run", cliEntry, ...args], {
    env: cliTestEnvironment(home, env),
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }
}

function expectSuccess(result: CliResult, context: string): void {
  if (result.exitCode === 0) return
  throw new Error(
    `${context} exited ${result.exitCode}\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`
  )
}

it("refuses a managed child that cannot prove the installed workspace and endpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "wt-service-proof-journey-"))
  const workspace = join(root, "workspace")
  const appDir = join(root, "app")
  const home = join(root, "home")
  const isolatedBin = join(root, "bin")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(appDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(isolatedBin, { recursive: true })
  symlinkSync(process.execPath, join(isolatedBin, "bun"))

  const reservation = Bun.serve({
    port: 0,
    fetch: () => new Response("reserved"),
  })
  const port = reservation.port
  reservation.stop(true)

  // The managed child is an external process boundary. Give it a real health
  // listener and PID marker, but deliberately no authority lease. Booting the
  // full application here made its cold-start time compete with the manager's
  // five-second PID deadline before this refusal contract could be exercised.
  const childEntry = join(root, "unproven-child.ts")
  writeFileSync(
    childEntry,
    `import { writeFileSync } from "node:fs"
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch: () => Response.json({ ok: true, service: "worktable" }),
})
writeFileSync(process.env.WORKTABLE_MANAGED_PID_FILE!, String(process.pid))
`
  )
  const launcher = join(appDir, "worktable-unproven-launcher.sh")
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec bun run ${JSON.stringify(childEntry)}\n`,
    { mode: 0o755 }
  )
  const environment = {
    WORKTABLE_WORKSPACE: workspace,
    WORKTABLE_APP_DIR: appDir,
    WORKTABLE_SERVICE_BACKEND: "process",
    WORKTABLE_LAUNCHER: launcher,
    WORKTABLE_NO_UPDATE_CHECK: "1",
    FORCE_COLOR: "0",
    PATH: isolatedBin,
  }

  try {
    expectSuccess(
      runCli(
        [
          "setup",
          "--yes",
          "--skip-mcp",
          "--background",
          "--no-launch",
          "--host",
          "0.0.0.0",
          "--owner-password",
          "correct-horse-battery-staple",
          "--port",
          String(port),
        ],
        home,
        environment
      ),
      "wrong-endpoint setup"
    )

    const started = runCli(["service", "start"], home, environment)
    expect(started.exitCode).toBe(1)
    expect(started.stderr).toContain(
      "endpoint answered at"
    )
    expect(started.stderr).toContain("no live local runtime lease")
    expect(
      JSON.parse(
        runCli(["service", "status", "--json"], home, environment).stdout
      )
    ).toMatchObject({ state: "stopped" })
    expect(existsSync(join(appDir, "service.pid"))).toBe(false)
  } finally {
    runCli(["service", "stop"], home, environment)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
