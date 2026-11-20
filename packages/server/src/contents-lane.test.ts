import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { parseInLane, type ParsingJob } from "./contents-lane.ts"

const testWorker = [
  process.execPath,
  fileURLToPath(new URL("./fixtures/contents-test-worker.ts", import.meta.url)),
]

const bytesOf = (text: string): ParsingJob["bytes"] => async (write) => {
  const encoded = new TextEncoder().encode(text)
  // Two writes, as a file read a chunk at a time arrives.
  await write(encoded.subarray(0, 3))
  await write(encoded.subarray(3))
}

const parse = (reader: string, extra: Partial<ParsingJob> = {}) =>
  parseInLane({ reader, priority: "waiting", bytes: bytesOf("hello lane"), command: testWorker, ...extra })

afterEach(() => {
  delete process.env["WORKTABLE_CONTENTS_ECHO"]
})

describe("the parsing lane", () => {
  it("gives a reader the file's bytes and nothing else, and returns what it read", async () => {
    expect(await parse("echo")).toEqual({
      kind: "ok",
      output: {
        parts: [{ label: "All", text: "hello lane" }],
        facts: { bytes: 10, environment: 0 },
        gaps: [],
      },
    })
    expect(await parse("encrypted")).toEqual({
      kind: "refused",
      reason: "encrypted",
      message: "This file is password protected.",
    })
    expect(await parse("missing")).toMatchObject({ kind: "refused", reason: "unsupported" })
  })

  it("stops a reader that hangs, grows too large or writes too much, and says why", async () => {
    expect(await parse("hang", { limits: { timeMs: 500 } })).toMatchObject({ kind: "failed", why: "time" })
    expect(await parse("balloon", { limits: { memoryBytes: 128 * 1024 * 1024 } })).toMatchObject({
      kind: "failed",
      why: "memory",
    })
    expect(await parse("flood", { limits: { outputBytes: 1024 * 1024 } })).toMatchObject({
      kind: "failed",
      why: "output",
    })
    expect(await parse("crash")).toMatchObject({ kind: "failed", why: "crashed" })
    // Bytes that stop coming end at the deadline too, and say so.
    let told = false
    const stalled: ParsingJob["bytes"] = async (write, signal) => {
      await write(new TextEncoder().encode("a"))
      signal.addEventListener("abort", () => (told = true))
      await new Promise(() => {})
    }
    expect(await parse("echo", { bytes: stalled, limits: { timeMs: 500 } })).toMatchObject({
      kind: "failed",
      why: "time",
    })
    expect(told).toBe(true)
    // Bytes that can't be read end the job at once, never as a timeout.
    const unreadable: ParsingJob["bytes"] = async (write) => {
      await write(new TextEncoder().encode("a"))
      throw new Error("the file changed while it was read")
    }
    const started = performance.now()
    expect(await parse("echo", { bytes: unreadable })).toMatchObject({ kind: "failed", why: "source" })
    expect(performance.now() - started).toBeLessThan(10_000)
    // A job can be cancelled, running or queued: its worker is killed.
    const cancelling = new AbortController()
    const running = parse("hang", { signal: cancelling.signal })
    const queued = parse("echo", { signal: cancelling.signal, priority: "background" })
    cancelling.abort()
    expect(await running).toMatchObject({ kind: "failed", why: "cancelled" })
    expect(await queued).toMatchObject({ kind: "failed", why: "cancelled" })
    // The lane is still there for the next file.
    expect(await parse("echo")).toMatchObject({ kind: "ok" })
  }, 30_000)

  it("can switch a reader off, and parses what someone waits for first", async () => {
    process.env["WORKTABLE_CONTENTS_ECHO"] = "off"
    expect(await parse("echo")).toMatchObject({ kind: "failed", why: "off" })
    delete process.env["WORKTABLE_CONTENTS_ECHO"]

    const finished: string[] = []
    const track = (name: string, job: Promise<unknown>) => job.then(() => finished.push(name))
    await Promise.all([
      track("first", parse("echo", { priority: "background" })),
      track("second", parse("echo", { priority: "background" })),
      track("asked", parse("echo", { priority: "waiting" })),
    ])
    // The first background job starts as it is queued; the one someone
    // asked for goes before the background job still waiting.
    expect(finished).toEqual(["first", "asked", "second"])
  }, 30_000)

  it("answers busy past the jobs one caller may have waiting, without starving another", async () => {
    // The first job starts as it is queued; four more wait for that caller,
    // whichever Spaces its files are in.
    const queued = Array.from({ length: 5 }, () => parse("echo", { owner: "agent-a" }))
    expect(await parse("echo", { owner: "agent-a" })).toMatchObject({ kind: "failed", why: "busy" })
    const other = parse("echo", { owner: "agent-b" })
    expect((await Promise.all(queued)).every((result) => result.kind === "ok")).toBe(true)
    expect(await other).toMatchObject({ kind: "ok" })
  }, 30_000)

  it("starts from the server's entry as a worker without loading the server", async () => {
    const entry = fileURLToPath(new URL("./server-entry.ts", import.meta.url))
    const result = await parseInLane({
      reader: "no-such-reader",
      priority: "waiting",
      bytes: bytesOf("x"),
      command: [process.execPath, entry, "contents-worker"],
      limits: { timeMs: 20_000 },
    })
    expect(result).toMatchObject({ kind: "refused", reason: "unsupported" })
  }, 30_000)
})
