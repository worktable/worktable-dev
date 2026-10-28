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
  ShareLinkToken,
  ShareTicket,
  SHARE_UNLOCK_HEADER,
  AGENT_ROUTE_HEADERS,
  VISITOR_HEADERS,
} from "@worktable/hosted-contract"
import { getWorkspaceRoot } from "./workspace.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import {
  admitWorkspaceRequest,
  classifyWorkspaceRequest,
  waitForWorkspaceAdmission,
  WRITE_ADMISSION_WAIT_MS,
} from "./workspace-request-lifecycle.ts"
import { handleRemoteMcpRequest } from "./routes/mcp.ts"
import { createPublicSharesRouter } from "./routes/public-shares.ts"
import { currentTeamWorktable } from "./team-database.ts"
import { resolveCloudTeamAgentCredential } from "./team-cloud.ts"
import type { TokenIdentity } from "./token-store.ts"
import { linkedGrokBotParticipantKey } from "./grok-bot-store.ts"
import { noteLinkedApp } from "./agent-connection-store.ts"
import {
  clearPendingUploads,
  receiveUploadPiece,
  sendDownloadPiece,
} from "./linked-file-links.ts"

function validShareRequest(claims: LinkedRequestClaims): boolean {
  if (claims.grant.kind !== "share") return false
  // Visitor comments come in one page; this binary names no comment pages.
  if (claims.grant.commentCursor !== undefined) return false
  if (claims.path === "/public/share/comments") {
    const visitor = claims.grant.visitor
    return Boolean(
      visitor &&
      ShareLinkToken.safeParse(claims.grant.capability).success &&
      claims.grant.clientAddress === undefined &&
      claims.grant.contentRevision === undefined &&
      (["GET", "HEAD"].includes(claims.method) ||
        (claims.method === "POST" && visitor.verified && visitor.client))
    )
  }
  if (claims.grant.visitor !== undefined) return false
  if (
    claims.grant.clientAddress !== undefined &&
    claims.path !== "/public/share/bridge"
  )
    return false
  if (
    claims.grant.contentRevision !== undefined &&
    (claims.path !== "/public/share/content" ||
      !["GET", "HEAD"].includes(claims.method))
  )
    return false
  if (
    claims.path === "/public/share/unlock" ||
    claims.path === "/public/share/bridge"
  ) {
    return (
      claims.method === "POST" &&
      ShareLinkToken.safeParse(claims.grant.capability).success
    )
  }
  if (
    !["/public/share", "/public/share/content"].includes(claims.path) ||
    !["GET", "HEAD"].includes(claims.method)
  )
    return false
  return (
    ShareLinkToken.safeParse(claims.grant.capability).success ||
    (claims.path === "/public/share/content" &&
      ShareTicket.safeParse(claims.grant.capability).success)
  )
}

/** A file link piece: an upload piece by POST, a download piece by GET or HEAD. */
function validFileLinkRequest(claims: LinkedRequestClaims): boolean {
  if (claims.grant.kind !== "file-link") return false
  if (claims.path === "/linked/file-links/upload")
    return claims.method === "POST" && claims.grant.total !== undefined
  return (
    claims.path === "/linked/file-links/download" &&
    ["GET", "HEAD"].includes(claims.method) &&
    claims.grant.total === undefined
  )
}

