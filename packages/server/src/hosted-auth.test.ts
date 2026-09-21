import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import {
  ACTOR_HEADERS,
  ENV,
  GATEWAY_HEADER,
  HOSTED_BROWSER_SCOPES,
  BROWSER_ASSERTION_TYPE,
  browserAssertionAudience,
  browserAssertionIssuer,
  browserRequestBinding,
} from "@worktable/hosted-contract"
import fc from "fast-check"
import { SignJWT, base64url } from "jose"
import { trustedLocalIdentity, requireWorkspaceOwner } from "./auth.ts"
import {
  HostedCredentialError,
  HOSTED_BROWSER_RUNTIME_SCOPES,
  verifyHostedBrowserAssertion,
} from "./hosted-auth.ts"
import { trustedGatewayScopeCeiling } from "./hosted.ts"

const origin = "https://app.worktable.cloud"
const workspaceId = "workspace_cloud_123"
const owner = "user_owner_123"
const admission = "gateway-admission-secret-value"
const assertionSecret = base64url.encode(new Uint8Array(32).fill(7))
const originalEnv = { ...process.env }

beforeEach(() => {
  process.env[ENV.HOSTED] = "1"
  process.env[ENV.GATEWAY_SECRET] = admission
  process.env[ENV.CLOUD_WORKSPACE_ID] = workspaceId
  process.env[ENV.OWNER_SUBJECT] = owner
  process.env[ENV.RESOURCE_URL] = `${origin}/api/mcp`
  process.env[ENV.BROWSER_ASSERTION_KEYRING] = JSON.stringify([
    { kid: "v1", secret: assertionSecret, state: "signing" },
  ])
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
})

function admittedRequest(url: string, method = "GET", upgrade = false) {
  return new Request(url, {
    method,
    headers: {
      [GATEWAY_HEADER]: admission,
      [ACTOR_HEADERS.ID]: `workos:${owner}`,
      [ACTOR_HEADERS.TYPE]: "human",
      [ACTOR_HEADERS.NAME]: "Cloud Owner",
      ...(upgrade ? { Upgrade: "websocket" } : {}),
    },
  })
}

async function assertionFor(
  request: Request,
  overrides: Record<string, unknown> = {},
  options: {
    kid?: string
    secret?: string
    wt?: Record<string, unknown>
  } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      browserRequestBinding(request.method, new URL(request.url))
    )
  )
  const claims = {
    iss: browserAssertionIssuer(origin),
    aud: browserAssertionAudience(workspaceId),
    sub: owner,
    iat: now,
    nbf: now - 5,
    exp: now + 60,
    jti: crypto.randomUUID(),
    wt: {
      credential: "browser",
      workspaceId,
      requestHash: base64url.encode(new Uint8Array(digest)),
      scopes: [...HOSTED_BROWSER_SCOPES],
      principal: {
        id: `workos:${owner}`,
        type: "human",
        displayName: "Cloud Owner",
      },
      ...options.wt,
    },
    ...overrides,
  }
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: "HS256",
      typ: BROWSER_ASSERTION_TYPE,
      kid: options.kid ?? "v1",
    })
    .sign(base64url.decode(options.secret ?? assertionSecret))
}

