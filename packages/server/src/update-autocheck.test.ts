import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  backgroundUpdateCheck,
  checkForUpdate,
  getCachedUpdateCheck,
  startBackgroundUpdateCheckScheduler,
} from "./update-check.ts"
import {
  invalidateServerSettingsCache,
  updateServerSettings,
} from "./settings-store.ts"

// A real local counting release host — the same override contract install.sh
// and the version route honor. We assert on fetch COUNT to prove the background
// gate short-circuits before any network call.
let appDir: string
const originalEnv = { ...process.env }
let hits: number
let host: ReturnType<typeof Bun.serve>

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "wt-autocheck-app-"))
  setAppDirOverride(appDir)
  invalidateServerSettingsCache()
  hits = 0
  host = Bun.serve({
    port: 0,
    fetch: () => {
      hits += 1
      return Response.json({ version: "9.9.9" })
    },
  })
  // Installed-build gate: without WORKTABLE_VERSION no surface phones home.
  process.env["WORKTABLE_VERSION"] = "0.0.1"
  process.env["WORKTABLE_RELEASE_BASE_URL"] = `http://127.0.0.1:${host.port}`
  delete process.env["WORKTABLE_NO_UPDATE_CHECK"]
})

afterEach(() => {
  host.stop(true)
  setAppDirOverride(null)
  invalidateServerSettingsCache()
  rmSync(appDir, { recursive: true, force: true })
  process.env = { ...originalEnv }
})

describe("background update check honors settings.updates.autoCheck", () => {
  it("makes zero release-host fetches when autoCheck is false", async () => {
    await updateServerSettings({ updates: { autoCheck: false } })
    await backgroundUpdateCheck()
    expect(hits).toBe(0)
  })

  it("retries a failed scheduler check before the normal interval", async () => {
    host.stop(true)
    host = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1
        return hits === 1
          ? new Response("unavailable", { status: 503 })
          : Response.json({ version: "9.9.9" })
      },
    })
    process.env["WORKTABLE_RELEASE_BASE_URL"] = `http://127.0.0.1:${host.port}`

    let retry!: () => void
    let reportRetryScheduled!: () => void
    let reportNormalScheduled!: () => void
    const retryScheduled = new Promise<void>((resolve) => {
      reportRetryScheduled = resolve
    })
    const normalScheduled = new Promise<void>((resolve) => {
      reportNormalScheduled = resolve
    })
    const stop = startBackgroundUpdateCheckScheduler({
      intervalMs: 1_000,
      retryDelaysMs: [10],
      schedule: (callback, delayMs) => {
        if (delayMs === 10) {
          retry = callback
          reportRetryScheduled()
        } else {
          reportNormalScheduled()
        }
        return delayMs as unknown as ReturnType<typeof setTimeout>
      },
      cancel: () => {},
    })
    try {
      await retryScheduled
      await Promise.resolve()
      await Promise.resolve()
      retry()
      await normalScheduled
      expect(hits).toBe(2)
      expect(getCachedUpdateCheck().checkStatus).toBe("fresh")
    } finally {
      await stop()
    }
  })

  it("honors a fresh cache on scheduler startup without immediately refetching", async () => {
    await backgroundUpdateCheck()
    expect(hits).toBe(1)

    // Stop immediately; use the normal cache lifetime instead of racing a short TTL.
    const stop = startBackgroundUpdateCheckScheduler()
    await stop()
    expect(hits).toBe(1)
  })

  it("drains an active scheduler check before stop resolves", async () => {
    await host.stop(true)
    let releaseResponse!: () => void
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    let markStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    host = Bun.serve({
      port: 0,
      async fetch() {
        hits += 1
        markStarted()
        await responseReleased
        return Response.json({ version: "9.9.9" })
      },
    })
    process.env["WORKTABLE_RELEASE_BASE_URL"] = `http://127.0.0.1:${host.port}`

    const stop = startBackgroundUpdateCheckScheduler({ intervalMs: 1_000 })
    await requestStarted
    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    releaseResponse()
    await stopping
    expect(stopped).toBe(true)
    expect(hits).toBe(1)
  })

  it("fetches on the background path when autoCheck is true (default)", async () => {
    await backgroundUpdateCheck()
    expect(hits).toBe(1)
  })

  it("leaves the MANUAL path working even when autoCheck is false", async () => {
    await updateServerSettings({ updates: { autoCheck: false } })
    const result = await checkForUpdate({ force: true })
    expect(hits).toBe(1)
    expect(result.latest).toBe("9.9.9")
  })

  it("WORKTABLE_NO_UPDATE_CHECK kills BOTH background and manual, even with autoCheck true", async () => {
    process.env["WORKTABLE_NO_UPDATE_CHECK"] = "1"
    await backgroundUpdateCheck()
    await checkForUpdate({ force: true })
    expect(hits).toBe(0)
  })
})
