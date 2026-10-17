import { describe, expect, it } from "bun:test"
import fc from "fast-check"
import {
  readTeamDirectorySnapshot,
  ACTOR_HEADERS,
  AssertionKeyring,
  authorizationServerMetadataCandidates,
  browserAssertionAudience,
  browserAssertionIssuer,
  browserRequestBinding,
  buildTenantEnv,
  ENV,
  GATEWAY_HEADER,
  PublicShareProjection,
  SHARE_CAPABILITY_HEADER,
  HOSTED_OAUTH_PERMISSION_GROUPS,
  HOSTED_OAUTH_SCOPES,
  MCP_RESOURCE_PATH,
  hostedOAuthPrincipalId,
  sameAuthorizationServerIssuer,
  tenantResourceUrl,
  TenantProvisionInput,
  BillingAccess,
  CLOUD_PLAN_IDS,
  CLOUD_PLANS,
  decodeTenantBilling,
  encodeTenantBilling,
  nextCloudPlan,
  PublicPlanDetails,
} from "./index.ts"

const base = {
  cloudWorkspaceId: "ws_01CLOUD",
  spriteBaseUrl: "https://wt-tenant-abc.sprites.app",
  publicBaseUrl: "https://app.worktable.cloud",
  authServerUrl: "https://acme.authkit.app",
  ownerSubject: "user_01OWNER",
  version: "0.0.25",
  gatewaySecret: "g".repeat(43),
  browserAssertionKeyring: [
    { kid: "v1", secret: "a".repeat(43), state: "signing" as const },
  ],
}

describe("tenantResourceUrl", () => {
  it("appends the /api/mcp path (never /mcp — the sprite proxy reserves it)", () => {
    expect(tenantResourceUrl("https://app.worktable.cloud")).toBe(
      "https://app.worktable.cloud/api/mcp"
    )
    expect(MCP_RESOURCE_PATH).toBe("/api/mcp")
  })

  it("tolerates a trailing slash", () => {
    expect(tenantResourceUrl("https://app.worktable.cloud/")).toBe(
      "https://app.worktable.cloud/api/mcp"
    )
  })
})

describe("authorization server discovery contract", () => {
  it("orders RFC 8414 and OIDC candidates correctly for path-scoped issuers", () => {
    const issuer = "https://idp.example/realms/acme/"
    expect(
      authorizationServerMetadataCandidates(
        issuer,
        "oauth-authorization-server"
      ).map(String)
    ).toEqual([
      "https://idp.example/.well-known/oauth-authorization-server/realms/acme",
      "https://idp.example/realms/acme/.well-known/oauth-authorization-server",
    ])
    expect(
      authorizationServerMetadataCandidates(issuer, "openid-configuration").map(
        String
      )
    ).toEqual([
      "https://idp.example/realms/acme/.well-known/openid-configuration",
      "https://idp.example/.well-known/openid-configuration/realms/acme",
    ])
    expect(
      sameAuthorizationServerIssuer(
        "https://idp.example/realms/acme/",
        "https://idp.example/realms/acme"
      )
    ).toBe(true)
  })
})

describe("hosted OAuth connection contract", () => {
  it("shares one stable principal and enforced Worktable ceiling", () => {
    expect(hostedOAuthPrincipalId("client_1", "user_1")).toBe(
      "oauth:client_1:user_1"
    )
    expect(HOSTED_OAUTH_PERMISSION_GROUPS).toEqual([
      "workspace-read",
      "workspace-write",
      "conversations",
      "export",
    ])
    expect(HOSTED_OAUTH_SCOPES).toContain("docs:write")
    expect(HOSTED_OAUTH_SCOPES).toContain("threads:participate")
    expect(HOSTED_OAUTH_SCOPES).toContain("workspace:export")
  })
})

