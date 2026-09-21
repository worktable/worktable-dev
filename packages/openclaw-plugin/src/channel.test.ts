import { describe, expect, it } from "bun:test"
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core"
import {
  agentCredentialForConnection,
  listDirectoryThreads,
  pendingAgentRegistrationToPromote,
  resolveWorktableAccount,
  resolveWorktableThreadTarget,
  worktableThreadHandle,
  worktableChannel,
} from "./channel.js"

describe("Worktable channel account setup", () => {
  it("verifies a staged credential before promoting that exact registration", () => {
    const active = {
      registrationId: "agent_reg_active",
      authorizationServer: "https://example.authkit.app",
      identityEndpoint: "https://example.authkit.app/agent/identity",
      tokenEndpoint: "https://example.authkit.app/oauth2/token",
      resource: "https://app.worktable.cloud/api/mcp",
      assertion: "active-assertion",
      assertionExpiresAt: "2030-01-01T00:00:00.000Z",
      refreshToken: "active-refresh",
      refreshTokenExpiresAt: "2030-02-01T00:00:00.000Z",
    }
    const pending = {
      ...active,
      registrationId: "agent_reg_pending",
      assertion: "pending-assertion",
      refreshToken: "pending-refresh",
    }
    const account = {
      accountId: "default",
      enabled: true,
      server: "https://app.worktable.cloud",
      token: "",
      authMode: "agent-registration" as const,
      agentAuth: active,
      pendingAgentAuth: pending,
    }

    expect(agentCredentialForConnection(account)).toEqual(pending)
    expect(
      pendingAgentRegistrationToPromote(account, active.registrationId)
    ).toBeUndefined()
    expect(
      pendingAgentRegistrationToPromote(account, pending.registrationId)
    ).toBe(pending.registrationId)
  })

  it("treats a staged Agent Registration credential as configured without a static token", () => {
    const credential = {
      registrationId: "agent_reg_1",
      authorizationServer: "https://example.authkit.app",
      identityEndpoint: "https://example.authkit.app/agent/identity",
      tokenEndpoint: "https://example.authkit.app/oauth2/token",
      resource: "https://app.worktable.cloud/api/mcp",
      assertion: "assertion",
      assertionExpiresAt: "2030-01-01T00:00:00.000Z",
      refreshToken: "refresh",
      refreshTokenExpiresAt: "2030-02-01T00:00:00.000Z",
    }
    const cfg = {
      channels: {
        worktable: {
          server: "https://app.worktable.cloud",
          authMode: "agent-registration",
          pendingAgentAuth: credential,
        },
      },
    } as unknown as OpenClawConfig
    const account = resolveWorktableAccount(cfg)
    expect(account.token).toBe("")
    expect(account.pendingAgentAuth).toEqual(credential)
    expect(worktableChannel.config!.isConfigured!(account, cfg)).toBe(true)
  })

  it("clears stale Agent Registration credentials when setup switches to a local token", () => {
    const credential = {
      registrationId: "agent_reg_stale",
      authorizationServer: "https://example.authkit.app",
      identityEndpoint: "https://example.authkit.app/agent/identity",
      tokenEndpoint: "https://example.authkit.app/oauth2/token",
      resource: "https://app.worktable.cloud/api/mcp",
      assertion: "assertion",
      assertionExpiresAt: "2030-01-01T00:00:00.000Z",
      refreshToken: "refresh",
      refreshTokenExpiresAt: "2030-02-01T00:00:00.000Z",
    }
    const cfg = {
      channels: {
        worktable: {
          server: "https://app.worktable.cloud",
          authMode: "agent-registration",
          agentAuth: credential,
          pendingAgentAuth: { ...credential, registrationId: "agent_reg_next" },
        },
      },
    } as unknown as OpenClawConfig

    const updated = worktableChannel.setup!.applyAccountConfig({
      cfg,
      accountId: "default",
      input: {
        url: "http://worktable.test",
        token: "local-token",
      },
    })
    const account = resolveWorktableAccount(updated)
    expect(account).toMatchObject({
      server: "http://worktable.test",
      token: "local-token",
      authMode: "local-token",
      agentAuth: undefined,
      pendingAgentAuth: undefined,
    })
    expect(agentCredentialForConnection(account)).toBeUndefined()
  })

  it("configures an account without a default Space", () => {
    const emptyCfg = {} as OpenClawConfig
    expect(
      worktableChannel.setup!.validateInput!({
        cfg: emptyCfg,
        accountId: "default",
        input: {
          url: "http://worktable.test",
          token: "thread-only-token",
        },
      })
    ).toBeNull()

    const cfg = worktableChannel.setup!.applyAccountConfig({
      cfg: emptyCfg,
      accountId: "default",
      input: {
        url: "http://worktable.test",
        token: "thread-only-token",
      },
    })
    expect(resolveWorktableAccount(cfg)).toMatchObject({
      server: "http://worktable.test",
      token: "thread-only-token",
      defaultSpaceId: undefined,
    })
    expect(
      worktableChannel.config!.isConfigured!(resolveWorktableAccount(cfg), cfg)
    ).toBe(true)
  })

  it("qualifies Space targets and leaves Worktable targets unqualified", () => {
    expect(
      resolveWorktableThreadTarget(
        "thread:other-space/thr_abcdefghijkl",
        "home-space"
      )
    ).toEqual({
      spaceId: "other-space",
      threadId: "thr_abcdefghijkl",
    })
    expect(
      resolveWorktableThreadTarget("thread:thr_abcdefghijkl", "home-space")
    ).toEqual({
      threadId: "thr_abcdefghijkl",
    })
    expect(
      worktableThreadHandle({
        id: "thr_abcdefghijkl",
        spaceId: "home-space",
        title: "Old server summary",
        participants: [],
      })
    ).toBe("thread:home-space/thr_abcdefghijkl")
    expect(
      worktableThreadHandle({
        id: "thr_abcdefghijkl",
        version: 2,
        location: { kind: "space", spaceId: "home-space" },
        spaceId: "home-space",
        title: "V2 summary",
        participants: [],
      })
    ).toBe("thread:home-space/thr_abcdefghijkl")
    expect(
      worktableThreadHandle({
        id: "thr_abcdefghijkl",
        version: 2,
        location: { kind: "worktable" },
        title: "Worktable summary",
        participants: [],
      })
    ).toBe("thread:thr_abcdefghijkl")
  })

  it("preserves a paired home Space when standard setup rotates the token", () => {
    const pairedCfg = {
      channels: {
        worktable: {
          server: "http://worktable.test",
          token: "old-token",
          defaultSpaceId: "connected-agents",
        },
      },
    } as OpenClawConfig
    const input = {
      url: "http://worktable.test",
      token: "rotated-token",
    }
    expect(
      worktableChannel.setup!.validateInput!({
        cfg: pairedCfg,
        accountId: "default",
        input,
      })
    ).toBeNull()

    const updated = worktableChannel.setup!.applyAccountConfig({
      cfg: pairedCfg,
      accountId: "default",
      input,
    })
    const account = resolveWorktableAccount(updated)
    expect(account).toMatchObject({
      token: "rotated-token",
      defaultSpaceId: "connected-agents",
    })
    expect(worktableChannel.config!.isConfigured!(account, updated)).toBe(true)
  })

  it("lists every thread before falling back to a legacy default Space", async () => {
    const calls: Array<string | undefined> = []
    const allThreads = [
      {
        id: "thr_abcdefghijkl",
        version: 2 as const,
        location: { kind: "worktable" as const },
        title: "General",
        participants: [],
      },
    ]
    expect(
      await listDirectoryThreads(
        {
          listThreads(spaceId) {
            calls.push(spaceId)
            return Promise.resolve(allThreads)
          },
        },
        "legacy-home"
      )
    ).toEqual(allThreads)
    expect(calls).toEqual([undefined])

    calls.length = 0
    expect(
      await listDirectoryThreads(
        {
          listThreads(spaceId) {
            calls.push(spaceId)
            return spaceId
              ? Promise.resolve(allThreads)
              : Promise.reject(
                  Object.assign(new Error("spaceId is required"), {
                    code: -32602,
                  })
                )
          },
        },
        "legacy-home"
      )
    ).toEqual(allThreads)
    expect(calls).toEqual([undefined, "legacy-home"])

    const currentFailure = new Error("server unavailable")
    await expect(
      listDirectoryThreads(
        {
          listThreads(spaceId) {
            calls.push(spaceId)
            return Promise.reject(currentFailure)
          },
        },
        "legacy-home"
      )
    ).rejects.toBe(currentFailure)
    expect(calls.at(-1)).toBeUndefined()
  })
})
