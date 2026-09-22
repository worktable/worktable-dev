import { createHash, randomUUID } from "node:crypto"
import { jwtVerify } from "jose"
import { Hono } from "hono"
import {
  HOSTED_OAUTH_SCOPES,
  LINKED_ASSERTION_HEADER,
  LINKED_ASSERTION_ISSUER,
  LINKED_ASSERTION_TTL_SECONDS,
  LINKED_ASSERTION_TYPE,
  LINKED_REQUEST_MAX_BYTES,
  LinkedDestinationBinding,
  LinkedRequestClaims,
  SHARE_CAPABILITY_HEADER,
} from "@worktable/hosted-contract"
import { getWorkspaceRoot } from "./workspace.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { admitWorkspaceRequest } from "./workspace-request-lifecycle.ts"
import { handleRemoteMcpRequest } from "./routes/mcp.ts"
import { createPublicSharesRouter } from "./routes/public-shares.ts"

async function readBody(
  request: Request,
  expiresAt: number
): Promise<Uint8Array> {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  let expired = false
  const deadline = setTimeout(
    () => {
      expired = true
      void reader.cancel().catch(() => undefined)
    },
    Math.max(0, expiresAt - Date.now())
  )
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (expired) throw new Error("Expired request")
      if (done) break
      size += value.byteLength
      if (size > LINKED_REQUEST_MAX_BYTES) throw new Error("Request too large")
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    clearTimeout(deadline)
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * Dedicated connector listener, never mounted on the implicit-owner local app.
 * Enrollment/supervision owns its lifetime. Creating it does not open a port.
 */
export async function createLinkedIngress(options: {
  binding: Omit<LinkedDestinationBinding, "bootNonce" | "workspaceEpoch">
  key: Uint8Array
  scopes: readonly string[]
  publicOrigin: string
  shareOrigin?: string
  bootNonce?: string
}) {
  if (options.key.byteLength < 32) throw new Error("Invalid installation key")
  for (const value of [options.publicOrigin, options.shareOrigin]) {
    if (value === undefined) continue
    const url = new URL(value)
    if (url.protocol !== "https:" || url.origin !== value) {
      throw new Error("Expected a Cloud HTTPS origin")
    }
  }
  const key = new Uint8Array(options.key)
  const { publicOrigin } = options
  let shareOrigin = options.shareOrigin ?? null
  const scopes = new Set(options.scopes)
  const workspace = getWorkspaceRoot()
  const binding = LinkedDestinationBinding.parse({
    ...options.binding,
    workspaceEpoch: await getWorkspaceCollaborationEpoch(),
    bootNonce: options.bootNonce ?? randomUUID(),
  })
  const shares = new Hono().route(
    "/public/share",
    createPublicSharesRouter(() => shareOrigin ?? null)
  )
  const consumed = new Map<string, number>()
  let active = true
  let inFlight = 0

  async function fetch(request: Request): Promise<Response> {
    const denied = () =>
      new Response(null, {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      })
    // Admission precedes all asynchronous work, fencing workspace replacements.
    const release = admitWorkspaceRequest()
    if (!release) return new Response(null, { status: 503 })
    if (inFlight >= 8) {
      release()
      return new Response(null, {
        status: 503,
        headers: { "Retry-After": "1" },
      })
    }
    inFlight++
    try {
      const url = new URL(request.url)
      const raw = request.headers.get(LINKED_ASSERTION_HEADER)
      if (!active || !raw || raw.length > 16384 || url.search) return denied()
      let claims: LinkedRequestClaims
      let body: Uint8Array
      try {
        const { payload } = await jwtVerify(raw, key, {
          algorithms: ["HS256"],
          typ: LINKED_ASSERTION_TYPE,
          issuer: LINKED_ASSERTION_ISSUER,
          audience: binding.destinationId,
          requiredClaims: ["iat", "exp", "jti"],
          maxTokenAge: LINKED_ASSERTION_TTL_SECONDS,
        })
        claims = LinkedRequestClaims.parse(payload["request"])
        const now = Math.floor(Date.now() / 1000)
        if (
          payload.aud !== binding.destinationId ||
          typeof payload.iat !== "number" ||
          typeof payload.exp !== "number" ||
          payload.iat > now ||
          payload.exp > payload.iat + LINKED_ASSERTION_TTL_SECONDS ||
          !payload.jti ||
          payload.jti.length > 128 ||
          Object.keys(binding).some(
            (field) =>
              claims.binding[field as keyof LinkedDestinationBinding] !==
              binding[field as keyof LinkedDestinationBinding]
          ) ||
          claims.path !== url.pathname ||
          claims.method !== request.method
        )
          return denied()
        if (
          claims.grant.kind === "health"
            ? claims.path !== "/linked/health" || claims.method !== "GET"
            : claims.grant.kind === "mcp"
              ? claims.path !== "/api/mcp" ||
                !["GET", "POST", "DELETE"].includes(claims.method)
              : !["/public/share", "/public/share/content"].includes(
                  claims.path
                ) || !["GET", "HEAD"].includes(claims.method)
        )
          return denied()
        body = await readBody(request, payload.exp * 1000)
        if (
          createHash("sha256").update(body).digest("hex") !== claims.bodyDigest
        )
          return denied()
        const epoch = await getWorkspaceCollaborationEpoch()
        const admittedAt = Math.floor(Date.now() / 1000)
        if (
          !active ||
          getWorkspaceRoot() !== workspace ||
          epoch !== binding.workspaceEpoch ||
          payload.exp <= admittedAt
        )
          return denied()
        // Atomic between awaits. Never evict a still-valid ID to admit new traffic.
        for (const [id, expires] of consumed)
          if (expires <= admittedAt) consumed.delete(id)
        if (consumed.has(payload.jti) || consumed.size >= 10000) return denied()
        consumed.set(payload.jti, payload.exp)
      } catch {
        return denied()
      }
      const headers = new Headers({
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      })
      if (claims.grant.kind === "health")
        return Response.json(
          { ready: true },
          { headers: { "Cache-Control": "no-store" } }
        )
      if (claims.grant.kind === "share") {
        headers.set(SHARE_CAPABILITY_HEADER, claims.grant.capability)
        return await shares.fetch(
          new Request(request.url, { method: request.method, headers })
        )
      }
      const grant = claims.grant
      return await handleRemoteMcpRequest(
        new Request(request.url, {
          method: request.method,
          headers,
          ...(request.method === "POST" ? { body: new Uint8Array(body) } : {}),
        }),
        {
          credentialClass: "resource",
          user: binding.ownerSubject,
          workspace,
          agent: grant.displayName,
          scopes: HOSTED_OAUTH_SCOPES.filter(
            (scope) => scopes.has(scope) && grant.scopes.includes(scope)
          ),
          principal: {
            id: grant.principalId,
            type: "agent",
            displayName: grant.displayName,
            authorizedBy: `workos:${binding.ownerSubject}`,
          },
        },
        `${publicOrigin}/api/mcp/d/${binding.destinationId}`
      )
    } finally {
      inFlight--
      release()
    }
  }
  return {
    binding: { ...binding },
    fetch,
    setSharingOrigin(origin: string | null) {
      if (origin !== null) {
        const url = new URL(origin)
        if (url.protocol !== "https:" || url.origin !== origin)
          throw new Error("Expected a Cloud HTTPS origin")
      }
      shareOrigin = origin
    },
    revoke() {
      active = false
    },
  }
}