describe("buildTenantEnv", () => {
  it("produces the full tenant env with the resource URL bound to the sprite", () => {
    const env = buildTenantEnv(base)
    expect(env[ENV.HOSTED]).toBe("1")
    expect(env[ENV.AUTH_SERVER_URL]).toBe("https://acme.authkit.app")
    expect(env[ENV.OWNER_SUBJECT]).toBe("user_01OWNER")
    expect(env[ENV.CLOUD_WORKSPACE_ID]).toBe("ws_01CLOUD")
    expect(JSON.parse(env[ENV.BROWSER_ASSERTION_KEYRING]!)).toEqual(
      base.browserAssertionKeyring
    )
    // The GATEWAY origin, never the sprite: it is the URL clients call, so it
    // is what the token audience names and what the 401 challenge points at.
    expect(env[ENV.RESOURCE_URL]).toBe(`https://app.worktable.cloud/api/mcp/w/${base.cloudWorkspaceId}`)
    // Existing directory connectors keep the shared audience. The gateway
    // forwards it only to the account's default or single Worktable.
    expect(env[ENV.LEGACY_RESOURCE_URL]).toBe("https://app.worktable.cloud/api/mcp")
    expect(env[ENV.VERSION]).toBe("0.0.25")
    expect(env[ENV.PORT]).toBe("8080")
    expect(env[ENV.WORKSPACE]).toBe("/data/workspace")
  })

  it("sets NO static owner token (M1 uses AS bearers, not WORKTABLE_MCP_TOKEN)", () => {
    const env = buildTenantEnv(base)
    expect(env["WORKTABLE_MCP_TOKEN"]).toBeUndefined()
    expect(Object.values(env)).not.toContain("")
  })

  it("rejects a non-URL sprite base or auth server", () => {
    expect(() =>
      buildTenantEnv({ ...base, spriteBaseUrl: "not-a-url" })
    ).toThrow()
    expect(() =>
      buildTenantEnv({ ...base, authServerUrl: "ftp://x" })
    ).toThrow()
  })

  it("rejects an empty owner subject (the tenant-isolation pin)", () => {
    expect(() => buildTenantEnv({ ...base, ownerSubject: "" })).toThrow()
  })

  it("carries the per-tenant gateway secret", () => {
    const env = buildTenantEnv(base)
    expect(env[ENV.GATEWAY_SECRET]).toBe("g".repeat(43))
    expect(GATEWAY_HEADER).toBe("x-worktable-gateway")
    expect(SHARE_CAPABILITY_HEADER).toBe("x-worktable-share-capability")
    expect(ACTOR_HEADERS).toEqual({
      ID: "x-worktable-actor-id",
      TYPE: "x-worktable-actor-type",
      NAME: "x-worktable-actor-name",
      AUTHORIZED_BY: "x-worktable-actor-authorized-by",
      SCOPES: "x-worktable-actor-scopes",
    })
  })

  it("rejects a weak/short gateway secret", () => {
    // Admission control is only as good as the secret; a short one would be
    // guessable and the whole guard pointless.
    expect(() => buildTenantEnv({ ...base, gatewaySecret: "short" })).toThrow()
  })

  it("keeps sharing disabled unless both isolated origins are supplied", () => {
    const disabled = buildTenantEnv(base)
    expect(disabled[ENV.SHARE_BASE_URL]).toBeUndefined()
    expect(disabled[ENV.HTML_SHARE_BASE_URL]).toBeUndefined()

    const enabled = buildTenantEnv({
      ...base,
      shareBaseUrl: "https://share.worktable.cloud/",
      htmlShareBaseUrl: "https://html.worktable-usercontent.com",
    })
    expect(enabled[ENV.SHARE_BASE_URL]).toBe("https://share.worktable.cloud")
    expect(enabled[ENV.HTML_SHARE_BASE_URL]).toBe(
      "https://html.worktable-usercontent.com"
    )
    expect(() =>
      buildTenantEnv({
        ...base,
        shareBaseUrl: "https://share.worktable.cloud",
      })
    ).toThrow()
    expect(() =>
      buildTenantEnv({
        ...base,
        shareBaseUrl: "https://share.worktable.cloud",
        htmlShareBaseUrl: "https://share.worktable.cloud/html",
      })
    ).toThrow()
  })
})

describe("public share projection contract", () => {
  it("keeps source links optional and rejects executable or credential-bearing URLs", () => {
    fc.assert(
      fc.property(
        fc.webUrl({ validSchemes: ["https"] }),
        fc.constantFrom("doc", "html"),
        (sourceUrl, kind) => {
          const projection =
            kind === "doc"
              ? {
                  kind,
                  format: "markdown",
                  title: "Shared",
                  projectionHtml: "<p>Shared</p>",
                }
              : { kind, title: "Shared" }
          expect(
            PublicShareProjection.parse({ ...projection, sourceUrl }).sourceUrl
          ).toBe(sourceUrl)
          expect(
            PublicShareProjection.parse(projection).sourceUrl
          ).toBeUndefined()
          for (const invalid of [
            "javascript:alert(1)",
            "data:text/html,hello",
            "//example.com/source",
            "not a URL",
            sourceUrl.replace("https:", "http:"),
            sourceUrl.replace("https://", "https://user:secret@"),
          ]) {
            expect(
              PublicShareProjection.safeParse({
                ...projection,
                sourceUrl: invalid,
              }).success
            ).toBe(false)
          }
        }
      )
    )
  })

  it("accepts only the inert tenant payloads the gateway can render", () => {
    expect(
      PublicShareProjection.safeParse({
        kind: "doc",
        format: "markdown",
        title: "Launch plan",
        projectionHtml: "<h1>Launch plan</h1>",
      }).success
    ).toBe(true)
    expect(
      PublicShareProjection.safeParse({
        kind: "html",
        title: "Status board",
      }).success
    ).toBe(true)
    expect(
      PublicShareProjection.safeParse({
        kind: "html",
        title: "Status board",
        contentUrl: "https://attacker.test",
      }).success
    ).toBe(false)
    expect(
      PublicShareProjection.safeParse({
        kind: "doc",
        format: "html",
        title: "Invalid",
        projectionHtml: "<p>Invalid</p>",
      }).success
    ).toBe(false)
  })
})

