import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { SignJWT, base64url, exportJWK, generateKeyPair } from "jose"
import { setAppDirOverride } from "./app-storage.ts"
import {
  getServerSettings,
  invalidateServerSettingsCache,
} from "./settings-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { versionKeyDir } from "./version-store.ts"
import {
  mcpBearerRequired,
  requireIdentity,
  requireMintAuth,
  trustedLocalIdentity,
  wsAuthRequired,
} from "./auth.ts"
import {
  resetAuthServerJwtState,
  verifyAuthServerJwt,
  warmAuthServerCaches,
} from "./oauth-jwt.ts"
import { createToken } from "./token-store.ts"
import {
  BROWSER_ASSERTION_TYPE,
  ENV,
  HOSTED_BROWSER_SCOPES,
  browserAssertionAudience,
  browserAssertionIssuer,
  browserRequestBinding,
} from "@worktable/hosted-contract"
import { ACTOR_HEADERS, GATEWAY_HEADER } from "./hosted.ts"
import { systemRouter } from "./routes/system.ts"
import { workspaceRouter } from "./routes/workspace.ts"

// AS-issued JWT validation, exercised against a REAL authorization server:
// a local Bun server publishing RFC 8414 metadata and a JWKS, with tokens
// signed by a real RS256 keypair. The suite covers the fail-closed matrix
// (signature, iss, aud, sub, exp, alg, config pins) and the surface wiring
// (requireIdentity accepts a good JWT; bare requests 401 once an AS is
// configured; minted wt_ tokens keep working alongside).

const OWNER_SUB = "user_01TESTOWNER0000000000000000"
const RESOURCE = "https://tenant.example.test/mcp"

let as: ReturnType<typeof Bun.serve>
let asUrl = ""
let signingKey: CryptoKey
let publicJwk: Record<string, unknown>
// A second key the AS does NOT publish — signatures from it must fail.
let rogueKey: CryptoKey

const ENV_KEYS = [
  "WORKTABLE_AUTH_SERVER_URL",
  "WORKTABLE_OWNER_SUBJECT",
  "WORKTABLE_RESOURCE_URL",
  "WORKTABLE_MCP_TOKEN",
  "HOST",
  "WORKTABLE_REQUIRE_AUTH",
  "WORKTABLE_HOSTED",
  "WORKTABLE_GATEWAY_SECRET",
  "WORKTABLE_CLOUD_WORKSPACE_ID",
  "WORKTABLE_BROWSER_ASSERTION_KEYRING",
  "WORKTABLE_PUBLIC_URL",
]
let savedEnv: Record<string, string | undefined>
let tempDir: string
let workspaceDir: string

beforeAll(async () => {
  const pair = await generateKeyPair("RS256")
  signingKey = pair.privateKey as CryptoKey
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test-key",
    alg: "RS256",
  }
  const roguePair = await generateKeyPair("RS256")
  rogueKey = roguePair.privateKey as CryptoKey

  as = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: asUrl,
          jwks_uri: `${asUrl}/oauth2/jwks`,
          scopes_supported: ["openid", "profile", "email", "offline_access"],
        })
      }
      if (path === "/oauth2/jwks") {
        return Response.json({ keys: [publicJwk] })
      }
      return new Response("not found", { status: 404 })
    },
  })
  asUrl = `http://127.0.0.1:${as.port}`
})

afterAll(() => {
  as.stop(true)
})

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env["WORKTABLE_AUTH_SERVER_URL"] = asUrl
  process.env["WORKTABLE_OWNER_SUBJECT"] = OWNER_SUB
  process.env["WORKTABLE_RESOURCE_URL"] = RESOURCE
  tempDir = mkdtempSync(join(tmpdir(), "wt-oauth-app-"))
  workspaceDir = mkdtempSync(join(tmpdir(), "wt-oauth-ws-"))
  setAppDirOverride(tempDir)
  setWorkspaceRootOverride(workspaceDir)
  invalidateServerSettingsCache()
  resetAuthServerJwtState()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  invalidateServerSettingsCache()
  resetAuthServerJwtState()
  rmSync(tempDir, { recursive: true, force: true })
  rmSync(workspaceDir, { recursive: true, force: true })
})

interface SignOptions {
  iss?: string
  aud?: string
  sub?: string
  exp?: string | number
  key?: CryptoKey
  act?: { sub: string }
}