async function readBody(
  request: Request,
  expiresAt: number,
  maxBytes = LINKED_REQUEST_MAX_BYTES
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
      if (size > maxBytes) throw new Error("Request too large")
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
  /** The Cloud origin the link's identity bindings were recorded under. */
  identityIssuer?: string
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
  const identityIssuer = options.identityIssuer ?? publicOrigin
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
    createPublicSharesRouter(() => shareOrigin ?? null, {
      trustedLinkIngress: true,
    })
  )
  const consumed = new Map<string, number>()
  let active = true
  let inFlight = 0
  let shareInFlight = 0

  async function fetch(request: Request): Promise<Response> {
    const denied = () =>
      new Response(null, {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      })
    const url = new URL(request.url)
    const sharing =
      url.pathname === "/public/share" ||
      url.pathname.startsWith("/public/share/")
    const download = url.pathname === "/linked/file-links/download"
    // Reserve before JWT verification or body reads. Sharing can occupy six
    // slots; two remain available for MCP even when visitors hold slow bodies.
    if (inFlight >= 8 || (sharing && shareInFlight >= 6)) {
      return new Response(null, {
        status: sharing ? 429 : 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "1" },
      })
    }
    inFlight++
    if (sharing) shareInFlight++
    let release: (() => void) | null = null
    try {
      const kind =
        (sharing &&
          classifyWorkspaceRequest(request.method, url.pathname) === "read") ||
        download
          ? "read"
          : "write"
      // Admission still fences every workspace read before asynchronous work.
      release =
        admitWorkspaceRequest(kind) ??
        ((await waitForWorkspaceAdmission(kind, WRITE_ADMISSION_WAIT_MS))
          ? admitWorkspaceRequest(kind)
          : null)
      if (!release)
        return new Response(null, {
          status: 503,
          headers: { "Retry-After": "1" },
        })
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
              : claims.grant.kind === "file-link"
                ? !validFileLinkRequest(claims)
                : !validShareRequest(claims)
        )
          return denied()
        body = await readBody(
          request,
          payload.exp * 1000,
          claims.path === "/public/share/comments"
            ? 16 * 1024
            : claims.path === "/public/share/bridge"
              ? 16 * 1024
              : LINKED_REQUEST_MAX_BYTES
        )
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
      if (claims.grant.kind === "file-link") {
        const grant = claims.grant
        return claims.path === "/linked/file-links/upload"
          ? await receiveUploadPiece(
              grant.capability,
              grant.offset,
              grant.total!,
              body
            )
          : await sendDownloadPiece(
              grant.capability,
              grant.offset,
              claims.method as "GET" | "HEAD"
            )
      }
      if (claims.grant.kind === "share") {
        headers.set(SHARE_CAPABILITY_HEADER, claims.grant.capability)
        if (claims.grant.unlock)
          headers.set(SHARE_UNLOCK_HEADER, claims.grant.unlock)
        if (claims.grant.visitor) {
          headers.set(VISITOR_HEADERS.KEY, claims.grant.visitor.key)
          headers.set(
            VISITOR_HEADERS.VERIFIED,
            claims.grant.visitor.verified ? "1" : "0"
          )
          if (claims.grant.visitor.client)
            headers.set(VISITOR_HEADERS.CLIENT, claims.grant.visitor.client)
        }
        if (claims.grant.clientAddress)
          headers.set(
            AGENT_ROUTE_HEADERS.CLIENT_ADDRESS,
            claims.grant.clientAddress
          )
        if (claims.grant.contentRevision)
          headers.set("If-None-Match", `"${claims.grant.contentRevision}"`)
        return await shares.fetch(
          new Request(request.url, {
            method: request.method,
            headers,
            ...(request.method === "POST"
              ? { body: new Uint8Array(body) }
              : {}),
          })
        )
      }
      const grant = claims.grant
      const credential: TokenIdentity = {
        credentialClass: "resource",
        credentialIssuedAt: grant.credentialIssuedAt,
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
          ...(!currentTeamWorktable()
            ? {
                participantKey: await linkedGrokBotParticipantKey(
                  grant.principalId,
                  grant.displayName
                ),
              }
            : {}),
        },
      }
      const identity = currentTeamWorktable()
        ? grant.credentialIssuedAt
          ? await resolveCloudTeamAgentCredential(credential, identityIssuer)
          : null
        : credential
      if (!identity) return denied()
      // A team's agents are its members'; others show in Settings → Agents.
      // Only an app's first request here waits, for the one write.
      if (!currentTeamWorktable()) await noteLinkedApp(identity)
      return await handleRemoteMcpRequest(
        new Request(request.url, {
          method: request.method,
          headers,
          ...(request.method === "POST" ? { body: new Uint8Array(body) } : {}),
        }),
        identity,
        `${publicOrigin}/api/mcp/d/${binding.destinationId}`
      )
    } finally {
      inFlight--
      if (sharing) shareInFlight--
      release?.()
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
      clearPendingUploads()
    },
  }
}
