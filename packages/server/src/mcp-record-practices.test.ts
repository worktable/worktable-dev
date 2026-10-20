import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setWorkspaceRootOverride } from "./workspace.ts"
import {
  buildRecordFile,
  findRecordBounded,
  writeRecord,
} from "./record-store.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { registerTools } from "./mcp/tools.ts"
import {
  logRecordPracticeWarnings,
  type RecordPracticeWarning,
} from "./mcp/record-practices.ts"

let workspaceDir: string

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-record-practices-"))
  mkdirSync(join(workspaceDir, "spaces"), { recursive: true })
  setWorkspaceRootOverride(workspaceDir)
})

afterEach(() => {
  setWorkspaceRootOverride(null)
  if (existsSync(workspaceDir))
    rmSync(workspaceDir, { recursive: true, force: true })
})

async function createSpace(): Promise<void> {
  await dispatchOperation("spaces.create", { name: "Product" })
}

function warningCodes(result: {
  warnings?: RecordPracticeWarning[]
}): string[] {
  return (result.warnings ?? []).map((warning) => warning.code)
}

describe("MCP record-practice advisories", () => {
  it("keeps machine-local diagnostics structural", () => {
    const info = spyOn(console, "error").mockImplementation(() => {})
    try {
      logRecordPracticeWarnings(
        "record_create",
        [
          {
            code: "duplicate_title",
            message: "Another record already has the same title or name.",
            suggestion: "Check for a merge.",
            evidence: { fields: ["private_customer_name"] },
          },
        ],
        { duplicateMatchCount: 1 }
      )
      const logged = JSON.stringify(info.mock.calls)
      expect(logged).toContain("duplicate_title")
      expect(logged).toContain("duplicateMatchCount")
      expect(logged).not.toContain("private_customer_name")
    } finally {
      info.mockRestore()
    }
  })

  it("writes a complex initial schema and returns explainable non-blocking warnings", async () => {
    await createSpace()
    const result = (await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "ideas",
      name: "Ideas",
      description:
        "A deliberately overlong first collection description. ".repeat(5),
      fields: {
        title: { type: "string", required: true },
        summary: { type: "text" },
        description: { type: "text" },
        details: { type: "text" },
        notes: { type: "text" },
        context: { type: "text" },
        rationale: { type: "text" },
        status: { type: "string" },
        stage: { type: "string" },
        created_at: { type: "datetime" },
      },
    })) as { collection: { id: string }; warnings?: RecordPracticeWarning[] }

    expect(result.collection.id).toBe("ideas")
    expect(
      existsSync(
        join(
          workspaceDir,
          "spaces",
          "product",
          "records",
          "ideas",
          "schema.yaml"
        )
      )
    ).toBe(true)
    expect(warningCodes(result)).toEqual(
      expect.arrayContaining([
        "collection_description_too_long",
        "large_initial_schema",
        "many_optional_narrative_fields",
        "near_synonymous_fields",
        "system_provenance_field",
      ])
    )

    const evolved = (await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "ideas",
      fields: {
        title: { type: "string", required: true },
        summary: { type: "text" },
      },
    })) as { warnings?: RecordPracticeWarning[] }
    expect(warningCodes(evolved)).not.toContain("large_initial_schema")
  })

  it("keeps synonym feedback high-confidence for qualified operational fields", async () => {
    await createSpace()
    const result = (await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "orders",
      fields: {
        title: { type: "string", required: true },
        shipping_status: { type: "string" },
        payment_status: { type: "string" },
        source_url: { type: "string" },
        source_type: { type: "string" },
      },
    })) as { warnings?: RecordPracticeWarning[] }

    expect(warningCodes(result)).not.toContain("near_synonymous_fields")
  })

  it("bounds best-effort duplicate inspection", async () => {
    await createSpace()
    for (const [id, title] of [
      ["a", "Alpha"],
      ["b", "Beta"],
      ["c", "Gamma"],
      ["d", "Delta"],
    ]) {
      const result = await writeRecord(
        "product",
        buildRecordFile({ id, collectionId: "tasks", data: { title } })
      )
      expect(result.error).toBeNull()
    }

    let inspected = 0
    const match = await findRecordBounded(
      "product",
      "tasks",
      () => {
        inspected += 1
        return false
      },
      { includeArchived: true, maxFiles: 2 }
    )
    expect(match).toBeNull()
    expect(inspected).toBe(2)
  })

  it("creates records despite duplicate or missing-title warnings", async () => {
    await createSpace()
    await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "tasks",
      name: "Tasks",
      description: "Work that can be completed independently.",
      fields: { title: { type: "string", required: true } },
    })

    const first = (await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "tasks",
      data: { title: "Prepare launch brief" },
    })) as { warnings?: RecordPracticeWarning[] }
    expect(first.warnings).toBeUndefined()

    const duplicate = (await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "tasks",
      data: { title: "Prepare launch brief" },
    })) as { record: { id: string }; warnings?: RecordPracticeWarning[] }
    expect(duplicate.record.id).toBe("prepare-launch-brief-2")
    expect(warningCodes(duplicate)).toContain("duplicate_title")

    const untitled = (await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "events",
      data: { occurred_on: "2026-07-13" },
    })) as { record: { id: string }; warnings?: RecordPracticeWarning[] }
    expect(untitled.record.id).toBe("record")
    expect(warningCodes(untitled)).toContain("missing_recognizable_title")
    expect(
      existsSync(
        join(
          workspaceDir,
          "spaces",
          "product",
          "records",
          "events",
          "record.yaml"
        )
      )
    ).toBe(true)
  })

  it("does not reveal duplicate identities to a write-only MCP token", async () => {
    await createSpace()
    await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "tasks",
      fields: { title: { type: "string", required: true } },
    })
    await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "tasks",
      data: { title: "Private roadmap item" },
    })

    const handlers: Record<
      string,
      (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>
      }>
    > = {}
    registerTools(
      {
        registerTool(
          name: string,
          _metadata: unknown,
          handler: (args: Record<string, unknown>) => Promise<{
            content: Array<{ type: string; text: string }>
          }>
        ) {
          handlers[name] = handler
        },
      } as never,
      { scopes: ["records:write"], urlOrigin: "http://127.0.0.1:7480" }
    )

    const response = await handlers["worktable_records_write"]!({
      request: {
        action: "create",
        spaceId: "product",
        collectionId: "tasks",
        recordId: "probe",
        data: { title: "Private roadmap item" },
      },
    })
    const payload = JSON.parse(response.content[0]!.text) as {
      warnings?: RecordPracticeWarning[]
    }
    expect(warningCodes(payload)).not.toContain("duplicate_title")
  })
})