async function signJwt(options: SignOptions = {}): Promise<string> {
  return new SignJWT(options.act ? { act: options.act } : {})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.iss ?? asUrl)
    .setAudience(options.aud ?? RESOURCE)
    .setSubject(options.sub ?? OWNER_SUB)
    .setIssuedAt()
    .setExpirationTime(options.exp ?? "5m")
    .sign(options.key ?? signingKey)
}

const GATEWAY_SECRET = "g".repeat(43)

function cloudApp() {
  const app = new Hono()
  app.use("/api/*", trustedLocalIdentity())
  app.route("/api/system", systemRouter)
  app.route("/api/workspace", workspaceRouter)
  return app
}

function cloudHeaders(
  jwt: string,
  actor: "human" | "agent" = "human"
): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
    [GATEWAY_HEADER]: GATEWAY_SECRET,
    [ACTOR_HEADERS.ID]:
      actor === "human" ? `workos:${OWNER_SUB}` : `oauth:test:${OWNER_SUB}`,
    [ACTOR_HEADERS.TYPE]: actor,
    [ACTOR_HEADERS.NAME]: actor === "human" ? "Test Owner" : "OAuth client",
    ...(actor === "agent"
      ? { [ACTOR_HEADERS.AUTHORIZED_BY]: `workos:${OWNER_SUB}` }
      : {}),
  }
}

