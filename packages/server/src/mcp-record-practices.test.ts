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
    // Nothing names the record, so it gets a short random id, not "record".
    expect(untitled.record.id).toMatch(/^rec-[0-9a-f]{10}$/)
    expect(warningCodes(untitled)).toContain("missing_recognizable_title")
    expect(
      existsSync(
        join(
          workspaceDir,
          "spaces",
          "product",
          "records",
          "events",
          `${untitled.record.id}.yaml`
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

describe("MCP record fields", () => {
  async function seedTasks(): Promise<void> {
    await createSpace()
    await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "tasks",
      name: "Tasks",
      fields: {
        title: { type: "string", required: true },
        status: { type: "select", values: ["open", "done"] },
      },
    })
  }

  it("refuses fields the schema does not declare and names the ones it does", async () => {
    await seedTasks()
    await expect(
      dispatchOperation("records.create", {
        spaceId: "product",
        collectionId: "tasks",
        recordId: "t1",
        data: { title: "One", stauts: "open" },
      })
    ).rejects.toThrow(
      'Field "stauts" is not in the schema of collection "tasks". Check the spelling, or add it with upsert_collection first. Declared fields: title, status.'
    )
    // Refused before anything is written.
    await expect(
      dispatchOperation("records.read", {
        spaceId: "product",
        collectionId: "tasks",
        recordId: "t1",
      })
    ).rejects.toThrow("Record not found")
    await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "tasks",
      recordId: "t1",
      data: { title: "One" },
    })
    await expect(
      dispatchOperation("records.update", {
        spaceId: "product",
        collectionId: "tasks",
        recordId: "t1",
        data: { owner: "ada" },
      })
    ).rejects.toThrow('Field "owner" is not in the schema')
  })

  it("makes a short, valid id from a long title", async () => {
    await createSpace()
    await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "notes",
      name: "Notes",
      fields: { title: { type: "string", required: true } },
    })
    const created = (await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "notes",
      data: { title: "Non-technical user can't give ChatGPT access to his vault except by copying" },
    })) as { record: { id: string } }
    // The first words, cut at a word boundary near 40 characters.
    expect(created.record.id).toBe("non-technical-user-can-t-give-chatgpt")
    const unbroken = (await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "notes",
      data: { title: `${"a".repeat(63)} rest` },
    })) as { record: { id: string } }
    expect(unbroken.record.id).toBe("a".repeat(40))
  })

  it("still skips an existing id after a field it carries was removed", async () => {
    await seedTasks()
    await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "tasks",
      recordId: "old",
      data: { title: "Old", status: "open" },
    })
    // Remove status the way the schema editor does (full replace).
    const { buildRecordCollectionSchema, readRecordCollectionSchema, writeRecordCollectionSchema } = await import("./record-store.ts")
    const current = (await readRecordCollectionSchema("product", "tasks")).data!
    await writeRecordCollectionSchema(
      "product",
      buildRecordCollectionSchema({ id: "tasks", fields: { title: { type: "string", required: true } }, existing: current })
    )
    // A replayed import row naming the removed field is skipped, not refused.
    const replay = (await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "tasks",
      recordId: "old",
      data: { title: "Old", status: "open" },
    })) as { created: boolean }
    expect(replay.created).toBe(false)
  })

  it("warns about a missing title when an empty collection gets its first fields, and accepts a text title", async () => {
    await createSpace()
    await dispatchOperation("records.upsert_collection", { spaceId: "product", collectionId: "empty", name: "Empty" })
    const first = (await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "empty",
      fields: { body: { type: "text" } },
    })) as { warnings?: RecordPracticeWarning[] }
    expect(warningCodes(first)).toContain("missing_recognizable_title")
    const titled = (await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "notes",
      name: "Notes",
      fields: { title: { type: "text" } },
    })) as { warnings?: RecordPracticeWarning[] }
    expect(warningCodes(titled)).not.toContain("missing_recognizable_title")
  })

  it("reports a schema with no title field once, when it is saved", async () => {
    await createSpace()
    const saved = (await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "quotes",
      name: "Quotes",
      fields: { quote: { type: "text", required: true }, url: { type: "url" } },
    })) as { warnings?: RecordPracticeWarning[] }
    expect(warningCodes(saved)).toContain("missing_recognizable_title")

    const widened = (await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "quotes",
      name: "Quotes",
      fields: {
        quote: { type: "text", required: true },
        url: { type: "url" },
        note: { type: "text" },
      },
    })) as { warnings?: RecordPracticeWarning[] }
    expect(warningCodes(widened)).not.toContain("missing_recognizable_title")

    const created = (await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "quotes",
      data: { quote: "Agents keep losing context.", url: "https://example.com/q" },
    })) as { record: { id: string }; warnings?: RecordPracticeWarning[] }
    expect(created.warnings).toBeUndefined()
    expect(created.record.id).toMatch(/^rec-[0-9a-f]{10}$/)
  })
})