describe("MCP record writes keep stored data", () => {
  async function seedCollection(): Promise<void> {
describe("MCP record queries", () => {
  async function seedSignals(count: number): Promise<void> {
    await createSpace()
    await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "signals",
      name: "Signals",
      fields: {
        title: { type: "string", required: true },
        url: { type: "url" },
        platform: { type: "select", values: ["Reddit", "X"] },
      },
    })
  }

  it("adds a field without dropping the fields it was not sent", async () => {
    await seedCollection()
    const result = (await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "signals",
      fields: { review: { type: "select", values: ["Verified", "Excluded"] } },
    })) as {
      collection: { fields: Record<string, unknown> }
      fieldChanges: { added: string[]; changed: string[]; kept: string[] }
    }
    expect(Object.keys(result.collection.fields).sort()).toEqual([
      "platform",
      "review",
      "title",
      "url",
    ])
    expect(result.fieldChanges).toEqual({
      added: ["review"],
      changed: [],
      kept: ["title", "url", "platform"],
    })

    const widened = (await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "signals",
      fields: {
        title: { type: "string", required: true },
        platform: { type: "select", values: ["Reddit", "X", "LinkedIn"] },
      },
    })) as { fieldChanges: { changed: string[]; kept: string[] } }
    // A field sent again unchanged is reported as kept, like one left out.
    expect(widened.fieldChanges.changed).toEqual(["platform"])
    expect(widened.fieldChanges.kept).toEqual(["title", "url", "review"])
  })

  it("returns an existing record unchanged instead of overwriting it", async () => {
    await seedCollection()
    const first = (await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "signals",
      recordId: "ds-1",
      data: { title: "Original", platform: "Reddit" },
      metadata: { source: "round-1" },
    })) as { record: { createdAt: string }; created: boolean }
    expect(first.created).toBe(true)

    const again = (await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "signals",
      recordId: "ds-1",
      data: { title: "Replacement" },
    })) as {
      record: {
        data: Record<string, unknown>
        metadata: Record<string, unknown>
        createdAt: string
      }
      created: boolean
      warnings?: unknown
    }
    expect(again.created).toBe(false)
    expect(again.warnings).toBeUndefined()
    expect(again.record.data).toEqual({ title: "Original", platform: "Reddit" })
    expect(again.record.metadata).toEqual({ source: "round-1" })
    expect(again.record.createdAt).toBe(first.record.createdAt)
  })

  it("says which ids are valid when a record id is not", async () => {
    await seedCollection()
    await expect(
      dispatchOperation("records.create", {
        spaceId: "product",
        collectionId: "signals",
        recordId: "https://example.com/post/1",
        data: { title: "By url" },
      })
    ).rejects.toThrow("Ids use lowercase letters, digits and hyphens")
  })

  it("merges metadata on update like data", async () => {
    await seedCollection()
    await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "signals",
      recordId: "ds-2",
      data: { title: "Two" },
      metadata: { source: "round-1" },
    })
    const updated = (await dispatchOperation("records.update", {
      spaceId: "product",
      collectionId: "signals",
      recordId: "ds-2",
      metadata: { checkedBy: "verifier" },
    })) as { record: { metadata: Record<string, unknown> } }
    expect(updated.record.metadata).toEqual({
      source: "round-1",
      checkedBy: "verifier",
    })
  })
})
        tags: { type: "multi_select", values: ["team", "sharing", "tools"] },
      },
    })
    for (let i = 0; i < count; i++) {
      await writeRecord(
        "product",
        buildRecordFile({
          id: `s-${String(i).padStart(3, "0")}`,
          collectionId: "signals",
          data: {
            title: `Signal ${i}`,
            tags: i % 2 === 0 ? ["team", "sharing"] : ["team"],
          },
        })
      )
    }
  }

  it("returns one page and a cursor when the agent sets no limit", async () => {
    await seedSignals(130)
    const first = (await dispatchOperation("records.query", {
      spaceId: "product",
      collectionId: "signals",
    })) as { records: unknown[]; nextCursor?: string; warnings?: string[] }
    expect(first.records).toHaveLength(100)
    expect(first.nextCursor).toBeDefined()
    expect(first.warnings?.join(" ")).toContain("nextCursor")

    const rest = (await dispatchOperation("records.query", {
      spaceId: "product",
      collectionId: "signals",
      cursor: first.nextCursor,
    })) as { records: unknown[]; nextCursor?: string; warnings?: string[] }
    expect(rest.records).toHaveLength(30)
    expect(rest.nextCursor).toBeUndefined()
    expect(rest.warnings).toBeUndefined()
  })

  it("counts each value of a multi-select field", async () => {
    await seedSignals(10)
    const result = (await dispatchOperation("records.query", {
      spaceId: "product",
      collectionId: "signals",
      aggregate: { groupBy: "tags", select: { n: { fn: "count" } } },
    })) as { groups: Array<{ key: unknown; n: number }> }
    expect(
      Object.fromEntries(result.groups.map((group) => [group.key, group.n]))
    ).toEqual({ team: 10, sharing: 5 })
  })
})

