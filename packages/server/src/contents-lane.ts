// ============================================================
// The lane that parses untrusted files, one at a time
// ============================================================
//
// A file a reader must parse (PDF, Office) is parsed in a worker process of
// its own (contents-worker.ts), started from the server's own executable,
// never in the server: a parser's bug, hang or appetite ends in a killed
// process and a stated reason, never in a stalled server or a held lock.
//
// The worker gets the file's bytes on its standard input and nothing else:
// no environment, no path, no link, and an empty working folder. The lane
// kills it when it runs past its time, its memory or its output, and each
// reader can be switched off (WORKTABLE_CONTENTS_<READER>=off) without
// touching how files are stored or downloaded.
//
// One job runs at a time. A job someone is waiting for goes before work done
// in the background; background work waits its turn and is refused, to be
// tried again later, when too much of it is queued.

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CONTENTS_WORKER_COMMAND,
  type ContentsOutput,
  type ContentsRefusal,
  type WorkerJobHeader,
  type WorkerReply,
} from "./contents-protocol.ts"

export interface ParsingLimits {
  /** How long a worker may run. */
  timeMs: number
  /** The memory a worker may hold, as its resident size. */
  memoryBytes: number
  /** The most a worker may write back. */
  outputBytes: number
}

export const PARSING_LIMITS: ParsingLimits = {
  timeMs: 60_000,
  memoryBytes: 1024 * 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
}

/** Background jobs queued at most; past it, background work is refused. */
const BACKGROUND_QUEUE_MAX = 256
/**
 * Jobs someone waits for, queued at most, and at most per owner (the person
 * or agent asking): past either, a read is answered busy at once, so one
 * caller, however many Spaces it reads from, can't fill the lane for
 * everyone else.
 */
const WAITING_QUEUE_MAX = 16
const WAITING_PER_OWNER = 4

/** Why a job ended without output from its reader. */
export type ParsingFailure =
  | "off"
  | "busy"
  | "cancelled"
  | "source"
  | "time"
  | "memory"
  | "output"
  | "crashed"

export type ParsingResult =
  | { kind: "ok"; output: ContentsOutput }
  | { kind: "refused"; reason: ContentsRefusal; message: string }
  | { kind: "failed"; why: ParsingFailure; message: string }

export interface ParsingJob {
  reader: string
  /** waiting: someone asked and waits; background: made ahead of asking. */
  priority: "waiting" | "background"
  /**
   * Writes the file's bytes, a chunk at a time, through `write`. `signal`
   * aborts when the worker has ended, and `write` then throws: the job
   * ends with the worker whether or not the bytes keep coming.
   */
  bytes: (
    write: (chunk: Uint8Array) => Promise<void>,
    signal: AbortSignal
  ) => Promise<void>
  limits?: Partial<ParsingLimits>
  /** The worker to start; the server's own executable unless given. */
  command?: readonly string[]
  /** Whose job it is, the person or agent asking, for the bound on jobs waited for. */
  owner?: string
  /** Ends the job, queued or running, as cancelled; a running worker is killed. */
  signal?: AbortSignal
}

const FAILURE_MESSAGES: Record<ParsingFailure, string> = {
  off: "Reading this kind of file is turned off on this Worktable.",
  busy: "Worktable is busy reading other files. Ask again in a moment.",
  source: "Worktable couldn't read this file to parse it. Ask again in a moment.",
  cancelled: "Worktable stopped reading this file. Ask again in a moment.",
  time: "Reading this file took too long, so Worktable stopped.",
  memory: "Reading this file needed too much memory, so Worktable stopped.",
  output: "This file gave more text than Worktable keeps, so it stopped.",
  crashed: "The reader stopped before it finished this file.",
}

function failed(why: ParsingFailure): ParsingResult {
  return { kind: "failed", why, message: FAILURE_MESSAGES[why] }
}

