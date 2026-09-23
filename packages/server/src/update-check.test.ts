import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { Database } from "bun:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  backgroundUpdateCheck,
  checkForUpdate,
  compareVersions,
  getCachedUpdateCheck,
  getUpdateCheckCachePath,
  isNewerVersion,
  normalizeVersion,
  resolveLatestVersion,
  setUpdateCheckCacheLockWaitHookForTests,
} from "./update-check.ts"

// Integration per the trophy: a real temp app dir for the cache and a real
// local HTTP server standing in for the release host (the same
// WORKTABLE_RELEASE_BASE_URL override install.sh honors).

const originalEnv = { ...process.env }
let appDir: string
let server: ReturnType<typeof Bun.serve> | null = null
let requests = 0
let lastPath = ""

function serveManifest(body: string, status = 200): void {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requests += 1
      lastPath = new URL(req.url).pathname
      return new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  process.env["WORKTABLE_RELEASE_BASE_URL"] = `http://127.0.0.1:${server.port}`
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "wt-update-check-"))
  setAppDirOverride(appDir)
  requests = 0
  lastPath = ""
  // An "installed release build": the launcher would stamp this.
  process.env["WORKTABLE_VERSION"] = "0.0.10"
  delete process.env["WORKTABLE_NO_UPDATE_CHECK"]
})

afterEach(() => {
  setUpdateCheckCacheLockWaitHookForTests(null)
  server?.stop(true)
  server = null
  setAppDirOverride(null)
  rmSync(appDir, { recursive: true, force: true })
  process.env = { ...originalEnv }
})

describe("version comparison", () => {
  it("normalizes tag and plain forms to X.Y.Z", () => {
    expect(normalizeVersion("v0.0.18")).toBe("0.0.18")
    expect(normalizeVersion(" 0.0.18 ")).toBe("0.0.18")
    expect(normalizeVersion("latest")).toBeNull()
    expect(normalizeVersion("1.2")).toBeNull()
    expect(normalizeVersion("")).toBeNull()
  })

  it("compares segments numerically, not lexically", () => {
    expect(isNewerVersion("0.0.10", "0.0.9")).toBe(true)
    expect(isNewerVersion("0.0.9", "0.0.10")).toBe(false)
    expect(isNewerVersion("0.1.0", "0.0.99")).toBe(true)
    expect(isNewerVersion("v0.0.11", "0.0.10")).toBe(true)
    expect(compareVersions("0.0.10", "v0.0.10")).toBe(0)
    // Invalid input never reports newer.
    expect(isNewerVersion("latest", "0.0.10")).toBe(false)
  })
})

