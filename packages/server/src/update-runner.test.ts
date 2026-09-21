import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { VERSION } from "./release-info.ts"
import {
  getEffectiveUpdateStatus,
  getUpdateStatusPath,
  readUpdateStatus,
  reconcileUpdateStatus,
  startUpdate,
  writeUpdateStatus,
} from "./update-runner.ts"

// Real temp app-dir, real marker file on disk — the state machine IS the
// contract the UI polls, so we exercise it against actual reads/writes.
let appDir: string
const originalEnv = { ...process.env }

function countOpenFds(): number | null {
  return existsSync("/proc/self/fd")
    ? readdirSync("/proc/self/fd").length
    : null
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "wt-update-"))
  setAppDirOverride(appDir)
  delete process.env["WORKTABLE_LAUNCHER"]
  delete process.env["WORKTABLE_RELEASE_DIR"]
})

afterEach(() => {
  setAppDirOverride(null)
  rmSync(appDir, { recursive: true, force: true })
  process.env = { ...originalEnv }
})

describe("update status marker", () => {
  it("reports idle when no marker exists, and round-trips a written status", () => {
    expect(readUpdateStatus().state).toBe("idle")
    writeUpdateStatus({ state: "running", from: "0.0.1", to: "latest" })
    const read = readUpdateStatus()
    expect(read.state).toBe("running")
    expect(read.to).toBe("latest")
    expect(getUpdateStatusPath()).toBe(join(appDir, "update-status.json"))
  })

  it("treats a corrupt marker as idle rather than throwing", async () => {
    await Bun.write(getUpdateStatusPath(), "{ not json")
    expect(readUpdateStatus().state).toBe("idle")
  })
})

describe("reconcileUpdateStatus (boot-time verdict)", () => {
  it("marks a pinned-version restart succeeded when the running version matches the target", () => {
    writeUpdateStatus({ state: "restarting", from: "0.0.0", to: VERSION })
    const result = reconcileUpdateStatus()
    expect(result.state).toBe("succeeded")
    expect(result.finishedAt).toBeString()
    // Persisted, not just returned.
    expect(readUpdateStatus().state).toBe("succeeded")
  })

  it("marks a 'latest' restart succeeded once the version moved off `from`", () => {
    writeUpdateStatus({
      state: "restarting",
      from: `${VERSION}-old`,
      to: "latest",
    })
    expect(reconcileUpdateStatus().state).toBe("succeeded")
  })

  it("marks a restart failed when the version never moved (new build never came up)", () => {
    writeUpdateStatus({ state: "restarting", from: VERSION, to: "9.9.9" })
    const result = reconcileUpdateStatus()
    expect(result.state).toBe("failed")
    expect(result.error).toContain(VERSION)
  })

  it("leaves terminal states untouched", () => {
    writeUpdateStatus({ state: "succeeded", from: "0.0.0", to: VERSION })
    expect(reconcileUpdateStatus().state).toBe("succeeded")
    writeUpdateStatus({ state: "failed", error: "boom" })
    expect(reconcileUpdateStatus().state).toBe("failed")
  })

  it("does NOT touch a `running` marker (a download may still be in progress)", () => {
    // An unrelated restart must not abort an in-flight download.
    writeUpdateStatus({ state: "running", from: VERSION, to: "latest" })
    expect(reconcileUpdateStatus().state).toBe("running")
  })

  it("treats a same-version `latest` reinstall restart as succeeded", () => {
    // from === VERSION (reinstall) must not read as failure — we booted, so the
    // restart took.
    writeUpdateStatus({ state: "restarting", from: VERSION, to: "latest" })
    expect(reconcileUpdateStatus().state).toBe("succeeded")
  })
})

describe("getEffectiveUpdateStatus", () => {
  it("settles a STALE in-flight marker to failed so the API stops showing a spinner", () => {
    const stale = new Date(Date.now() - 30 * 60_000).toISOString()
    writeUpdateStatus({
      state: "running",
      from: VERSION,
      to: "latest",
      startedAt: stale,
    })
    const effective = getEffectiveUpdateStatus()
    expect(effective.state).toBe("failed")
    // Persisted, so the next read and the next startUpdate agree.
    expect(readUpdateStatus().state).toBe("failed")
  })

  it("passes a fresh in-flight marker through unchanged", () => {
    writeUpdateStatus({
      state: "running",
      from: VERSION,
      to: "latest",
      startedAt: new Date().toISOString(),
    })
    expect(getEffectiveUpdateStatus().state).toBe("running")
  })

  it("keeps a slow-but-ALIVE worker in flight no matter the elapsed time", () => {
    // Our own PID is alive; a 30-min-old start must NOT time it out (a slow
    // download), which also keeps startUpdate refusing a second installer.
    const stale = new Date(Date.now() - 30 * 60_000).toISOString()
    writeUpdateStatus({
      state: "running",
      from: VERSION,
      to: "latest",
      startedAt: stale,
      pid: process.pid,
    })
    expect(getEffectiveUpdateStatus().state).toBe("running")
  })

  it("fails an in-flight marker whose worker PID is gone", async () => {
    const proc = Bun.spawn(["sh", "-c", "exit 0"])
    const deadPid = proc.pid
    await proc.exited // ensure it's really gone
    writeUpdateStatus({
      state: "running",
      from: VERSION,
      to: "latest",
      startedAt: new Date().toISOString(), // fresh — only the dead PID settles it
      pid: deadPid,
    })
    expect(getEffectiveUpdateStatus().state).toBe("failed")
  })

  it("does NOT fail a fresh `restarting` marker just because the worker PID is gone", async () => {
    // The restart is expected to kill the worker — a gone PID here is the
    // success path, to be settled by the new server's boot reconcile, not raced
    // to `failed` by an effective read on the old server.
    const proc = Bun.spawn(["sh", "-c", "exit 0"])
    const deadPid = proc.pid
    await proc.exited
    writeUpdateStatus({
      state: "restarting",
      from: VERSION,
      to: "latest",
      startedAt: new Date().toISOString(),
      pid: deadPid,
    })
    expect(getEffectiveUpdateStatus().state).toBe("restarting")
  })

  it("settles a `restarting` marker that is wedged past the staleness window", () => {
    const stale = new Date(Date.now() - 30 * 60_000).toISOString()
    writeUpdateStatus({
      state: "restarting",
      from: VERSION,
      to: "latest",
      startedAt: stale,
    })
    expect(getEffectiveUpdateStatus().state).toBe("failed")
  })
})

