// Terminal styling and CLI error helpers.
//
// Color is gated on NO_COLOR / FORCE_COLOR (the de-facto standards) and stdout
// being a TTY, so piped or redirected output never captures raw escape codes.
// Evaluated per call so tests and subprocesses see the current environment.

export function colorEnabled(): boolean {
  // FORCE_COLOR=0/false disables; any other non-empty value forces color on.
  const force = process.env["FORCE_COLOR"]
  if (force === "0" || force === "false") return false
  if (force != null && force !== "") return true
  // NO_COLOR disables on presence regardless of value (per the NO_COLOR spec).
  if (process.env["NO_COLOR"] != null) return false
  return Boolean(process.stdout.isTTY)
}

const wrap =
  (open: string, close: string) =>
  (value: string): string =>
    colorEnabled() ? `${open}${value}${close}` : value

const RESET = "\x1b[0m"

export const style = {
  bold: wrap("\x1b[1m", RESET),
  dim: wrap("\x1b[2m", RESET),
  cyan: wrap("\x1b[36m", RESET),
  magenta: wrap("\x1b[35m", RESET),
  yellow: wrap("\x1b[33m", RESET),
  green: wrap("\x1b[32m", RESET),
  white: wrap("\x1b[37m", RESET),
}

/**
 * A user-facing input error (bad value, unknown selection). Prints a clean
 * message to stderr without a `Fatal:` prefix or stack trace, and exits 1.
 * Distinct from unexpected runtime failures, which keep the `Fatal:` prefix.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

/** Write an error to stderr and mark the process as failed (without exiting). */
export function fail(message: string): void {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
