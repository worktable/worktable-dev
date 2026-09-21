import { Hono } from "hono"
import { cors } from "hono/cors"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { requireIdentity } from "../auth.ts"
import { createWorktableMcpServer } from "../mcp/server.ts"
import { resolveWorkspaceOriginForRequest } from "../workspace-origin.ts"
import type { TokenIdentity } from "../token-store.ts"

// ============================================================
// Server factory — creates a fresh server per request (stateless)
// ============================================================

function createRemoteMcpServer(identity: TokenIdentity, urlOrigin: string) {
  return createWorktableMcpServer({
    version: "0.0.1",
    scopes: identity.scopes,
    urlOrigin,
    // The implicit loopback bridge and legacy WORKTABLE_MCP_TOKEN both use
    // ownerIdentity() for authorization, but the caller is still an MCP agent.
    // Preserve the historical agent attribution for those compatibility modes;
    // minted/OAuth/gateway identities carry a real actor principal and retain it.
    principal:
      identity.principal.id === "local:owner" ? undefined : identity.principal,
    identity:
      identity.principal.id === "local:owner"
        ? undefined
        : {
            agent: identity.agent,
            credentialClass: identity.credentialClass,
            principal: identity.principal,
          },
  })
}

// ============================================================
// Hono router
// ============================================================

export const mcpRouter = new Hono()

// CORS for MCP-specific headers
mcpRouter.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "mcp-session-id",
      "Last-Event-ID",
      "mcp-protocol-version",
    ],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  })
)

// Auth: bare literal-loopback requests may act as local owner while deployment
// policy is local. Scoped minted tokens can coexist with that path and resolve
// their own principal when presented; exposed/public/AS/explicit-credential
// postures require a valid bearer. Invalid presented credentials always fail.
mcpRouter.use("*", requireIdentity())

// MCP endpoint — stateless: new server + transport per request
mcpRouter.all("/", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    // Answer POSTs with plain application/json instead of SSE (spec-legal:
    // the server chooses). Worktable tools are strict request/response —
    // nothing streams mid-request — and SSE responses break behind
    // buffering proxies: the Fly Sprites wake proxy delivered NOTHING of a
    // text/event-stream POST response (not even headers) while the origin
    // closed the stream in 3ms, which real MCP clients (Claude, ChatGPT)
    // surfaced as the whole server being unreachable.
    enableJsonResponse: true,
  })
  const identity = c.get("identity")
  const { origin } = resolveWorkspaceOriginForRequest(c.req.raw)
  const server = createRemoteMcpServer(identity, origin)
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})
