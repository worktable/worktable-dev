import {
  authorizationServerMetadataCandidates,
  sameAuthorizationServerIssuer,
} from "./worktable-contract"
import type { WorktableAgentAuth } from "./types.js"

interface AgentAuthDiscovery {
  authorizationServer: string
  identityEndpoint: string
  claimEndpoint: string
  tokenEndpoint: string
  resource: string
}

interface IdentityCredential {
  assertion: string
  expiresAt: string
  refreshToken: string
  refreshTokenExpiresAt: string
}

interface TokenResponse {
  access_token?: unknown
  expires_in?: unknown
  token_type?: unknown
}

type FetchLike = typeof fetch
const AGENT_AUTH_PROVIDER_TIMEOUT_MS = 10_000

function providerRequest(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(AGENT_AUTH_PROVIDER_TIMEOUT_MS),
  }
}

async function readJson(
  response: Response,
  label: string
): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => null)) as unknown
  if (!response.ok) {
    const error =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    throw Object.assign(
      new Error(
        typeof error["error_description"] === "string"
          ? error["error_description"]
          : typeof error["error"] === "string"
            ? error["error"]
            : `${label} returned HTTP ${response.status}`
      ),
      {
        code:
          typeof error["error"] === "string"
            ? error["error"]
            : `HTTP_${response.status}`,
        status: response.status,
      }
    )
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${label} returned an invalid response`)
  }
  return body as Record<string, unknown>
}

export async function discoverAgentAuth(
  server: string,
  fetchImpl: FetchLike = fetch
): Promise<AgentAuthDiscovery> {
  const origin = new URL(server).origin
  const resourceMetadata = await readJson(
    await fetchImpl(
      `${origin}/.well-known/oauth-protected-resource`,
      providerRequest()
    ),
    "Protected resource discovery"
  )
  const authorizationServers = resourceMetadata["authorization_servers"]
  const resource = resourceMetadata["resource"]
  if (
    !Array.isArray(authorizationServers) ||
    typeof authorizationServers[0] !== "string" ||
    typeof resource !== "string"
  ) {
    throw new Error(
      "Worktable Cloud did not advertise an authorization server and resource"
    )
  }
  const authorizationServer = authorizationServers[0].replace(/\/+$/, "")
  let metadata: Record<string, unknown> | null = null
  let discoveryFailure = "no metadata candidate succeeded"
  for (const candidate of authorizationServerMetadataCandidates(
    authorizationServer,
    "oauth-authorization-server"
  )) {
    const response = await fetchImpl(candidate, providerRequest())
    if (!response.ok) {
      discoveryFailure = `HTTP ${response.status} at ${candidate.pathname}`
      continue
    }
    const document = await readJson(response, "Authorization server discovery")
    const issuer = document["issuer"]
    if (
      typeof issuer !== "string" ||
      !sameAuthorizationServerIssuer(issuer, authorizationServer)
    ) {
      discoveryFailure = `issuer mismatch at ${candidate.pathname}`
      continue
    }
    metadata = document
    break
  }
  if (!metadata) {
    throw new Error(
      `Authorization server discovery failed: ${discoveryFailure}`
    )
  }
  const agentAuth =
    metadata["agent_auth"] &&
    typeof metadata["agent_auth"] === "object" &&
    !Array.isArray(metadata["agent_auth"])
      ? (metadata["agent_auth"] as Record<string, unknown>)
      : null
  const supported = agentAuth?.["identity_types_supported"]
  if (
    !agentAuth ||
    typeof agentAuth["identity_endpoint"] !== "string" ||
    typeof agentAuth["claim_endpoint"] !== "string" ||
    typeof metadata["token_endpoint"] !== "string" ||
    !Array.isArray(supported) ||
    !supported.includes("service_auth")
  ) {
    throw Object.assign(
      new Error(
        "This Worktable Cloud environment has not enabled service-auth Agent Registration"
      ),
      { code: "AGENT_REGISTRATION_UNAVAILABLE" }
    )
  }
  return {
    authorizationServer,
    identityEndpoint: agentAuth["identity_endpoint"],
    claimEndpoint: agentAuth["claim_endpoint"],
    tokenEndpoint: metadata["token_endpoint"],
    resource,
  }
}

function identityCredential(value: unknown): IdentityCredential {
  const root =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  const identity =
    root?.["identity"] &&
    typeof root["identity"] === "object" &&
    !Array.isArray(root["identity"])
      ? (root["identity"] as Record<string, unknown>)
      : null
  const refresh =
    identity?.["refresh_token"] &&
    typeof identity["refresh_token"] === "object" &&
    !Array.isArray(identity["refresh_token"])
      ? (identity["refresh_token"] as Record<string, unknown>)
      : null
  if (
    typeof identity?.["assertion"] !== "string" ||
    typeof identity["expires_at"] !== "string" ||
    typeof refresh?.["value"] !== "string" ||
    typeof refresh["expires_at"] !== "string"
  ) {
    throw new Error(
      "Agent Registration returned incomplete identity credentials"
    )
  }
  return {
    assertion: identity["assertion"],
    expiresAt: identity["expires_at"],
    refreshToken: refresh["value"],
    refreshTokenExpiresAt: refresh["expires_at"],
  }
}

export async function beginServiceAuthRegistration(
  discovery: AgentAuthDiscovery,
  email: string,
  fetchImpl: FetchLike = fetch
): Promise<{
  registrationId: string
  claimToken: string
  verificationUri: string
}> {
  const result = await readJson(
    await fetchImpl(
      discovery.identityEndpoint,
      providerRequest({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "service_auth", login_hint: email }),
      })
    ),
    "Agent Registration"
  )
  const claim =
    result["claim"] &&
    typeof result["claim"] === "object" &&
    !Array.isArray(result["claim"])
      ? (result["claim"] as Record<string, unknown>)
      : null
  const attempt =
    claim?.["attempt"] &&
    typeof claim["attempt"] === "object" &&
    !Array.isArray(claim["attempt"])
      ? (claim["attempt"] as Record<string, unknown>)
      : null
  if (
    typeof result["id"] !== "string" ||
    typeof claim?.["token"] !== "string" ||
    typeof attempt?.["verification_uri"] !== "string"
  ) {
    throw new Error("Agent Registration returned incomplete claim details")
  }
  return {
    registrationId: result["id"],
    claimToken: claim["token"],
    verificationUri: attempt["verification_uri"],
  }
}

export async function completeServiceAuthRegistration(
  discovery: AgentAuthDiscovery,
  registration: { registrationId: string; claimToken: string },
  userCode: string,
  fetchImpl: FetchLike = fetch
): Promise<WorktableAgentAuth> {
  const completeEndpoint = `${discovery.claimEndpoint.replace(/\/+$/, "")}/complete`
  const result = await readJson(
    await fetchImpl(
      completeEndpoint,
      providerRequest({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claim_token: registration.claimToken,
          user_code: userCode,
        }),
      })
    ),
    "Agent Registration claim"
  )
  const credential = identityCredential(result)
  return {
    registrationId: registration.registrationId,
    authorizationServer: discovery.authorizationServer,
    identityEndpoint: discovery.identityEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    resource: discovery.resource,
    assertion: credential.assertion,
    assertionExpiresAt: credential.expiresAt,
    refreshToken: credential.refreshToken,
    refreshTokenExpiresAt: credential.refreshTokenExpiresAt,
  }
}

function validAgentAuth(value: unknown): value is WorktableAgentAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const auth = value as Record<string, unknown>
  return [
    "registrationId",
    "authorizationServer",
    "identityEndpoint",
    "tokenEndpoint",
    "resource",
    "assertion",
    "assertionExpiresAt",
    "refreshToken",
    "refreshTokenExpiresAt",
  ].every((key) => typeof auth[key] === "string" && auth[key].length > 0)
}

export function parseWorktableAgentAuth(
  value: unknown
): WorktableAgentAuth | undefined {
  return validAgentAuth(value) ? value : undefined
}

const credentialRefreshQueues = new Map<string, Promise<void>>()

async function serializeCredentialRefresh<T>(
  registrationId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = credentialRefreshQueues.get(registrationId)
  let result!: T
  const current = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      result = await operation()
    })
  credentialRefreshQueues.set(registrationId, current)
  try {
    await current
    return result
  } finally {
    if (credentialRefreshQueues.get(registrationId) === current) {
      credentialRefreshQueues.delete(registrationId)
    }
  }
}

export class WorktableAgentCredentialProvider {
  #credential: WorktableAgentAuth
  #accessToken: string | null = null
  #accessTokenExpiresAt = 0
  readonly #load: () => Promise<WorktableAgentAuth | undefined>
  readonly #save: (credential: WorktableAgentAuth) => Promise<void>
  readonly #fetch: FetchLike

  constructor(options: {
    credential: WorktableAgentAuth
    load?(): Promise<WorktableAgentAuth | undefined>
    save(credential: WorktableAgentAuth): Promise<void>
    fetch?: FetchLike
  }) {
    this.#credential = options.credential
    this.#load = options.load ?? (() => Promise.resolve(this.#credential))
    this.#save = options.save
    this.#fetch = options.fetch ?? fetch
  }

  get resource(): string {
    return this.#credential.resource
  }

  invalidate(): void {
    this.#accessToken = null
    this.#accessTokenExpiresAt = 0
  }

  async accessToken(): Promise<string> {
    if (this.#accessToken && this.#accessTokenExpiresAt - Date.now() > 30_000) {
      return this.#accessToken
    }
    if (
      Date.parse(this.#credential.assertionExpiresAt) - Date.now() <=
      30_000
    ) {
      const registrationId = this.#credential.registrationId
      await serializeCredentialRefresh(registrationId, async () => {
        // Every provider reloads while holding the process-wide registration
        // lock. A sibling provider may already have rotated and persisted the
        // only valid refresh token.
        const durable = await this.#load()
        if (durable?.registrationId === registrationId) {
          this.#credential = durable
        }
        if (
          Date.parse(this.#credential.assertionExpiresAt) - Date.now() >
          30_000
        ) {
          return
        }
        const refreshed = await readJson(
          await this.#fetch(
            this.#credential.identityEndpoint,
            providerRequest({
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "refresh",
                refresh_token: this.#credential.refreshToken,
              }),
            })
          ),
          "Agent Registration refresh"
        )
        const identity = identityCredential(refreshed)
        const next = {
          ...this.#credential,
          assertion: identity.assertion,
          assertionExpiresAt: identity.expiresAt,
          refreshToken: identity.refreshToken,
          refreshTokenExpiresAt: identity.refreshTokenExpiresAt,
        }
        // WorkOS refresh tokens rotate. Persist the replacement before using
        // the new assertion so a crash cannot strand the installation.
        await this.#save(next)
        this.#credential = next
      })
    }
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: this.#credential.assertion,
      resource: this.#credential.resource,
    })
    const token = (await readJson(
      await this.#fetch(
        this.#credential.tokenEndpoint,
        providerRequest({
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        })
      ),
      "Agent credential exchange"
    )) as TokenResponse
    if (typeof token.access_token !== "string") {
      throw new Error("Agent credential exchange returned no access token")
    }
    const expiresIn =
      typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
        ? Math.max(30, token.expires_in)
        : 300
    this.#accessToken = token.access_token
    this.#accessTokenExpiresAt = Date.now() + expiresIn * 1000
    return token.access_token
  }
}
