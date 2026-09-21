import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  utimesSync,
} from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  attachPairingToken,
  createPairingSession,
  formatPairingCode,
  getPairingSession,
  normalizePairingCode,
  recordPairingProgress,
  redeemPairingSession,
} from "./pairing-store.ts"

let appDir: string

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-pairing-app-"))
  setAppDirOverride(appDir)
})

afterEach(() => {
  setSystemTime()
  setAppDirOverride(null)
  if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true })
})

const OPTS = {
  client: "codex",
  scopes: ["docs:*", "search:read"],
  mcpUrl: "https://wt.example.com/mcp",
}

describe("pairing codes", () => {
  it("issues a formatted Crockford code and stores only its hash", async () => {
    const { code, session } = await createPairingSession(OPTS)
    // 5-5 grouping; alphabet excludes I, L, O, U.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
    expect(session.id).toMatch(/^[0-9a-f]{12}$/)
    expect(session.status).toBe("pending")

    const raw = await readFile(join(appDir, "pairing.json"), "utf8")
    expect(raw).not.toContain(normalizePairingCode(code))
  })

  it("normalizes case and separators", () => {
    expect(normalizePairingCode("abcde-fghjk")).toBe("ABCDEFGHJK")
    expect(normalizePairingCode(" AB cde-FG hjk ")).toBe("ABCDEFGHJK")
    expect(formatPairingCode("abcdefghjk")).toBe("ABCDE-FGHJK")
  })
})

describe("redemption", () => {
  it("redeems once, with any code formatting, and never twice", async () => {
    const { code, session } = await createPairingSession(OPTS)

    const sloppy = code.toLowerCase().replace("-", " ")
    const first = await redeemPairingSession(sloppy, {
      hostname: "devbox",
      client: null,
    })
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.session.id).toBe(session.id)
      expect(first.session.redeemedBy).toEqual({
        hostname: "devbox",
        client: null,
      })
      expect(first.session.status).toBe("redeemed")
    }

    const second = await redeemPairingSession(code, {
      hostname: "x",
      client: null,
    })
    expect(second).toEqual({ ok: false, reason: "already_redeemed" })
  })

  it("resolves exactly one winner for concurrent redeems of one code", async () => {
    const { code } = await createPairingSession(OPTS)
    const results = await Promise.all([
      redeemPairingSession(code, { hostname: "a", client: null }),
      redeemPairingSession(code, { hostname: "b", client: null }),
      redeemPairingSession(code, { hostname: "c", client: null }),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it("rejects unknown and expired codes distinctly", async () => {
    expect(
      await redeemPairingSession("AAAAA-AAAAA", {
        hostname: null,
        client: null,
      })
    ).toEqual({ ok: false, reason: "not_found" })

    const { code } = await createPairingSession({ ...OPTS, ttlMs: 0 })
    expect(
      await redeemPairingSession(code, { hostname: null, client: null })
    ).toEqual({ ok: false, reason: "expired" })

    const { session } = await createPairingSession({ ...OPTS, ttlMs: 0 })
    expect((await getPairingSession(session.id))?.status).toBe("expired")
  })
})

describe("progress and lifecycle", () => {
  it("keeps progress nonterminal until authenticated completion", async () => {
    const { code, session } = await createPairingSession(OPTS)

    expect(await recordPairingProgress(code, "config_written")).toEqual({
      ok: false,
      reason: "not_redeemed",
    })

    await redeemPairingSession(code, { hostname: "devbox", client: null })
    const progressed = await recordPairingProgress(
      code,
      "config_written",
      "~/.codex/config.toml"
    )
    expect(progressed.ok).toBe(true)

    const view = await getPairingSession(session.id)
    expect(view?.status).toBe("redeemed")
    expect(view?.outcome).toBeNull()
    expect(view?.events.map((e) => e.event)).toEqual([
      "redeemed",
      "config_written",
    ])

    await recordPairingProgress(code, "failed", "verification failed")
    expect((await getPairingSession(session.id))?.status).toBe("failed")
  })

  it("keeps a redeemed session live past the code expiry", async () => {
    const createdAt = new Date("2026-07-27T12:00:00.000Z")
    setSystemTime(createdAt)
    const { code, session } = await createPairingSession({
      ...OPTS,
      ttlMs: 1_000,
    })
    await redeemPairingSession(code, { hostname: "devbox", client: null })
    expect((await getPairingSession(session.id))?.status).toBe("redeemed")

    setSystemTime(new Date(createdAt.getTime() + 1_001))
    expect((await getPairingSession(session.id))?.status).toBe("redeemed")
  })

  it("caps events so a code holder cannot grow the file unboundedly", async () => {
    const { code, session } = await createPairingSession(OPTS)
    await redeemPairingSession(code, { hostname: null, client: null })
    for (let i = 0; i < 60; i++) {
      await recordPairingProgress(code, "verifying", `attempt ${i}`)
    }
    const view = await getPairingSession(session.id)
    expect(view!.events.length).toBeLessThanOrEqual(50)
  })

  it("waits for a live cross-process lock and steals a stale one", async () => {
    const lockDir = join(appDir, "pairing.json.lock")

    // Live lock (fresh mtime): the mutation must wait until it releases.
    mkdirSync(lockDir)
    let created = false
    const pending = createPairingSession(OPTS).then((r) => {
      created = true
      return r
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(created).toBe(false)
    rmdirSync(lockDir)
    const { session } = await pending
    expect(session.status).toBe("pending")

    // Stale lock (old mtime, e.g. a crashed holder): stolen, not waited on.
    mkdirSync(lockDir)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockDir, old, old)
    const { session: second } = await createPairingSession(OPTS)
    expect(second.status).toBe("pending")
  })

  it("links the minted token and purges long-dead sessions", async () => {
    const { session } = await createPairingSession(OPTS)
    await attachPairingToken(session.id, "abc123")
    expect((await getPairingSession(session.id))?.tokenId).toBe("abc123")

    // A session whose expiry is >24h in the past is dropped on load.
    const { session: ancient } = await createPairingSession({
      ...OPTS,
      ttlMs: -25 * 60 * 60 * 1000,
    })
    expect(await getPairingSession(ancient.id)).toBeNull()
    // The fresh session survives the same purge pass.
    expect(await getPairingSession(session.id)).not.toBeNull()
  })
})
