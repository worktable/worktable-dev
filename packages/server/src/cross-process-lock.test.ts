import { afterEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireCrossProcessLock } from "./cross-process-lock.ts"

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("cross-process lock", () => {
  it("publishes a complete ownership generation with the lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worktable-lock-publish-"))
    tempDirs.push(directory)
    const lockDir = join(directory, "state.lock")

    const release = await acquireCrossProcessLock(lockDir, {
      label: "atomic publication test",
    })
    const owner = JSON.parse(readFileSync(lockDir, "utf8")) as {
      pid: number
      nonce: string
      incarnation: string
    }
    expect(owner).toMatchObject({
      pid: process.pid,
      nonce: expect.any(String),
      incarnation: expect.any(String),
    })

    release()
    expect(existsSync(lockDir)).toBe(false)
  })

  it("reclaims a stale lock after the operating system reuses its PID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worktable-lock-pid-"))
    tempDirs.push(directory)
    const lockDir = join(directory, "state.lock")
    mkdirSync(lockDir)
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        nonce: "previous-process",
        incarnation: "previous-process-incarnation",
      })
    )
    const stale = new Date(Date.now() - 10_000)
    utimesSync(lockDir, stale, stale)

    const release = await acquireCrossProcessLock(lockDir, {
      label: "PID reuse test",
      staleMs: 10,
      retryMs: 1,
      timeoutMs: 1_000,
    })
    const owner = JSON.parse(readFileSync(lockDir, "utf8")) as {
      pid: number
      nonce: string
      incarnation: string
    }
    expect(owner.pid).toBe(process.pid)
    expect(owner.nonce).not.toBe("previous-process")
    expect(owner.incarnation).not.toBe("previous-process-incarnation")

    release()
    expect(existsSync(lockDir)).toBe(false)
  })

  it("lets only one process replace and enter through a stale lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worktable-lock-race-"))
    tempDirs.push(directory)
    const lockDir = join(directory, "state.lock")
    const evidencePath = join(directory, "evidence.log")
    mkdirSync(lockDir)
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        nonce: "abandoned",
        incarnation: "abandoned-process",
      })
    )
    const stale = new Date(Date.now() - 10_000)
    utimesSync(lockDir, stale, stale)

    const moduleUrl = new URL("./cross-process-lock.ts", import.meta.url).href
    const source = `
      import { appendFileSync, existsSync } from "node:fs";
      import { join } from "node:path";
      import { acquireCrossProcessLock } from ${JSON.stringify(moduleUrl)};
      const release = await acquireCrossProcessLock(
        ${JSON.stringify(lockDir)},
        { label: "stale race test", staleMs: 10, retryMs: 2, timeoutMs: 3000 }
      );
      appendFileSync(${JSON.stringify(evidencePath)}, "start:" + process.pid + "\\n");
      const releasePath = join(${JSON.stringify(directory)}, "release-" + process.pid);
      while (!existsSync(releasePath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      appendFileSync(${JSON.stringify(evidencePath)}, "end:" + process.pid + "\\n");
      release();
    `
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn({
        cmd: [process.execPath, "-e", source],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      })
    )
    for (let owner = 1; owner <= children.length; owner += 1) {
      const expectedEvents = owner * 2 - 1
      const deadline = Date.now() + 2_000
      let events: string[] = []
      while (events.length < expectedEvents && Date.now() < deadline) {
        events = existsSync(evidencePath)
          ? readFileSync(evidencePath, "utf8").trim().split("\n")
          : []
        if (events.length >= expectedEvents) break
        // test-policy: external-readiness-backoff
        await Bun.sleep(5)
      }
      expect(events).toHaveLength(expectedEvents)
      const pid = events.at(-1)?.match(/^start:(\d+)$/)?.[1]
      expect(pid).toBeDefined()
      writeFileSync(join(directory, `release-${pid}`), "release")
    }
    const exitCodes = await Promise.all(children.map((child) => child.exited))
    const errors = await Promise.all(
      children.map((child) => new Response(child.stderr).text())
    )
    expect(exitCodes).toEqual([0, 0, 0, 0])
    expect(errors).toEqual(["", "", "", ""])

    const events = readFileSync(evidencePath, "utf8").trim().split("\n")
    expect(events).toHaveLength(8)
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]).toMatch(/^start:/)
      expect(events[index + 1]).toBe(events[index]!.replace(/^start:/, "end:"))
    }
  })
})
