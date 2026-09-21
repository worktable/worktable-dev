import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { setAppDirOverride } from "./app-storage.ts"
import { startServer } from "./index.ts"
import { recordIndex } from "./record-index.ts"
import { buildRecordFile } from "./record-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import { wsManager } from "./ws.ts"
import { stringifyCanonicalYaml } from "./yaml.ts"

const repoRoot = join(import.meta.dir, "../../..")

let workspaceDir: string
let appDir: string
let server: ReturnType<typeof startServer> | null

async function jsonRequest(
  origin: string,
  method: string,
  path: string,
  body?: unknown
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json()
  return { response, json }
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!accept(value) && Date.now() < deadline) {
    // test-policy: external-readiness-backoff
    await Bun.sleep(25)
    value = await read()
  }
  return value
}

describe("record projection integrity", () => {
  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worktable-projection-ws-"))
    appDir = mkdtempSync(join(tmpdir(), "worktable-projection-app-"))
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(appDir, { recursive: true })
    setWorkspaceRootOverride(workspaceDir)
    setAppDirOverride(appDir)
    server = null
  })

  afterEach(async () => {
    await server?.stop(true)
    server = null
    recordIndex.stop()
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    for (const dir of [workspaceDir, appDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  it("converges separate MCP stdio creates, updates, schema writes, batches, and deletes without a restart", async () => {
    server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`

    const createdSpace = await jsonRequest(origin, "POST", "/api/spaces", {
      name: "Meta",
    })
    expect(createdSpace.response.status).toBe(201)
    const spaceId = String(createdSpace.json.spaceId)

    const createdCollection = await jsonRequest(
      origin,
      "POST",
      `/api/spaces/${spaceId}/records`,
      {
        id: "ideas",
        name: "Ideas",
        fields: { title: { type: "string", required: true } },
      }
    )
    expect(createdCollection.response.status).toBe(201)
    await recordIndex.whenReady()

    writeFileSync(
      join(appDir, "config.json"),
      JSON.stringify({
        version: 2,
        workspace: workspaceDir,
        service: {
          host: "127.0.0.1",
          port: server.port,
          startAtLogin: false,
          reachable: false,
          exposureAcknowledged: false,
          httpsUpstream: false,
        },
        mcp: { endpoint: `${origin}/mcp`, clients: {} },
      })
    )

    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", join(repoRoot, "apps/cli/src/index.ts"), "mcp", "stdio"],
      cwd: repoRoot,
      env: {
        ...getDefaultEnvironment(),
        WORKTABLE_APP_DIR: appDir,
        WORKTABLE_WORKSPACE: join(appDir, "ambient-workspace"),
      },
      stderr: "pipe",
    })
    const client = new Client({
      name: "projection-integrity-test",
      version: "1.0.0",
    })

    try {
      await client.connect(transport)
      const created = await client.callTool({
        name: "worktable_records_write",
        arguments: {
          request: {
            action: "create",
            spaceId,
            collectionId: "ideas",
            recordId: "from-stdio",
            data: { title: "Written from stdio" },
          },
        },
      })
      expect(created.isError).not.toBe(true)

      const createdQuery = await waitFor(
        async () =>
          jsonRequest(
            origin,
            "POST",
            `/api/spaces/${spaceId}/records/ideas/query`,
            {
              where: { title: "Written from stdio" },
            }
          ),
        (result) =>
          result.response.status === 200 && result.json.records?.length === 1
      )
      expect(
        createdQuery.json.records?.map((record: { id: string }) => record.id)
      ).toEqual(["from-stdio"])

      const updated = await client.callTool({
        name: "worktable_records_write",
        arguments: {
          request: {
            action: "update",
            spaceId,
            collectionId: "ideas",
            recordId: "from-stdio",
            data: { title: "Updated from stdio" },
          },
        },
      })
      expect(updated.isError).not.toBe(true)
      const updatedQuery = await waitFor(
        async () =>
          jsonRequest(
            origin,
            "POST",
            `/api/spaces/${spaceId}/records/ideas/query`,
            {
              where: { title: "Updated from stdio" },
            }
          ),
        (result) => result.json.records?.length === 1
      )
      expect(updatedQuery.json.records?.[0]?.data.title).toBe(
        "Updated from stdio"
      )

      const schemaUpdate = await client.callTool({
        name: "worktable_records_write",
        arguments: {
          request: {
            action: "upsert_collection",
            spaceId,
            collectionId: "ideas",
            name: "Renamed Ideas",
            fields: { title: { type: "string", required: true } },
          },
        },
      })
      expect(schemaUpdate.isError).not.toBe(true)
      const searchHits = await waitFor(
        async () => recordIndex.searchRecords("Renamed", 10) ?? [],
        (hits) => hits.some((hit) => hit.recordId === "from-stdio")
      )
      expect(searchHits.some((hit) => hit.recordId === "from-stdio")).toBe(true)

      // Larger than the 48-record incident batch. Every child write uses the
      // same atomic temp+rename helper and the watcher coalesces the temp-path
      // activity into bounded collection reconciliation.
      const batch = await Promise.all(
        Array.from({ length: 64 }, (_, index) =>
          client.callTool({
            name: "worktable_records_write",
            arguments: {
              request: {
                action: "create",
                spaceId,
                collectionId: "ideas",
                recordId: `batch-${String(index).padStart(2, "0")}`,
                data: { title: `Batch ${index}` },
              },
            },
          })
        )
      )
      expect(batch.every((result) => result.isError !== true)).toBe(true)
      const batchQuery = await waitFor(
        async () =>
          jsonRequest(
            origin,
            "POST",
            `/api/spaces/${spaceId}/records/ideas/query`,
            {
              limit: 100,
            }
          ),
        (result) => result.json.records?.length === 65
      )
      expect(batchQuery.json.records).toHaveLength(65)

      const health = await jsonRequest(
        origin,
        "GET",
        `/api/spaces/${spaceId}/records/ideas?includeRecords=false`
      )
      expect(health.json.projection).toMatchObject({
        state: "ready",
        canonicalFileCount: 65,
        indexedFileCount: 65,
        validRecordCount: 65,
        invalidRecordCount: 0,
      })

      const deleted = await client.callTool({
        name: "worktable_delete",
        arguments: {
          request: {
            action: "record",
            spaceId,
            collectionId: "ideas",
            recordId: "from-stdio",
          },
        },
      })
      expect(deleted.isError).not.toBe(true)
      const deletedQuery = await waitFor(
        async () =>
          jsonRequest(
            origin,
            "POST",
            `/api/spaces/${spaceId}/records/ideas/query`,
            {
              limit: 100,
            }
          ),
        (result) => result.json.records?.length === 64
      )
      expect(deletedQuery.json.records).toHaveLength(64)
    } finally {
      await client.close()
    }
  }, 30_000)

  it("broadcasts an external record edit even when projection maintenance fails", async () => {
    server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`
    const createdSpace = await jsonRequest(origin, "POST", "/api/spaces", {
      name: "Meta",
    })
    const spaceId = String(createdSpace.json.spaceId)
    await jsonRequest(origin, "POST", `/api/spaces/${spaceId}/records`, {
      id: "tasks",
      name: "Tasks",
    })
    await jsonRequest(origin, "POST", `/api/spaces/${spaceId}/records/tasks`, {
      id: "external",
      data: { title: "Before" },
    })
    await recordIndex.whenReady()

    const originalIngest = recordIndex.ingestFile.bind(recordIndex)
    const broadcasts: Array<{
      type: string
      recordId?: string
      data?: { data?: Record<string, unknown> }
    }> = []
    const client = {
      data: { spaceId, canReadRecords: true },
      send(message: string) {
        broadcasts.push(
          JSON.parse(message) as {
            type: string
            recordId?: string
            data?: { data?: Record<string, unknown> }
          }
        )
      },
      close() {},
    }
    wsManager.subscribe(client, spaceId)
    recordIndex.ingestFile = async () => {
      throw new Error("simulated projection failure")
    }
    try {
      const changed = buildRecordFile({
        id: "external",
        collectionId: "tasks",
        data: { title: "Changed on disk" },
        createdBy: "external",
      })
      writeFileSync(
        join(
          workspaceDir,
          "spaces",
          spaceId,
          "records",
          "tasks",
          "external.yaml"
        ),
        stringifyCanonicalYaml(changed)
      )
      const broadcast = await waitFor(
        async () =>
          broadcasts.find(
            (message) =>
              message.type === "record_update" &&
              message.recordId === "external"
          ),
        (message) => message?.data?.data?.["title"] === "Changed on disk"
      )
      expect(broadcast?.data?.data?.["title"]).toBe("Changed on disk")
    } finally {
      recordIndex.ingestFile = originalIngest
      wsManager.unsubscribe(client)
    }
  }, 10_000)
})