describe("startUpdate launch lock", () => {
  it("refuses a second concurrent launch while the lock is held", () => {
    const releaseDir = mkdtempSync(join(tmpdir(), "wt-rel-"))
    writeFileSync(join(releaseDir, "install.sh"), "#!/bin/sh\n")
    // A real executable launcher that just sleeps, so the first launch's worker
    // stays alive (and the running marker stands) for the second call.
    const launcher = join(releaseDir, "worktable")
    writeFileSync(launcher, "#!/bin/sh\nsleep 5\n", { mode: 0o755 })
    process.env["WORKTABLE_RELEASE_DIR"] = releaseDir
    process.env["WORKTABLE_LAUNCHER"] = launcher
    try {
      const first = startUpdate({})
      expect(first.started).toBe(true)
      const second = startUpdate({})
      expect(second.started).toBe(false)
      expect(second.reason).toContain("already in progress")
    } finally {
      rmSync(releaseDir, { recursive: true, force: true })
    }
  })
})

describe("startUpdate worker logging", () => {
  it("does not leak the server's update.log descriptor after spawning workers", async () => {
    const before = countOpenFds()
    if (before === null) return

    const releaseDir = mkdtempSync(join(tmpdir(), "wt-rel-"))
    writeFileSync(join(releaseDir, "install.sh"), "#!/bin/sh\n")
    const launcher = join(releaseDir, "worktable")
    const workerDir = join(releaseDir, "workers")
    mkdirSync(workerDir)
    writeFileSync(
      launcher,
      '#!/bin/sh\n: > "$WORKTABLE_TEST_WORKER_DIR/$2"\nexit 0\n',
      { mode: 0o755 }
    )
    process.env["WORKTABLE_RELEASE_DIR"] = releaseDir
    process.env["WORKTABLE_LAUNCHER"] = launcher
    process.env["WORKTABLE_TEST_WORKER_DIR"] = workerDir
    try {
      for (let i = 0; i < 5; i++) {
        const result = startUpdate({ version: `9.9.${i}` })
        expect(result.started).toBe(true)
        const workerMarker = join(workerDir, `9.9.${i}`)
        const deadline = Date.now() + 2_000
        while (!existsSync(workerMarker) && Date.now() < deadline) {
          // test-policy: external-readiness-backoff
          await Bun.sleep(5)
        }
        expect(existsSync(workerMarker)).toBe(true)
        writeUpdateStatus({
          state: "failed",
          finishedAt: new Date().toISOString(),
        })
      }

      expect(countOpenFds()).toBeLessThanOrEqual(before)
    } finally {
      rmSync(releaseDir, { recursive: true, force: true })
    }
  })
})

describe("startUpdate guards", () => {
  it("refuses when the build cannot self-update", () => {
    // No WORKTABLE_LAUNCHER / installer → canUpdate is false.
    const result = startUpdate({})
    expect(result.started).toBe(false)
    expect(result.reason).toContain("cannot self-update")
    expect(readUpdateStatus().state).toBe("idle")
  })

  it("refuses to start a second update while one is in progress", () => {
    // Make this build updatable so we get past the capability gate to the
    // in-progress guard: an install.sh in the release dir + a launcher.
    const releaseDir = mkdtempSync(join(tmpdir(), "wt-rel-"))
    writeFileSync(join(releaseDir, "install.sh"), "#!/bin/sh\n")
    process.env["WORKTABLE_RELEASE_DIR"] = releaseDir
    process.env["WORKTABLE_LAUNCHER"] = join(releaseDir, "worktable")
    try {
      writeUpdateStatus({
        state: "running",
        from: VERSION,
        to: "latest",
        startedAt: new Date().toISOString(),
      })
      const result = startUpdate({ version: "9.9.9" })
      expect(result.started).toBe(false)
      expect(result.reason).toContain("already in progress")
    } finally {
      rmSync(releaseDir, { recursive: true, force: true })
    }
  })

  it("does not let a STALE running marker block a fresh update forever", () => {
    const releaseDir = mkdtempSync(join(tmpdir(), "wt-rel-"))
    writeFileSync(join(releaseDir, "install.sh"), "#!/bin/sh\n")
    // A real, harmless executable so the detached spawn succeeds and exits 0.
    const launcher = join(releaseDir, "worktable")
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.env["WORKTABLE_RELEASE_DIR"] = releaseDir
    process.env["WORKTABLE_LAUNCHER"] = launcher
    try {
      // Started 30 minutes ago — well past the staleness window.
      const stale = new Date(Date.now() - 30 * 60_000).toISOString()
      writeUpdateStatus({
        state: "running",
        from: VERSION,
        to: "latest",
        startedAt: stale,
      })
      const result = startUpdate({ version: "9.9.9" })
      expect(result.started).toBe(true)
      expect(result.status.state).toBe("running")
    } finally {
      rmSync(releaseDir, { recursive: true, force: true })
    }
  })
})
