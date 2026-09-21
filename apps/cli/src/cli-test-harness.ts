import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliTestResult } from "./cli-test-runner.ts"

export interface CliTestWorker {
  run(args: string[], env?: Record<string, string>): CliTestResult
  runAsync(args: string[], env?: Record<string, string>): Promise<CliTestResult>
  close(): Promise<void>
}

export function cliTestEnvironment(
  home: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  // A test runner may itself live under launchd/systemd. Do not let that
  // ambient manager identity turn ordinary foreground children into services;
  // tests that own that contract add the marker back explicitly.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== "HOST" &&
        key !== "PORT" &&
        key !== "XPC_SERVICE_NAME" &&
        key !== "INVOCATION_ID" &&
        key !== "JOURNAL_STREAM" &&
        !key.startsWith("WORKTABLE_")
    )
  ) as Record<string, string>
  return {
    ...inherited,
    HOME: home,
    WORKTABLE_LAUNCHER: join(import.meta.dir, "..", "bin", "worktable.ts"),
    WORKTABLE_SKIP_STARTER_SEED: "1",
    WORKTABLE_SKIP_LINT_SWEEP: "1",
    WORKTABLE_SKIP_RETENTION_SWEEP: "1",
    WORKTABLE_SKIP_RECORD_RECONCILE_SWEEP: "1",
    ...overrides,
  }
}

function waitSynchronously(
  predicate: () => boolean,
  deadline: number,
  diagnostic: string
): void {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(diagnostic)
    // test-policy: external-readiness-backoff
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
  }
}

export function createCliTestWorker(home: string): CliTestWorker {
  const mailbox = mkdtempSync(join(tmpdir(), "worktable-cli-worker-"))
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "cli-test-worker.ts"), mailbox],
    {
      env: cliTestEnvironment(home),
      stdout: "inherit",
      stderr: "inherit",
    }
  )
  waitSynchronously(
    () => existsSync(join(mailbox, "ready")),
    Date.now() + 10_000,
    "Timed out starting the in-process CLI test worker"
  )

  let sequence = 0
  let closed = false

  const submit = (
    args: string[],
    env: Record<string, string>
  ): { responsePath: string; deadline: number } => {
    if (closed) throw new Error("CLI test worker is already closed")
    sequence += 1
    const id = `${String(sequence).padStart(6, "0")}-${Date.now()}`
    const requestPath = join(mailbox, `request-${id}.json`)
    const temporaryPath = `${requestPath}.${process.pid}.tmp`
    const responsePath = join(mailbox, `response-${id}.json`)
    writeFileSync(
      temporaryPath,
      JSON.stringify({
        args,
        env: cliTestEnvironment(home, env),
      }),
      { mode: 0o600 }
    )
    renameSync(temporaryPath, requestPath)
    return { responsePath, deadline: Date.now() + 30_000 }
  }

  const consume = (responsePath: string): CliTestResult => {
    const response = JSON.parse(
      readFileSync(responsePath, "utf8")
    ) as CliTestResult
    rmSync(responsePath, { force: true })
    return response
  }

  return {
    run(args, env = {}) {
      const { responsePath, deadline } = submit(args, env)
      waitSynchronously(
        () => existsSync(responsePath),
        deadline,
        `Timed out running CLI test command: ${args.join(" ")}`
      )
      return consume(responsePath)
    },
    async runAsync(args, env = {}) {
      const { responsePath, deadline } = submit(args, env)
      while (!existsSync(responsePath)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out running CLI test command: ${args.join(" ")}`
          )
        }
        // test-policy: external-readiness-backoff
        await Bun.sleep(2)
      }
      return consume(responsePath)
    },
    async close() {
      if (closed) return
      closed = true
      writeFileSync(join(mailbox, "stop"), "")
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      const exit = await Promise.race([
        child.exited,
        new Promise<null>((resolve) => {
          closeTimer = setTimeout(() => resolve(null), 2_000)
        }),
      ])
      if (closeTimer !== undefined) clearTimeout(closeTimer)
      if (exit === null) {
        child.kill("SIGTERM")
        await child.exited
      }
      rmSync(mailbox, { recursive: true, force: true })
    },
  }
}