describe("browser assertion contract", () => {
  it("derives stable issuer, audience, and exact request binding", () => {
    expect(browserAssertionIssuer("https://app.worktable.cloud/")).toBe(
      "https://app.worktable.cloud/_worktable/browser-assertions"
    )
    expect(browserAssertionAudience("ws_123")).toBe(
      "urn:worktable:cloud:workspace:ws_123"
    )
    expect(
      browserRequestBinding(
        "get",
        new URL("https://tenant.invalid/api/docs/a%20b?z=%2F&x=1")
      )
    ).toBe("GET\n/api/docs/a%20b?z=%2F&x=1")
  })

  it("requires one signing key and at most one previous key", () => {
    const signing = {
      kid: "v2",
      secret: "s".repeat(43),
      state: "signing" as const,
    }
    const previous = {
      kid: "v1",
      secret: "p".repeat(43),
      state: "verify-only" as const,
    }
    expect(AssertionKeyring.safeParse([signing, previous]).success).toBe(true)
    expect(AssertionKeyring.safeParse([previous]).success).toBe(false)
    expect(
      AssertionKeyring.safeParse([signing, { ...signing, kid: "v3" }]).success
    ).toBe(false)
    expect(
      AssertionKeyring.safeParse([
        signing,
        { ...previous, secret: signing.secret },
      ]).success
    ).toBe(false)
  })
})

describe("TenantProvisionInput", () => {
  it("is the parse gate buildTenantEnv relies on", () => {
    expect(TenantProvisionInput.safeParse(base).success).toBe(true)
    expect(TenantProvisionInput.safeParse({}).success).toBe(false)
  })

  it("never permits an assertion key to reuse the admission secret", () => {
    expect(
      TenantProvisionInput.safeParse({
        ...base,
        browserAssertionKeyring: [
          {
            kid: "v1",
            secret: base.gatewaySecret,
            state: "signing",
          },
        ],
      }).success
    ).toBe(false)
  })
})


it("reads fragmented UTF-8 directories and cancels oversized tenant responses before consuming them", async () => {
  const snapshot = { workspaceId: "team", name: "Équipe", portableWorkspaceId: "portable", epoch: "a".repeat(64), revision: 1, capturedAt: 1, members: [] }
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
  const split = bytes.indexOf(0xc3) + 1
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.slice(0, split))
    controller.enqueue(bytes.slice(split))
    controller.close()
  } })
  expect(await readTeamDirectorySnapshot(new Response(body))).toEqual(snapshot)
  let cancelled = false
  let remaining = 50
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(new Uint8Array(1024 * 1024))
      else controller.close()
    },
    cancel() { cancelled = true },
  })
  await expect(readTeamDirectorySnapshot(new Response(oversized))).rejects.toThrow("Team directory too large")
  expect(cancelled).toBe(true)
  expect(remaining).toBeGreaterThan(0)
})

describe("tenant billing header", () => {
  it("round-trips any valid billing, including names outside ASCII", () => {
    fc.assert(
      fc.property(
        fc.record({
          plan: fc.constantFrom(...CLOUD_PLAN_IDS),
          peopleLimit: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: null }),
          access: fc.constantFrom(...BillingAccess.options),
          payer: fc.record({
            subject: fc.string({ minLength: 1, maxLength: 40 }),
            name: fc.string({ maxLength: 40 }),
          }),
        }),
        (billing) => {
          expect(decodeTenantBilling(encodeTenantBilling(billing))).toEqual(
            billing
          )
        }
      )
    )
  })

  it("reads anything else as no billing", () => {
    for (const value of [null, "", "not base64!", btoa("{}"), "x".repeat(5000)])
      expect(decodeTenantBilling(value)).toBeNull()
  })
})

describe("cloud plans", () => {
  it("grow from Solo to Team to Team 30, each holding more people", () => {
    expect(nextCloudPlan("solo")).toBe("team")
    expect(nextCloudPlan("team")).toBe("team30")
    expect(nextCloudPlan("team30")).toBeNull()
    for (const id of CLOUD_PLAN_IDS) {
      const plan = CLOUD_PLANS[id]
      expect(PublicPlanDetails.parse(plan)).toEqual(plan)
      const next = nextCloudPlan(id)
      if (next) expect(CLOUD_PLANS[next].peopleLimit).toBeGreaterThan(plan.peopleLimit)
    }
  })
})