describe("hosted browser assertions", () => {
  it("accepts only exact known scopes from admitted gateway policy", () => {
    const request = new Request(`${origin}/api/mcp`, {
      headers: {
        [GATEWAY_HEADER]: admission,
        [ACTOR_HEADERS.ID]: "workos-agent:agent_1",
        [ACTOR_HEADERS.TYPE]: "agent",
        [ACTOR_HEADERS.NAME]: "OpenClaw",
        [ACTOR_HEADERS.AUTHORIZED_BY]: `workos:${owner}`,
        [ACTOR_HEADERS.SCOPES]: JSON.stringify([
          "threads:read",
          "threads:write",
          "threads:participate",
          "*",
          "tokens:manage",
        ]),
      },
    })
    expect(trustedGatewayScopeCeiling(request)).toEqual([
      "threads:read",
      "threads:write",
      "threads:participate",
    ])
    const malformed = new Request(request, {
      headers: {
        ...Object.fromEntries(request.headers),
        [ACTOR_HEADERS.SCOPES]: '{"threads":"*"}',
      },
    })
    expect(trustedGatewayScopeCeiling(malformed)).toEqual([])
  })

  it("accepts an admitted, owner- and request-bound assertion", async () => {
    const request = admittedRequest(`${origin}/api/spaces?after=a%2Fb`)
    const identity = await verifyHostedBrowserAssertion(
      request,
      await assertionFor(request)
    )
    expect(identity?.principal).toEqual({
      id: `workos:${owner}`,
      type: "human",
      displayName: "Cloud Owner",
    })
    expect(identity?.credentialClass).toBe("browser")
    expect(HOSTED_BROWSER_SCOPES).not.toContain("documents:*")
    expect(identity?.scopes).toEqual([...HOSTED_BROWSER_RUNTIME_SCOPES])
    expect(identity?.scopes).toContain("documents:*")
    expect(identity?.scopes).toContain("threads:*")

    // A verified hosted owner deliberately has no wildcard credential. Owner-only
    // REST operations must still accept the authenticated browser principal.
    const app = new Hono()
    app.use("*", trustedLocalIdentity())
    app.get("/api/spaces", requireWorkspaceOwner(), c => c.json({ ok: true }))
    const credential = await assertionFor(request)
    const response = await app.fetch(new Request(request, {
      headers: { ...Object.fromEntries(request.headers), Authorization: `Bearer ${credential}` },
    }))
    expect(response.status).toBe(200)
  })

  it("rejects route, method, workspace, subject, actor, key, and admission substitution", async () => {
    const request = admittedRequest(`${origin}/api/spaces/a`, "POST")
    const token = await assertionFor(request)
    expect(
      await verifyHostedBrowserAssertion(
        admittedRequest(`${origin}/api/spaces/b`, "POST"),
        token
      )
    ).toBeNull()
    expect(
      await verifyHostedBrowserAssertion(
        admittedRequest(`${origin}/api/spaces/a`, "DELETE"),
        token
      )
    ).toBeNull()
    expect(
      await verifyHostedBrowserAssertion(
        request,
        await assertionFor(request, { sub: "user_other" })
      )
    ).toBeNull()
    expect(
      await verifyHostedBrowserAssertion(
        request,
        await assertionFor(request, {
          aud: browserAssertionAudience("workspace_other"),
        })
      )
    ).toBeNull()
    const badAdmission = new Request(request, {
      headers: {
        ...Object.fromEntries(request.headers),
        [GATEWAY_HEADER]: assertionSecret,
      },
    })
    expect(await verifyHostedBrowserAssertion(badAdmission, token)).toBeNull()
    const badActor = new Request(request, {
      headers: {
        ...Object.fromEntries(request.headers),
        [ACTOR_HEADERS.NAME]: "Another actor",
      },
    })
    expect(await verifyHostedBrowserAssertion(badActor, token)).toBeNull()
  })

  it("binds the signed human principal to both the configured owner and every trusted actor field", async () => {
    const base = admittedRequest(`${origin}/api/spaces`)
    const wrongPrincipalRequest = new Request(base, {
      headers: {
        ...Object.fromEntries(base.headers),
        [ACTOR_HEADERS.ID]: "workos:user_other",
      },
    })
    expect(
      await verifyHostedBrowserAssertion(
        wrongPrincipalRequest,
        await assertionFor(
          wrongPrincipalRequest,
          {},
          {
            wt: {
              principal: {
                id: "workos:user_other",
                type: "human",
                displayName: "Cloud Owner",
              },
            },
          }
        )
      )
    ).toBeNull()

    const token = await assertionFor(base)
    const actorSubstitutions: Array<Record<string, string>> = [
      { [ACTOR_HEADERS.ID]: "workos:user_other" },
      { [ACTOR_HEADERS.TYPE]: "agent" },
      { [ACTOR_HEADERS.NAME]: "Another actor" },
      { [ACTOR_HEADERS.AUTHORIZED_BY]: `workos:${owner}` },
    ]
    for (const headers of actorSubstitutions) {
      const substituted = new Request(base, {
        headers: {
          ...Object.fromEntries(base.headers),
          ...headers,
        },
      })
      expect(await verifyHostedBrowserAssertion(substituted, token)).toBeNull()
    }
  })

  it("requires the exact one-minute assertion window and five-second not-before skew", async () => {
    const request = admittedRequest(`${origin}/api/spaces`)
    const now = Math.floor(Date.now() / 1000)
    expect(
      await verifyHostedBrowserAssertion(
        request,
        await assertionFor(request, {
          iat: now + 5,
          nbf: now,
          exp: now + 65,
        })
      )
    ).not.toBeNull()
    for (const overrides of [
      { iat: now, nbf: now - 4, exp: now + 60 },
      { iat: now, nbf: now - 5, exp: now + 59 },
      { iat: now + 10, nbf: now + 5, exp: now + 70 },
    ]) {
      expect(
        await verifyHostedBrowserAssertion(
          request,
          await assertionFor(request, overrides)
        )
      ).toBeNull()
    }
  })

  it("property-checks every signed assertion boundary", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "issuer",
          "audience",
          "workspace",
          "subject",
          "kid",
          "signature",
          "expired",
          "premature",
          "duration",
          "hash",
          "scopes"
        ),
        async (fault) => {
          const request = admittedRequest(
            `${origin}/api/docs/a%20b?nonce=${crypto.randomUUID()}`,
            "POST"
          )
          const now = Math.floor(Date.now() / 1000)
          const overrides: Record<string, unknown> = {}
          const options: Parameters<typeof assertionFor>[2] = {}
          if (fault === "issuer") overrides.iss = `${origin}/wrong-issuer`
          if (fault === "audience") {
            overrides.aud = browserAssertionAudience("workspace_other")
          }
          if (fault === "subject") overrides.sub = "user_other"
          if (fault === "kid") options.kid = "unknown"
          if (fault === "signature") {
            options.secret = base64url.encode(new Uint8Array(32).fill(8))
          }
          if (fault === "expired") {
            overrides.iat = now - 120
            overrides.nbf = now - 125
            overrides.exp = now - 60
          }
          if (fault === "premature") {
            overrides.iat = now + 30
            overrides.nbf = now + 25
            overrides.exp = now + 90
          }
          if (fault === "duration") overrides.exp = now + 120
          if (fault === "workspace") options.wt = { workspaceId: "other" }
          if (fault === "hash") options.wt = { requestHash: "x".repeat(43) }
          if (fault === "scopes") options.wt = { scopes: ["*"] }
          expect(
            await verifyHostedBrowserAssertion(
              request,
              await assertionFor(request, overrides, options)
            )
          ).toBeNull()
        }
      ),
      { numRuns: 55 }
    )
  })

  it("rejects malformed and oversized bearer input without throwing", async () => {
    const request = admittedRequest(`${origin}/api/spaces`)
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        async (bytes) => {
          expect(
            await verifyHostedBrowserAssertion(request, base64url.encode(bytes))
          ).toBeNull()
        }
      ),
      { numRuns: 50 }
    )
    expect(
      await verifyHostedBrowserAssertion(request, "x".repeat(16_385))
    ).toBeNull()
  })

  it("consumes unsafe and WebSocket jtis exactly once", async () => {
    for (const request of [
      admittedRequest(`${origin}/api/spaces`, "POST"),
      admittedRequest(`${origin}/ws?spaceId=main`, "GET", true),
    ]) {
      const token = await assertionFor(request)
      expect(await verifyHostedBrowserAssertion(request, token)).not.toBeNull()
      await expect(
        verifyHostedBrowserAssertion(request, token)
      ).rejects.toMatchObject({
        code: "AUTH_REPLAYED",
      } satisfies Partial<HostedCredentialError>)
    }
  })

  it("returns the replay rejection as a 401 at the REST boundary", async () => {
    const app = new Hono()
    app.use("/api/*", trustedLocalIdentity())
    app.post("/api/probe", (c) => c.json({ ok: true }))
    const request = admittedRequest(`${origin}/api/probe`, "POST")
    const token = await assertionFor(request)
    const authenticated = new Request(request, {
      headers: {
        ...Object.fromEntries(request.headers),
        Authorization: `Bearer ${token}`,
      },
    })

    expect((await app.fetch(authenticated.clone())).status).toBe(200)
    const replayed = await app.fetch(authenticated)
    expect(replayed.status).toBe(401)
    expect(await replayed.json()).toEqual({
      error: "Unauthorized",
      code: "AUTH_REPLAYED",
    })
  })

  it("does not consume a safe read assertion's jti", async () => {
    const request = admittedRequest(`${origin}/api/spaces`)
    const token = await assertionFor(request)
    expect(await verifyHostedBrowserAssertion(request, token)).not.toBeNull()
    expect(await verifyHostedBrowserAssertion(request, token)).not.toBeNull()
  })

  it("preserves exact path/query encoding while binding requests", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("a", "Z", "%20", "%2F", "-", "_"), {
          minLength: 1,
          maxLength: 12,
        }),
        async (parts) => {
          const url = `${origin}/api/docs/${parts.join("")}?q=${parts.slice().reverse().join("")}`
          const request = admittedRequest(url)
          expect(
            await verifyHostedBrowserAssertion(
              request,
              await assertionFor(request)
            )
          ).not.toBeNull()
        }
      ),
      { numRuns: 50 }
    )
  })
})
