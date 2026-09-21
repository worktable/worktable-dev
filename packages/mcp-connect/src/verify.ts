// ============================================================
// End-to-end MCP verification (plain fetch, no SDK)
// ============================================================
//
// Exercises the REAL path a configured agent will use: JSON-RPC over
// streamable HTTP against the Worktable MCP endpoint, with the bearer the
// connector just received. Worktable's transport is stateless with JSON
// responses, so each POST is independent — no session id required. Runs
// under plain Node 18+ (global fetch), so the connector bundle can use it.

export interface VerifyResult {
  ok: boolean;
  /** Number of tools the server advertised (when tools/list succeeded). */
  toolCount?: number;
  message?: string;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

async function rpc(
  mcpUrl: string,
  token: string | undefined,
  body: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  if (res.status === 401) {
    throw new Error("endpoint requires a valid bearer token (401)");
  }
  if (!res.ok) {
    throw new Error(`endpoint returned HTTP ${res.status}`);
  }
  return (await res.json()) as JsonRpcResponse;
}

/** initialize -> tools/list -> worktable_discover, reporting the first failure. */
export async function verifyMcpEndpoint(
  mcpUrl: string,
  token?: string
): Promise<VerifyResult> {
  try {
    const init = await rpc(mcpUrl, token, {
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "worktable-connect", version: "1" },
      },
    });
    if (init.error) {
      return { ok: false, message: `initialize failed: ${init.error.message}` };
    }

    const tools = await rpc(mcpUrl, token, { method: "tools/list", params: {} });
    if (tools.error) {
      return { ok: false, message: `tools/list failed: ${tools.error.message}` };
    }
    const toolCount = Array.isArray(
      (tools.result as { tools?: unknown[] } | undefined)?.tools
    )
      ? (tools.result as { tools: unknown[] }).tools.length
      : 0;

    const state = await rpc(mcpUrl, token, {
      method: "tools/call",
      params: {
        name: "worktable_discover",
        arguments: { request: { action: "state" } },
      },
    });
    if (state.error) {
      return {
        ok: false,
        toolCount,
        message: `worktable_discover failed: ${state.error.message}`,
      };
    }
    // Tool-level failures come back as a SUCCESSFUL JSON-RPC response with
    // result.isError (e.g. a token whose custom scopes cannot drive the
    // tool) — they must not read as verified.
    const result = state.result as
      | { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
      | undefined;
    if (result?.isError) {
      const text = result.content?.find((c) => typeof c.text === "string")?.text;
      return {
        ok: false,
        toolCount,
        message: `worktable_discover failed: ${text ?? "tool error"}`,
      };
    }

    return { ok: true, toolCount };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