describe("checkForUpdate", () => {
  it("fetches latest/manifest.json, reports the newer version, and caches it", async () => {
    serveManifest(JSON.stringify({ version: "0.0.11" }))
    const result = await checkForUpdate()
    expect(lastPath).toBe("/latest/manifest.json")
    expect(result.current).toBe("0.0.10")
    expect(result.latest).toBe("0.0.11")
    expect(result.updateAvailable).toBe(true)
    expect(result.checkedAt).toBeTruthy()
    expect(result.lastAttemptAt).toBeTruthy()
    expect(result.checkTtlRemainingMs).toBeGreaterThan(0)
    expect(result.checkTtlRemainingMs).toBeLessThanOrEqual(6 * 60 * 60_000)
    expect(result.checkStatus).toBe("fresh")
    expect(existsSync(getUpdateCheckCachePath())).toBe(true)
    expect(requests).toBe(1)
  })

  it("serves from the cache within the TTL and refetches on force", async () => {
    serveManifest(JSON.stringify({ version: "0.0.11" }))
    await checkForUpdate()
    const second = await checkForUpdate()
    expect(second.latest).toBe("0.0.11")
    expect(requests).toBe(1)
    await checkForUpdate({ force: true })
    expect(requests).toBe(2)
  })

  it("reports up to date when the published version is not newer", async () => {
    serveManifest(JSON.stringify({ version: "0.0.10" }))
    const result = await checkForUpdate()
    expect(result.latest).toBe("0.0.10")
    expect(result.updateAvailable).toBe(false)
  })

  it("falls back to the stale cache when the release server fails", async () => {
    serveManifest(JSON.stringify({ version: "0.0.11" }))
    await checkForUpdate()
    server!.stop(true)
    serveManifest("oops", 500)
    const result = await checkForUpdate({ force: true })
    expect(result.latest).toBe("0.0.11")
    expect(result.updateAvailable).toBe(true)
    expect(result.checkStatus).toBe("failed")
    expect(result.lastAttemptAt).toBeTruthy()
  })

  it("records a failed first attempt for a malformed manifest", async () => {
    serveManifest(JSON.stringify({ version: "latest" }))
    const result = await checkForUpdate()
    expect(result.latest).toBeNull()
    expect(result.updateAvailable).toBe(false)
    expect(result.checkStatus).toBe("failed")
    expect(result.lastAttemptAt).toBeTruthy()
    expect(existsSync(getUpdateCheckCachePath())).toBe(true)
  })

  it("coalesces concurrent forced checks into one release-host request", async () => {
    let releaseResponse!: () => void
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    let reportRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      reportRequestStarted = resolve
    })
    server = Bun.serve({
      port: 0,
      async fetch() {
        requests += 1
        reportRequestStarted()
        await responseReleased
        return Response.json({ version: "0.0.11" })
      },
    })
    process.env["WORKTABLE_RELEASE_BASE_URL"] =
      `http://127.0.0.1:${server.port}`

    const pending = Promise.all([
      checkForUpdate({ force: true }),
      checkForUpdate({ force: true }),
      checkForUpdate({ force: true }),
    ])
    await requestStarted
    expect(requests).toBe(1)
    releaseResponse()
    const results = await pending
    expect(requests).toBe(1)
    expect(results.every((result) => result.latest === "0.0.11")).toBe(true)
  })

  it("serializes cache writes across replacement lock owners", async () => {
    serveManifest(JSON.stringify({ version: "0.0.11" }))
    const lockPath = `${getUpdateCheckCachePath()}.lock.sqlite`
    const firstOwner = new Database(lockPath, { create: true })
    firstOwner.exec("BEGIN IMMEDIATE")
    let waitCount = 0
    let reportFirstWait!: () => void
    let reportSecondWait!: () => void
    const firstWait = new Promise<void>((resolve) => {
      reportFirstWait = resolve
    })
    const secondWait = new Promise<void>((resolve) => {
      reportSecondWait = resolve
    })
    setUpdateCheckCacheLockWaitHookForTests(() => {
      waitCount += 1
      if (waitCount === 1) reportFirstWait()
      if (waitCount === 2) reportSecondWait()
    })

    let settled = false
    const pending = checkForUpdate({ force: true }).then((result) => {
      settled = true
      return result
    })
    await firstWait
    expect(requests).toBe(1)
    expect(settled).toBe(false)
    expect(existsSync(getUpdateCheckCachePath())).toBe(false)

    firstOwner.exec("COMMIT")
    firstOwner.close()
    const replacementOwner = new Database(lockPath, { create: true })
    replacementOwner.exec("BEGIN IMMEDIATE")
    await secondWait
    expect(settled).toBe(false)
    replacementOwner.exec("COMMIT")
    replacementOwner.close()
    expect((await pending).latest).toBe("0.0.11")
  })

  it("recovers the cache lock when its owning process exits", async () => {
    serveManifest(JSON.stringify({ version: "0.0.11" }))
    const lockPath = `${getUpdateCheckCachePath()}.lock.sqlite`
    const readyPath = join(appDir, "lock-owner-ready")
    const locker = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          const { Database } = await import("bun:sqlite");
          const { writeFileSync } = await import("node:fs");
          const db = new Database(process.env.LOCK_PATH, { create: true });
          db.exec("BEGIN IMMEDIATE");
          writeFileSync(process.env.READY_PATH, "ready");
          await new Promise(() => {});
          db.exec("ROLLBACK");
          db.close();
        `,
      ],
      {
        env: {
          ...process.env,
          LOCK_PATH: lockPath,
          READY_PATH: readyPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    try {
      const readyDeadline = Date.now() + 2_000
      while (!existsSync(readyPath) && Date.now() < readyDeadline) {
        // test-policy: external-readiness-backoff
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(existsSync(readyPath)).toBe(true)

      let settled = false
      const pending = checkForUpdate({ force: true }).then((result) => {
        settled = true
        return result
      })
      const requestDeadline = Date.now() + 2_000
      while (requests === 0 && Date.now() < requestDeadline) {
        // test-policy: external-readiness-backoff
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(requests).toBe(1)
      expect(settled).toBe(false)

      locker.kill()
      await locker.exited
      expect((await pending).latest).toBe("0.0.11")
      expect(getCachedUpdateCheck().checkStatus).toBe("fresh")
    } finally {
      locker.kill()
      await locker.exited
    }
  })

  it("reports a successful fetch with failed persistence to the scheduler", async () => {
    serveManifest(JSON.stringify({ version: "0.0.11" }))
    const lockPath = `${getUpdateCheckCachePath()}.lock.sqlite`
    const lockOwner = new Database(lockPath, { create: true })
    lockOwner.exec("BEGIN IMMEDIATE")

    // Keep the actual SQLite contention and advance only the deadline clock.
    setUpdateCheckCacheLockWaitHookForTests(() => {
      setSystemTime(new Date(Date.now() + 4_000))
    })
    try {
      const outcome = await backgroundUpdateCheck({ force: true })
      expect(outcome).toBe("failed")
      expect(requests).toBe(1)
      expect(getCachedUpdateCheck().checkStatus).toBe("unchecked")
    } finally {
      setUpdateCheckCacheLockWaitHookForTests(null)
      setSystemTime()
      lockOwner.exec("COMMIT")
      lockOwner.close()
    }
  })

  it("preserves a newer cache written by another process while a check fails", async () => {
    server = Bun.serve({
      port: 0,
      async fetch() {
        requests += 1
        const checkedAt = new Date().toISOString()
        writeFileSync(
          getUpdateCheckCachePath(),
          JSON.stringify({
            latest: "0.0.12",
            checkedAt,
            lastAttemptAt: checkedAt,
          })
        )
        return new Response("unavailable", { status: 503 })
      },
    })
    process.env["WORKTABLE_RELEASE_BASE_URL"] =
      `http://127.0.0.1:${server.port}`

    const result = await checkForUpdate({ force: true })
    expect(requests).toBe(1)
    expect(result.latest).toBe("0.0.12")
    expect(result.updateAvailable).toBe(true)
    expect(result.checkStatus).toBe("fresh")
    expect(getCachedUpdateCheck().latest).toBe("0.0.12")
    expect(getCachedUpdateCheck().checkStatus).toBe("fresh")
  })

  it("preserves newer failure-attempt metadata written by another process", async () => {
    let newerAttemptAt = ""
    server = Bun.serve({
      port: 0,
      async fetch() {
        requests += 1
        newerAttemptAt = new Date().toISOString()
        writeFileSync(
          getUpdateCheckCachePath(),
          JSON.stringify({
            latest: "0.0.12",
            checkedAt: new Date(Date.now() - 60_000).toISOString(),
            lastAttemptAt: newerAttemptAt,
            lastFailure: "network",
          })
        )
        return new Response("unavailable", { status: 503 })
      },
    })
    process.env["WORKTABLE_RELEASE_BASE_URL"] =
      `http://127.0.0.1:${server.port}`

    const result = await checkForUpdate({ force: true })
    expect(requests).toBe(1)
    expect(result.latest).toBe("0.0.12")
    expect(result.updateAvailable).toBe(true)
    expect(result.checkStatus).toBe("failed")
    expect(result.lastAttemptAt).toBe(newerAttemptAt)
    expect(getCachedUpdateCheck().lastAttemptAt).toBe(newerAttemptAt)
    expect(getCachedUpdateCheck().checkStatus).toBe("failed")
  })

  it("makes no network call for a source build (no WORKTABLE_VERSION)", async () => {
    serveManifest(JSON.stringify({ version: "9.9.9" }))
    delete process.env["WORKTABLE_VERSION"]
    const result = await checkForUpdate()
    expect(result.latest).toBeNull()
    expect(requests).toBe(0)
  })

  it("makes no network call when WORKTABLE_NO_UPDATE_CHECK is set", async () => {
    serveManifest(JSON.stringify({ version: "9.9.9" }))
    process.env["WORKTABLE_NO_UPDATE_CHECK"] = "1"
    const result = await checkForUpdate()
    expect(result.latest).toBeNull()
    expect(requests).toBe(0)
  })

  it("ignores a warm cache when checks are disabled or unsupported", async () => {
    writeFileSync(
      getUpdateCheckCachePath(),
      JSON.stringify({ latest: "9.9.9", checkedAt: new Date().toISOString() })
    )
    serveManifest(JSON.stringify({ version: "9.9.10" }))

    process.env["WORKTABLE_NO_UPDATE_CHECK"] = "1"
    const disabled = await checkForUpdate()
    expect(disabled.latest).toBeNull()
    expect(disabled.updateAvailable).toBe(false)
    expect(disabled.checkedAt).toBeNull()
    expect(disabled.checkStatus).toBe("disabled")
    expect(requests).toBe(0)

    delete process.env["WORKTABLE_NO_UPDATE_CHECK"]
    delete process.env["WORKTABLE_VERSION"]
    const unsupported = await checkForUpdate()
    expect(unsupported.latest).toBeNull()
    expect(unsupported.updateAvailable).toBe(false)
    expect(unsupported.checkedAt).toBeNull()
    expect(unsupported.checkStatus).toBe("unsupported")
    expect(requests).toBe(0)
  })

  it("survives a corrupt cache file", async () => {
    writeFileSync(getUpdateCheckCachePath(), "{not json")
    serveManifest(JSON.stringify({ version: "0.0.12" }))
    const result = await checkForUpdate()
    expect(result.latest).toBe("0.0.12")
  })
})