/** Whether a reader is switched off: WORKTABLE_CONTENTS_<READER>=off. */
export function readerSwitchedOff(reader: string): boolean {
  const name = `WORKTABLE_CONTENTS_${reader.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
  return process.env[name]?.trim().toLowerCase() === "off"
}

/** The server's own executable as a worker, built or run from source. */
function workerCommand(): string[] {
  const built = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/")
  return built
    ? [process.execPath, CONTENTS_WORKER_COMMAND]
    : [process.execPath, fileURLToPath(new URL("./contents-worker.ts", import.meta.url))]
}

/** A process's resident memory in bytes, or null when it can't be read. */
async function residentBytes(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => null)
    const kib = status?.match(/^VmRSS:\s+(\d+) kB/m)?.[1]
    return kib ? Number(kib) * 1024 : null
  }
  const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const kib = Number((await new Response(ps.stdout).text()).trim())
  return Number.isFinite(kib) && kib > 0 ? kib * 1024 : null
}

async function runWorker(job: ParsingJob): Promise<ParsingResult> {
  const limits = { ...PARSING_LIMITS, ...job.limits }
  const workDir = await mkdtemp(join(tmpdir(), "worktable-contents-"))
  const child = Bun.spawn([...(job.command ?? workerCommand())], {
    cwd: workDir,
    env: {},
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  let stopped: ParsingFailure | null = null
  const stop = (why: ParsingFailure) => {
    if (stopped) return
    stopped = why
    child.kill("SIGKILL")
  }
  // Held by timers the job owns: Bun 1.3 can collect an unreferenced
  // AbortSignal.timeout before it fires.
  const deadline = setTimeout(() => stop("time"), limits.timeMs)
  const cancel = () => stop("cancelled")
  job.signal?.addEventListener("abort", cancel)
  if (job.signal?.aborted) cancel()
  const watching = setInterval(
    () => {
      void residentBytes(child.pid).then((bytes) => {
        if (bytes !== null && bytes > limits.memoryBytes) stop("memory")
      })
    },
    process.platform === "linux" ? 100 : 500
  )
  const reading = (async () => {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of child.stdout) {
      size += chunk.byteLength
      if (size > limits.outputBytes) {
        stop("output")
        break
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
  })()
  const ended = new AbortController()
  void child.exited.then(() => ended.abort())
  try {
    const header: WorkerJobHeader = { reader: job.reader }
    const sink = child.stdin
    const write = async (chunk: Uint8Array) => {
      if (ended.signal.aborted) throw new Error("worker ended")
      sink.write(chunk)
      await sink.flush()
    }
    const sending = (async () => {
      await write(new TextEncoder().encode(`${JSON.stringify(header)}\n`))
      await job.bytes(write, ended.signal)
      await sink.end()
    })().catch(() => {
      // A worker that exits or is stopped early closes its input; what it
      // wrote back, or why it was stopped, still says how the job ended.
      // Bytes that couldn't be read stop the worker at once: ending its
      // input instead would have it parse part of a file as all of it.
      if (!ended.signal.aborted) stop("source")
    })
    // Bytes that stop coming can't hold the lane: a worker stopped at its
    // deadline ends the job.
    await Promise.race([sending, child.exited])
    const [text] = await Promise.all([reading, child.exited])
    if (stopped) return failed(stopped)
    let reply: WorkerReply
    try {
      reply = JSON.parse(text.trim().split("\n").at(-1) ?? "") as WorkerReply
    } catch {
      return failed("crashed")
    }
    return reply.ok
      ? { kind: "ok", output: reply.output }
      : { kind: "refused", reason: reply.reason, message: reply.message }
  } finally {
    clearTimeout(deadline)
    clearInterval(watching)
    job.signal?.removeEventListener("abort", cancel)
    ended.abort()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await rm(workDir, { recursive: true, force: true })
  }
}

interface Queued {
  job: ParsingJob
  resolve: (result: ParsingResult) => void
}

const waiting: Queued[] = []
const background: Queued[] = []
let running = false

async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      const next = waiting.shift() ?? background.shift()
      if (!next) return
      if (next.job.signal?.aborted) {
        next.resolve(failed("cancelled"))
        continue
      }
      next.resolve(await runWorker(next.job).catch(() => failed("crashed")))
    }
  } finally {
    running = false
  }
}

/**
 * Parses a file's bytes with a reader in the lane, one job at a time, a job
 * someone waits for first. Never throws: every end is a result.
 */
export function parseInLane(job: ParsingJob): Promise<ParsingResult> {
  if (readerSwitchedOff(job.reader)) return Promise.resolve(failed("off"))
  const queue = job.priority === "waiting" ? waiting : background
  if (queue === background && background.length >= BACKGROUND_QUEUE_MAX) {
    return Promise.resolve(failed("busy"))
  }
  if (
    queue === waiting &&
    (waiting.length >= WAITING_QUEUE_MAX ||
      (job.owner !== undefined &&
        waiting.filter((queued) => queued.job.owner === job.owner).length >= WAITING_PER_OWNER))
  ) {
    return Promise.resolve(failed("busy"))
  }
  return new Promise((resolve) => {
    queue.push({ job, resolve })
    void drain()
  })
}