describe("MCP record writes keep stored data", () => {
  async function seedCollection(): Promise<void> {
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

describe("MCP record queries", () => {
  async function seedSignals(count: number): Promise<void> {
    await createSpace()
    await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "signals",
      name: "Signals",
      fields: {
        title: { type: "string", required: true },
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
    expect((first as { total?: number }).total).toBe(130)
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

describe("MCP record batches (preview)", () => {
  const preview = { surface: "preview" as const }

  async function seedTeam(): Promise<void> {
    await createSpace()
    await dispatchOperation("records.upsert_collection", {
      spaceId: "product",
      collectionId: "posts",
      name: "Posts",
      fields: {
        title: { type: "string", required: true },
        review: { type: "select", values: ["Verified", "Excluded"] },
      },
    })
  }

  it("adds new records and skips existing ids in one call", async () => {
    await seedTeam()
    await dispatchOperation("records.create", {
      spaceId: "product",
      collectionId: "posts",
      recordId: "p-1",
      data: { title: "Kept as is" },
    })
    const result = (await dispatchOperation(
      "records.create_many",
      {
        spaceId: "product",
        collectionId: "posts",
        records: [
          { recordId: "p-1", data: { title: "Would overwrite" } },
          { recordId: "p-2", data: { title: "Two" } },
          { recordId: "p-3", data: { title: "Three" } },
        ],
      },
      preview
    )) as {
      results: Array<{ recordId: string; created: boolean }>
      created: number
      skipped: number
    }
    expect(result.results).toEqual([
      { recordId: "p-1", created: false },
      { recordId: "p-2", created: true },
      { recordId: "p-3", created: true },
    ])
    expect([result.created, result.skipped]).toEqual([2, 1])
    const kept = (await dispatchOperation("records.read", {
      spaceId: "product",
      collectionId: "posts",
      recordId: "p-1",
    })) as { record: { data: { title: string } } }
    expect(kept.record.data.title).toBe("Kept as is")
  })

  it("writes nothing when any row is invalid, and lists every bad row", async () => {
    await seedTeam()
    await expect(
      dispatchOperation(
        "records.create_many",
        {
          spaceId: "product",
          collectionId: "posts",
          records: [
            { recordId: "ok", data: { title: "Fine" } },
            { recordId: "bad-1", data: { title: "X", reveiw: "Verified" } },
            { recordId: "bad-2", data: { title: "Y", review: "Maybe" } },
          ],
        },
        preview
      )
    ).rejects.toThrow(/Nothing was written: 2 of 3 rows.*row 2 \(bad-1\).*reveiw.*row 3 \(bad-2\).*review must be one of/)
    const all = (await dispatchOperation("records.query", {
      spaceId: "product",
      collectionId: "posts",
    })) as { records: unknown[] }
    expect(all.records).toHaveLength(0)
  })

  it("sets the same values on records chosen by ids or by a filter", async () => {
    await seedTeam()
    await dispatchOperation(
      "records.create_many",
      {
        spaceId: "product",
        collectionId: "posts",
        records: ["a", "b", "c", "d"].map((id) => ({
          recordId: id,
          data: { title: `Post ${id}` },
        })),
      },
      preview
    )
    const byIds = (await dispatchOperation(
      "records.update_many",
      {
        spaceId: "product",
        collectionId: "posts",
        recordIds: ["a", "b", "missing"],
        data: { review: "Excluded" },
      },
      preview
    )) as { updated: number; failed: number; results: Array<{ error?: string }> }
    expect([byIds.updated, byIds.failed]).toEqual([2, 1])
    expect(byIds.results[2]!.error).toContain("Record not found")

    const byFilter = (await dispatchOperation(
      "records.update_many",
      {
        spaceId: "product",
        collectionId: "posts",
        where: { review: { in: ["Excluded"] } },
        data: { review: "Verified" },
      },
      preview
    )) as { updated: number }
    expect(byFilter.updated).toBe(2)

    await expect(
      dispatchOperation(
        "records.update_many",
        {
          spaceId: "product",
          collectionId: "posts",
          recordIds: ["a"],
          data: { review: "Maybe" },
        },
        preview
      )
    ).rejects.toThrow("Nothing was written")
  })

  it("is refused to a caller offered the released tools", async () => {
    await seedTeam()
    await expect(
      dispatchOperation("records.create_many", {
        spaceId: "product",
        collectionId: "posts",
        records: [{ data: { title: "x" } }],
      })
    ).rejects.toThrow("preview action")
  })
})

