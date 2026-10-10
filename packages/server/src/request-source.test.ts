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
  it("is the public address that connected, never one a request claims", () => {
    expect(requestSource(from("203.0.113.7"))).toBe("203.0.113.7")
    expect(requestSource(from("203.0.113.7", "198.51.100.1"))).toBe(
      "203.0.113.7"
    )
    // Through a proxy, a tunnel, or from a neighbour, senders cannot be told
    // apart, whatever they forward.
    expect(requestSource(from("127.0.0.1", "203.0.113.9"))).toBeNull()
    expect(requestSource(from("172.18.0.5", "203.0.113.9"))).toBeNull()
    expect(requestSource(from("100.101.102.103"))).toBeNull()
    expect(requestSource(from("::1"))).toBeNull()
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

  const ask = (source: string | null) =>
    createConnectionRequest({
      target: { kind: "mcp-client", client: null },
      hostname: null,
      suggestedName: null,
      source,
    })

  it("lets one sender hold only a few, so it cannot crowd out others", async () => {
    for (let i = 0; i < 3; i++) await ask("203.0.113.7")
    await expect(ask("203.0.113.7")).rejects.toBeInstanceOf(
      ConnectionRequestLimitError
    )
    // Everyone else can still ask.
    await expect(ask("198.51.100.1")).resolves.toMatchObject({
      userCode: expect.any(String),
    })
  })

  it("shares the earlier limit among senders that cannot be told apart", async () => {
    for (let i = 0; i < 20; i++) await ask(null)
    await expect(ask(null)).rejects.toBeInstanceOf(ConnectionRequestLimitError)
    // Identified senders are counted on their own.
    await expect(ask("198.51.100.1")).resolves.toMatchObject({
      userCode: expect.any(String),
    })
  })
})
