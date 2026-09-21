import { afterEach, describe, expect, it } from "bun:test";
import { verifyMcpEndpoint } from "./verify.ts";

// verifyMcpEndpoint against a stub MCP endpoint: the tool-level failure shape
// (successful JSON-RPC response carrying result.isError) must not read as
// verified — that is how scope-limited tokens fail.

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

type Responder = (method: string) => Record<string, unknown>;

function stubMcp(respond: Responder): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { method: string; id: number };
      return Response.json({ jsonrpc: "2.0", id: body.id, ...respond(body.method) });
    },
  });
  return `http://127.0.0.1:${server.port}/mcp`;
}

const HAPPY: Record<string, Record<string, unknown>> = {
  initialize: { result: { protocolVersion: "2025-06-18", capabilities: {} } },
  "tools/list": { result: { tools: [{ name: "worktable_discover" }] } },
  "tools/call": { result: { content: [{ type: "text", text: "{}" }] } },
};

describe("verifyMcpEndpoint", () => {
  it("verifies a healthy endpoint and counts tools", async () => {
    const url = stubMcp((method) => HAPPY[method]!);
    const result = await verifyMcpEndpoint(url, "token");
    expect(result).toEqual({ ok: true, toolCount: 1 });
  });

  it("fails when the tool returns result.isError (scope-limited token)", async () => {
    const url = stubMcp((method) =>
      method === "tools/call"
        ? {
            result: {
              isError: true,
              content: [{ type: "text", text: "Missing scope: search:read" }],
            },
          }
        : HAPPY[method]!
    );
    const result = await verifyMcpEndpoint(url, "token");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Missing scope: search:read");
  });

  it("fails on a JSON-RPC error and on a 401", async () => {
    const errUrl = stubMcp(() => ({ error: { code: -32000, message: "boom" } }));
    const errResult = await verifyMcpEndpoint(errUrl, "token");
    expect(errResult.ok).toBe(false);
    expect(errResult.message).toContain("boom");
    server?.stop(true);

    server = Bun.serve({
      port: 0,
      fetch: () => new Response("Unauthorized", { status: 401 }),
    });
    const unauth = await verifyMcpEndpoint(
      `http://127.0.0.1:${server.port}/mcp`,
      "bad"
    );
    expect(unauth.ok).toBe(false);
    expect(unauth.message).toContain("401");
  });
});
