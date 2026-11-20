// ============================================================
// The worker that parses one file for its contents
// ============================================================
//
// Started by the lane (contents-lane.ts) as a process of its own, with no
// environment, an empty working folder, and limits on its time, memory and
// output that the lane enforces by killing it. It reads a job from standard
// input (one line naming the reader, then the file's bytes), runs that
// reader, writes one line of JSON, and exits. It is given no path, link or
// credential: the bytes are all it has. It loads only the readers.

import {
  ReaderRefused,
  type ParsingReader,
  type WorkerJobHeader,
  type WorkerReply,
} from "./contents-protocol.ts"
import { CONTENTS_READERS } from "./contents-readers.ts"

async function reply(message: WorkerReply): Promise<void> {
  const line = `${JSON.stringify(message)}\n`
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(line, (error) => (error ? reject(error) : resolve()))
  )
}

/** Runs one job from standard input with `readers`, then exits. */
export async function runContentsWorker(
  readers: Readonly<Record<string, ParsingReader>> = CONTENTS_READERS
): Promise<never> {
  const input = new Uint8Array(await Bun.stdin.arrayBuffer())
  const newline = input.indexOf(0x0a)
  let header: WorkerJobHeader
  try {
    header = JSON.parse(new TextDecoder().decode(input.subarray(0, newline))) as WorkerJobHeader
  } catch {
    await reply({ ok: false, reason: "failed", message: "The parse job couldn't be read." })
    process.exit(2)
  }
  const reader = Object.hasOwn(readers, header.reader) ? readers[header.reader] : undefined
  if (!reader) {
    await reply({ ok: false, reason: "unsupported", message: "Worktable has no reader for this file." })
    process.exit(0)
  }
  try {
    const output = await reader.read(input.subarray(newline + 1))
    await reply({ ok: true, output })
  } catch (error) {
    await reply(
      error instanceof ReaderRefused
        ? { ok: false, reason: error.reason, message: error.message }
        : { ok: false, reason: "failed", message: "The reader couldn't read this file." }
    )
  }
  process.exit(0)
}

if (import.meta.main) await runContentsWorker()
