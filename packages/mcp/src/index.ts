#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createWorktableMcpServer } from "@worktable/server/mcp"

const server = createWorktableMcpServer({ version: "0.0.1" })

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[Worktable MCP] server started on stdio")
}

main().catch((e) => {
  console.error("[Worktable MCP] fatal:", e)
  process.exit(1)
})