describe("verifyAuthServerJwt", () => {
  it("maps a valid AS-issued JWT to the owner identity", async () => {
    const identity = await verifyAuthServerJwt(await signJwt())
    expect(identity).not.toBeNull()
    expect(identity?.user).toBe("owner")
    expect(identity?.credentialClass).toBe("resource")
    // The CONTENT surface, not "*". An AS bearer is held by third-party MCP
    // clients and a browser; "*" would make isLocalOwner() true and let them drive
    // owner-only instance administration (system update, settings).
    expect(identity?.scopes).toEqual([
      "documents:*",
      "docs:*",
      "widgets:*",
      "records:*",
      "annotations:*",
      "threads:*",
      "search:read",
      "workspace:export",
    ])
    expect(identity?.scopes).not.toContain("*")
    expect(identity?.scopes).not.toContain("tokens:manage")
    expect(identity?.agent).toBeNull()
    expect(identity?.workspace).toBe(workspaceDir)
    expect(identity?.principal).toMatchObject({
      id: `workos:${OWNER_SUB}`,
      type: "human",
    })
  })

  it("maps a claimed agent registration to its agent and human delegator", async () => {
    const agentSub = "agent_reg_01CLAUDE"
    const identity = await verifyAuthServerJwt(
      await signJwt({ sub: agentSub, act: { sub: OWNER_SUB } })
    )
    expect(identity?.agent).toBe(agentSub)
    expect(identity?.principal).toEqual({
      id: `workos-agent:${agentSub}`,
      type: "agent",
      displayName: "Connected agent",
      authorizedBy: `workos:${OWNER_SUB}`,
    })
  })

  it("rejects an agent delegated by another workspace owner", async () => {
    expect(
      await verifyAuthServerJwt(
        await signJwt({
          sub: "agent_reg_01OTHER",
          act: { sub: "user_01SOMEONEELSE" },
        })
      )
    ).toBeNull()
  })

  it("rejects a wrong issuer", async () => {
    const jwt = await signJwt({ iss: "https://evil.example.test" })
    expect(await verifyAuthServerJwt(jwt)).toBeNull()
  })

  it("rejects a wrong audience", async () => {
    const jwt = await signJwt({ aud: "https://other-tenant.example.test/mcp" })
    expect(await verifyAuthServerJwt(jwt)).toBeNull()
  })

  it("rejects a wrong subject (another user of the same AS)", async () => {
    const jwt = await signJwt({ sub: "user_01SOMEONEELSE00000000000000" })
    expect(await verifyAuthServerJwt(jwt)).toBeNull()
  })

  it("rejects an expired token", async () => {
    const jwt = await signJwt({ exp: Math.floor(Date.now() / 1000) - 60 })
    expect(await verifyAuthServerJwt(jwt)).toBeNull()
  })

  it("rejects a token that carries no exp claim at all", async () => {
    // jose validates exp only when present — a template omitting it would
    // otherwise mint a never-expiring owner bearer.
    const eternal = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(asUrl)
      .setAudience(RESOURCE)
      .setSubject(OWNER_SUB)
      .setIssuedAt()
      .sign(signingKey)
    expect(await verifyAuthServerJwt(eternal)).toBeNull()
  })

  it("rejects a token signed by a key the AS does not publish", async () => {
    const jwt = await signJwt({ key: rogueKey })
    expect(await verifyAuthServerJwt(jwt)).toBeNull()
  })

  it("rejects an unsigned (alg none) token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
      "base64url"
    )
    const payload = Buffer.from(
      JSON.stringify({
        iss: asUrl,
        aud: RESOURCE,
        sub: OWNER_SUB,
        exp: Math.floor(Date.now() / 1000) + 300,
      })
    ).toString("base64url")
    expect(await verifyAuthServerJwt(`${header}.${payload}.x`)).toBeNull()
  })

  it("rejects garbage and non-JWT-shaped bearers", async () => {
    expect(await verifyAuthServerJwt("wt_abcdef123456_notajwt")).toBeNull()
    expect(await verifyAuthServerJwt("just-a-string")).toBeNull()
    expect(await verifyAuthServerJwt("a.b")).toBeNull()
  })

  it("fails closed when WORKTABLE_OWNER_SUBJECT is unset", async () => {
    delete process.env["WORKTABLE_OWNER_SUBJECT"]
    expect(await verifyAuthServerJwt(await signJwt())).toBeNull()
  })

  it("fails closed when WORKTABLE_RESOURCE_URL is unset", async () => {
    delete process.env["WORKTABLE_RESOURCE_URL"]
    expect(await verifyAuthServerJwt(await signJwt())).toBeNull()
  })

  it("fails closed when no auth server is configured", async () => {
    const jwt = await signJwt()
    delete process.env["WORKTABLE_AUTH_SERVER_URL"]
    expect(await verifyAuthServerJwt(jwt)).toBeNull()
  })

  it("fails closed when the AS metadata endpoint is unreachable", async () => {
    process.env["WORKTABLE_AUTH_SERVER_URL"] = "http://127.0.0.1:9"
    expect(await verifyAuthServerJwt(await signJwt())).toBeNull()
  })

  it("tolerates a trailing slash in the configured AS URL", async () => {
    process.env["WORKTABLE_AUTH_SERVER_URL"] = `${asUrl}/`
    expect(await verifyAuthServerJwt(await signJwt())).not.toBeNull()
  })

  it("honors an issuer whose identifier ends in a slash", async () => {
    // Some providers publish an issuer WITH a trailing slash and put that
    // exact string in `iss`. The expected issuer comes from the AS's own
    // metadata, so the token verifies without the configured value having
    // to match character for character.
    let slashUrl = ""
    const slashAs = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: `${slashUrl}/`,
            jwks_uri: `${slashUrl}/oauth2/jwks`,
          })
        }
        if (path === "/oauth2/jwks") return Response.json({ keys: [publicJwk] })
        return new Response("not found", { status: 404 })
      },
    })
    slashUrl = `http://127.0.0.1:${slashAs.port}`
    try {
      process.env["WORKTABLE_AUTH_SERVER_URL"] = slashUrl
      resetAuthServerJwtState()
      // `iss` carries the trailing slash exactly as published.
      const jwt = await signJwt({ iss: `${slashUrl}/` })
      expect(await verifyAuthServerJwt(jwt)).not.toBeNull()
      // A token claiming the slash-less form must NOT verify.
      const wrong = await signJwt({ iss: slashUrl })
      expect(await verifyAuthServerJwt(wrong)).toBeNull()
    } finally {
      slashAs.stop(true)
    }
  })

  it("discovers a path-scoped issuer (Keycloak-style realm)", async () => {
    // RFC 8414 §3.1 inserts the well-known segment before the issuer path;
    // OIDC discovery appends it. A realm issuer must not collapse to the
    // host-level document (which would be another tenant's, or a 404).
    let realmUrl = ""
    const realm = "/realms/acme"
    let insertedHit = false
    const realmAs = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        // Host-level metadata exists and belongs to a DIFFERENT issuer:
        // fetching it would be the bug.
        if (path === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: realmUrl.replace(realm, ""),
            jwks_uri: `${realmUrl}/wrong-keys`,
          })
        }
        if (path === `/.well-known/oauth-authorization-server${realm}`) {
          insertedHit = true
          return Response.json({
            issuer: realmUrl,
            jwks_uri: `${realmUrl}/oauth2/jwks`,
          })
        }
        if (path === `${realm}/oauth2/jwks`) {
          return Response.json({ keys: [publicJwk] })
        }
        return new Response("not found", { status: 404 })
      },
    })
    realmUrl = `http://127.0.0.1:${realmAs.port}${realm}`
    try {
      process.env["WORKTABLE_AUTH_SERVER_URL"] = realmUrl
      resetAuthServerJwtState()
      const identity = await verifyAuthServerJwt(
        await signJwt({ iss: realmUrl })
      )
      expect(identity).not.toBeNull()
      expect(insertedHit).toBe(true)
    } finally {
      realmAs.stop(true)
    }
  })

  it("falls back to the OIDC-style appended well-known path", async () => {
    let realmUrl = ""
    const realm = "/realms/acme"
    const realmAs = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        // Only the appended form exists (Keycloak's actual layout).
        if (path === `${realm}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: realmUrl,
            jwks_uri: `${realmUrl}/oauth2/jwks`,
          })
        }
        if (path === `${realm}/oauth2/jwks`) {
          return Response.json({ keys: [publicJwk] })
        }
        return new Response("not found", { status: 404 })
      },
    })
    realmUrl = `http://127.0.0.1:${realmAs.port}${realm}`
    try {
      process.env["WORKTABLE_AUTH_SERVER_URL"] = realmUrl
      resetAuthServerJwtState()
      expect(
        await verifyAuthServerJwt(await signJwt({ iss: realmUrl }))
      ).not.toBeNull()
    } finally {
      realmAs.stop(true)
    }
  })

  it("falls back to OIDC discovery when RFC 8414 metadata omits jwks_uri", async () => {
    // Some AS deployments publish jwks_uri only in the OIDC document
    // (where it is REQUIRED). Verification must still work, without
    // guessing any vendor's key path.
    let partialUrl = ""
    const partialAs = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/.well-known/oauth-authorization-server") {
          return Response.json({ issuer: partialUrl }) // no jwks_uri
        }
        if (path === "/.well-known/openid-configuration") {
          return Response.json({
            issuer: partialUrl,
            jwks_uri: `${partialUrl}/oauth2/jwks`,
          })
        }
        if (path === "/oauth2/jwks") return Response.json({ keys: [publicJwk] })
        return new Response("not found", { status: 404 })
      },
    })
    partialUrl = `http://127.0.0.1:${partialAs.port}`
    try {
      process.env["WORKTABLE_AUTH_SERVER_URL"] = partialUrl
      resetAuthServerJwtState()
      expect(
        await verifyAuthServerJwt(await signJwt({ iss: partialUrl }))
      ).not.toBeNull()
    } finally {
      partialAs.stop(true)
    }
  })

  it("fails closed when neither discovery document publishes jwks_uri", async () => {
    let barrenUrl = ""
    const barrenAs = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/.well-known/oauth-authorization-server") {
          return Response.json({ issuer: barrenUrl })
        }
        return new Response("not found", { status: 404 })
      },
    })
    barrenUrl = `http://127.0.0.1:${barrenAs.port}`
    try {
      process.env["WORKTABLE_AUTH_SERVER_URL"] = barrenUrl
      resetAuthServerJwtState()
      expect(
        await verifyAuthServerJwt(await signJwt({ iss: barrenUrl }))
      ).toBeNull()
    } finally {
      barrenAs.stop(true)
    }
  })

  it("engages the WS auth gate when an authorization server is configured", async () => {
    // Loopback bind, no exposure flags: only the AS env is set. MCP is
    // bearer-only in this config, and /ws + /yjs carry the same document
    // traffic — the WS gate must engage from the same signal.
    expect(wsAuthRequired()).toBe(true)
    delete process.env["WORKTABLE_AUTH_SERVER_URL"]
    expect(wsAuthRequired()).toBe(false)
  })

  it("skips a wrong-issuer document in the OIDC jwks_uri fallback", async () => {
    // Path-scoped issuer whose RFC 8414 metadata omits jwks_uri. The
    // INSERTED OIDC URL answers with a host-level document for a DIFFERENT
    // issuer carrying a hostile jwks_uri; the correct realm document lives
    // at the OIDC APPENDED path. The fallback must reject the mismatched
    // document (RFC 8414 §3.3) and use the realm's keys — otherwise
    // another tenant's keys on a shared host could verify forged tokens.
    let realmUrl = ""
    const realm = "/realms/acme"
    const roguePair = await generateKeyPair("RS256")
    const rogueJwk = {
      ...(await exportJWK(roguePair.publicKey)),
      kid: "test-key",
      alg: "RS256",
    }
    const sharedHost = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === `/.well-known/oauth-authorization-server${realm}`) {
          return Response.json({ issuer: realmUrl }) // no jwks_uri
        }
        if (path === `/.well-known/openid-configuration${realm}`) {
          // Wrong issuer, hostile keys — must be skipped.
          return Response.json({
            issuer: realmUrl.replace(realm, ""),
            jwks_uri: `${realmUrl.replace(realm, "")}/rogue/jwks`,
          })
        }
        if (path === "/rogue/jwks") return Response.json({ keys: [rogueJwk] })
        if (path === `${realm}/.well-known/openid-configuration`) {
          return Response.json({
            issuer: realmUrl,
            jwks_uri: `${realmUrl}/oauth2/jwks`,
          })
        }
        if (path === `${realm}/oauth2/jwks`) {
          return Response.json({ keys: [publicJwk] })
        }
        return new Response("not found", { status: 404 })
      },
    })
    realmUrl = `http://127.0.0.1:${sharedHost.port}${realm}`
    try {
      process.env["WORKTABLE_AUTH_SERVER_URL"] = realmUrl
      resetAuthServerJwtState()
      // Signed with the REAL realm key: must verify via the appended doc.
      expect(
        await verifyAuthServerJwt(await signJwt({ iss: realmUrl }))
      ).not.toBeNull()
      // Signed with the rogue host key claiming the realm issuer: rejected.
      const forged = await signJwt({
        iss: realmUrl,
        key: roguePair.privateKey as CryptoKey,
      })
      expect(await verifyAuthServerJwt(forged)).toBeNull()
    } finally {
      sharedHost.stop(true)
    }
  })

  it("rejects metadata whose issuer does not match the configured AS", async () => {
    // RFC 8414 §3.3 mix-up guard: a hostile/misconfigured metadata
    // document must not be able to name a different issuer.
    let liarUrl = ""
    const liar = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: "https://evil.example.test",
            jwks_uri: `${liarUrl}/oauth2/jwks`,
          })
        }
        if (path === "/oauth2/jwks") return Response.json({ keys: [publicJwk] })
        return new Response("not found", { status: 404 })
      },
    })
    liarUrl = `http://127.0.0.1:${liar.port}`
    try {
      process.env["WORKTABLE_AUTH_SERVER_URL"] = liarUrl
      resetAuthServerJwtState()
      const jwt = await signJwt({ iss: "https://evil.example.test" })
      expect(await verifyAuthServerJwt(jwt)).toBeNull()
    } finally {
      liar.stop(true)
    }
  })

  it("verifies from warmed caches while the AS is unreachable", async () => {
    // Boot-time warmup makes verification survive a transient AS outage
    // (or egress stall) for already-fetched keys: after warmup, a valid
    // token must verify even though the AS answers nothing. Simulated by
    // pointing a second local AS at a port that is then closed.
    let outageUrl = ""
    const outage = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: outageUrl,
            jwks_uri: `${outageUrl}/oauth2/jwks`,
          })
        }
        if (path === "/oauth2/jwks") {
          return Response.json({ keys: [publicJwk] })
        }
        return new Response("not found", { status: 404 })
      },
    })
    outageUrl = `http://127.0.0.1:${outage.port}`
    process.env["WORKTABLE_AUTH_SERVER_URL"] = outageUrl
    resetAuthServerJwtState()
    await warmAuthServerCaches()
    outage.stop(true)

    const jwt = await signJwt({ iss: outageUrl })
    expect(await verifyAuthServerJwt(jwt)).not.toBeNull()
  })

  it("warmup is a no-op without an authorization server configured", async () => {
    delete process.env["WORKTABLE_AUTH_SERVER_URL"]
    await warmAuthServerCaches()
  })
})

