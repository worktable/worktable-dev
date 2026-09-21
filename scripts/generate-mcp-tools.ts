// Regenerates mcp-tools.json through the real MCP tools/list path.
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createWorktableMcpServer } from "../packages/server/src/mcp/server.ts"

const server = createWorktableMcpServer({ version: "catalog" })
const client = new Client({ name: "catalog-generator", version: "1" })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const check = process.argv.slice(2).includes("--check")

try {
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  const { tools } = await client.listTools()
  const catalog = tools.map(
    ({
      name,
      title,
      description,
      inputSchema,
      outputSchema,
      annotations,
      _meta,
    }) => ({
      name,
      ...(title ? { title } : {}),
      description: description ?? "",
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      ...(annotations ? { annotations } : {}),
      ...(Array.isArray(_meta?.securitySchemes)
        ? { securitySchemes: _meta.securitySchemes }
        : {}),
      ...(_meta ? { _meta } : {}),
    })
  )
  const outPath = join(import.meta.dir, "..", "mcp-tools.json")
  const generated = `${JSON.stringify(catalog, null, 2)}\n`
  if (check) {
    const stale: string[] = []
    if ((await Bun.file(outPath).text()) !== generated) stale.push(outPath)
    if (stale.length > 0) {
      throw new Error(
        `Generated MCP artifacts are stale: ${stale.join(", ")}. Run 'bun run generate:tools' and commit the result.`
      )
    }
    console.log(`Verified ${catalog.length} tools`)
  } else {
    await Bun.write(outPath, generated)
    console.log(`Wrote ${catalog.length} tools`)
  }
} finally {
  await client.close()
  await server.close()
}
