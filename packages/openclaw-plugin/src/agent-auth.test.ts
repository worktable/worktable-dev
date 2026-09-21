import { describe, expect, it } from "bun:test"
import {
  beginServiceAuthRegistration,
  completeServiceAuthRegistration,
  discoverAgentAuth,
  WorktableAgentCredentialProvider,
} from "./agent-auth.js"
import type { WorktableAgentAuth } from "./types.js"

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

describe("WorkOS Agent Registration", () => {
  it("discovers service-auth, completes the claim, and preserves rotating credentials", async () => {
    const requests: Array<{
      url: string
      body?: unknown
      signal?: AbortSignal | null
    }> = []
    const fetchImpl = (async (input, init) => {
      const url = String(input)
      requests.push({
        url,
        signal: init?.signal,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      })
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return json({
          resource: "https://app.worktable.cloud/api/mcp",
          authorization_servers: ["https://example.authkit.app"],
        })
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return json({
          issuer: "https://example.authkit.app",
          token_endpoint: "https://example.authkit.app/oauth2/token",
          agent_auth: {
            identity_endpoint: "https://example.authkit.app/agent/identity",
            claim_endpoint: "https://example.authkit.app/agent/identity/claim",
            identity_types_supported: ["service_auth"],
          },
        })
      }
      if (url.endsWith("/agent/identity")) {
        return json({
          id: "agent_reg_1",
          claim: {
            token: "claim_1",
            attempt: {
              verification_uri: "https://example.authkit.app/claim/attempt_1",
            },
          },
        })
      }
      if (url.endsWith("/agent/identity/claim/complete")) {
        return json({
          id: "agent_reg_1",
          identity: {
            assertion: "assertion_1",
            expires_at: "2030-01-01T00:00:00.000Z",
            refresh_token: {
              value: "refresh_1",
              expires_at: "2030-02-01T00:00:00.000Z",
            },
          },
        })
      }
      throw new Error(`Unexpected URL ${url}`)
    }) as typeof fetch

    const discovery = await discoverAgentAuth(
      "https://app.worktable.cloud",
      fetchImpl
    )
    const registration = await beginServiceAuthRegistration(
      discovery,
      "owner@example.com",
      fetchImpl
    )
    const credential = await completeServiceAuthRegistration(
      discovery,
      registration,
      "BCDF-GHJK",
      fetchImpl
    )

    expect(registration.verificationUri).toContain("/claim/attempt_1")
    expect(credential).toMatchObject({
      registrationId: "agent_reg_1",
      resource: "https://app.worktable.cloud/api/mcp",
      assertion: "assertion_1",
      refreshToken: "refresh_1",
    })
    expect(requests.at(-1)?.body).toEqual({
      claim_token: "claim_1",
      user_code: "BCDF-GHJK",
    })
    expect(requests).toHaveLength(4)
    expect(
      requests.every((request) => request.signal instanceof AbortSignal)
    ).toBe(true)
  })

  it("uses RFC 8414 discovery for a path-scoped authorization server", async () => {
    const requested: string[] = []
    const fetchImpl = (async (input) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return json({
          resource: "https://app.worktable.cloud/api/mcp",
          authorization_servers: ["https://idp.example/realms/acme"],
        })
      }
      if (
        url ===
        "https://idp.example/.well-known/oauth-authorization-server/realms/acme"
      ) {
        return json({
          issuer: "https://idp.example/realms/acme/",
          token_endpoint: "https://idp.example/realms/acme/token",
          agent_auth: {
            identity_endpoint: "https://idp.example/realms/acme/agent/identity",
            claim_endpoint:
              "https://idp.example/realms/acme/agent/identity/claim",
            identity_types_supported: ["service_auth"],
          },
        })
      }
      return json({ error: "not found" }, 404)
    }) as typeof fetch

    await expect(
      discoverAgentAuth("https://app.worktable.cloud", fetchImpl)
    ).resolves.toMatchObject({
      authorizationServer: "https://idp.example/realms/acme",
      tokenEndpoint: "https://idp.example/realms/acme/token",
    })
    expect(requested).toEqual([
      "https://app.worktable.cloud/.well-known/oauth-protected-resource",
      "https://idp.example/.well-known/oauth-authorization-server/realms/acme",
    ])
  })

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