describe("MCP surface with an authorization server configured", () => {
  function mcpApp(): Hono {
    const app = new Hono()
    app.use("/mcp", requireIdentity())
    app.get("/mcp", (c) => c.json({ user: c.get("identity").user }))
    return app
  }

  it("accepts a valid AS-issued JWT as Bearer", async () => {
    const res = await mcpApp().fetch(
      new Request("http://localhost/mcp", {
        headers: { Authorization: `Bearer ${await signJwt()}` },
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: "owner" })
  })

  it("401s an invalid JWT with the RFC 9728 discovery hint", async () => {
    const res = await mcpApp().fetch(
      new Request("http://localhost/mcp", {
        headers: {
          Authorization: `Bearer ${await signJwt({ sub: "user_nope" })}`,
        },
      })
    )
    expect(res.status).toBe(401)
    // The hint must advertise the CONFIGURED resource origin, not the
    // request origin — behind the hosted proxy the request origin is the
    // internal bind, which OAuth clients cannot fetch.
    expect(res.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="https://tenant.example.test/.well-known/oauth-protected-resource"`
    )
  })

  it("401s bare requests once an AS is configured (no owner fallback)", async () => {
    expect(await mcpBearerRequired()).toBe(true)
    const res = await mcpApp().fetch(new Request("http://localhost/mcp"))
    expect(res.status).toBe(401)
  })

  it("mirrors the AS's scope vocabulary in the protected-resource metadata", async () => {
    const { wellKnownRouter } = await import("./routes/well-known.ts")
    const app = new Hono().route("/.well-known", wellKnownRouter)
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await app.fetch(new Request(`http://localhost${path}`))
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body["resource"]).toBe(RESOURCE)
      expect(body["authorization_servers"]).toEqual([asUrl])
      // The AS's scopes, NOT Worktable's internal token scopes — clients
      // echo this field into authorize requests and the AS rejects scopes
      // it doesn't know (invalid_scope, found live with Claude vs AuthKit).
      expect(body["scopes_supported"]).toEqual([
        "openid",
        "profile",
        "email",
        "offline_access",
      ])
    }
  })

  it("passes the AS's RFC 8414 metadata through on the resource origin", async () => {
    const { wellKnownRouter } = await import("./routes/well-known.ts")
    const app = new Hono().route("/.well-known", wellKnownRouter)
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
    ]) {
      const res = await app.fetch(new Request(`http://localhost${path}`))
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body["issuer"]).toBe(asUrl)
      expect(body["jwks_uri"]).toBe(`${asUrl}/oauth2/jwks`)
    }
    // The test AS serves no OIDC discovery document — passthrough must
    // fail closed to JSON 404, not surface an error or the SPA shell.
    const oidc = await app.fetch(
      new Request("http://localhost/.well-known/openid-configuration")
    )
    expect(oidc.status).toBe(404)
  })

  it("lets an AS bearer drive REST, but NEVER mint a permanent credential", async () => {
    // The hosted web app talks to /api/*, and its user authenticates with an
    // AS bearer — REST that rejected them would leave the cloud product with
    // no working UI. So the REST bridge accepts AS bearers.
    //
    // The escalation this must still prevent is narrower and is what actually
    // matters: an OAuth bearer minting a PERMANENT wt_ credential, which would
    // outlive the AS's revocation. The mint gate verifies independently with
    // local credentials only, so it stays closed.
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1" // exposed posture
    const jwt = await signJwt()

    const rest = new Hono()
    rest.use("/api/probe", trustedLocalIdentity())
    rest.get("/api/probe", (c) => c.json({ user: c.get("identity").user }))
    const restRes = await rest.fetch(
      new Request("http://localhost/api/probe", {
        headers: { Authorization: `Bearer ${jwt}` },
      })
    )
    expect(restRes.status).toBe(200)
    expect(await restRes.json()).toEqual({ user: "owner" })

    // The mint gate: still local-only. This is the escalation boundary.
    const mint = new Hono()
    mint.use("/api/tokens", requireMintAuth())
    mint.post("/api/tokens", (c) => c.json({ minted: true }))
    const mintRes = await mint.fetch(
      new Request("http://localhost/api/tokens", {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      })
    )
    expect(mintRes.status).toBe(401)

    // And the MCP surface still accepts it.
    const mcp = new Hono()
    mcp.use("/mcp", requireIdentity())
    mcp.get("/mcp", (c) => c.json({ user: c.get("identity").user }))
    const mcpRes = await mcp.fetch(
      new Request("http://localhost/mcp", {
        headers: { Authorization: `Bearer ${jwt}` },
      })
    )
    expect(mcpRes.status).toBe(200)
  })

  it("an AS bearer is NOT an owner: it cannot pass an owner-only gate", async () => {
    // routes/system.ts gates local update/settings mutations on isLocalOwner(), which
    // tests for the "*" scope. An MCP client holding the user's OAuth token
    // must not be able to drive fleet-level instance administration.
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const jwt = await signJwt()

    const app = new Hono()
    app.use("/api/system/settings", trustedLocalIdentity())
    app.put("/api/system/settings", (c) => {
      const identity = c.get("identity")
      // Mirror isLocalOwner(): owner-only routes require the "*" scope.
      if (!identity.scopes.includes("*")) {
        return c.json({ error: "Forbidden" }, 403)
      }
      return c.json({ changed: true })
    })

    const res = await app.fetch(
      new Request("http://localhost/api/system/settings", {
        method: "PUT",
        headers: { Authorization: `Bearer ${jwt}` },
      })
    )
    expect(res.status).toBe(403)
  })

  it("does not accept AS bearers on REST when NO auth server is configured", async () => {
    // Local installs are byte-for-byte unchanged: with no AS configured the
    // AS path returns null, so a JWT-shaped bearer is simply an invalid token.
    const jwt = await signJwt()
    delete process.env["WORKTABLE_AUTH_SERVER_URL"]
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"

    const rest = new Hono()
    rest.use("/api/probe", trustedLocalIdentity())
    rest.get("/api/probe", (c) => c.json({ ok: true }))
    const res = await rest.fetch(
      new Request("http://localhost/api/probe", {
        headers: { Authorization: `Bearer ${jwt}` },
      })
    )
    expect(res.status).toBe(401)
  })

  it("keeps accepting locally minted wt_ tokens alongside AS JWTs", async () => {
    const minted = await createToken({
      user: "owner",
      scopes: ["*"],
      agent: "test-agent",
    })
    const res = await mcpApp().fetch(
      new Request("http://localhost/mcp", {
        headers: { Authorization: `Bearer ${minted.token}` },
      })
    )
    expect(res.status).toBe(200)
  })
})

