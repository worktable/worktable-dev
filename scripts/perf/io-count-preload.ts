/**
 * Preloaded into the server by io-count.ts (`bun --preload`). Logs every SQL
 * statement the process executes and every timer callback of 100 ms or more,
 * one JSON line each, to the file named by WORKTABLE_PERF_IO_LOG.
 *
 * File I/O is not counted here: Bun binds `node:fs` named imports before a
 * preload can wrap them, so io-count.ts takes file system calls from strace.
 * bun:sqlite statements are plain objects whose methods are set per instance,
 * so they are wrapped as `query` and `prepare` hand them out.
 *
 * The log is opened once and written with writeSync, so logging adds write
 * calls only: no open or stat that strace would count against a request.
 */
import { closeSync, openSync, writeSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { Database } from "bun:sqlite"

const target = process.env["WORKTABLE_PERF_IO_LOG"]
// Sites are shown relative to the measured checkout.
const ROOT = resolve(
  process.env["WORKTABLE_PERF_IO_ROOT"] ?? join(import.meta.dirname, "..", "..")
)

if (target) {
  const fd = openSync(target, "a")
  process.once("exit", () => closeSync(fd))
  const log = (entry: Record<string, unknown>) =>
    writeSync(fd, `${JSON.stringify({ t: Date.now(), ...entry })}\n`)

  /**
   * The first frame outside this file and node_modules, and whether the call
   * came from Better Auth (its own session and account statements).
   */
  const origin = (): { site: string; auth: boolean } => {
    const stack = new Error().stack?.split("\n").slice(1) ?? []
    const auth = stack.some((line) =>
      /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:better-auth|@better-auth|kysely)\//.test(
        line
      )
    )
    for (const line of stack) {
      const match = /\(?((?:\/|[A-Za-z]:\\)[^():]+):(\d+):\d+\)?$/.exec(line)
      if (!match) continue
      const file = match[1]!
      if (file.includes("node_modules") || file === import.meta.filename)
        continue
      return { site: `${relative(ROOT, file)}:${match[2]}`, auth }
    }
    return { site: "(unknown)", auth }
  }

  const wrapped = new WeakSet<object>()
  const wrapStatement = <T extends object>(statement: T, sql: string): T => {
    if (wrapped.has(statement)) return statement
    wrapped.add(statement)
    const text = sql.replace(/\s+/g, " ").trim().slice(0, 160)
    for (const name of ["get", "all", "run", "values", "iterate", "raw"]) {
      const method = (statement as Record<string, unknown>)[name]
      if (typeof method !== "function") continue
      ;(statement as Record<string, unknown>)[name] = function (
        this: unknown,
        ...args: unknown[]
      ) {
        log({ kind: "sql", sql: text, ...origin() })
        return method.apply(this, args)
      }
    }
    return statement
  }

  const prototype = Database.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >
  for (const name of ["query", "prepare"]) {
    const original = prototype[name]!
    prototype[name] = function (this: unknown, ...args: unknown[]) {
      return wrapStatement(
        original.apply(this, args) as object,
        String(args[0] ?? "")
      )
    }
  }
  for (const name of ["run", "exec"]) {
    const original = prototype[name]!
    prototype[name] = function (this: unknown, ...args: unknown[]) {
      log({
        kind: "sql",
        sql: String(args[0] ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160),
        ...origin(),
      })
      return original.apply(this, args)
    }
  }

  // Timers: which callbacks wake an idle server, and how often.
  for (const name of ["setInterval", "setTimeout"] as const) {
    const original = globalThis[name] as unknown as (
      ...args: unknown[]
    ) => unknown
    const replacement = function (
      this: unknown,
      callback: unknown,
      delay?: unknown,
      ...rest: unknown[]
    ) {
      const ms = Number(delay ?? 0)
      if (typeof callback !== "function" || !(ms >= 100))
        return original.call(this, callback, delay, ...rest)
      const { site } = origin()
      return original.call(
        this,
        function (this: unknown, ...args: unknown[]) {
          log({ kind: "timer", timer: name, delay: ms, site })
          return (callback as (...values: unknown[]) => unknown).apply(
            this,
            args
          )
        },
        delay,
        ...rest
      )
    }
    // Keep extras such as util.promisify.custom.
    for (const key of Reflect.ownKeys(original))
      if (!["length", "name", "prototype"].includes(String(key)))
        Reflect.defineProperty(
          replacement,
          key,
          Reflect.getOwnPropertyDescriptor(original, key)!
        )
    ;(globalThis as Record<string, unknown>)[name] = replacement
  }
  log({ kind: "ready" })
}
