import { describe, expect, it } from "bun:test"
import { WorktableAgentCredentialProvider } from "./agent-auth.js"
import type { WorktableAgentAuth } from "./types.js"

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

describe("WorkOS Agent Registration", () => {
  it("persists a rotated refresh token before exchanging the new assertion", async () => {
    const order: string[] = []
    const signals: Array<AbortSignal | null | undefined> = []
    const credential: WorktableAgentAuth = {
      registrationId: "agent_reg_1",
      authorizationServer: "https://example.authkit.app",
      identityEndpoint: "https://example.authkit.app/agent/identity",
      tokenEndpoint: "https://example.authkit.app/oauth2/token",
      resource: "https://app.worktable.cloud/api/mcp",
      assertion: "expired",
      assertionExpiresAt: "2000-01-01T00:00:00.000Z",
      refreshToken: "refresh_old",
      refreshTokenExpiresAt: "2030-01-01T00:00:00.000Z",
    }
    const provider = new WorktableAgentCredentialProvider({
      credential,
      async save(next) {
        order.push(`save:${next.refreshToken}`)
      },
      fetch: (async (input, init) => {
        signals.push(init?.signal)
        const url = String(input)
        if (url.endsWith("/agent/identity")) {
          order.push("refresh")
          return json({
            identity: {
              assertion: "assertion_new",
              expires_at: "2030-01-01T00:00:00.000Z",
              refresh_token: {
                value: "refresh_new",
                expires_at: "2030-02-01T00:00:00.000Z",
              },
            },
          })
        }
        order.push("exchange")
        return json({
          access_token: "access_new",
          token_type: "Bearer",
          expires_in: 300,
        })
      }) as typeof fetch,
    })

    expect(await provider.accessToken()).toBe("access_new")
    expect(order).toEqual(["refresh", "save:refresh_new", "exchange"])
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
    expect(await provider.accessToken()).toBe("access_new")
    expect(order).toHaveLength(3)
  })

  it("serializes rotating refreshes across providers and reloads the winner", async () => {
    let durable: WorktableAgentAuth = {
      registrationId: "agent_reg_shared",
      authorizationServer: "https://example.authkit.app",
      identityEndpoint: "https://example.authkit.app/agent/identity",
      tokenEndpoint: "https://example.authkit.app/oauth2/token",
      resource: "https://app.worktable.cloud/api/mcp",
      assertion: "expired",
      assertionExpiresAt: "2000-01-01T00:00:00.000Z",
      refreshToken: "refresh_old",
      refreshTokenExpiresAt: "2030-01-01T00:00:00.000Z",
    }
    let refreshes = 0
    const fetchImpl = (async (input) => {
      const url = String(input)
      if (url.endsWith("/agent/identity")) {
        refreshes += 1
        return json({
          identity: {
            assertion: "assertion_new",
            expires_at: "2030-01-01T00:00:00.000Z",
            refresh_token: {
              value: "refresh_new",
              expires_at: "2030-02-01T00:00:00.000Z",
            },
          },
        })
      }
      return json({
        access_token: "access_new",
        token_type: "Bearer",
        expires_in: 300,
      })
    }) as typeof fetch
    const provider = () =>
      new WorktableAgentCredentialProvider({
        credential: { ...durable },
        load: () => Promise.resolve({ ...durable }),
        async save(next) {
          durable = next
        },
        fetch: fetchImpl,
      })

    const [first, second] = await Promise.all([
      provider().accessToken(),
      provider().accessToken(),
    ])

    expect([first, second]).toEqual(["access_new", "access_new"])
    expect(refreshes).toBe(1)
    expect(durable).toMatchObject({
      assertion: "assertion_new",
      refreshToken: "refresh_new",
    })
  })
})
