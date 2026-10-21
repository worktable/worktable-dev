// Regenerates mcp-tools.json through the real MCP tools/list path.
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createWorktableMcpServer } from "../packages/server/src/mcp/server.ts"

export const toolCatalogPath = join(import.meta.dir, "..", "mcp-tools.json")
/** The held surface a Worktable serves with preview tools turned on. */
export const previewToolCatalogPath = join(
  import.meta.dir,
  "..",
  "mcp-tools.preview.json"
)

/** The tool surface exactly as tools/list serves it. */
export async function generateToolCatalog(
  surface: "released" | "preview" = "released"
) {
  const server = createWorktableMcpServer({ version: "catalog", surface })
  const client = new Client({ name: "catalog-generator", version: "1" })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])
    const { tools } = await client.listTools()
    return tools.map(
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
  } finally {
    await client.close()
    await server.close()
  }
}

if (import.meta.main) {
  const check = process.argv.slice(2).includes("--check")
  const catalogs = [
    { path: toolCatalogPath, tools: await generateToolCatalog() },
    {
      path: previewToolCatalogPath,
      tools: await generateToolCatalog("preview"),
    },
  ]
  const stale: string[] = []
  for (const { path, tools } of catalogs) {
    const generated = `${JSON.stringify(tools, null, 2)}\n`
    if (!check) {
      await Bun.write(path, generated)
      continue
    }
    const file = Bun.file(path)
    if (!(await file.exists()) || (await file.text()) !== generated)
      stale.push(path)
  }
  if (stale.length > 0) {
    throw new Error(
      `Generated MCP artifacts are stale: ${stale.join(", ")}. Run 'bun run generate:tools' and commit the result.`
    )
  }
  console.log(
    `${check ? "Verified" : "Wrote"} ${catalogs[0]!.tools.length} tools (released and preview)`
  )
}
