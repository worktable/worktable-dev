import { describe, expect, it } from "bun:test"
import { createServer, type Socket } from "node:net"
import {
  claimWithThreadLocations,
  McpWorktableClient,
  worktableAgentPresentationHeaders,
} from "./worktable-client.js"

describe("OpenClaw Worktable client", () => {
  it("recovers from failed initialization with one shared fresh handshake", async () => {
    let initializations = 0
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (request.method !== "POST")
          return new Response(null, { status: 405 })
        const rpc = (await request.json()) as { id?: number; method: string }
        if (rpc.method === "initialize") {
          initializations += 1
          if (initializations === 1)
            return new Response("Unavailable", { status: 503 })
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "recovery-test", version: "1" },
            },
          })
        }
        if (rpc.id === undefined) return new Response(null, { status: 202 })
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ participants: [] }) },
            ],
          },
        })
      },
    })
    const client = new McpWorktableClient(server.url.href, "test-token")
    try {
      await expect(client.participants()).rejects.toThrow()
      expect(
        await Promise.all([client.participants(), client.participants()])
      ).toEqual([[], []])
      expect(initializations).toBe(2)
    } finally {
      await client.close()
      await server.stop(true)
    }
  })

  it("closes an initialization request before it becomes connected", async () => {
    let markRequested!: () => void
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve
    })
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on("data", () => markRequested())
      socket.on("close", () => sockets.delete(socket))
      // Accept the HTTP request but deliberately never finish initialization.
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No test port")
    const client = new McpWorktableClient(
      `http://127.0.0.1:${address.port}`,
      "test-token"
    )
    // Observe the rejection immediately, including if shutdown races the request.
    const pending = client.participants().then(
      () => "connected",
      () => "closed"
    )
    try {
      await requested
      await client.close()
      expect(await pending).toBe("closed")
      await expect(client.participants()).rejects.toThrow("closed")
    } finally {
      await client.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it("keeps Unicode participant names out of ByteString headers", () => {
    const headers = worktableAgentPresentationHeaders({
      adapter: "openclaw",
      installationId: "agent_reg_1",
      label: "OpenClaw · 智能助手 😀",
      machine: "máquina-一",
    })

    expect(headers).toEqual({
      "x-worktable-agent-adapter": "openclaw",
      "x-worktable-agent-installation": "agent_reg_1",
      "x-worktable-agent-label": "OpenClaw",
      "x-worktable-agent-machine": "maquina-",
    })
    expect(() => new Headers(headers)).not.toThrow()
  })

  it("advertises location support while claiming deliveries", async () => {
    const requests: Array<Record<string, unknown>> = []
    const result = await claimWithThreadLocations(async (request) => {
      requests.push(request)
      return { delivery: null }
    }, 25)

    expect(requests).toEqual([
      {
        action: "claim",
        waitSeconds: 25,
        threadLocationVersion: 2,
      },
    ])
    expect(result).toEqual({ delivery: null })
  })

  it("propagates claim failures", async () => {
    const failure = Object.assign(new Error("Unauthorized"), { code: 401 })
    await expect(
      claimWithThreadLocations(() => Promise.reject(failure), 0)
    ).rejects.toBe(failure)
  })
})
