import { expect, test, spyOn } from "bun:test"
import { LinkReadPool } from "./link-read-pool.ts"
import { LinkReadMemo } from "./link-read-memo.ts"

test("visitor admission bounds overload, admits other links, and recovers after timeout", async () => {
  const pool = new LinkReadPool({
    active: 2,
    perLink: 1,
    queued: 2,
    waitMs: 15,
  })
  const first = (await pool.acquire("first"))!
  const waiting = pool.acquire("first")
  const other = (await pool.acquire("other"))!
  const expired = pool.acquire("other")
  expect(await pool.acquire("overflow")).toBeNull()
  other()
  const next = (await expired)!
  expect(typeof next).toBe("function")
  expect(await waiting).toBeNull()
  next()
  first()
  first() // A late finally must not free someone else's slot.
  const recovered = await pool.acquire("first")
  expect(typeof recovered).toBe("function")
  recovered!()
})

test("visitor memo coalesces reads but never retains failed or unencodable results", async () => {
  const memo = new LinkReadMemo()
  let calls = 0
  let finish!: (value: { records: number[] }) => void
  const load = () => {
    calls++
    return new Promise<{ records: number[] }>((resolve) => {
      finish = resolve
    })
  }
  const first = memo.read("allowed", load)
  const second = memo.read("allowed", load)
  await Promise.resolve()
  finish({ records: [1] })
  expect(await first).toEqual(await second)
  expect(calls).toBe(1)
  expect(await memo.read("allowed", load)).toEqual({ records: [1] })
  expect(calls).toBe(1)
  const now = spyOn(Date, "now").mockReturnValue(Date.now() + 2001)
  try {
    expect(await memo.read("allowed", async () => ({ records: [2] }))).toEqual({ records: [2] })
  } finally { now.mockRestore() }
  await expect(
    memo.read("failure", async () => {
      throw new Error("busy")
    })
  ).rejects.toThrow("busy")
  expect(await memo.read("failure", async () => 2)).toBe(2)
  await expect(memo.read("encoding", async () => 1n)).rejects.toThrow()
  expect(await memo.read("encoding", async () => 3)).toBe(3)
  await expect(
    memo.read("synchronous", () => {
      throw new Error("busy")
    })
  ).rejects.toThrow("busy")
  expect(await memo.read("synchronous", async () => 4)).toBe(4)
})