describe("resolveLatestVersion", () => {
  it("fetches fresh (no TTL), persists the cache, and null-fails without clobbering it", async () => {
    serveManifest(JSON.stringify({ version: "0.0.11" }))
    expect(await resolveLatestVersion()).toBe("0.0.11")
    expect(await resolveLatestVersion()).toBe("0.0.11")
    expect(requests).toBe(2) // no TTL — every call is a real fetch
    server!.stop(true)
    serveManifest("oops", 500)
    expect(await resolveLatestVersion()).toBeNull()
    // The failed resolve did not erase the last known answer.
    expect(getCachedUpdateCheck().latest).toBe("0.0.11")
  })

  it("honors the opt-out and the installed-build gate (no network)", async () => {
    serveManifest(JSON.stringify({ version: "9.9.9" }))
    process.env["WORKTABLE_NO_UPDATE_CHECK"] = "1"
    expect(await resolveLatestVersion()).toBeNull()
    expect(requests).toBe(0)
    delete process.env["WORKTABLE_NO_UPDATE_CHECK"]
    delete process.env["WORKTABLE_VERSION"]
    expect(await resolveLatestVersion()).toBeNull()
    expect(requests).toBe(0)
  })
})

describe("getCachedUpdateCheck", () => {
  it("never touches the network", async () => {
    serveManifest(JSON.stringify({ version: "9.9.9" }))
    const result = getCachedUpdateCheck()
    expect(result.latest).toBeNull()
    expect(result.checkStatus).toBe("unchecked")
    expect(requests).toBe(0)
  })

  it("ignores cached latest data when checks are disabled or unsupported", () => {
    writeFileSync(
      getUpdateCheckCachePath(),
      JSON.stringify({ latest: "9.9.9", checkedAt: new Date().toISOString() })
    )

    process.env["WORKTABLE_NO_UPDATE_CHECK"] = "1"
    const disabled = getCachedUpdateCheck()
    expect(disabled.latest).toBeNull()
    expect(disabled.updateAvailable).toBe(false)
    expect(disabled.checkedAt).toBeNull()
    expect(disabled.checkStatus).toBe("disabled")

    delete process.env["WORKTABLE_NO_UPDATE_CHECK"]
    delete process.env["WORKTABLE_VERSION"]
    const unsupported = getCachedUpdateCheck()
    expect(unsupported.latest).toBeNull()
    expect(unsupported.updateAvailable).toBe(false)
    expect(unsupported.checkedAt).toBeNull()
    expect(unsupported.checkStatus).toBe("unsupported")
  })

  it("distinguishes a stale successful answer from a current one", () => {
    writeFileSync(
      getUpdateCheckCachePath(),
      JSON.stringify({
        latest: "0.0.11",
        checkedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
      })
    )
    expect(getCachedUpdateCheck().checkStatus).toBe("stale")
  })
})
