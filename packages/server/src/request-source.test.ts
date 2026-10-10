import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  ConnectionRequestLimitError,
  createConnectionRequest,
} from "./connection-request-store.ts"
import { rememberPeer, requestSource } from "./request-source.ts"

function from(peer: string, forwardedFor?: string): Request {
  const req = new Request("http://worktable.example/api/pairing/requests", {
    headers: forwardedFor ? { "X-Forwarded-For": forwardedFor } : {},
  })
  rememberPeer(req, peer)
  return req
}

describe("who sent a request", () => {
  it("trusts a forwarded address only from a proxy on this computer", () => {
    expect(requestSource(from("203.0.113.7"))).toBe("203.0.113.7")
    // A remote sender cannot claim another address.
    expect(requestSource(from("203.0.113.7", "198.51.100.1"))).toBe(
      "203.0.113.7"
    )
    // A local proxy's last entry is the address it saw; earlier ones are the
    // sender's own claims.
    expect(requestSource(from("127.0.0.1", "198.51.100.1, 203.0.113.9"))).toBe(
      "203.0.113.9"
    )
    expect(requestSource(from("::1"))).toBe("::1")
  })

  it("on Cloud, cannot tell senders apart without the gateway's address", () => {
    const saved = process.env["WORKTABLE_HOSTED"]
    process.env["WORKTABLE_HOSTED"] = "1"
    try {
      expect(requestSource(from("10.0.0.2"))).toBeNull()
    } finally {
      if (saved === undefined) delete process.env["WORKTABLE_HOSTED"]
      else process.env["WORKTABLE_HOSTED"] = saved
    }
  })
})

describe("waiting connection requests", () => {
  let appDir: string
  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), "worktable-request-limits-"))
    setAppDirOverride(appDir)
  })
  afterEach(async () => {
    setAppDirOverride(null)
    await rm(appDir, { recursive: true, force: true })
  })

  it("lets one sender hold only a few, so it cannot crowd out others", async () => {
    const ask = (source: string | null) =>
      createConnectionRequest({
        target: { kind: "mcp-client", client: null },
        hostname: null,
        suggestedName: null,
        source,
      })
    for (let i = 0; i < 3; i++) await ask("203.0.113.7")
    await expect(ask("203.0.113.7")).rejects.toBeInstanceOf(
      ConnectionRequestLimitError
    )
    // Everyone else can still ask.
    await expect(ask("198.51.100.1")).resolves.toMatchObject({
      userCode: expect.any(String),
    })
  })

  it("keeps only the overall limit when senders cannot be told apart", async () => {
    for (let i = 0; i < 4; i++) {
      await createConnectionRequest({
        target: { kind: "mcp-client", client: null },
        hostname: null,
        suggestedName: null,
        source: null,
      })
    }
  })
})
