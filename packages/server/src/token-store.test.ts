import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { setAppDirOverride } from "./app-storage.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import {
  createToken,
  finalizeAgentTokenRotation,
  finalizeAgentTokenRotations,
  hasActiveTokens,
  hasScope,
  isValidScope,
  listTokens,
  revokeToken,
  rotateAgentToken,
  verifyToken,
} from "./token-store.ts"

let appDir: string
let workspaceDir: string

async function waitForFiles(paths: string[]): Promise<void> {
  // Starting fresh Bun processes can take more than two seconds while the
  // canonical subprocess lanes are running in parallel. Wait for the explicit
  // readiness handshake rather than treating scheduler latency as a token-lock
  // failure.
  const deadline = Date.now() + 10_000
  while (paths.some((path) => !existsSync(path)) && Date.now() < deadline) {
    // test-policy: external-readiness-backoff
    await Bun.sleep(5)
  }
  expect(paths.filter((path) => !existsSync(path))).toEqual([])
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-app-"))
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-ws-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
})

afterEach(() => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  for (const dir of [appDir, workspaceDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

describe("token store", () => {
  it("mints a token that verifies to its full identity", async () => {
    const { token, metadata } = await createToken({
      scopes: ["docs:read", "records:*"],
      agent: "claude-code",
    })

    expect(token).toMatch(/^wt_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/)
    expect(metadata.agent).toBe("claude-code")

    const identity = await verifyToken(token)
    expect(identity).toEqual({
      user: "owner",
      workspace: workspaceDir,
      credentialClass: "local",
      scopes: ["docs:read", "records:*"],
      agent: "claude-code",
      principal: metadata.principal,
    })
  })

  it("rejects tampered, truncated, and unknown tokens", async () => {
    const { token } = await createToken({ scopes: ["*"] })

    // Flip one character of the secret
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")
    expect(await verifyToken(tampered)).toBeNull()
    expect(await verifyToken(token.slice(0, -1))).toBeNull()
    expect(await verifyToken("wt_000000000000_" + "A".repeat(43))).toBeNull()
    expect(await verifyToken("")).toBeNull()
    expect(await verifyToken("Bearer " + token)).toBeNull()
  })

  it("revoked tokens stop verifying but stay listed", async () => {
    const { token, metadata } = await createToken({ scopes: ["*"] })
    expect(await verifyToken(token)).not.toBeNull()
    expect(await hasActiveTokens()).toBe(true)

    expect(await revokeToken(metadata.id)).toBe(true)
    expect(await verifyToken(token)).toBeNull()
    expect(await hasActiveTokens()).toBe(false)

    const listed = await listTokens()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.revokedAt).not.toBeNull()
  })

  it("revoking an unknown id returns false", async () => {
    expect(await revokeToken("doesnotexist")).toBe(false)
  })

  it("tokens are bound to the workspace they were minted for", async () => {
    const { token } = await createToken({ scopes: ["*"] })
    expect(await verifyToken(token)).not.toBeNull()

    const otherWorkspace = mkdtempSync(join(tmpdir(), "worktable-ws2-"))
    try {
      setWorkspaceRootOverride(otherWorkspace)
      expect(await verifyToken(token)).toBeNull()
    } finally {
      setWorkspaceRootOverride(workspaceDir)
      rmSync(otherWorkspace, { recursive: true, force: true })
    }
  })

  it("never persists or lists the secret", async () => {
    const { token } = await createToken({ scopes: ["*"] })
    const match = /^wt_[0-9a-f]{12}_([A-Za-z0-9_-]{43})$/.exec(token)
    expect(match).not.toBeNull()
    const secret = match![1]!

    const onDisk = await readFile(join(appDir, "tokens.json"), "utf8")
    expect(onDisk).not.toContain(secret)

    const listed = await listTokens()
    expect(JSON.stringify(listed)).not.toContain(secret)
    expect(listed[0]).not.toHaveProperty("secretHash")
  })

  it("rejects empty and malformed scopes at mint time", async () => {
    await expect(createToken({ scopes: [] })).rejects.toThrow()
    await expect(createToken({ scopes: ["docs read"] })).rejects.toThrow()
    await expect(createToken({ scopes: ["DOCS:READ"] })).rejects.toThrow()
  })

  it("multiple tokens coexist and revoke independently", async () => {
    const a = await createToken({ scopes: ["docs:read"], agent: "a" })
    const b = await createToken({ scopes: ["*"], agent: "b" })

    await revokeToken(a.metadata.id)
    expect(await verifyToken(a.token)).toBeNull()
    expect(await verifyToken(b.token)).not.toBeNull()
    expect(await listTokens()).toHaveLength(2)
  })

  it("serializes token mutations across Worktable processes", async () => {
    const lockDir = join(appDir, "tokens.json.lock")
    mkdirSync(lockDir)
    const moduleUrl = new URL("./token-store.ts", import.meta.url).href
    const spawnMint = (agent: string) => {
      const readyPath = join(appDir, `${agent}.ready`)
      return {
        readyPath,
        child: Bun.spawn({
          cmd: [
            process.execPath,
            "-e",
            `
            import { writeFileSync } from "node:fs";
            import { createToken } from ${JSON.stringify(moduleUrl)};
            writeFileSync(process.env.READY_PATH, "ready");
            const result = await createToken({
              scopes: ["docs:read"],
              agent: ${JSON.stringify(agent)}
            });
            console.log(result.metadata.id);
          `,
          ],
          cwd: process.cwd(),
          env: {
            ...process.env,
            WORKTABLE_APP_DIR: appDir,
            WORKTABLE_WORKSPACE: workspaceDir,
            READY_PATH: readyPath,
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      }
    }
    const spawned = [spawnMint("process-a"), spawnMint("process-b")]
    const minters = spawned.map(({ child }) => child)
    let exited = 0
    for (const minter of minters) {
      void minter.exited.then(() => {
        exited += 1
      })
    }

    try {
      await waitForFiles(spawned.map(({ readyPath }) => readyPath))
      expect(exited).toBe(0)
    } finally {
      if (existsSync(lockDir)) rmdirSync(lockDir)
    }

    expect(await Promise.all(minters.map((minter) => minter.exited))).toEqual([
      0, 0,
    ])
    expect(
      await Promise.all(
        minters.map((minter) => new Response(minter.stderr).text())
      )
    ).toEqual(["", ""])
    expect(
      (await listTokens())
        .filter((token) => !token.revokedAt)
        .map((token) => token.agent)
        .sort()
    ).toEqual(["process-a", "process-b"])
  }, 15_000)

  it("property: random strings never verify", async () => {
    await createToken({ scopes: ["*"] })
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 80 }), async (raw) => {
        expect(await verifyToken(raw)).toBeNull()
      }),
      { numRuns: 200 }
    )
  })

  it("property: well-formed tokens with wrong secrets never verify", async () => {
    const { metadata } = await createToken({ scopes: ["*"] })
    const base64urlChar = fc.constantFrom(
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    )
    await fc.assert(
      fc.asyncProperty(
        fc.array(base64urlChar, { minLength: 43, maxLength: 43 }),
        async (chars) => {
          const forged = `wt_${metadata.id}_${chars.join("")}`
          expect(await verifyToken(forged)).toBeNull()
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe("scopes", () => {
  it("validates scope syntax", () => {
    expect(isValidScope("*")).toBe(true)
    expect(isValidScope("docs:read")).toBe(true)
    expect(isValidScope("docs:*")).toBe(true)
    expect(isValidScope("tokens:manage")).toBe(true)
    expect(isValidScope("docs")).toBe(false)
    expect(isValidScope("docs:")).toBe(false)
    expect(isValidScope(":read")).toBe(false)
    expect(isValidScope("*:read")).toBe(false)
    expect(isValidScope("")).toBe(false)
  })

  it("matches exact, wildcard, and star scopes", () => {
    expect(hasScope(["*"], "anything:atall")).toBe(true)
    expect(hasScope(["docs:read"], "docs:read")).toBe(true)
    expect(hasScope(["docs:read"], "docs:write")).toBe(false)
    expect(hasScope(["docs:*"], "docs:write")).toBe(true)
    expect(hasScope(["docs:*"], "records:read")).toBe(false)
    expect(hasScope([], "docs:read")).toBe(false)
  })

  it("property: prefix wildcards grant exactly their resource", () => {
    const ident = fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/)
    fc.assert(
      fc.property(ident, ident, ident, (resource, action, otherResource) => {
        fc.pre(resource !== otherResource)
        expect(hasScope([`${resource}:*`], `${resource}:${action}`)).toBe(true)
        expect(hasScope([`${resource}:*`], `${otherResource}:${action}`)).toBe(
          false
        )
      }),
      { numRuns: 200 }
    )
  })
})

describe("usage stamps (last seen)", () => {
  it("stamps lastUsedAt on successful verify, throttled within the interval", async () => {
    const { token, metadata } = await createToken({
      scopes: ["docs:read"],
      agent: "codex@devbox",
    })
    expect(metadata.lastUsedAt).toBeNull()

    await verifyToken(token)
    const [afterFirst] = await listTokens()
    expect(afterFirst!.lastUsedAt).not.toBeNull()

    // A second verify inside the throttle window must not move the stamp.
    await verifyToken(token)
    const [afterSecond] = await listTokens()
    expect(afterSecond!.lastUsedAt).toBe(afterFirst!.lastUsedAt)
  })

  it("never stamps failed verifications", async () => {
    const { token } = await createToken({ scopes: ["docs:read"] })
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")
    await verifyToken(tampered)
    const [meta] = await listTokens()
    expect(meta!.lastUsedAt).toBeNull()
  })
})

describe("rotateAgentToken", () => {
  it("revokes every active same-label token, then mints a fresh one", async () => {
    const first = await createToken({
      scopes: ["docs:*"],
      agent: "codex@devbox",
    })
    const other = await createToken({
      scopes: ["docs:*"],
      agent: "codex@laptop",
    })

    const rotated = await rotateAgentToken({
      scopes: ["docs:*", "search:read"],
      agent: "codex@devbox",
    })

    expect(await verifyToken(first.token)).toBeNull()
    expect(await verifyToken(other.token)).not.toBeNull()
    const identity = await verifyToken(rotated.token)
    expect(identity?.scopes).toEqual(["docs:*", "search:read"])
    expect(identity?.agent).toBe("codex@devbox")
  })
})

describe("finalizeAgentTokenRotation", () => {
  it("keeps the previous credential live until its replacement is finalized", async () => {
    const previous = await createToken({
      scopes: ["docs:*"],
      agent: "codex@devbox",
    })
    const replacement = await createToken({
      scopes: ["docs:*", "search:read"],
      agent: "codex@devbox",
    })

    expect(await verifyToken(previous.token)).not.toBeNull()
    expect(await verifyToken(replacement.token)).not.toBeNull()
    expect(await finalizeAgentTokenRotation(replacement.metadata.id)).toBe(true)
    expect(await verifyToken(previous.token)).toBeNull()
    expect(await verifyToken(replacement.token)).not.toBeNull()
  })

  it("preserves newer same-label credentials when an older pairing completes late", async () => {
    const previous = await createToken({
      scopes: ["docs:*"],
      agent: "codex@devbox",
    })
    const delayedWinner = await createToken({
      scopes: ["docs:*", "search:read"],
      agent: "codex@devbox",
    })
    const newer = await createToken({
      scopes: ["docs:*", "search:read"],
      agent: "codex@devbox",
    })

    expect(await finalizeAgentTokenRotation(delayedWinner.metadata.id)).toBe(
      true
    )
    expect(await verifyToken(previous.token)).toBeNull()
    expect(await verifyToken(delayedWinner.token)).not.toBeNull()
    expect(await verifyToken(newer.token)).not.toBeNull()
  })

  it("atomically finalizes per-client credentials and retires the legacy shared credential", async () => {
    const legacy = await createToken({
      scopes: ["threads:*"],
      agent: "managed",
    })
    const oldCursor = await createToken({
      scopes: ["threads:*"],
      agent: "managed:cursor",
    })
    const cursor = await createToken({
      scopes: ["threads:*"],
      agent: "managed:cursor",
    })
    const codex = await createToken({
      scopes: ["threads:*"],
      agent: "managed:codex",
    })

    expect(
      await finalizeAgentTokenRotations(
        [cursor.metadata.id, codex.metadata.id],
        { retireAgentLabels: ["managed"] }
      )
    ).toBe(true)
    expect(await verifyToken(legacy.token)).toBeNull()
    expect(await verifyToken(oldCursor.token)).toBeNull()
    expect(await verifyToken(cursor.token)).not.toBeNull()
    expect(await verifyToken(codex.token)).not.toBeNull()
  })
})

describe("rotation workspace scoping", () => {
  it("leaves same-label tokens of OTHER workspaces untouched", async () => {
    const inA = await createToken({ scopes: ["docs:*"], agent: "codex@devbox" })

    const workspaceB = mkdtempSync(join(tmpdir(), "worktable-ws-b-"))
    try {
      setWorkspaceRootOverride(workspaceB)
      await rotateAgentToken({ scopes: ["docs:*"], agent: "codex@devbox" })

      // Back in workspace A, its token still verifies.
      setWorkspaceRootOverride(workspaceDir)
      expect(await verifyToken(inA.token)).not.toBeNull()
    } finally {
      setWorkspaceRootOverride(workspaceDir)
      rmSync(workspaceB, { recursive: true, force: true })
    }
  })
})

describe("write serialization", () => {
  it("concurrent rotations for different agents each yield a surviving token", async () => {
    const [a, b] = await Promise.all([
      rotateAgentToken({ scopes: ["docs:*"], agent: "codex@a" }),
      rotateAgentToken({ scopes: ["docs:*"], agent: "codex@b" }),
    ])
    expect(await verifyToken(a.token)).not.toBeNull()
    expect(await verifyToken(b.token)).not.toBeNull()
    expect(await listTokens()).toHaveLength(2)
  })

  it("concurrent verifies of different tokens both land usage stamps", async () => {
    const a = await createToken({ scopes: ["docs:read"], agent: "a" })
    const b = await createToken({ scopes: ["docs:read"], agent: "b" })
    await Promise.all([verifyToken(a.token), verifyToken(b.token)])
    const listed = await listTokens()
    for (const meta of listed) expect(meta.lastUsedAt).not.toBeNull()
  })
})
