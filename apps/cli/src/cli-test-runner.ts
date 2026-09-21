import { format } from "node:util"
import { join } from "node:path"
import { buildProgram, preprocessArgv } from "./index.ts"
import { setServiceHomeOverride } from "./service.ts"
import { UsageError } from "./style.ts"

export interface CliTestResult {
  stdout: string
  stderr: string
  exitCode: number
}

class CapturedProcessExit extends Error {
  readonly exitCode: number

  constructor(exitCode: number) {
    super(`CLI requested process exit ${exitCode}`)
    this.exitCode = exitCode
  }
}

function replaceEnvironment(next: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) delete process.env[key]
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) process.env[key] = value
  }
}

function commandExitCode(error: unknown): number | null {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("commander.")
  ) {
    const exitCode = (error as { exitCode?: unknown }).exitCode
    return typeof exitCode === "number" ? exitCode : 1
  }
  return null
}

/**
 * Exercise the real Commander graph and command handlers without paying for a
 * fresh Bun runtime for every sibling case. The harness isolates every mutable
 * process boundary that the CLI owns and restores it before returning.
 *
 * This is intentionally test support, not a parallel command model: retained
 * journeys still prove argv/stdout/process behavior in a real child process.
 */
export async function runCliInProcess(
  args: string[],
  env: Record<string, string> = {}
): Promise<CliTestResult> {
  const originalEnvironment = { ...process.env }
  const originalExitCode = process.exitCode
  const originalLog = console.log
  const originalError = console.error
  const originalWarn = console.warn
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalProcessExit = process.exit
  let stdout = ""
  let stderr = ""
  let exitCode = 0

  const appendLine = (target: "stdout" | "stderr", values: unknown[]) => {
    const rendered = `${format(...values)}\n`
    if (target === "stdout") stdout += rendered
    else stderr += rendered
  }

  try {
    const isolatedHome = env.HOME
    const isolatedEnvironment = isolatedHome
      ? {
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
          WORKTABLE_CODEX_CONFIG: join(isolatedHome, ".codex", "config.toml"),
          WORKTABLE_CURSOR_MCP_CONFIG: join(
            isolatedHome,
            ".cursor",
            "mcp.json"
          ),
          WORKTABLE_OPENCODE_CONFIG: join(
            isolatedHome,
            ".config",
            "opencode",
            "opencode.json"
          ),
          WORKTABLE_VSCODE_MCP_CONFIG: join(
            isolatedHome,
            ".config",
            "Code",
            "User",
            "mcp.json"
          ),
          CLAUDE_CONFIG_DIR: join(isolatedHome, ".claude"),
          ...env,
        }
      : env
    replaceEnvironment(isolatedEnvironment)
    setServiceHomeOverride(isolatedHome ?? null)
    process.exitCode = 0
    console.log = (...values: unknown[]) => appendLine("stdout", values)
    console.error = (...values: unknown[]) => appendLine("stderr", values)
    console.warn = (...values: unknown[]) => appendLine("stderr", values)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stderr.write
    process.exit = ((code = 0) => {
      throw new CapturedProcessExit(typeof code === "number" ? code : 1)
    }) as typeof process.exit

    const program = buildProgram()
    program.exitOverride()
    program.configureOutput({
      writeOut: (value) => {
        stdout += value
      },
      writeErr: (value) => {
        stderr += value
      },
    })
    try {
      await program.parseAsync(preprocessArgv(args), { from: "user" })
      exitCode =
        typeof process.exitCode === "number" ? process.exitCode : exitCode
    } catch (error) {
      const commanderExit = commandExitCode(error)
      if (commanderExit !== null) {
        exitCode = commanderExit
      } else if (error instanceof CapturedProcessExit) {
        exitCode = error.exitCode
      } else if (error instanceof UsageError) {
        stderr += `${error.message}\n`
        exitCode = 1
      } else {
        stderr += `Fatal: ${error instanceof Error ? error.message : String(error)}\n`
        exitCode = 1
      }
    }
  } finally {
    console.log = originalLog
    console.error = originalError
    console.warn = originalWarn
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalProcessExit
    setServiceHomeOverride(null)
    replaceEnvironment(originalEnvironment)
    process.exitCode = originalExitCode
  }

  return { stdout, stderr, exitCode }
}