describe("Worktable Cloud human settings authority", () => {
  beforeEach(() => {
    process.env["WORKTABLE_HOSTED"] = "1"
    process.env["WORKTABLE_GATEWAY_SECRET"] = GATEWAY_SECRET
  })

  it("accepts a request-bound browser assertion through the real REST middleware", async () => {
    const workspaceId = "workspace_cloud_assertion"
    const secret = base64url.encode(new Uint8Array(32).fill(4))
    process.env[ENV.CLOUD_WORKSPACE_ID] = workspaceId
    process.env[ENV.BROWSER_ASSERTION_KEYRING] = JSON.stringify([
      { kid: "v1", secret, state: "signing" },
    ])
    ensureWorkspaceManifest()
    const url = "http://tenant.test/api/workspace"
    const requestUrl = new URL(url)
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(browserRequestBinding("GET", requestUrl))
    )
    const now = Math.floor(Date.now() / 1000)
    const assertion = await new SignJWT({
      wt: {
        credential: "browser",
        workspaceId,
        requestHash: base64url.encode(new Uint8Array(hash)),
        scopes: [...HOSTED_BROWSER_SCOPES],
        principal: {
          id: `workos:${OWNER_SUB}`,
          type: "human",
          displayName: "Test Owner",
        },
      },
    })
      .setProtectedHeader({
        alg: "HS256",
        typ: BROWSER_ASSERTION_TYPE,
        kid: "v1",
      })
      .setIssuer(browserAssertionIssuer(new URL(RESOURCE).origin))
      .setAudience(browserAssertionAudience(workspaceId))
      .setSubject(OWNER_SUB)
      .setIssuedAt(now)
      .setNotBefore(now - 5)
      .setExpirationTime(now + 60)
      .setJti(crypto.randomUUID())
      .sign(base64url.decode(secret))

    const response = await cloudApp().fetch(
      new Request(url, {
        headers: {
          ...cloudHeaders(assertion),
          Authorization: `Bearer ${assertion}`,
        },
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ root: null })
  })

  it("lets the admitted browser owner rename while keeping the root private", async () => {
    const jwt = await signJwt()
    ensureWorkspaceManifest()
    const rename = await cloudApp().fetch(
      new Request("http://tenant.test/api/workspace", {
        method: "PUT",
        headers: cloudHeaders(jwt),
        body: JSON.stringify({ name: "Cloud Workspace" }),
      })
    )
    expect(rename.status).toBe(200)
    expect(await rename.json()).toMatchObject({
      name: "Cloud Workspace",
      root: null,
    })

    const read = await cloudApp().fetch(
      new Request("http://tenant.test/api/workspace", {
        headers: cloudHeaders(jwt),
      })
    )
    expect(await read.json()).toMatchObject({
      name: "Cloud Workspace",
      root: null,
    })
  })

  it("lets the admitted browser owner persist editor and history settings", async () => {
    const jwt = await signJwt()
    const versions = versionKeyDir("cloud-space", "docs", "note")
    mkdirSync(versions, { recursive: true })
    for (const id of ["old", "middle", "new"]) {
      writeFileSync(join(versions, `${id}.json`), JSON.stringify({ id }))
    }
    const res = await cloudApp().fetch(
      new Request("http://tenant.test/api/system/settings", {
        method: "PUT",
        headers: cloudHeaders(jwt),
        body: JSON.stringify({
          editor: { spellcheck: true },
          history: { retention: { mode: "count", maxPerDoc: 1 } },
        }),
      })
    )
    expect(res.status).toBe(200)
    expect(getServerSettings()).toMatchObject({
      editor: { spellcheck: true },
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    })
    expect(
      readdirSync(versions).filter((name) => name.endsWith(".json"))
    ).toHaveLength(1)
  })

  it("rejects agent resource tokens before browser REST authorization", async () => {
    const jwt = await signJwt()
    ensureWorkspaceManifest()
    const rename = await cloudApp().fetch(
      new Request("http://tenant.test/api/workspace", {
        method: "PUT",
        headers: cloudHeaders(jwt, "agent"),
        body: JSON.stringify({ name: "Agent Rename" }),
      })
    )
    const settings = await cloudApp().fetch(
      new Request("http://tenant.test/api/system/settings", {
        method: "PUT",
        headers: cloudHeaders(jwt, "agent"),
        body: JSON.stringify({
          editor: { spellcheck: true },
          history: { retention: { mode: "count", maxPerDoc: 1 } },
        }),
      })
    )
    expect(rename.status).toBe(401)
    expect(settings.status).toBe(401)
    expect(ensureWorkspaceManifest().name).not.toBe("Agent Rename")
    expect(getServerSettings().editor.spellcheck).toBe(false)
    expect(getServerSettings().history.retention).toEqual({ mode: "all" })
  })

  it("atomically rejects hosted update and network preferences", async () => {
    const jwt = await signJwt()
    const mixed = await cloudApp().fetch(
      new Request("http://tenant.test/api/system/settings", {
        method: "PUT",
        headers: cloudHeaders(jwt),
        body: JSON.stringify({
          editor: { spellcheck: true },
          updates: { autoCheck: false },
        }),
      })
    )
    expect(mixed.status).toBe(403)
    expect(await mixed.json()).toMatchObject({ code: "HOSTED_DISABLED" })
    expect(getServerSettings().editor.spellcheck).toBe(false)

    const updates = await cloudApp().fetch(
      new Request("http://tenant.test/api/system/settings", {
        method: "PUT",
        headers: cloudHeaders(jwt),
        body: JSON.stringify({ updates: { autoCheck: false } }),
      })
    )
    expect(updates.status).toBe(403)
    expect(await updates.json()).toMatchObject({ code: "HOSTED_DISABLED" })

    const network = await cloudApp().fetch(
      new Request("http://tenant.test/api/system/settings", {
        method: "PUT",
        headers: cloudHeaders(jwt),
        body: JSON.stringify({ network: { publicUrl: "https://other.test" } }),
      })
    )
    expect(network.status).toBe(403)
    expect(await network.json()).toMatchObject({ code: "HOSTED_DISABLED" })
    expect(getServerSettings().network.publicUrl).toBeNull()
  })
})
