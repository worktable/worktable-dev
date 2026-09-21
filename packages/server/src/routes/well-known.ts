import { Hono, type Context } from "hono";
import type { AuthorizationServerMetadataName } from "@worktable/hosted-contract";
import { getAuthServerUrl } from "../auth.ts";
import { authServerScopes, fetchAsWellKnown } from "../oauth-jwt.ts";

// ============================================================
// OAuth discovery (RFC 9728 Protected Resource Metadata)
// ============================================================
//
// The seam that lets the hosted control plane plug in without touching
// core: when WORKTABLE_AUTH_SERVER_URL points at an authorization
// server, MCP clients discover it from here (after a 401 carrying the
// WWW-Authenticate resource_metadata hint) and walk the OAuth flow on
// their own. Locally nothing is configured and this endpoint 404s —
// local auth stays token/zero-ceremony, no OAuth ceremony.

export const wellKnownRouter = new Hono();

async function protectedResourceMetadata(c: Context) {
  const authServer = getAuthServerUrl();
  if (!authServer) {
    return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
  }
  const requestOrigin = new URL(c.req.url).origin;
  const resource =
    process.env["WORKTABLE_RESOURCE_URL"]?.trim() || `${requestOrigin}/mcp`;

  // scopes_supported must be the AS's vocabulary, never Worktable's
  // internal token scopes: MCP clients echo this field into their
  // authorize request, and the AS error-redirects on scopes it doesn't
  // know (invalid_scope — found live with Claude vs AuthKit). Omitted
  // when the AS advertises nothing usable; clients then request the AS
  // defaults, which AuthKit accepts.
  const scopes = await authServerScopes();
  return c.json({
    resource,
    authorization_servers: [authServer],
    bearer_methods_supported: ["header"],
    ...(scopes ? { scopes_supported: scopes } : {}),
  });
}

// Root variant (what the 401 WWW-Authenticate hint advertises) AND the
// RFC 9728 path-insertion variants — spec-following MCP clients construct
// those themselves (well-known path + resource path) and try them FIRST.
// This core serves exactly one protected resource, so every suffix
// describes it; a wildcard keeps the metadata correct wherever the MCP
// endpoint is mounted (/mcp locally, /api/mcp hosted — the Sprites proxy
// reserves the literal /mcp path for its own MCP feature and swallows
// non-POST methods on it).
wellKnownRouter.get("/oauth-protected-resource", protectedResourceMetadata);
wellKnownRouter.get("/oauth-protected-resource/*", protectedResourceMetadata);

// RFC 8414 / OIDC discovery passthrough: clients on the pre-RFC-9728 MCP
// auth spec (and some current ones, as a parallel probe) fetch the
// AUTHORIZATION SERVER's metadata from the resource origin. Serve the
// AS's own document; without these routes the SPA catch-all answered
// 200 text/html, which clients parsed as a broken OAuth configuration.
function asDocumentPassthrough(name: AuthorizationServerMetadataName) {
  return async (c: Context) => {
    const authServer = getAuthServerUrl();
    if (!authServer) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    try {
      return c.json(await fetchAsWellKnown(authServer, name));
    } catch {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
  };
}
for (const name of [
  "oauth-authorization-server",
  "openid-configuration",
] as const) {
  wellKnownRouter.get(`/${name}`, asDocumentPassthrough(name));
  wellKnownRouter.get(`/${name}/*`, asDocumentPassthrough(name));
}

// Unknown well-known paths are 404 JSON, NEVER the SPA shell: discovery
// clients probe several specs here and treat a 200 text/html as a broken
// (not merely absent) configuration.
wellKnownRouter.all("*", (c) =>
  c.json({ error: "Not found", code: "NOT_FOUND" }, 404)
);
